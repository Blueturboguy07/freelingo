// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { migrate, type Db } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { emptySchedulerState, asItemId, rowAt } from '@freelingo/core/scheduler';
import { ES_PACK, ES_UNIT } from '../../../../packages/core/src/grading/packs/es';
import type {
  VerifiedRuntimeItem,
  RuntimeLexicalBinding,
} from '../../../../packages/core/src/packs/runtime-item-types';
import { registerSources, projectSourceRegistration } from './learningSources';
const opened: Db[] = [];
afterEach(() => {
  opened.forEach((db) => db.close());
  opened.length = 0;
});
const clock = {
  utcMs: Date.parse('2026-09-13T12:00:00Z'),
  monotonicMs: 100,
  zone: { tzId: 'UTC', utcOffsetMinutes: 0, tzSource: 'iana' as const },
};
const binding: RuntimeLexicalBinding = {
  schedulerItemId: 'lx:cat',
  surfaceId: 'sf:cat',
  surface: 'gato',
  language: 'es',
  lexemeId: 'lx:cat',
  lemma: 'gato',
  pos: 'NOUN',
  wordItemId: 'word-cat',
  semantic: {
    prompt: 'cat',
    preferredSurface: 'gato',
    register: 'neutral',
    lexemes: ['gato'],
    grammarConcepts: [],
    graphemes: [],
  },
  countable: true,
  classification: 'word',
  proof: {
    sourceId: 'source',
    sourceSha256: 'a'.repeat(64),
    declarationSha256: 'b'.repeat(64),
    bindingSha256: 'c'.repeat(64),
  },
};
function fixture() {
  const db = createNodeDb();
  opened.push(db);
  migrate(db);
  db.run("INSERT INTO course_progress(course_id,added_at) VALUES('en-es','2026-09-13')");
  const item: VerifiedRuntimeItem = {
    schemaVersion: 1,
    exerciseId: 'grid',
    itemId: 'aggregate-grid',
    unitId: 'u1',
    lessonIndex: 1,
    profileId: 'es',
    responseLanguage: 'es',
    proof: {
      sourceId: binding.proof.sourceId,
      sourceSha256: binding.proof.sourceSha256,
      approvalId: 'approval',
      approvalSha256: 'd'.repeat(64),
      draftSha256: 'e'.repeat(64),
    },
    gradable: { itemId: 'aggregate-grid', family: 'match', accepted: [] },
    presentation: {
      itemId: 'aggregate-grid',
      type: 'matchPairs',
      prompt: 'Match',
      promptLanguage: 'en',
      instruction: 'Match',
      language: 'es',
      acceptedAnswers: [],
    },
    schedulerSurfaces: [
      {
        itemId: binding.schedulerItemId,
        itemRef: binding.lexemeId,
        kind: 'lexeme',
        surfaceId: binding.surfaceId,
        surface: binding.surface,
        language: 'es',
        canonical: true,
      },
    ],
    lexicalBindings: [binding],
    introductions: [],
    explanation: '',
    grading: { pack: ES_PACK, unit: ES_UNIT, profileId: 'es', responseLanguage: 'es' },
  };
  const register = (next = item) =>
    db.withExclusiveTransaction(() =>
      registerSources(db, 'en-es', emptySchedulerState('UTC'), [{ item: next }], clock),
    );
  return { db, item, register };
}
it('[INV-ECO-27][INV-SCH-11] explicit lexical targets register separately from the aggregate without an exposure', () => {
  const f = fixture(),
    state = f.register();
  expect(
    f.db.all('SELECT item_id,countable,quarantined FROM course_item ORDER BY item_id'),
  ).toEqual([
    { item_id: 'aggregate-grid', countable: 0, quarantined: 0 },
    { item_id: 'lx:cat', countable: 1, quarantined: 0 },
  ]);
  expect(rowAt(state, asItemId('lx:cat'), 'gato')?.introducedAt).toBeNull();
  expect(state.introductions.records).toEqual([]);
  expect(f.db.all('SELECT * FROM account_word')).toEqual([]);
});
it('[INV-PACK-02] registration preserves local quarantine and rejects conflicting stored countability', () => {
  const f = fixture();
  f.db.run(
    "INSERT INTO course_item(course_id,item_id,countable,quarantined) VALUES('en-es','lx:cat',1,1)",
  );
  f.register();
  expect(f.db.get("SELECT quarantined FROM course_item WHERE item_id='lx:cat'")?.quarantined).toBe(
    1,
  );
  f.db.run("UPDATE course_item SET countable=0 WHERE item_id='lx:cat'");
  expect(() => f.register()).toThrow(/countability|countable/);
  expect(f.db.get("SELECT countable,quarantined FROM course_item WHERE item_id='lx:cat'")).toEqual({
    countable: 0,
    quarantined: 1,
  });
});
it('[INV-ECO-27] reviewed excluded particles retain explicit false without a POS heuristic', () => {
  const f = fixture();
  f.register({
    ...f.item,
    lexicalBindings: [{ ...binding, countable: false, classification: 'particle' }],
  });
  expect(f.db.get("SELECT countable FROM course_item WHERE item_id='lx:cat'")?.countable).toBe(0);
});
it.each([
  'missing',
  'duplicate',
  'target',
  'surface',
  'language',
  'lexeme',
  'classification',
  'source',
] as const)(
  '[INV-ECO-27][INV-PACK-41] no child registration from mismatched lexical proof: %s',
  (fault) => {
    const f = fixture();
    let b = { ...binding };
    if (fault === 'target') b = { ...b, schedulerItemId: 'other' };
    if (fault === 'surface') b = { ...b, surface: 'perro' };
    if (fault === 'language') b = { ...b, language: 'en' };
    if (fault === 'lexeme') b = { ...b, lexemeId: 'other' };
    if (fault === 'classification') b = { ...b, classification: 'particle' };
    if (fault === 'source') b = { ...b, proof: { ...b.proof, sourceId: 'other' } };
    const item = {
      ...f.item,
      lexicalBindings: fault === 'missing' ? [] : fault === 'duplicate' ? [b, b] : [b],
    };
    expect(() => f.register(item)).toThrow();
    expect(f.db.all('SELECT * FROM course_item')).toEqual([]);
  },
);

