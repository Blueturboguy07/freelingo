/**
 * The progress bar — S031.
 *
 * Owns INV-COM-06, INV-COM-10, and the "reserved final segment consumed exactly once"
 * half of INV-SESS-18.
 *
 * The denominator is the MAIN QUEUE LENGTH FIXED AT SESSION START and immutable for the
 * session's life. A 12-exercise lesson with 2 mistakes has 16 answerable items and a
 * denominator of 12: the bar visibly stalls during the drain, never rewinds and never
 * re-scales, because a shrinking segment reads as the app losing progress (EC-COM-07).
 */
import type { Answer } from './types.js';

export interface ProgressState {
  /** Fixed at session start. Never written again. */
  readonly denominator: number;
  readonly numerator: number;
  /** True once the reserved last segment has been consumed — exactly once, at complete. */
  readonly finalSegmentConsumed: boolean;
}

export function initialProgress(mainQueueLength: number): ProgressState {
  if (!Number.isInteger(mainQueueLength) || mainQueueLength < 0) {
    throw new RangeError(
      `progress denominator must be a non-negative integer, got ${mainQueueLength}`,
    );
  }
  return { denominator: mainQueueLength, numerator: 0, finalSegmentConsumed: false };
}

/**
 * The numerator after one answer.
 *
 * - advances ONLY on correct answers (`deep/01` §Rules; a soft-correct is a correct
 *   answer with a note);
 * - a wrong answer neither advances nor rewinds;
 * - a modality SKIP consumes no segment and the replacement occupies it, so the bar is
 *   unchanged and the denominator never moves (INV-COM-10);
 * - a mistake-queue replay consumes NO segment (EC-COM-07) except the reserved last one,
 *   which `consumeFinalSegment` does.
 *
 * The cap is `denominator - 1` while any mistake is outstanding: the reserve renders as a
 * static gap, never as repeated micro-advances.
 */
export function advanceProgress(
  state: ProgressState,
  answer: Answer,
  mistakesOutstanding: number,
): ProgressState {
  if (answer.queue === 'mistakes') return state;
  if (answer.skipped) return state;
  const advances =
    answer.verdict === 'correct' ||
    answer.verdict === 'softCorrect' ||
    answer.verdict === 'accepted';
  if (!advances) return state;
  // The reserve exists only while a replay is outstanding. With no mistakes the last
  // correct answer fills the bar, and `consumeFinalSegment` is then a no-op advance that
  // still records the flag (INV-SESS-18: exactly once).
  const reserve = mistakesOutstanding > 0 ? 1 : 0;
  const cap = Math.max(0, state.denominator - reserve);
  return { ...state, numerator: Math.min(state.numerator + 1, cap) };
}

/**
 * Consume the reserved final segment. Idempotent by construction — the flag makes
 * "exactly once" checkable rather than a matter of who called what (INV-SESS-18).
 */
export function consumeFinalSegment(state: ProgressState): ProgressState {
  if (state.finalSegmentConsumed) return state;
  return { ...state, numerator: state.denominator, finalSegmentConsumed: true };
}

/** What S031 renders. `fraction` is never > 1 and never decreases across a session. */
export function progressFraction(state: ProgressState): number {
  if (state.denominator === 0) return 0;
  return Math.min(1, state.numerator / state.denominator);
}

/**
 * INV-COM-10: "the progress numerator equals correct answers". Recomputed from the
 * answer list so the incremental path above can be checked against a definition rather
 * than against itself.
 */
export function numeratorFromAnswers(answers: readonly Answer[]): number {
  return answers.filter(
    (a) =>
      a.queue === 'main' &&
      !a.skipped &&
      (a.verdict === 'correct' || a.verdict === 'softCorrect' || a.verdict === 'accepted'),
  ).length;
}
