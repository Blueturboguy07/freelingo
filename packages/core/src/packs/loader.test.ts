import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from '@freelingo/testkit';
import { isContentHashItemId } from './items.js';
import {
  CREDITS_META_PREFIX,
  PACK_LOADER_READS,
  PRESENTATION_ITEM_FIELDS,
  SEMANTIC_ITEM_FIELDS,
  PackFormatError,
  joinPackPath,
  openPack,
  packItemId,
  readPackMeta,
  semanticItemContent,
  type PackReader,
} from './loader.js';

/**
 * The P2 gate clause: *"the pack loads in `packages/core`'s pack loader tests"*.
 *
 * It loads the **committed** `__fixtures__/es-mini` pack — a real `coursekit` G9 output,
 * built from `seed.json` by the same code that will build the Spanish pack, not a
 * database hand-written to agree with this loader. A fixture written to match the reader
 * proves only that the reader agrees with itself.
 *
 * Regenerate it (from `tools/coursekit`) with:
 *   uv run python -c "from coursekit.packbuild.sqlite import build_fixture_pack as b; b()"
 */

const FIXTURE = new URL('./__fixtures__/es-mini/', import.meta.url);
const PACK_ROOT = fileURLToPath(FIXTURE).replace(/\/$/, '');

function openFixture(): PackReader & { close(): void } {
  const handle = new DatabaseSync(fileURLToPath(new URL('pack.sqlite', FIXTURE)), {
    readOnly: true,
  });
  return {
    all: <T>(sql: string, params: readonly unknown[] = []) =>
      handle.prepare(sql).all(...(params as never[])) as T[],
    get: <T>(sql: string, params: readonly unknown[] = []) =>
      handle.prepare(sql).get(...(params as never[])) as T | undefined,
    close: () => handle.close(),
  };
}

const manifest = JSON.parse(readFileSync(new URL('manifest.json', FIXTURE), 'utf8')) as Record<
  string,
  unknown
>;

/**
 * An in-memory pack for the cases a real one cannot reach.
 *
 * `pack-schema.ts` puts a CHECK on `sentence` and `audio` so an ownerless attributed row
 * cannot be inserted at all — which is the point, and which also means the loader's own
 * reachability scan can never be exercised against a real pack. So these two tables are
 * created here **without** that CHECK, deliberately: the scan has to catch the case even
 * if a future schema edit drops the constraint, and a check whose failure path has never
 * run is a check nobody has tested.
 */
function relaxedPack(): { reader: PackReader; run(sql: string): void } {
  const handle = new DatabaseSync(':memory:');
  handle.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`);
  handle.exec(`CREATE TABLE sentence (
     sentence_id TEXT PRIMARY KEY NOT NULL, lang TEXT, text TEXT, translation TEXT,
     provenance TEXT, source_id TEXT, licence TEXT,
     attribution_required INTEGER NOT NULL, attribution_owner TEXT, audio_id TEXT)`);
  handle.exec(`CREATE TABLE audio (
     audio_id TEXT PRIMARY KEY NOT NULL, clip_hash TEXT, path TEXT, voice_id TEXT,
     engine TEXT, codec TEXT, bitrate_kbps INTEGER, duration_ms INTEGER, bytes INTEGER,
     pipeline TEXT, licence TEXT, attribution_required INTEGER NOT NULL,
     attribution_owner TEXT)`);
  handle.exec(`CREATE TABLE exercise (exercise_id TEXT PRIMARY KEY, item_id TEXT, unit_id TEXT,
     lesson_index INTEGER, slot_index INTEGER, type TEXT, prompt TEXT, preferred_surface TEXT,
     register TEXT, accepted_answers_json TEXT, distractors_json TEXT, ruby_json TEXT,
     illustration_ref TEXT, audio_id TEXT, source_sentence_id TEXT)`);
  handle.exec(`CREATE TABLE exercise_item_tag (exercise_id TEXT, item_kind TEXT, item_ref TEXT,
     is_new INTEGER)`);
  handle.exec(`CREATE TABLE unit (unit_id TEXT PRIMARY KEY, section_index INTEGER,
     section_cefr TEXT, unit_index INTEGER, title TEXT, "function" TEXT, grammar_concept TEXT,
     register_slot TEXT, level_count INTEGER)`);
  for (const [key, value] of [
    ['pack_id', 'p'],
    ['course_id', 'en-es'],
    ['lang', 'es'],
    ['major', '0'],
    ['version', '0'],
    ['schema_version', '1'],
    ['ledger_unit', 'lemma'],
    ['provenance_corpus_pct', '100'],
    ['provenance_machine_authored_pct', '0'],
    ['defect_rate', '0'],
    ['cefr_claim', 'A1 · CEFR-checked'],
  ]) {
    handle
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`)
      .run(key as string, value as string);
  }
  return {
    reader: {
      all: <T>(sql: string, params: readonly unknown[] = []) =>
        handle.prepare(sql).all(...(params as never[])) as T[],
      get: <T>(sql: string, params: readonly unknown[] = []) =>
        handle.prepare(sql).get(...(params as never[])) as T | undefined,
    },
    run: (sql: string) => handle.exec(sql),
  };
}

