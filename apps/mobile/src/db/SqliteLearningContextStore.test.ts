// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, type Db } from '@freelingo/schema';
import { toLocalDay } from '@freelingo/core/day';
import {
  freshSession,
  item,
  step,
  DEFAULT_FLAVOUR_MATRIX,
  type StepDeps,
  type SessionState,
} from '@freelingo/core/session';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import {
  SqliteLearningContextStore,
  type LearningLaunch,
  type LessonSlotBinding,
  type AnswerReceipt,
  type CompletionIntent,
} from './SqliteLearningContextStore';
const dbs: Db[] = [],
  dirs: string[] = [];
afterEach(() => {
  for (const db of dbs) db.close();
  dbs.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
const course = 'en-es',
  epoch = Date.parse('2026-09-13T12:00:00Z');
const zone = { tzId: 'America/Chicago', utcOffsetMinutes: -300, tzSource: 'iana' } as const;
const launch: LearningLaunch = {
  courseId: course,
  sessionKind: 'graded',
  nodeRef: 'node-1',
  start: {
    sessionId: 'session-1',
    startedAtUtcMs: epoch,
    startedAtMonotonicMs: 1000,
    startZone: zone,
  },
  economyFlavour: 'hubWords',
  practiceItemRatio: 0.3,
  longFormEntry: null,
  boostAtStart: {
    kind: 'xpBoost',
    multiplier: 2,
    startedAtUtc: '2026-09-13T11:59:00Z',
    expiresAtUtc: '2026-09-13T12:01:00Z',
  },
  packContentHash: 'verified-sha',
  origin: { kind: 'hub', offerId: 'words-1', localDay: toLocalDay('2026-09-13') },
  targetNodeId: null,
};
const slot: LessonSlotBinding = {
  slotId: 'slot-1',
  exerciseId: 'exercise-exact-1',
  itemId: 'semantic-1',
  surface: 'el niño',
  role: 'recognition',
  rubyShown: false,
};
function receipt(index = 0): AnswerReceipt {
  return {
    exerciseIndex: index,
    slotId: slot.slotId,
    itemId: slot.itemId,
    exerciseId: slot.exerciseId,
    surface: slot.surface,
    role: slot.role,
    rubyShown: false,
    answeredAtUtcMs: epoch + 60000,
    answeredLocalDay: toLocalDay('2026-09-13'),
    activeMs: 5000,
  };
}
const intent: CompletionIntent = {
  completedAtUtcMs: epoch + 120000,
  completedAtMonotonicMs: 121000,
  completionZone: zone,
  outcome: 'completed',
  intendedAtUtc: '2026-09-13T12:02:00Z',
};
function open(path = ':memory:') {
  const db = createNodeDb({ location: path });
  dbs.push(db);
  migrate(db);
  return db;
}
function seed(db: Db) {
  db.run('INSERT INTO course_progress(course_id,added_at) VALUES(?,?)', [
    course,
    new Date(epoch).toISOString(),
  ]);
}
function setup() {
  const db = open();
  seed(db);
  const store = new SqliteLearningContextStore(db);
  store.create(launch, [slot]);
  return { db, store };
}
it('[INV-SESS-01] restores exact launch clocks, captured boost, economy mode and source variant after close/reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'freelingo-context-'));
  dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const db = open(path);
  seed(db);
  const s = new SqliteLearningContextStore(db);
  s.create(launch, [slot]);
  s.addActiveMs(course, 'session-1', 1234);
  const expected = s.load(course, 'session-1');
  db.close();
  dbs.splice(dbs.indexOf(db), 1);
  expect(new SqliteLearningContextStore(open(path)).load(course, 'session-1')).toEqual(expected);
  expect(expected).toMatchObject({
    launch,
    slots: [slot],
    activeMs: 1234,
    completion: null,
    startedLocalDay: '2026-09-13',
  });
});
it('[INV-SESS-01] identical creation retries preserve data and changed pack or slot bindings reject', () => {
  const { store } = setup();
  store.create(launch, [slot]);
  expect(() => store.create({ ...launch, packContentHash: 'different' }, [slot])).toThrow(/launch/);
  expect(() => store.create(launch, [{ ...slot, exerciseId: 'different' }])).toThrow(/slot/);
  expect(store.load(course, 'session-1')?.slots).toEqual([slot]);
});
it('[INV-DAY-15] first completion intent survives retry clocks and freezes active time', () => {
  const { store } = setup();
  store.addActiveMs(course, 'session-1', 12000);
  store.freezeCompletion(course, 'session-1', intent);
  expect(
    store.freezeCompletion(course, 'session-1', { ...intent, completedAtUtcMs: epoch + 999999 }),
  ).toEqual(intent);
  expect(() => store.addActiveMs(course, 'session-1', 1)).toThrow(/completion/);
  expect(store.load(course, 'session-1')).toMatchObject({ completion: intent, activeMs: 12000 });
});
it('[INV-SESS-15] only an ungraded slot may replace its exact variant; receipts retain the originally graded source', () => {
  const { store } = setup();
  const next = { ...slot, exerciseId: 'text-fallback', surface: 'la niña' };
  store.replaceSlot(course, 'session-1', next);
  expect(() => store.recordReceipt(course, 'session-1', receipt())).toThrow(/binding/);
  const r = { ...receipt(), exerciseId: next.exerciseId, surface: next.surface };
  store.recordReceipt(course, 'session-1', r);
  expect(() => store.replaceSlot(course, 'session-1', slot)).toThrow(/graded/);
  expect(store.receipts(course, 'session-1')).toEqual([r]);
});
it('[INV-SESS-15] a modality replacement without a core transition cannot change the semantic item or invent a new slot', () => {
  const { store } = setup();
  expect(() => store.replaceSlot(course, 'session-1', { ...slot, itemId: 'other-item' })).toThrow(
    /item/,
  );
  expect(() => store.replaceSlot(course, 'session-1', { ...slot, slotId: 'missing' })).toThrow(
    /slot/,
  );
});
it('[INV-SESS-06] preserves negative replay indices and idempotent receipts while rejecting changed or gapped history', () => {
  const { db, store } = setup();
  store.recordReceipt(course, 'session-1', receipt(0));
  store.recordReceipt(course, 'session-1', receipt(-2));
  store.recordReceipt(course, 'session-1', receipt(-2));
  expect(store.receipts(course, 'session-1').map((r) => r.exerciseIndex)).toEqual([0, -2]);
  expect(() => store.recordReceipt(course, 'session-1', { ...receipt(-2), activeMs: 9 })).toThrow(
    /receipt/,
  );
  db.run('UPDATE course_session_answer_receipt SET receipt_sequence=7 WHERE exercise_index=-2');
  const before = db.all('SELECT * FROM course_session_answer_receipt');
  expect(() => store.receipts(course, 'session-1')).toThrow(/sequence/);
  expect(() => store.recordReceipt(course, 'session-1', receipt(1))).toThrow(/sequence/);
  expect(db.all('SELECT * FROM course_session_answer_receipt')).toEqual(before);
});
it('[INV-CER-01] failed containing checkpoint write rolls back exact answer receipts and completion intent', () => {
  const { db, store } = setup();
  const tx: Db = {
    run: db.run.bind(db),
    all: db.all.bind(db),
    get: db.get.bind(db),
    withExclusiveTransaction: (fn) => fn(),
    close: () => {
      throw Error('transaction view');
    },
  };
  expect(() =>
    db.withExclusiveTransaction(() => {
      const s = new SqliteLearningContextStore(tx);
      s.recordReceipt(course, 'session-1', receipt());
      s.freezeCompletion(course, 'session-1', intent);
      throw Error('checkpoint failed');
    }),
  ).toThrow('checkpoint failed');
  expect(store.receipts(course, 'session-1')).toEqual([]);
  expect(store.load(course, 'session-1')?.completion).toBeNull();
});
it('[INV-DAT-03] rejects wrong-course and removed-course writes without replacing context rows', () => {
  const { db, store } = setup();
  expect(() => store.recordReceipt('en-fr', 'session-1', receipt())).toThrow();
  db.run('DELETE FROM course_progress WHERE course_id=?', [course]);
  expect(() => store.create(launch, [slot])).toThrow();
  expect(db.all('SELECT * FROM course_session_context')).toEqual([]);
});
it('[INV-DAY-04] corrupt civil stamps and partial receipts remain recoverable instead of normalized on read', () => {
  const { db, store } = setup();
  db.run('DROP TRIGGER course_session_context_launch_immutable');
  db.run("UPDATE course_session_context SET started_local_day='2026-02-31'");
  expect(() => store.load(course, 'session-1')).toThrow();
  expect(db.get('SELECT started_local_day FROM course_session_context')?.started_local_day).toBe(
    '2026-02-31',
  );
});

const engineDeps: StepDeps = {
  config: DEFAULT_FLAVOUR_MATRIX.lesson,
  grading: { grade: () => ({ kind: 'wrong' }) },
  clock: { nowMs: () => 10 },
  isTypeEligible: () => true,
  stepUpTripped: () => false,
};
function engineStart(
  type: 'meaningSelect' | 'speakSentence' | 'matchPairs' = 'meaningSelect',
): SessionState {
  const state = freshSession({
    sessionId: launch.start.sessionId,
    courseId: course,
    nodeRef: launch.nodeRef,
    queue: [{ ...item(1, { type }), itemId: slot.itemId }],
    motivationalMessages: false,
  });
  return { ...state, shellState: 'challenge.idle' };
}
function throughGrade(state: SessionState, deps: StepDeps): SessionState {
  let s = step(
    state,
    { type: 'input', text: 'answer', caret: 6, partialState: {}, gradeable: true },
    deps,
  ).state;
  s = step(s, { type: 'check' }, deps).state;
  return step(s, { type: 'graded' }, deps).state;
}
function toReplay(state: SessionState, deps: StepDeps): SessionState {
  let s = state;
  for (let n = 0; n < 10 && s.currentReplay === null; n++)
    s = step(s, { type: 'continue' }, deps).state;
  expect(s.currentReplay).not.toBeNull();
  return s;
}
it('[INV-MOD-02] persists an actual main-queue modality replacement with a different same-concept item', () => {
  const { store } = setup();
  const before = engineStart('speakSentence');
  const deps: StepDeps = {
    ...engineDeps,
    modalityReplacement: (q) => ({
      ...q,
      itemId: 'replacement-item',
      type: 'meaningSelect',
      family: 'recognition',
      requiresAudio: false,
    }),
  };
  const after = step(
    before,
    {
      type: 'modalitySkip',
      eventId: 'skip',
      slotId: slot.slotId,
      itemId: slot.itemId,
      family: 'speaking',
    },
    deps,
  ).state;
  expect(after.core.queue[0]?.itemId).toBe('replacement-item');
  const replacement = {
    ...slot,
    itemId: after.core.queue[0]!.itemId,
    exerciseId: 'verified-replacement',
  };
  store.replaceSlot(course, 'session-1', replacement, { before, after });
  expect(store.load(course, 'session-1')?.slots).toEqual([replacement]);
  const graded = throughGrade(after, { ...deps, grading: { grade: () => ({ kind: 'correct' }) } });
  store.recordReceipt(course, 'session-1', {
    ...receipt(),
    itemId: graded.core.answers[0]!.itemId,
    exerciseId: replacement.exerciseId,
  });
  expect(store.receipts(course, 'session-1')[0]?.itemId).toBe('replacement-item');
});
it('[INV-MIS-07][INV-SESS-01] binds the actual newly minted replay slot before its signed-index grade checkpoint', () => {
  const { store } = setup();
  const main = throughGrade(engineStart(), engineDeps);
  store.recordReceipt(course, 'session-1', receipt(main.core.answers[0]!.exerciseIndex));
  const replay = toReplay(main, engineDeps),
    q = replay.currentReplay!.item;
  expect(q.id).not.toBe(slot.slotId);
  const bound = { ...slot, slotId: q.id, exerciseId: 'verified-replay-variant', itemId: q.itemId };
  store.addReplaySlot(replay, slot.slotId, bound);
  const graded = throughGrade(replay, {
      ...engineDeps,
      grading: { grade: () => ({ kind: 'correct' }) },
    }),
    answer = graded.core.answers.at(-1)!;
  expect(answer.exerciseIndex).toBeLessThan(0);
  store.recordReceipt(course, 'session-1', { ...receipt(answer.exerciseIndex), ...bound });
  expect(store.receipts(course, 'session-1').map((r) => r.slotId)).toEqual([slot.slotId, q.id]);
  expect(() =>
    store.addReplaySlot(replay, slot.slotId, { ...bound, slotId: 'invented-replay' }),
  ).toThrow();
});
it('[INV-GRD-07] the actual failed grid replay binds only its verified first-wrong left item', () => {
  const { store } = setup();
  const pairs = Array.from({ length: 5 }, (_, i) => ({
    leftId: 'l' + i,
    rightId: 'r' + i,
    leftItemId: 'lexeme' + i,
  }));
  const deps = { ...engineDeps, matchPairs: () => pairs };
  let state = step(
    engineStart('matchPairs'),
    { type: 'matchPair', attemptId: 'wrong', leftId: 'l3', rightId: 'r1' },
    deps,
  ).state;
  for (let i = 0; i < 5; i++)
    state = step(
      state,
      { type: 'matchPair', attemptId: 'correct' + i, leftId: 'l' + i, rightId: 'r' + i },
      deps,
    ).state;
  store.recordReceipt(course, 'session-1', receipt(state.core.answers[0]!.exerciseIndex));
  const replay = toReplay(state, deps),
    q = replay.currentReplay!.item;
  expect(q.itemId).toBe('lexeme3');
  const bound = { ...slot, slotId: q.id, itemId: q.itemId, exerciseId: 'verified-left-replay' };
  expect(() => store.addReplaySlot(replay, slot.slotId, bound, [])).toThrow(/pair|source/);
  store.addReplaySlot(
    replay,
    slot.slotId,
    bound,
    pairs.map((p) => p.leftItemId),
  );
  expect(store.load(course, 'session-1')?.slots.some((s) => s.itemId === 'lexeme3')).toBe(true);
});
