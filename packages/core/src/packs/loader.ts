/**
 * Reading an installed pack: units, lessons, items, audio and credits.
 *
 * `install.ts` decides whether a pack may be installed at all (signature, digest, the
 * six-state enum). This is what happens afterwards — the read side, and only the read
 * side. The reader interface it takes has `all` and `get` and **no `run`**, because a
 * content pack is read-only in the strongest sense available to us: it lives in the
 * cache directory, the OS may reclaim it, and anything the app wrote into it would be
 * silently lost and would invalidate the signature besides.
 *
 * Two invariants are answered here rather than in the pack builder, because the builder
 * is not what ships:
 *
 * - **INV-PACK-17** — every sentence, voice and derived list whose licence requires
 *   attribution is *reachable from the rendered credits surface*. The two halves are
 *   deliberately computed from **disjoint** rows:
 *
 *   - `credits()` renders the `attribution:` rows of `meta` and nothing else. Those are
 *     the build's authoritative credit rows — one per source, owner resolved, licence
 *     URL filled in — and they are the whole of what S152 shows.
 *   - `creditsViolations()` never reads those rows for its evidence. It walks `sentence`
 *     and `audio`, which `credits()` does not touch, and asks whether each attributed
 *     row's source and owner appear in what the surface renders.
 *
 *   An earlier version had `credits()` scan `sentence` and `audio` *as well*, which was
 *   wrong twice: Tatoeba rendered on S152 twice (once from the scan with no URL, once
 *   from its meta row), and the reachability half of the check could not fail, because
 *   every row it walked had put itself into the set it was being checked against.
 * - **INV-PACK-41** — item ids are content hashes over semantic fields only, so this
 *   module resolves an FSRS row to an exercise through `item_id` and never through a
 *   position, a rowid or an audio hash.
 *
 * Column names come from `packages/schema/src/pack-schema.ts`, which is the one place
 * the DDL exists. `packages/core` cannot import `@freelingo/schema` (schema depends on
 * core; the arrow only points one way), so this module *declares what it reads* in
 * `PACK_LOADER_READS`, and `loader.test.ts` checks that declaration against the **shipped
 * fixture pack** — a stronger gate than comparing two TypeScript constants, because it
 * also fails when the build stops writing a column the DDL still declares. There is no
 * second copy of the schema here.
 *
 * Specs: scope2/00 §2.5, plan §Data model, S001/S002/S137/S151 (+ S152, which the
 * product map still owes a row). Purity: no React, no React Native, no `node:` imports.
 */
import { contentHashItemId } from './items.js';

/* ================================================= item identity (INV-PACK-41) */

/**
 * The fields an item id is hashed over, and the ones it is deliberately blind to.
 *
 * EC-PACK-38 names both halves: hash over *"prompt, preferred surface,
 * lexeme/concept/grapheme tags and register only"*; ruby spans, audio hashes, stroke
 * paths, illustration refs, the accepted-alternate set and the distractor pool are
 * **outside** it. The cost of getting it wrong is not a wrong id, it is a silently
 * orphaned learner: a monthly JmdictFurigana release re-solves one word's ruby, every id
 * under it moves, twelve weeks of FSRS history stops resolving, and `NEW WORD` comes back
 * on a word they know.
 *
 * The same two lists are declared in `packages/schema/src/pack-schema.ts`, which is what
 * `tools/coursekit` parses; `loader.test.ts` fails if the two copies disagree. They are
 * restated here rather than imported because core cannot import schema — schema depends
 * on core, and the arrow points one way.
 */
export const SEMANTIC_ITEM_FIELDS = [
  'prompt',
  'preferredSurface',
  'register',
  'lexemes',
  'grammarConcepts',
  'graphemes',
] as const;

export const PRESENTATION_ITEM_FIELDS = [
  'ruby',
  'audioHash',
  'strokePaths',
  'illustration',
  'acceptedAlternates',
  'distractors',
] as const;

