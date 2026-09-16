import { expect, it } from 'vitest';
import { attemptCount, attemptLedgerOf, attemptsForSession, pendingAttempts } from './attempts.js';
import { applyEncounter, emptySchedulerState, introduce, registerRows, rowAt } from './engine.js';
import { asItemId, asSessionId, type Encounter } from './types.js';

const start = new Date('2026-09-13T08:00:00Z');
const later = new Date('2026-09-15T08:00:00Z');
const targets = ['gato', 'perro', 'ave', 'pez', 'oso'].map((surface, i): Encounter => ({
  sessionId: asSessionId('actual-grid'),
  exerciseIndex: 0,
  itemId: asItemId(`lex:${i}`),
  surface,
  targetSurfaceId: `sf:${i}`,
  role: 'recognition',
  grade: 3,
  at: later,
}));
function initial() {
  let state = registerRows(
    emptySchedulerState('UTC'),
    targets.map((e) => ({
      itemId: e.itemId,
      surface: e.surface,
      kind: 'lexeme' as const,
    })),
  );
  for (const e of targets) state = introduce(state, e.itemId, e.surface, start);
  return state;
}
it('[INV-SCH-03][INV-SESS-13] one grid answer updates five actual FSRS targets without five accuracy attempts', () => {
  let state = initial();
  for (const target of targets) {
    const result = applyEncounter(state, target);
    expect(result.wroteAttempt).toBe(true);
    expect(result.review).not.toBeNull();
    state = result.state;
  }
  expect(attemptCount(state.attempts)).toBe(1);
  expect(attemptsForSession(state.attempts, targets[0]!.sessionId)).toHaveLength(1);
  expect(state.attempts.targetRows.size).toBe(5);
  for (const target of targets)
    expect(rowAt(state, target.itemId, target.surface)?.card.reps).toBe(1);
  const saved = state;
  for (const target of [...targets].reverse()) {
    const replay = applyEncounter(state, { ...target, grade: 1, at: new Date('2026-10-01') });
    expect(replay.state).toBe(saved);
    expect(replay.wroteAttempt).toBe(false);
  }
});
it('[INV-SCH-03] persisted targets reconstruct per-target idempotency while pending siblings remain writable', () => {
  let state = applyEncounter(initial(), targets[0]!).state;
  state = { ...state, attempts: attemptLedgerOf(state.attempts.targetRows.values()) };
  const rows = targets.map((e) => ({ ...e, reviewKind: 'scheduled' as const }));
  expect(pendingAttempts(state.attempts, [...rows, ...rows])).toEqual(rows.slice(1));
  expect(applyEncounter(state, targets[0]!).state).toBe(state);
  for (const target of targets.slice(1)) state = applyEncounter(state, target).state;
  expect(state.attempts.targetRows.size).toBe(5);
  expect(attemptCount(state.attempts)).toBe(1);
});
it('[INV-SCH-03] target identity includes semantic item and exact surface, not only the parent answer', () => {
  const a = targets[0]!;
  const otherSurface = { ...a, surface: 'gata', targetSurfaceId: 'sf:gata' };
  let state = registerRows(initial(), [{ itemId: a.itemId, surface: 'gata', kind: 'lexeme' }]);
  state = introduce(state, a.itemId, 'gata', start);
  for (const e of [a, otherSurface, { ...targets[1]!, targetSurfaceId: a.targetSurfaceId! }]) {
    state = applyEncounter(state, e).state;
  }
  expect(state.attempts.targetRows.size).toBe(3);
  expect(attemptCount(state.attempts)).toBe(1);
  expect(rowAt(state, a.itemId, 'gata')?.card.reps).toBe(1);
  expect(applyEncounter(state, { ...a, exerciseIndex: -1 }).wroteAttempt).toBe(true);
  expect(applyEncounter(state, { ...a, sessionId: asSessionId('fresh-grid') }).wroteAttempt).toBe(
    true,
  );
});
it('[INV-SCH-03] legacy parent evidence cannot be replayed through an explicit target to mint credit', () => {
  const { targetSurfaceId: _id, ...legacy } = targets[0]!;
  const old = applyEncounter(initial(), legacy).state;
  expect(applyEncounter(old, targets[0]!).state).toBe(old);
  expect(applyEncounter(old, targets[1]!).state).toBe(old);
  const modern = applyEncounter(initial(), targets[0]!).state;
  expect(
    applyEncounter(modern, { ...legacy, itemId: targets[1]!.itemId, surface: targets[1]!.surface })
      .state,
  ).toBe(modern);
  expect(attemptCount(modern.attempts)).toBe(1);
});
it('[INV-SCH-03] an explicit target cannot use a missing or blank surface identity', () => {
  for (const targetSurfaceId of ['', '   '])
    expect(() => applyEncounter(initial(), { ...targets[0]!, targetSurfaceId })).toThrow();
});
