import {
  DEFAULT_FLAVOUR_MATRIX,
  isGradedAttempt,
  type SessionState,
} from '@freelingo/core/session';
import type { LearningClock } from './learningRuntimePorts';
import type {
  AnswerReceipt,
  CompletionIntent,
  LearningContext,
} from './SqliteLearningContextStore';
import { LearningDataError } from './SqliteSchedulerStore';

/** The failed clock is the actual allowance-exhausting grade, not a later button tap.
 * Subsequent UI navigation may change the shell but can never change this receipt.
 */
export function completionIntentFor(
  prior: SessionState,
  state: SessionState,
  context: LearningContext,
  receipts: readonly AnswerReceipt[],
  clock: LearningClock,
): CompletionIntent | null {
  if (
    context.launch.start.sessionId !== state.sessionId ||
    context.launch.courseId !== state.courseId ||
    context.launch.economyFlavour !== state.flavour
  )
    throw new LearningDataError('Completion context changed.');
  const exhausted = state.core.hearts.kind === 'pips' && state.core.hearts.remaining === 0;
  const failed = context.completion?.outcome === 'failed' || state.shellState === 'outOfHearts';
  if (failed) {
    const allowance = DEFAULT_FLAVOUR_MATRIX[state.flavour].mistakeAllowance,
      last = state.core.answers.at(-1);
    if (
      !exhausted ||
      allowance === null ||
      state.core.hearts.kind !== 'pips' ||
      state.core.hearts.total !== allowance ||
      !last ||
      !isGradedAttempt(last) ||
      !last.wrong
    )
      throw new LearningDataError('Failed allowance has no actual terminal grade.');
    let cost = 0;
    if (receipts.length !== state.core.answers.length)
      throw new LearningDataError('Failure receipt history is incomplete.');
    state.core.answers.forEach((answer, index) => {
      const receipt = receipts[index],
        slot = context.slots.find((s) => s.slotId === answer.slotId);
      if (
        !receipt ||
        !slot ||
        receipt.exerciseIndex !== answer.exerciseIndex ||
        receipt.slotId !== answer.slotId ||
        receipt.itemId !== answer.itemId ||
        slot.itemId !== answer.itemId ||
        receipt.exerciseId !== slot.exerciseId ||
        receipt.surface !== slot.surface ||
        receipt.role !== slot.role ||
        receipt.rubyShown !== slot.rubyShown ||
        !Number.isSafeInteger(answer.costPaid) ||
        answer.costPaid < 0
      )
        throw new LearningDataError('Failure grade/source receipt changed.');
      cost += answer.costPaid;
    });
    if (cost !== allowance)
      throw new LearningDataError('Failed allowance costs do not match real receipts.');
    if (
      context.completion === null &&
      (prior.shellState === 'outOfHearts' ||
        state.core.answers.length !== prior.core.answers.length + 1)
    )
      throw new LearningDataError('Missing original failure clock intent.');
  }
  if (context.completion !== null) {
    if (
      context.completion.outcome === 'failed' &&
      state.core.answers.length !== prior.core.answers.length
    )
      throw new LearningDataError('A frozen failure cannot accept another grade.');
    return context.completion;
  }
  if (!failed && state.exited === null) return null;
  return {
    completedAtUtcMs: clock.utcMs,
    completedAtMonotonicMs: clock.monotonicMs,
    completionZone: clock.zone,
    outcome: failed ? 'failed' : state.exited === 'quit' ? 'quit' : 'completed',
    intendedAtUtc: new Date(clock.utcMs).toISOString(),
  };
}