/** The semantic half of an item. Everything an id may depend on, and nothing else. */
export interface SemanticItem {
  readonly prompt: string;
  readonly preferredSurface: string;
  readonly register: string;
  readonly lexemes: readonly string[];
  readonly grammarConcepts: readonly string[];
  readonly graphemes: readonly string[];
}

/**
 * The exact object that is hashed: the six fields, tag arrays sorted, nothing else.
 *
 * Extra keys are dropped rather than hashed, which is what makes the falsifier — a
 * rebuild after a distractor swap — impossible rather than merely unlikely. Tags are
 * sorted because a tagger emitting the same set in another order is not a content
 * change, while `canonicalJson` preserves array order by design (an ordered list is
 * content elsewhere in the pack).
 */
export function semanticItemContent(item: SemanticItem): Record<string, unknown> {
  return {
    prompt: item.prompt,
    preferredSurface: item.preferredSurface,
    register: item.register,
    lexemes: [...item.lexemes].sort(),
    grammarConcepts: [...item.grammarConcepts].sort(),
    graphemes: [...item.graphemes].sort(),
  };
}

/** The content-hashed item id: `i_` + 16 hex, exactly as `coursekit` mints it. */
export function packItemId(item: SemanticItem): string {
  return contentHashItemId(semanticItemContent(item));
}

/** The read-only subset of a SQLite handle a pack may be touched through. */
export interface PackReader {
  all<T>(sql: string, params?: readonly unknown[]): T[];
  get<T>(sql: string, params?: readonly unknown[]): T | undefined;
}

/**
 * Every table and column this module reads, declared so the schema package can prove the
 * DDL still provides them. Adding a query here without adding its column makes
 * `pack-schema.test.ts` red, which is the whole point: the alternative failure is a pack
 * that installs green and returns nothing for one query on a device.
 */
export const PACK_LOADER_READS: Readonly<Record<string, readonly string[]>> = {
  meta: ['key', 'value'],
  unit: [
    'unit_id',
    'section_index',
    'section_cefr',
    'unit_index',
    'title',
    'function',
    'grammar_concept',
    'register_slot',
    'level_count',
  ],
  unit_item: ['unit_id', 'item_kind', 'item_ref', 'introduction_order'],
  exercise: [
    'exercise_id',
    'item_id',
    'unit_id',
    'lesson_index',
    'slot_index',
    'type',
    'prompt',
    'preferred_surface',
    'register',
    'accepted_answers_json',
    'distractors_json',
    'ruby_json',
    'illustration_ref',
    'audio_id',
    'source_sentence_id',
  ],
  exercise_item_tag: ['exercise_id', 'item_kind', 'item_ref', 'is_new'],
  sentence: [
    'sentence_id',
    'text',
    'translation',
    'provenance',
    'source_id',
    'licence',
    'attribution_required',
    'attribution_owner',
    'audio_id',
  ],
  audio: [
    'audio_id',
    'clip_hash',
    'path',
    'voice_id',
    'engine',
    'codec',
    'bitrate_kbps',
    'duration_ms',
    'bytes',
    'pipeline',
    'licence',
    'attribution_required',
    'attribution_owner',
  ],
};

/** Credits rows live in `meta` under this prefix. Mirrors `CREDITS_META_PREFIX`. */
export const CREDITS_META_PREFIX = 'attribution:';

/**
 * A voice is credited per engine, never per clip: `voice:kokoro`, not one row for each
 * of 8,000 utterances. Mirrors the id `packbuild/attribution.py` mints, and the read side
 * has to mint the same string or its reachability check compares two vocabularies.
 */
export const VOICE_SOURCE_PREFIX = 'voice:';

/* ================================================================ pack meta */

