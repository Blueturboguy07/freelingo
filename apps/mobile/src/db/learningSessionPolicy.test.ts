import { expect, it } from 'vitest';
import {
  freshSession,
  items,
  DEFAULT_FLAVOUR_MATRIX,
  step,
  type SessionState,
  type Answer,
} from '@freelingo/core/session';
import { shouldStepUp } from './learningSessionPolicy';
function state(): SessionState {
  const queue = items(7, { type: 'typedTranslate' });
  const answers: Answer[] = queue.slice(0, 5).map((q, i) => ({
    exerciseIndex: i,
    slotId: q.id,
    itemId: q.itemId,
    type: q.type,
    verdict: 'correct',
    softCorrected: false,
    wrong: false,
    costPaid: 0,
    skipped: false,
    scorable: true,
    queue: 'main',
    note: null,
  }));
  const base = freshSession({ queue });
  return {
    ...base,
    shellState: 'banner.correct',
    core: { ...base.core, index: 4, answers, combo: 5 },
  };
}
it('[INV-COM-12] a named five-success policy requires a real eligible remaining production source', () => {
  const s = state();
  expect(shouldStepUp(s, () => true)).toBe(true);
  expect(shouldStepUp(s, () => false)).toBe(false);
  expect(
    shouldStepUp({ ...s, core: { ...s.core, answers: s.core.answers.slice(0, 4) } }, () => true),
  ).toBe(false);
  expect(shouldStepUp({ ...s, core: { ...s.core, index: 6 } }, () => true)).toBe(false);
});
it('[INV-COM-12] wrong, skipped and replay answers cannot trigger the main-queue escalation', () => {
  const s = state();
  for (const change of [
    { wrong: true, verdict: 'wrong' as const },
    { skipped: true, verdict: 'noVerdict' as const },
    { queue: 'mistakes' as const },
  ]) {
    const answers = s.core.answers.map((a, i) => (i === 4 ? { ...a, ...change } : a));
    expect(shouldStepUp({ ...s, core: { ...s.core, answers } }, () => true)).toBe(false);
  }
  expect(shouldStepUp({ ...s, flavour: 'placement' }, () => true)).toBe(false);
});
it('[INV-COM-12][INV-COM-09] actual core routing queues combo then the one supported step-up', () => {
  const s = state();
  const result = step(
    s,
    { type: 'continue' },
    {
      config: DEFAULT_FLAVOUR_MATRIX.lesson,
      clock: { nowMs: () => 100 },
      isTypeEligible: () => true,
      grading: {
        grade: () => {
          throw Error('not grading');
        },
      },
      stepUpTripped: (v) => shouldStepUp(v, () => true),
    },
  );
  expect(result.state.pendingInterstitialKeys).toEqual(['combo.5_in_a_row', 'stepup:production']);
  expect(result.state.stepUpFired).toBe(true);
  expect(result.state.core.hardMode).toBe(true);
});
