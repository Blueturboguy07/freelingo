// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { migrate, type Db } from '@freelingo/schema';
import { runCeremony } from '@freelingo/core/ceremony';
import { ceremonyState } from '../../../../packages/core/src/ceremony/__falsifiers__/fixtures';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import type { CeremonyReceipt } from './ceremonyCodec';
import { SqliteCeremonyStore } from './SqliteCeremonyStore';
const dbs: Db[] = [];
afterEach(() => {
  for (const d of dbs) d.close();
  dbs.length = 0;
});
const utc = '2026-09-13T18:00:00Z';
function setup() {
  const db = createNodeDb({ location: ':memory:' });
  dbs.push(db);
  migrate(db);
  db.run('INSERT INTO course_progress(course_id,added_at) VALUES(?,?)', ['es', utc]);
  return { db, store: new SqliteCeremonyStore(db, () => utc) };
}
function receipt(): CeremonyReceipt {
  const state = ceremonyState(
    { streakGoal: { goal: null, presentations: 0, lastPicked: null } },
    { courseId: 'es' },
    { sessionId: 's1', xp: 13 },
  );
  return {
    schemaVersion: 1,
    state,
    result: runCeremony(state),
    facts: {
      courseName: 'Spanish',
      combo: 3,
      accuracy: 1,
      xpExplanation: '',
      unitIndex: 1,
      unitName: 'Basics',
      sectionName: 'A1',
      score: 1,
    },
  };
}
function commit(db: Db, r = receipt()) {
  db.run(
    'INSERT INTO committed_session(session_id,committed_at,xp_awarded,gems_awarded) VALUES(?,?,?,?)',
    [r.state.session.sessionId, utc, r.result.committed!.xp, r.result.committed!.gems],
  );
  db.run(
    'INSERT INTO course_session_commit_link(session_id,course_id,economy_flavour) VALUES(?,?,?)',
    [r.state.session.sessionId, r.state.course.courseId, 'lesson'],
  );
}
it('[INV-CER-01] stores only a receipt joined to an actual committed session and course', () => {
  const { db, store } = setup(),
    r = receipt();
  expect(() => store.insert(r)).toThrow();
  commit(db, r);
  store.insert(r);
  expect(store.load('s1')?.receipt).toEqual(r);
  expect(() => store.insert({ ...r, facts: { ...r.facts, score: 2 } })).toThrow(/immutable/i);
});
it('[INV-CER-02] resumes a saved cursor without reevaluating the frozen predicates or paying rewards', () => {
  const { db, store } = setup(),
    r = receipt();
  commit(db, r);
  store.insert(r);
  store.advance({ sessionId: 's1', expectedIndex: 0, nextIndex: 1, goalChoice: null });
  const fresh = new SqliteCeremonyStore(db, () => utc);
  expect(fresh.pending()?.index).toBe(1);
  expect(fresh.load('s1')?.receipt.result.predicateEvaluations).toEqual(
    r.result.predicateEvaluations,
  );
  expect(db.get('SELECT COUNT(*) AS n FROM committed_session')?.n).toBe(1);
});
it('[INV-CER-13] cannot skip a one-time screen or return-to-path but may collapse repeated screens', () => {
  const { db, store } = setup(),
    r = receipt();
  commit(db, r);
  store.insert(r);
  const picker = r.result.chain.indexOf('S072_streakGoalPicker');
  expect(picker).toBeGreaterThan(0);
  expect(() =>
    store.advance({ sessionId: 's1', expectedIndex: 0, nextIndex: picker + 1, goalChoice: null }),
  ).toThrow(/one-time/i);
  store.advance({ sessionId: 's1', expectedIndex: 0, nextIndex: picker, goalChoice: null });
  expect(store.load('s1')?.index).toBe(picker);
});
it('[INV-CER-14] goal defer and cursor CAS commit together exactly once', () => {
  const { db, store } = setup(),
    r = receipt();
  commit(db, r);
  store.insert(r);
  const index = r.result.chain.indexOf('S072_streakGoalPicker');
  db.run('UPDATE course_ceremony SET cursor=? WHERE session_id=?', [index, 's1']);
  const request = {
    sessionId: 's1',
    expectedIndex: index,
    nextIndex: index + 1,
    goalChoice: { kind: 'defer' } as const,
  };
  expect(store.advance(request)).toBe(true);
  expect(store.advance(request)).toBe(false);
  expect(db.get('SELECT streak_goal_presentations FROM account')?.streak_goal_presentations).toBe(
    1,
  );
});
it('[INV-CER-14] picker accepts only declared goals and no fabricated choice on another screen', () => {
  const { db, store } = setup(),
    r = receipt();
  commit(db, r);
  store.insert(r);
  expect(() =>
    store.advance({
      sessionId: 's1',
      expectedIndex: 0,
      nextIndex: 1,
      goalChoice: { kind: 'choose', days: 7 },
    }),
  ).toThrow(/picker/i);
  const index = r.result.chain.indexOf('S072_streakGoalPicker');
  db.run('UPDATE course_ceremony SET cursor=?', [index]);
  expect(() =>
    store.advance({
      sessionId: 's1',
      expectedIndex: index,
      nextIndex: index + 1,
      goalChoice: { kind: 'choose', days: 8 },
    }),
  ).toThrow(/goal/i);
  store.advance({
    sessionId: 's1',
    expectedIndex: index,
    nextIndex: index + 1,
    goalChoice: { kind: 'choose', days: 14 },
  });
  expect(
    db.get(
      'SELECT streak_goal_value,streak_goal_last_picked,streak_goal_presentations FROM account',
    ),
  ).toEqual({ streak_goal_value: 14, streak_goal_last_picked: 14, streak_goal_presentations: 0 });
});
it('[INV-CER-01] a failed cursor write rolls back its goal choice while preserving frozen presentation', () => {
  const { db, store } = setup(),
    r = receipt();
  commit(db, r);
  store.insert(r);
  const index = r.result.chain.indexOf('S072_streakGoalPicker');
  db.run('UPDATE course_ceremony SET cursor=?', [index]);
  db.run(
    "CREATE TRIGGER reject_advance BEFORE UPDATE ON course_ceremony BEGIN SELECT RAISE(ABORT,'injected'); END",
  );
  expect(() =>
    store.advance({
      sessionId: 's1',
      expectedIndex: index,
      nextIndex: index + 1,
      goalChoice: { kind: 'choose', days: 14 },
    }),
  ).toThrow(/injected/);
  expect(db.get('SELECT streak_goal_value,streak_goal_presentations FROM account')).toEqual({
    streak_goal_value: null,
    streak_goal_presentations: 0,
  });
  expect(store.load('s1')?.index).toBe(index);
});
it('[INV-CER-02] multiple pending receipts fail without deleting evidence', () => {
  const { db, store } = setup(),
    r = receipt();
  commit(db, r);
  store.insert(r);
  const second = { ...r, state: { ...r.state, session: { ...r.state.session, sessionId: 's2' } } };
  const s = { ...second, result: runCeremony(second.state) };
  commit(db, s);
  store.insert(s);
  expect(() => store.pending()).toThrow(/pending/i);
  expect(db.get('SELECT COUNT(*) AS n FROM course_ceremony')?.n).toBe(2);
});
it('[INV-CER-02] completion marks the final cursor and repeated callback cannot change the finish time', () => {
  const { db, store } = setup(),
    r = receipt();
  commit(db, r);
  store.insert(r);
  const index = r.result.chain.length - 1;
  db.run('UPDATE course_ceremony SET cursor=?', [index]);
  const req = { sessionId: 's1', expectedIndex: index, nextIndex: index + 1, goalChoice: null };
  expect(store.advance(req)).toBe(true);
  expect(store.pending()).toBeNull();
  expect(store.advance(req)).toBe(false);
  expect(store.load('s1')?.finishedAtUtc).toBe(utc);
});