export interface PackMeta {
  readonly packId: string;
  readonly courseId: string;
  readonly lang: string;
  readonly major: number;
  readonly version: string;
  readonly schemaVersion: number;
  /** INV-PACK-40: a Mode-A morpheme for `ja`, a lemma otherwise. Declared once. */
  readonly ledgerUnit: string;
  /** S001/S137: the two provenance percentages, as declared by the build. */
  readonly provenanceCorpusPct: number;
  readonly provenanceMachineAuthoredPct: number;
  /** The measured native-reviewer wrong-item rate. S001 renders it. */
  readonly defectRate: number;
  /** `A1 · CEFR-checked` for es/fr; `Beginner · frequency-ordered` otherwise. */
  readonly cefrClaim: string;
  /**
   * The machine-readable half of the same fact, and the one a UI should branch on.
   *
   * `CourseManifest.cefrChecked` (`packages/core/src/types`) is a boolean that
   * `path/manifest.ts` renders its own section-card chip from. Before this existed the
   * pack carried only the sentence and the path lane carried only the boolean, so the
   * same learner-facing claim had two independent sources of truth and had already
   * drifted on its separator. This is where the boolean comes from now.
   */
  readonly cefrChecked: boolean;
}

export class PackFormatError extends Error {}

function metaMap(reader: PackReader): Map<string, string> {
  const rows = reader.all<{ key: string; value: string }>(`SELECT key, value FROM meta`);
  return new Map(rows.map((row) => [row.key, row.value]));
}

function requireMeta(meta: ReadonlyMap<string, string>, key: string): string {
  const value = meta.get(key);
  if (value === undefined || value.trim() === '') {
    throw new PackFormatError(`pack meta has no ${key}`);
  }
  return value;
}

function requireNumber(meta: ReadonlyMap<string, string>, key: string): number {
  const raw = requireMeta(meta, key);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new PackFormatError(`pack meta ${key} is ${raw}, which is not a number`);
  }
  return value;
}

export function readPackMeta(reader: PackReader): PackMeta {
  const meta = metaMap(reader);
  return {
    packId: requireMeta(meta, 'pack_id'),
    courseId: requireMeta(meta, 'course_id'),
    lang: requireMeta(meta, 'lang'),
    major: requireNumber(meta, 'major'),
    version: requireMeta(meta, 'version'),
    schemaVersion: requireNumber(meta, 'schema_version'),
    ledgerUnit: requireMeta(meta, 'ledger_unit'),
    provenanceCorpusPct: requireNumber(meta, 'provenance_corpus_pct'),
    provenanceMachineAuthoredPct: requireNumber(meta, 'provenance_machine_authored_pct'),
    defectRate: requireNumber(meta, 'defect_rate'),
    cefrClaim: requireMeta(meta, 'cefr_claim'),
    cefrChecked: requireMeta(meta, 'cefr_checked') === '1',
  };
}

/* ==================================================== units, lessons, items */

export interface PackUnit {
  readonly unitId: string;
  readonly sectionIndex: number;
  readonly sectionCefr: string;
  readonly unitIndex: number;
  readonly title: string;
  readonly function: string;
  readonly grammarConcept: string;
  readonly registerSlot: string;
  readonly levelCount: number;
}

export interface PackItemTag {
  readonly kind: 'lexeme' | 'grammar_concept' | 'grapheme';
  readonly ref: string;
  readonly isNew: boolean;
}

export interface PackExercise {
  readonly exerciseId: string;
  /** The content-hashed FSRS key (INV-PACK-41). Not unique: shapes can share an item. */
  readonly itemId: string;
  readonly unitId: string;
  readonly lessonIndex: number;
  readonly slotIndex: number;
  readonly type: string;
  readonly prompt: string;
  readonly preferredSurface: string;
  readonly register: string;
  readonly acceptedAnswers: readonly string[];
  readonly distractors: readonly string[];
  readonly ruby: string | null;
  readonly illustrationRef: string | null;
  readonly audioId: string | null;
  readonly sourceSentenceId: string | null;
  readonly tags: readonly PackItemTag[];
}