describe('opening the committed es fixture pack', () => {
  const reader = openFixture();
  const pack = openPack(reader, { packRoot: PACK_ROOT });

  it('reads the meta the course card and About render', () => {
    // S001: `English → Spanish`, the CEFR claim, the machine-authored share, the
    // measured wrong-item rate. S137 repeats provenance and defect rate.
    expect(pack.meta.packId).toBe('freelingo-es');
    expect(pack.meta.courseId).toBe('en-es');
    expect(pack.meta.lang).toBe('es');
    expect(pack.meta.cefrClaim).toBe('A1 · CEFR-checked');
    expect(pack.meta.provenanceMachineAuthoredPct).toBeGreaterThan(0);
    expect(pack.meta.provenanceCorpusPct + pack.meta.provenanceMachineAuthoredPct).toBeCloseTo(
      100,
      1,
    );
    expect(pack.meta.defectRate).toBeLessThan(0.02);
  });

  it('declares its ledger unit, so no consumer invents its own notion of a token', () => {
    // INV-PACK-40 / EC-PACK-37: a Mode-A morpheme for `ja`, a lemma otherwise.
    expect(pack.meta.ledgerUnit).toBe('lemma');
    expect(manifest.ledgerUnit).toBe(pack.meta.ledgerUnit);
  });

  it('lists units in path order', () => {
    const units = pack.units();
    expect(units.map((unit) => unit.unitIndex)).toEqual([1, 2]);
    expect(units[0]?.title).toBe('Greet someone');
    expect(units[0]?.sectionCefr).toBe('A1');
    expect(pack.unit('u002')?.title).toBe('Say who you are');
    expect(pack.unit('nope')).toBeNull();
  });

  it('returns a lesson in slot order, with its tags and parsed JSON columns', () => {
    const lesson = pack.lesson('u001', 1);
    expect(lesson.map((exercise) => exercise.slotIndex)).toEqual([0, 1, 2]);
    expect(lesson.map((exercise) => exercise.type).sort()).toEqual([
      'listen',
      'translate',
      'word_bank',
    ]);

    const translate = lesson.find((exercise) => exercise.type === 'translate');
    expect(translate?.prompt).toBe('Hola, ¿cómo estás?');
    expect(translate?.acceptedAnswers).toEqual(['Hello, how are you?']);
    expect(translate?.preferredSurface).toBe('Hello, how are you?');
    expect(translate?.distractors.length).toBe(2);
    // D1's join: the lexeme tags and the grammar concept an exercise practises. A wrong
    // row here silently corrupts the memory model, which is what V4 exists to catch.
    expect(translate?.tags.map((tag) => tag.ref).sort()).toEqual([
      'cómo',
      'estar',
      'gc:present-estar',
      'hola',
    ]);
    expect(translate?.tags.some((tag) => tag.kind === 'grammar_concept')).toBe(true);
    expect(translate?.tags.filter((tag) => tag.isNew).length).toBeGreaterThan(0);
  });

  it('gives two shapes over the same sentence two item ids when they ask different things', () => {
    // `translate` asks for the English; `listen` asks for the Spanish back. Same prompt
    // string, different preferred surface — so they are different items, and a learner's
    // history on one does not silently satisfy the other.
    const lesson = pack.lesson('u001', 1);
    const translate = lesson.find((exercise) => exercise.type === 'translate');
    const listen = lesson.find((exercise) => exercise.type === 'listen');
    expect(translate?.itemId).not.toBe(listen?.itemId);
  });

  it('returns nothing, rather than throwing, for a lesson that is not there', () => {
    expect(pack.lesson('u001', 99)).toEqual([]);
  });

  it('resolves an FSRS row to its exercises through the item id, never a position', () => {
    const ids = pack.itemIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every(isContentHashItemId)).toBe(true);
    const found = pack.exercisesForItem(ids[0] as string);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((exercise) => exercise.itemId === ids[0])).toBe(true);
    expect(pack.exercisesForItem('i_0000000000000000')).toEqual([]);
  });

  it('declares in its manifest exactly the item ids the pack contains', () => {
    // `applyPackUpdate` quarantines an FSRS row whose id the new pack no longer declares.
    // If the manifest and the database disagreed, a pack that had lost nothing would
    // retire a learner's rows anyway.
    expect(manifest.itemIds).toEqual(pack.itemIds());
  });

  it('resolves audio to a location under the audio root', () => {
    const clip = pack.resolveAudio(
      pack.lesson('u001', 1).find((exercise) => exercise.audioId !== null)?.audioId as string,
    );
    expect(clip).not.toBeNull();
    expect(clip?.codec).toBe('opus');
    expect(clip?.bitrateKbps).toBe(20);
    expect(clip?.uri.startsWith(`${PACK_ROOT}/audio/`)).toBe(true);
    expect(clip?.uri.endsWith('.opus')).toBe(true);
    expect(readFileSync(clip?.uri as string).byteLength).toBe(clip?.bytes);
  });

  it('returns null for an audio id the pack does not have', () => {
    expect(pack.resolveAudio('nope')).toBeNull();
  });

  it('names the clips a partial pack is missing instead of refusing to run', () => {
    // S151: "a partial pack is not a missing pack" — the path renders in full and
    // lessons run with per-item audio fallback, which needs this list, not an exception.
    const existing = new Set(pack.unresolvedAudio(() => false).map((clip) => clip.audioId));
    expect(existing.size).toBeGreaterThan(0);
    expect(pack.unresolvedAudio(() => true)).toEqual([]);
  });

  it('refuses a database that is not a pack', () => {
    const empty = new DatabaseSync(':memory:');
    empty.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
    const reader: PackReader = {
      all: <T>(sql: string) => empty.prepare(sql).all() as T[],
      get: <T>(sql: string) => empty.prepare(sql).get() as T | undefined,
    };
    expect(() => readPackMeta(reader)).toThrow(PackFormatError);
  });
});

