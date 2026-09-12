/**
 * The attempt row (INV-GRD-04).
 *
 * > "The attempt row carries **two** independent flags (`soft_corrected`, `wrong`).
 * > `correctFirstTry = !wrong`; `Perfect lesson! ⟺ count(wrong) = 0`; a soft-correct never
 * > creates a mistake row."
 *
 * EC-GRD-08 says why the two flags cannot be one: "Tier-2 and Tier-3 must be **two flags
 * on the attempt row, not one boolean**." A single `correct` boolean forces a choice
 * between calling a soft correct right — and losing the fact that a note was shown, which
 * Explain My Answer needs (EC-GRD-22) — or calling it wrong, which costs a heart the
 * learner never paid, blocks `Perfect lesson!` and drops accuracy to 90% for an extra
 * space. Both have shipped in clones of this app; the invariant exists because of them.
 *
 * The flags are independent in the type and in the values: `soft_corrected` is true only
 * for tier 2, `wrong` only for tier 3 and `register`, and the pair `(true, true)` never
 * occurs. `attempt.test.ts` asserts that over every verdict the grader can produce.
 */
import type { AttemptOutcome, AttemptRow, GradableItem, Verdict } from './types.js';

/**
 * The row an answered exercise persists, or `null` when nothing is written at all.
 *
 * `null` is INV-GRD-14's case: an answer with zero target-script characters "produces no
 * verdict, no attempt row, no heart and no combo change". Returning `null` rather than a
 * row with a flag makes it impossible to count one by accident.
 */
export function attemptRowFor(
  item: GradableItem,
  verdict: Verdict,
  outcome: AttemptOutcome = 'graded',
): AttemptRow | null {
  if (!verdict.writesAttemptRow) return null;
  return {
    itemId: item.itemId,
    softCorrected: verdict.softCorrected,
    wrong: verdict.wrong,
    outcome,
    family: item.family,
  };
}

/** A row for an item that was never graded: a skip, a failed speak, a completed trace. */
export function unscoredAttemptRow(item: GradableItem, outcome: AttemptOutcome): AttemptRow {
  return { itemId: item.itemId, softCorrected: false, wrong: false, outcome, family: item.family };
}

/** `correctFirstTry = !wrong` (INV-GRD-04). Stated once, so nothing re-derives it. */
export function correctFirstTry(row: AttemptRow): boolean {
  return !row.wrong;
}

/**
 * The mistake rows an answer creates.
 *
 * A soft correct creates NONE — that is the second half of INV-GRD-04 and the reason
 * `Verdict.mistakeLexemeIds` is empty for every tier-2 branch in `grade.ts` rather than
 * being filtered out here. This function reads the verdict; it does not second-guess it.
 */
export function mistakeRowsFor(verdict: Verdict): readonly string[] {
  return verdict.mistakeLexemeIds;
}