interface ExerciseRow {
  readonly exercise_id: string;
  readonly item_id: string;
  readonly unit_id: string;
  readonly lesson_index: number;
  readonly slot_index: number;
  readonly type: string;
  readonly prompt: string;
  readonly preferred_surface: string;
  readonly register: string;
  readonly accepted_answers_json: string;
  readonly distractors_json: string;
  readonly ruby_json: string | null;
  readonly illustration_ref: string | null;
  readonly audio_id: string | null;
  readonly source_sentence_id: string | null;
}

/**
 * JSON columns are parsed defensively. A pack that verified its signature is not
 * therefore well-formed — it is *authentically* whatever the build put in it — and one
 * unparseable column must not take down a lesson that could have run without it.
 */
function parseStringArray(raw: string, where: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PackFormatError(`${where} is not JSON`);
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new PackFormatError(`${where} is not an array of strings`);
  }
  return value as string[];
}

/* ===================================================================== audio */

export interface PackAudio {
  readonly audioId: string;
  readonly clipHash: string;
  /** Where the bytes live, relative to the pack root, as the build wrote it. */
  readonly path: string;
  /** The resolved location: `packRoot` joined to `path`. What a player is handed. */
  readonly uri: string;
  readonly voiceId: string;
  readonly engine: string;
  readonly codec: string;
  readonly bitrateKbps: number;
  readonly durationMs: number;
  readonly bytes: number;
  readonly pipeline: string;
  readonly licence: string;
  readonly attributionOwner: string | null;
}

interface AudioRow {
  readonly audio_id: string;
  readonly clip_hash: string;
  readonly path: string;
  readonly voice_id: string;
  readonly engine: string;
  readonly codec: string;
  readonly bitrate_kbps: number;
  readonly duration_ms: number;
  readonly bytes: number;
  readonly pipeline: string;
  readonly licence: string;
  readonly attribution_required: number;
  readonly attribution_owner: string | null;
}

/**
 * Join a root and a pack-relative path.
 *
 * Hand-rolled rather than `node:path`, which does not exist on a device, and kept
 * deliberately dumb: one separator, no `..` resolution, no platform branch. The pack
 * writes its own paths, and a path that needs resolving is a pack bug this should
 * surface rather than repair.
 */
export function joinPackPath(root: string, relative: string): string {
  const left = root.replace(/[/\\]+$/, '');
  const right = relative.replace(/^[/\\]+/, '');
  return left === '' ? right : `${left}/${right}`;
}

/* ================================================================== credits */

export type PackCreditKind = 'sentence' | 'voice' | 'derived-list';

/** One row of the credits surface (S152). */
export interface PackCredit {
  readonly kind: PackCreditKind;
  readonly sourceId: string;
  readonly owner: string;
  readonly licence: string;
  /** True where the licence is share-alike (CC BY-SA), which the surface must state. */
  readonly shareAlike: boolean;
  readonly url: string | null;
  /** How many rows of the pack this one credit covers. Rendered as a count. */
  readonly items: number;
}

interface DerivedListCredit {
  readonly source_id?: unknown;
  readonly owner?: unknown;
  readonly licence?: unknown;
  readonly share_alike?: unknown;
  readonly url?: unknown;
  readonly kind?: unknown;
  readonly items?: unknown;
}

/** How a violation names each kind of credit. `derived-list` reads as prose, not a slug. */
const CREDIT_LABELS: Readonly<Record<PackCreditKind, string>> = {
  sentence: 'credited source',
  voice: 'credited voice',
  'derived-list': 'derived list',
};

function isShareAlike(licence: string): boolean {
  return /(^|[^A-Z])SA([^A-Z]|$)/i.test(licence.replace(/[-_]/g, '-'));
}

/* ============================================================== the loader */

