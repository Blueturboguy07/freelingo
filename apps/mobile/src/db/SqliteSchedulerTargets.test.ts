// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { migrate, type Db } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import {
  applyEncounter,
  asItemId,
  asSessionId,
  attemptCount,
  emptySchedulerState,
  introduce,
  registerRows,
} from '@freelingo/core/scheduler';
import {
  SqliteSchedulerStore,
  type SchedulerAnswerEvidence,
  type SchedulerTargetEvidence,
} from './SqliteSchedulerStore';
const opened: Db[] = [];
afterEach(() => {
  for (const db of opened) db.close();
  opened.length = 0;
});
const at = Date.parse('2026-09-13T12:00:00Z');
function setup() {
  const db = createNodeDb();
  opened.push(db);
  migrate(db);
  db.run("INSERT INTO course_progress(course_id,added_at) VALUES('en-es','2026-09-13')");
  const targets: SchedulerTargetEvidence[] = ['gato', 'perro', 'ave', 'pez', 'oso'].map(
    (surface, i) => ({
      itemId: 'lex:' + i,
      surfaceId: 'sf:' + i,
      surface,
      role: 'recognition',
      rubyShown: false,
      grade: 3,
    }),
  );
  for (const item of ['grid', ...targets.map((t) => t.itemId)])
    db.run('INSERT INTO course_item(course_id,item_id,countable) VALUES(?,?,1)', ['en-es', item]);
  let state = registerRows(
    emptySchedulerState('UTC'),
    targets.map((t) => ({
      itemId: asItemId(t.itemId),
      surface: t.surface,
      kind: 'lexeme' as const,
    })),
  );
  for (const t of targets)
    state = introduce(state, asItemId(t.itemId), t.surface, new Date(at - 86400000));
  for (const t of targets)
    state = applyEncounter(state, {
      sessionId: asSessionId('s'),
      exerciseIndex: 0,
      itemId: asItemId(t.itemId),
      surface: t.surface,
      targetSurfaceId: t.surfaceId,
      role: t.role,
      grade: t.grade,
      at: new Date(at),
    }).state;
  const evidence: SchedulerAnswerEvidence = {
    sessionId: 's',
    exerciseId: 'exact-grid',
    packContentHash: 'a'.repeat(64),
    surface: 'gato',
    role: 'recognition',
    rubyShown: false,
    answeredAtUtc: new Date(at).toISOString(),
    activeMs: 1234,
    targets,
    answer: {
      exerciseIndex: 0,
      slotId: 'slot',
      itemId: 'grid',
      type: 'matchPairs',
      verdict: 'correct',
      softCorrected: false,
      wrong: false,
      costPaid: 0,
      skipped: false,
      scorable: true,
      queue: 'main',
      note: null,
    },
  };
  return { db, state, evidence, targets, store: new SqliteSchedulerStore(db) };
}
it('[INV-SCH-03][INV-SESS-13] real SQLite stores one grid attempt and reloads all five target ledgers before replay', () => {
  const { db, state, evidence, targets, store } = setup();
  store.save('en-es', state, [evidence]);
  expect(db.all('SELECT * FROM course_attempt')).toHaveLength(1);
  expect(db.get('SELECT item_id,scheduler_grade FROM course_attempt')).toEqual({
    item_id: 'grid',
    scheduler_grade: null,
  });
  expect(db.all('SELECT * FROM course_attempt_target ORDER BY position')).toHaveLength(5);
  let loaded = new SqliteSchedulerStore(db).load('en-es', 'UTC');
  expect(attemptCount(loaded.attempts)).toBe(1);
  expect([...loaded.attempts.targetRows]).toEqual([...state.attempts.targetRows]);
  for (const t of targets) {
    const result = applyEncounter(loaded, {
      sessionId: asSessionId('s'),
      exerciseIndex: 0,
      itemId: asItemId(t.itemId),
      surface: t.surface,
      targetSurfaceId: t.surfaceId,
      role: t.role,
      grade: 1,
      at: new Date(at + 86400000),
    });
    expect(result.state).toBe(loaded);
    loaded = result.state;
  }
  store.save('en-es', loaded, [evidence]);
  expect(db.all('SELECT * FROM course_attempt_target')).toHaveLength(5);
});
it('[INV-SCH-03] an already frozen answer cannot gain a new alternate target on completion retry', () => {
  const { db, state, evidence, store } = setup();
  store.save('en-es', state, [evidence]);
  const changed = {
    ...evidence,
    targets: evidence.targets!.map((t, i) =>
      i === 0 ? { ...t, surfaceId: 'sf:other', surface: 'gata' } : t,
    ),
  };
  expect(() => store.save('en-es', state, [changed])).toThrow(/target/);
  const extra = applyEncounter(state, {
    sessionId: asSessionId('s'),
    exerciseIndex: 0,
    itemId: asItemId('lex:0'),
    surface: 'gata',
    targetSurfaceId: 'sf:other',
    role: 'recognition',
    grade: 3,
    at: new Date(at),
  }).state;
  expect(() =>
    store.save('en-es', extra, [
      {
        ...evidence,
        targets: [
          ...evidence.targets!,
          {
            itemId: 'lex:0',
            surface: 'gata',
            surfaceId: 'sf:other',
            role: 'recognition',
            rubyShown: false,
            grade: 3,
          },
        ],
      },
    ]),
  ).toThrow(/target/);
  expect(db.all('SELECT * FROM course_attempt_target')).toHaveLength(5);
});
it('[INV-SCH-03] incomplete, reordered or mismatched target evidence rejects the entire scheduler transaction', () => {
  for (const mutate of [
    (e: SchedulerAnswerEvidence) => ({ ...e, targets: e.targets!.slice(1) }),
    (e: SchedulerAnswerEvidence) => ({ ...e, targets: [...e.targets!].reverse() }),
    (e: SchedulerAnswerEvidence) => ({
      ...e,
      targets: e.targets!.map((t, i) => (i === 0 ? { ...t, grade: 1 as const } : t)),
    }),
  ]) {
    const { db, state, evidence, store } = setup();
    expect(() => store.save('en-es', state, [mutate(evidence)])).toThrow(/target/);
    expect(db.all('SELECT * FROM course_attempt')).toEqual([]);
    expect(db.all('SELECT * FROM course_item_surface')).toEqual([]);
  }
});
it('[INV-SCH-03] a child insertion failure rolls back parent answer and every FSRS change', () => {
  const { db, state, evidence, store } = setup();
  db.run(
    "CREATE TRIGGER kill_target BEFORE INSERT ON course_attempt_target WHEN NEW.position=3 BEGIN SELECT RAISE(ABORT,'kill fourth target');END",
  );
  expect(() => store.save('en-es', state, [evidence])).toThrow('kill fourth target');
  expect(db.all('SELECT * FROM course_attempt')).toEqual([]);
  expect(db.all('SELECT * FROM course_attempt_target')).toEqual([]);
  expect(db.all('SELECT * FROM course_item_surface')).toEqual([]);
});
it('[INV-SCH-03] loaded gapped target positions preserve bytes and require recovery', () => {
  const { db, state, evidence, store } = setup();
  store.save('en-es', state, [evidence]);
  db.run('DROP TRIGGER course_attempt_target_append_only_update');
  db.run('UPDATE course_attempt_target SET position=8 WHERE position=4');
  const bytes = db.all('SELECT * FROM course_attempt_target');
  expect(() => store.load('en-es', 'UTC')).toThrow(/position/);
  expect(db.all('SELECT * FROM course_attempt_target')).toEqual(bytes);
});
it('[INV-SCH-03] loaded child time or mixed legacy scheduler proof cannot silently override parent evidence', () => {
  for (const corrupt of [
    'UPDATE course_attempt_target SET answered_at_utc_ms=1 WHERE position=0',
    "UPDATE course_attempt SET surface='x',scheduler_grade=3,encounter_role='recognition',scheduler_review_kind='scheduled',ruby_shown=0",
  ]) {
    const { db, state, evidence, store } = setup();
    store.save('en-es', state, [evidence]);
    db.run('DROP TRIGGER course_attempt_target_append_only_update');
    for (const trigger of db.all(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='course_attempt'",
    ))
      db.run('DROP TRIGGER ' + String(trigger.name));
    db.run(corrupt);
    expect(() => store.load('en-es', 'UTC')).toThrow();
  }
});
it('[INV-SCH-03] existing target parents require complete supplied proof even on a no-op retry', () => {
  const { store, state, evidence } = setup();
  store.save('en-es', state, [evidence]);
  const { targets: _targets, ...missing } = evidence;
  expect(() => store.save('en-es', state, [{ ...missing, exerciseId: 'forged' }])).toThrow(
    /target/,
  );
});
it('[INV-SCH-03] every persisted parent Answer field is immutable when target completion is retried', () => {
  for (const delta of [
    { queue: 'mistakes' as const },
    { softCorrected: true },
    { costPaid: 2 },
    { skipped: true },
    { scorable: false },
    { note: 'changed' },
    { wrong: true },
  ]) {
    const { store, state, evidence } = setup();
    store.save('en-es', state, [evidence]);
    expect(() =>
      store.save('en-es', state, [{ ...evidence, answer: { ...evidence.answer, ...delta } }]),
    ).toThrow(/target/);
  }
});
