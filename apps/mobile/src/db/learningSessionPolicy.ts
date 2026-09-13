import {
  DEFAULT_FLAVOUR_MATRIX,
  isGradedAttempt,
  type QueuedItem,
  type SessionState,
  type SessionFlavourConfig,
} from '@freelingo/core/session';
import { roleOfExerciseType } from '@freelingo/core/scheduler';
/** Freelingo application heuristic, approved 2026-09-13; no measured Duolingo
 * numeric trigger exists in deep/01 S13–S14. Core owns one-shot/collision behavior. */
export const LEARNING_STEP_UP_POLICY = { consecutiveMainSuccesses: 5 } as const;
export function shouldStepUp(
  state: SessionState,
  eligible: (item: QueuedItem) => boolean,
  config: SessionFlavourConfig = DEFAULT_FLAVOUR_MATRIX[state.flavour],
): boolean {
  const kind = config.stepUp;
  if (
    kind === null ||
    state.stepUpFired ||
    state.currentReplay !== null ||
    state.core.answers.at(-1)?.queue !== 'main'
  )
    return false;
  const last = state.core.answers
    .filter((a) => a.queue === 'main')
    .slice(-LEARNING_STEP_UP_POLICY.consecutiveMainSuccesses);
  if (
    last.length < LEARNING_STEP_UP_POLICY.consecutiveMainSuccesses ||
    last.some((a) => !isGradedAttempt(a) || a.wrong || a.skipped)
  )
    return false;
  return state.core.queue
    .slice(state.core.index + 1)
    .some(
      (q) =>
        eligible(q) &&
        (kind === 'production' ? roleOfExerciseType(q.type) === 'production' : q.requiresAudio),
    );
}