describe('the loader and the schema cannot drift', () => {
  /**
   * `packages/core` cannot import `@freelingo/schema` — schema depends on core, and the
   * arrow points one way — so the loader declares what it reads and this test checks the
   * declaration against a **real pack**, which is a stronger check than comparing two
   * TypeScript constants: it fails if the DDL changed, if the build stopped writing a
   * column, or if a query here started naming one that was never there.
   */
  const reader = openFixture();

  it('reads only columns the shipped pack actually has', () => {
    const missing: string[] = [];
    for (const [table, columns] of Object.entries(PACK_LOADER_READS)) {
      const present = new Set(
        reader.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((row) => row.name),
      );
      for (const column of columns) {
        if (!present.has(column)) missing.push(`${table}.${column}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('would notice a column vanishing', () => {
    const present = new Set(
      reader.all<{ name: string }>(`PRAGMA table_info("sentence")`).map((row) => row.name),
    );
    expect(present.has('invented_column')).toBe(false);
  });

  it('[INV-PACK-41] agrees with the schema package about the two hash halves', () => {
    // Read as TEXT rather than imported, for the same dependency-direction reason. The
    // third reader of these lists is `tools/coursekit`, which parses the same file.
    const schema = readRepoFile('packages/schema/src/pack-schema.ts');
    for (const field of SEMANTIC_ITEM_FIELDS) expect(schema).toContain(`'${field}'`);
    for (const field of PRESENTATION_ITEM_FIELDS) expect(schema).toContain(`'${field}'`);
    const declared = /export const SEMANTIC_ITEM_FIELDS = \[([\s\S]*?)\] as const;/.exec(schema);
    expect(declared).not.toBeNull();
    const names = [...(declared?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(names).toEqual([...SEMANTIC_ITEM_FIELDS]);
  });
});

describe('item identity (INV-PACK-41)', () => {
  const base = {
    prompt: '¿Cómo estás?',
    preferredSurface: '¿Cómo estás?',
    register: 'informal',
    lexemes: ['estar', 'cómo'],
    grammarConcepts: ['present-tense-questions'],
    graphemes: [] as string[],
  };

  it('[INV-PACK-41] hashes the same golden vector coursekit does', () => {
    // The same literal is asserted from Python in
    // tools/coursekit/tests/test_itemid.py::test_the_golden_vector_pins_python_to_typescript.
    // Canonical JSON, UTF-8, key sorting and non-ASCII escaping are four separate ways
    // for two implementations of one hash to disagree, and `¿Cómo estás?` exercises all
    // of them; a shared VALUE is the only thing that catches it.
    expect(packItemId(base)).toBe('i_14df0f2e14669171');
  });

  it('[INV-PACK-41] is blind to tag order', () => {
    expect(packItemId({ ...base, lexemes: ['cómo', 'estar'] })).toBe(packItemId(base));
  });

  it('[INV-PACK-41] cannot see a presentation field even when handed one', () => {
    // The falsifier (tools/coursekit/tests/falsifiers/INV-PACK-41.json) is a rebuild
    // after a distractor swap orphaning a strength meter. The projection is what makes
    // that impossible rather than merely unlikely: extra keys are dropped, not hashed.
    const withPresentation = {
      ...base,
      distractors: ['Estoy bien.', 'Muy bien.'],
      ruby: '[{"base":"今日","ruby":"きょう"}]',
      audioHash: 'deadbeef',
      illustration: 'art/hello.svg',
      acceptedAlternates: ['¿Qué tal?'],
    } as unknown as typeof base;
    expect(packItemId(withPresentation)).toBe(packItemId(base));
    expect(Object.keys(semanticItemContent(withPresentation)).sort()).toEqual(
      [...SEMANTIC_ITEM_FIELDS].sort(),
    );
  });

  it('[INV-PACK-41] moves for a semantic change, or the rule would say nothing', () => {
    expect(packItemId({ ...base, register: 'formal' })).not.toBe(packItemId(base));
    expect(packItemId({ ...base, prompt: '¿Cómo está usted?' })).not.toBe(packItemId(base));
    expect(packItemId({ ...base, preferredSurface: '¿Qué tal?' })).not.toBe(packItemId(base));
    expect(packItemId({ ...base, grammarConcepts: ['imperative'] })).not.toBe(packItemId(base));
  });

  it('[INV-PACK-41] mints ids the rest of the engine recognises', () => {
    expect(isContentHashItemId(packItemId(base))).toBe(true);
  });
});

describe('credits (INV-PACK-17)', () => {
  it('[INV-PACK-17] every attributed sentence, voice and derived list is reachable', () => {
    const pack = openPack(openFixture(), { packRoot: PACK_ROOT });
    const credits = pack.credits();
    expect(pack.creditsViolations()).toEqual([]);
    expect(credits.length).toBeGreaterThan(0);
    expect(credits.every((credit) => credit.owner.trim() !== '')).toBe(true);

    const tatoeba = credits.find((credit) => credit.sourceId === 'tatoeba');
    expect(tatoeba?.owner).toBe('Tatoeba contributors');
    expect(tatoeba?.kind).toBe('sentence');
    expect(tatoeba?.items).toBeGreaterThan(0);

    // A derived list is neither a sentence nor a voice: the frequency ordering reaches
    // the learner as the order units are taught in, has no row of its own anywhere else,
    // and is share-alike.
    const derived = credits.find((credit) => credit.kind === 'derived-list');
    expect(derived?.sourceId).toBe('hermitdave');
    expect(derived?.shareAlike).toBe(true);
    expect(derived?.url).toContain('hermitdave');
  });

  it('[INV-PACK-17] reports an attributed sentence the surface would not render', () => {
    // Insertable only because `relaxedPack` drops the schema's CHECK; a real pack cannot
    // hold this row. The scan must catch it anyway — a constraint is not a substitute for
    // the check that runs on what shipped.
    const { reader, run } = relaxedPack();
    run(
      `INSERT INTO sentence (sentence_id, attribution_required, attribution_owner, source_id,
         licence, provenance, text, translation, lang)
       VALUES ('s1', 1, NULL, 'tatoeba', 'CC-BY-2.0-FR', 'corpus', 'Hola.', 'Hi.', 'es')`,
    );
    const pack = openPack(reader, { packRoot: '/tmp' });
    expect(pack.creditsViolations()).toEqual([
      'sentence s1 requires attribution and names no owner',
    ]);
  });

  it('[INV-PACK-17] reports an attributed voice clip with no owner', () => {
    const { reader, run } = relaxedPack();
    run(
      `INSERT INTO audio (audio_id, clip_hash, path, voice_id, engine, codec, bitrate_kbps,
         duration_ms, bytes, pipeline, licence, attribution_required, attribution_owner)
       VALUES ('a1', 'h', 'audio/h.opus', 'v', 'piper', 'opus', 20, 1, 1, 'lesson',
         'CC-BY-NC-SA-4.0', 1, '  ')`,
    );
    const pack = openPack(reader, { packRoot: '/tmp' });
    expect(pack.creditsViolations()).toEqual([
      'voice clip a1 requires attribution and names no owner',
    ]);
  });

  it('[INV-PACK-17] reports a derived list whose credits row has no owner', () => {
    const { reader, run } = relaxedPack();
    run(
      `INSERT INTO meta (key, value) VALUES ('${CREDITS_META_PREFIX}hermitdave',
        '{"kind":"derived-list","source_id":"hermitdave","owner":"","licence":"CC-BY-SA-4.0"}')`,
    );
    const pack = openPack(reader, { packRoot: '/tmp' });
    expect(pack.creditsViolations()).toEqual([
      'derived list hermitdave requires attribution and names no owner',
    ]);
  });

  it('infers share-alike from the licence when a credits row does not state it', () => {
    const { reader, run } = relaxedPack();
    run(
      `INSERT INTO meta (key, value) VALUES ('${CREDITS_META_PREFIX}kanjivg',
        '{"kind":"derived-list","source_id":"kanjivg","owner":"KanjiVG (Ulrich Apel)","licence":"CC-BY-SA-3.0"}')`,
    );
    const pack = openPack(reader, { packRoot: '/tmp' });
    const credit = pack.credits().find((row) => row.sourceId === 'kanjivg');
    expect(credit?.shareAlike).toBe(true);
    expect(pack.creditsViolations()).toEqual([]);
  });
});

describe('path joining', () => {
  it('joins a root and a pack-relative path with exactly one separator', () => {
    expect(joinPackPath('/var/cache/packs/es', 'audio/a.opus')).toBe(
      '/var/cache/packs/es/audio/a.opus',
    );
    expect(joinPackPath('/var/cache/packs/es/', '/audio/a.opus')).toBe(
      '/var/cache/packs/es/audio/a.opus',
    );
    expect(joinPackPath('', 'audio/a.opus')).toBe('audio/a.opus');
  });
});
