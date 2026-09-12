/**
 * The accuracy denominator (INV-GRD-06) — the load-bearing one.
 *
 * > "`accuracy = correctFirstTry / scorable`, where `scorable` excludes skipped
 * > speaking/listening items, failed speak attempts, character traces and
 * > read/listen-and-respond. If `scorable = 0`, accuracy is **undefined** and the tile is
 * > omitted (single-tile layout) — never rendered as 0%."
 *
 * `deep/00-INVARIANTS.md` §"what matters most" lists this fifth: "It is what makes
 * 'speaking is skippable' true rather than merely advertised." A learner on a bus who taps
 * `Can't speak now` four times has not got four answers wrong; a denominator that counted
 * those skips would score a clean session 11/12 and make `AMAZING` unreachable for anyone
 * who ever uses the skip (EC-GRD-10).
 *
 * Three separate exclusions, each from a different edge case, and they are not the same
 * rule wearing three hats:
 *
 *  - **skips** (EC-GRD-10) leave BOTH numerator and denominator; the drawn replacement is
 *    what gets scored;
 *  - **failed speak attempts** (EC-GRD-11) leave both as well, and additionally cost no
 *    heart and no combo — "an all-speaking session yields undefined accuracy and the
 *    single-tile layout";
 *  - **character traces** (EC-GRD-36) sit outside both "and still consume their
 *    progress-bar segment on completion. An untimed motor-skill retry is not a
 *    comprehension miss."
 *
 * And one counting rule that is easy to get silently wrong: `scorable` counts **gradeable
 * items presented, once each**. A five-pair match grid is ONE, a two-gap item is ONE
 * (EC-GRD-10). So the summary de-duplicates by item id and scores the FIRST attempt —
 * the end-of-lesson replay does not get a second vote, which is EC-GRD-12: "Accuracy still
 * counts the original miss."
 */
import type { AttemptRow, ItemFamily } from './types.js';

/**
 * Families that never enter the denominator, whatever their outcome.
 *
 * `read-and-respond` and `listen-and-respond` are here because the family is non-binary
 * and never punishes (`deep/01` §S9): scoring it would put an opinion in a percentage.
 */
export const NON_SCORABLE_FAMILIES: ReadonlySet<ItemFamily> = new Set<ItemFamily>([
  'character-trace',
  'read-and-respond',
  'listen-and-respond',
]);

/** Outcomes that leave the denominator even when the family would otherwise be scorable. */
export const NON_SCORABLE_OUTCOMES = new Set([
  'skipped-speaking',
  'skipped-listening',
  'failed-speak',
  'trace-completed',
]);

/** Is this attempt in the accuracy denominator? */
export function isScorable(attempt: AttemptRow): boolean {
  if (NON_SCORABLE_FAMILIES.has(attempt.family)) return false;
  return !NON_SCORABLE_OUTCOMES.has(attempt.outcome);
}

/** What the ceremony's accuracy tile renders — or does not. */
export interface AccuracySummary {
  readonly scorable: number;
  readonly correctFirstTry: number;
  /**
   * `undefined`, not `0`, when nothing was scorable. The distinction is the invariant:
   * `0` means "you got everything wrong" and `undefined` means "there was nothing to
   * score", and a session of skips must never be shown the first.
   */
  readonly accuracy: number | undefined;
  /** False when `scorable === 0`: the tile is omitted and the layout is single-tile. */
  readonly renderTile: boolean;
}

/**
 * Summarise a session's attempts.
 *
 * `attempts` is the append-only event list in order. Later attempts on an item id are
 * recycles and replays; they are ignored here by design.
 */
export function accuracyOf(attempts: readonly AttemptRow[]): AccuracySummary {
  const firstByItem = new Map<string, AttemptRow>();
  for (const attempt of attempts) {
    if (!firstByItem.has(attempt.itemId)) firstByItem.set(attempt.itemId, attempt);
  }

  let scorable = 0;
  let correctFirstTry = 0;
  for (const attempt of firstByItem.values()) {
    if (!isScorable(attempt)) continue;
    scorable += 1;
    if (!attempt.wrong) correctFirstTry += 1;
  }

  return {
    scorable,
    correctFirstTry,
    accuracy: scorable === 0 ? undefined : correctFirstTry / scorable,
    renderTile: scorable > 0,
  };
}

/**
 * `Perfect lesson! ⟺ count(wrong) = 0` (INV-GRD-04).
 *
 * Over EVERY attempt, not only the first per item and not only the scorable ones: a
 * mistake recovered on the end-of-lesson replay still blocks it (EC-GRD-12), and a
 * soft-correct never does, because a soft correct sets `softCorrected` and leaves `wrong`
 * false.
 */
export function isPerfectLesson(attempts: readonly AttemptRow[]): boolean {
  return attempts.every((attempt) => !attempt.wrong);
}