export interface OpenPackOptions {
  /**
   * Where this pack's directory sits on the device, as an absolute location.
   *
   * Every path in the pack — `audio/<hash>.opus` today — is stored relative to it, so a
   * pack that MOVES stays readable without rewriting a row. That is not hypothetical: the
   * pack lives in the cache directory, and iOS relocates the container between launches.
   */
  readonly packRoot: string;
}

export interface LoadedPack {
  readonly meta: PackMeta;
  units(): readonly PackUnit[];
  unit(unitId: string): PackUnit | null;
  /** Every exercise of one lesson, in slot order. The session queue's input. */
  lesson(unitId: string, lessonIndex: number): readonly PackExercise[];
  /** Every exercise carrying an item id — how an FSRS row finds something to show. */
  exercisesForItem(itemId: string): readonly PackExercise[];
  /** Every item id the pack declares, sorted. The manifest's `itemIds`, read back. */
  itemIds(): readonly string[];
  resolveAudio(audioId: string): PackAudio | null;
  /** Audio rows whose file `exists` says is absent: the S151 partial-pack fallback list. */
  unresolvedAudio(exists: (uri: string) => boolean): readonly PackAudio[];
  credits(): readonly PackCredit[];
  /** INV-PACK-17, read side: anything attributed that the credits surface would miss. */
  creditsViolations(): string[];
}

/**
 * Open an installed pack. Throws `PackFormatError` if it is not one.
 *
 * Nothing is cached across calls except the meta row, which is read once and is what a
 * caller checks before doing anything else. The rest is queried on demand: a pack is
 * tens of thousands of rows, a device has a session's worth of memory, and SQLite is
 * already the index.
 */