it('[INV-SCH-11][INV-HUB-09] source preview projects exact registration without any SQL writes or introductions', () => {
  const f = fixture(),
    before = f.db.all('SELECT * FROM course_item');
  const initial = emptySchedulerState('UTC');
  const projection = projectSourceRegistration(f.db, 'en-es', initial, [{ item: f.item }], clock);
  expect(f.db.all('SELECT * FROM course_item')).toEqual(before);
  expect(f.db.all('SELECT * FROM course_item_surface')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_surface_exposure')).toEqual([]);
  expect(f.db.all('SELECT * FROM account_word')).toEqual([]);
  expect(initial.rows.size).toBe(0);
  expect(projection.newItems).toEqual([
    { itemId: 'aggregate-grid', countable: false },
    { itemId: 'lx:cat', countable: true },
  ]);
  expect(projection.scheduler).toEqual(f.register());
  expect(
    projectSourceRegistration(f.db, 'en-es', initial, [{ item: f.item }], clock).newItems,
  ).toEqual([]);
});
it('[INV-ECO-27][INV-HUB-09] preview coalesces repeated sources but rejects conflicting future countability', () => {
  const f = fixture(),
    initial = emptySchedulerState('UTC');
  const projected = projectSourceRegistration(
    f.db,
    'en-es',
    initial,
    [{ item: f.item }, { item: f.item }],
    clock,
  );
  expect(projected.newItems).toHaveLength(2);
  const conflicting = {
    ...f.item,
    lexicalBindings: [{ ...binding, countable: false, classification: 'particle' as const }],
  };
  expect(() =>
    projectSourceRegistration(
      f.db,
      'en-es',
      initial,
      [{ item: f.item }, { item: conflicting }],
      clock,
    ),
  ).toThrow(/countability/);
  expect(f.db.all('SELECT * FROM course_item')).toEqual([]);
  expect(initial.rows.size).toBe(0);
});
it('[INV-PACK-02][INV-HUB-09] read-only registration retains quarantine and the same existing countability guards', () => {
  const f = fixture();
  f.db.run(
    "INSERT INTO course_item(course_id,item_id,countable,quarantined) VALUES('en-es','lx:cat',1,1)",
  );
  const before = f.db.all('SELECT * FROM course_item');
  const p = projectSourceRegistration(
    f.db,
    'en-es',
    emptySchedulerState('UTC'),
    [{ item: f.item }],
    clock,
  );
  expect(p.newItems).toEqual([{ itemId: 'aggregate-grid', countable: false }]);
  expect(f.db.all('SELECT * FROM course_item')).toEqual(before);
  f.db.run("UPDATE course_item SET countable=0 WHERE item_id='lx:cat'");
  expect(() =>
    projectSourceRegistration(f.db, 'en-es', emptySchedulerState('UTC'), [{ item: f.item }], clock),
  ).toThrow(/countability/);
});