export function openPack(reader: PackReader, options: OpenPackOptions): LoadedPack {
  const meta = readPackMeta(reader);

  const toExercise = (row: ExerciseRow, tags: readonly PackItemTag[]): PackExercise => ({
    exerciseId: row.exercise_id,
    itemId: row.item_id,
    unitId: row.unit_id,
    lessonIndex: row.lesson_index,
    slotIndex: row.slot_index,
    type: row.type,
    prompt: row.prompt,
    preferredSurface: row.preferred_surface,
    register: row.register,
    acceptedAnswers: parseStringArray(
      row.accepted_answers_json,
      `exercise ${row.exercise_id} accepted_answers_json`,
    ),
    distractors: parseStringArray(
      row.distractors_json,
      `exercise ${row.exercise_id} distractors_json`,
    ),
    ruby: row.ruby_json,
    illustrationRef: row.illustration_ref,
    audioId: row.audio_id,
    sourceSentenceId: row.source_sentence_id,
    tags,
  });

  const tagsFor = (exerciseIds: readonly string[]): Map<string, PackItemTag[]> => {
    const out = new Map<string, PackItemTag[]>();
    if (exerciseIds.length === 0) return out;
    const placeholders = exerciseIds.map(() => '?').join(', ');
    const rows = reader.all<{
      exercise_id: string;
      item_kind: PackItemTag['kind'];
      item_ref: string;
      is_new: number;
    }>(
      `SELECT exercise_id, item_kind, item_ref, is_new FROM exercise_item_tag
         WHERE exercise_id IN (${placeholders})
         ORDER BY exercise_id, item_kind, item_ref`,
      exerciseIds,
    );
    for (const row of rows) {
      const list = out.get(row.exercise_id) ?? [];
      list.push({ kind: row.item_kind, ref: row.item_ref, isNew: row.is_new === 1 });
      out.set(row.exercise_id, list);
    }
    return out;
  };

  const hydrate = (rows: readonly ExerciseRow[]): readonly PackExercise[] => {
    const tags = tagsFor(rows.map((row) => row.exercise_id));
    return rows.map((row) => toExercise(row, tags.get(row.exercise_id) ?? []));
  };

  const audioFrom = (row: AudioRow): PackAudio => ({
    audioId: row.audio_id,
    clipHash: row.clip_hash,
    path: row.path,
    uri: joinPackPath(options.packRoot, row.path),
    voiceId: row.voice_id,
    engine: row.engine,
    codec: row.codec,
    bitrateKbps: row.bitrate_kbps,
    durationMs: row.duration_ms,
    bytes: row.bytes,
    pipeline: row.pipeline,
    licence: row.licence,
    attributionOwner: row.attribution_owner,
  });

  return {
    meta,

    units() {
      return reader
        .all<{
          unit_id: string;
          section_index: number;
          section_cefr: string;
          unit_index: number;
          title: string;
          function: string;
          grammar_concept: string;
          register_slot: string;
          level_count: number;
        }>(
          `SELECT unit_id, section_index, section_cefr, unit_index, title, "function",
                  grammar_concept, register_slot, level_count
             FROM unit ORDER BY section_index, unit_index`,
        )
        .map((row) => ({
          unitId: row.unit_id,
          sectionIndex: row.section_index,
          sectionCefr: row.section_cefr,
          unitIndex: row.unit_index,
          title: row.title,
          function: row.function,
          grammarConcept: row.grammar_concept,
          registerSlot: row.register_slot,
          levelCount: row.level_count,
        }));
    },

    unit(unitId) {
      return this.units().find((unit) => unit.unitId === unitId) ?? null;
    },

    lesson(unitId, lessonIndex) {
      const rows = reader.all<ExerciseRow>(
        `SELECT exercise_id, item_id, unit_id, lesson_index, slot_index, type, prompt,
                preferred_surface, register, accepted_answers_json, distractors_json,
                ruby_json, illustration_ref, audio_id, source_sentence_id
           FROM exercise WHERE unit_id = ? AND lesson_index = ? ORDER BY slot_index`,
        [unitId, lessonIndex],
      );
      return hydrate(rows);
    },

    exercisesForItem(itemId) {
      const rows = reader.all<ExerciseRow>(
        `SELECT exercise_id, item_id, unit_id, lesson_index, slot_index, type, prompt,
                preferred_surface, register, accepted_answers_json, distractors_json,
                ruby_json, illustration_ref, audio_id, source_sentence_id
           FROM exercise WHERE item_id = ? ORDER BY unit_id, lesson_index, slot_index`,
        [itemId],
      );
      return hydrate(rows);
    },

    itemIds() {
      return reader
        .all<{ item_id: string }>(`SELECT DISTINCT item_id FROM exercise ORDER BY item_id`)
        .map((row) => row.item_id);
    },

    resolveAudio(audioId) {
      const row = reader.get<AudioRow>(
        `SELECT audio_id, clip_hash, path, voice_id, engine, codec, bitrate_kbps,
                duration_ms, bytes, pipeline, licence, attribution_required, attribution_owner
           FROM audio WHERE audio_id = ?`,
        [audioId],
      );
      return row === undefined ? null : audioFrom(row);
    },

    unresolvedAudio(exists) {
      return reader
        .all<AudioRow>(
          `SELECT audio_id, clip_hash, path, voice_id, engine, codec, bitrate_kbps,
                  duration_ms, bytes, pipeline, licence, attribution_required, attribution_owner
             FROM audio ORDER BY audio_id`,
        )
        .map(audioFrom)
        .filter((audio) => !exists(audio.uri));
    },

    credits() {
      /*
       * The `attribution:` rows of `meta`, and only those.
       *
       * They are one row per source — sentences and voices already grouped, the owner
       * resolved against the run's own licence table, the licence URL substituted for
       * this language — which is exactly the shape S152 renders. Scanning `sentence` and
       * `audio` here as well is what produced two Tatoeba rows, one of them with a null
       * URL, and it is also what made `creditsViolations()` unable to fail: see the
       * module comment.
       */
      return reader
        .all<{ key: string; value: string }>(
          `SELECT key, value FROM meta WHERE key LIKE ? ORDER BY key`,
          [`${CREDITS_META_PREFIX}%`],
        )
        .map((row): PackCredit => {
          let parsed: DerivedListCredit;
          try {
            parsed = JSON.parse(row.value) as DerivedListCredit;
          } catch {
            throw new PackFormatError(`pack meta ${row.key} is not JSON`);
          }
          const licence = typeof parsed.licence === 'string' ? parsed.licence : '';
          return {
            kind:
              parsed.kind === 'voice' || parsed.kind === 'sentence' ? parsed.kind : 'derived-list',
            sourceId:
              typeof parsed.source_id === 'string'
                ? parsed.source_id
                : row.key.slice(CREDITS_META_PREFIX.length),
            owner: typeof parsed.owner === 'string' ? parsed.owner : '',
            licence,
            shareAlike:
              typeof parsed.share_alike === 'boolean'
                ? parsed.share_alike
                : isShareAlike(licence),
            url: typeof parsed.url === 'string' ? parsed.url : null,
            items: typeof parsed.items === 'number' ? parsed.items : 0,
          };
        });
    },

    creditsViolations() {
      const violations: string[] = [];
      const rendered = this.credits();
      const owners = new Set(
        rendered.filter((credit) => credit.owner.trim() !== '').map((credit) => credit.owner),
      );
      const sources = new Set(rendered.map((credit) => credit.sourceId));

      /*
       * `sentence` and `audio` are rows `credits()` never reads. That disjointness is
       * the whole value of this function: it can report a source the surface does not
       * carry, which a check built from the surface's own query cannot.
       */
      for (const row of reader.all<{
        sentence_id: string;
        source_id: string;
        attribution_owner: string | null;
      }>(
        `SELECT sentence_id, source_id, attribution_owner FROM sentence
           WHERE attribution_required = 1 ORDER BY sentence_id`,
      )) {
        const owner = row.attribution_owner ?? '';
        if (owner.trim() === '') {
          violations.push(`sentence ${row.sentence_id} requires attribution and names no owner`);
        } else if (!sources.has(row.source_id)) {
          violations.push(
            `sentence ${row.sentence_id} cites ${row.source_id}, which the credits surface does not render`,
          );
        } else if (!owners.has(owner)) {
          violations.push(
            `sentence ${row.sentence_id} is attributed to ${owner}, which the credits surface does not render`,
          );
        }
      }

      for (const row of reader.all<{
        audio_id: string;
        engine: string;
        voice_id: string;
        attribution_owner: string | null;
      }>(
        `SELECT audio_id, engine, voice_id, attribution_owner FROM audio
           WHERE attribution_required = 1 ORDER BY audio_id`,
      )) {
        const owner = row.attribution_owner ?? '';
        // The source id a voice clip is credited under, as the build mints it
        // (`packbuild/attribution.py`): one row per engine, not one per clip.
        const sourceId = `${VOICE_SOURCE_PREFIX}${row.engine}`;
        if (owner.trim() === '') {
          violations.push(`voice clip ${row.audio_id} requires attribution and names no owner`);
        } else if (!sources.has(sourceId)) {
          violations.push(
            `voice clip ${row.audio_id} cites ${sourceId}, which the credits surface does not render`,
          );
        } else if (!owners.has(owner)) {
          violations.push(
            `voice clip ${row.audio_id} is attributed to ${owner}, which the credits surface does not render`,
          );
        }
      }

      /*
       * A derived list has no row of its own anywhere else in the pack — the frequency
       * ordering reaches the learner as the order units are taught in — so there is
       * nothing here to cross-check it against, and the read side can only ask whether
       * the row it renders names somebody. The independent walk for derived lists is on
       * the BUILD side, where the run's licence table still exists:
       * `packbuild/attribution.py::attribution_violations`.
       */
      for (const credit of rendered) {
        if (credit.owner.trim() !== '') continue;
        violations.push(`${CREDIT_LABELS[credit.kind]} ${credit.sourceId} requires attribution and names no owner`);
      }

      return violations.sort();
    },
  };
}
