/**
 * Match exercises (INV-GRD-07, INV-GRD-25).
 *
 * > "A match exercise with ≥1 wrong pair yields exactly **one** mistake row (the
 * > left-hand lexeme of the first wrong pair) and exactly one accuracy miss."
 *
 * The grid is FIVE pairs and one item. EC-GRD-10 states the denominator once for every
 * type: "`scorable` counts gradeable items presented, once each, so a 5-pair match grid is
 * one item". A grid that wrote five mistake rows would make a single slip look like five,
 * and would put a five-pair session's accuracy denominator at five while a five-item
 * session's is also five — the two would be indistinguishable and both wrong.
 *
 * Hearts are the one place match is not item-scoped: the rules table (`deep/01`) records
 * "Wrong match-pair tap → −1 heart immediately, no CHECK", so a learner who taps wrong
 * three times pays three. That is why `heartsSpent` is a number here and the item-level
 * `Verdict.heartCost` stays the 0/1 the rest of the engine speaks: they answer different
 * questions and collapsing them would silently change one of the two.
 */
import { HEART_COST_SOFT_CORRECT, HEART_COST_WRONG } from './config.js';
import type { GradableItem, Verdict } from './types.js';

/** One tap: the learner joined a left tile to a right tile. */
export interface MatchTap {
  readonly leftLexemeId: string;
  readonly rightLexemeId: string;
}

/** What a graded grid produced. */
export interface MatchOutcome {
  readonly verdict: Verdict;
  /** Hearts charged tap-by-tap during the grid, one per wrong tap. */
  readonly heartsSpent: number;
  /** How many taps were wrong. Diagnostic; never a multiplier on anything below. */
  readonly wrongTapCount: number;
  /** Exactly one accuracy miss when any tap was wrong, else zero (INV-GRD-07). */
  readonly accuracyMisses: 0 | 1;
}

/**
 * Grade a completed grid.
 *
 * `taps` is the learner's join sequence in tap order. A tap is wrong when the right-hand
 * tile is not the one the pack paired with that left-hand tile.
 */
export function gradeMatch(item: GradableItem, taps: readonly MatchTap[]): MatchOutcome {
  const pairs = item.pairs ?? [];
  const rightFor = new Map(pairs.map((p) => [p.leftLexemeId, p.rightLexemeId]));

  let firstWrongLeft: string | null = null;
  let wrongTapCount = 0;
  for (const tap of taps) {
    if (rightFor.get(tap.leftLexemeId) === tap.rightLexemeId) continue;
    wrongTapCount += 1;
    if (firstWrongLeft === null) firstWrongLeft = tap.leftLexemeId;
  }

  const wrong = firstWrongLeft !== null;
  const verdict: Verdict = {
    tier: wrong ? 3 : 1,
    verdictClass: wrong ? 'wrong' : 'correct',
    channel: null,
    note: null,
    alternateSolution: null,
    advisories: [],
    softCorrected: false,
    wrong,
    heartCost: wrong ? HEART_COST_WRONG : HEART_COST_SOFT_CORRECT,
    comboReset: wrong,
    // Exactly one row, and it is the LEFT-hand lexeme of the FIRST wrong pair: the left
    // column is the prompt side, so that is the item the learner actually failed to
    // recognise and the one the mistake queue must replay (EC-GRD-13).
    mistakeLexemeIds: firstWrongLeft === null ? [] : [firstWrongLeft],
    matchedSurfaceId: null,
    highlights: [],
    schedulerTargets: schedulerTargetsFor(item),
    writesAttemptRow: true,
    notArmedReason: null,
    escape: null,
  };

  return { verdict, heartsSpent: wrongTapCount, wrongTapCount, accuracyMisses: wrong ? 1 : 0 };
}

/**
 * Which scheduler rows a grid advances (INV-GRD-25).
 *
 * > "An intra-language orthography match updates only the reading item's scheduler row.
 * > Falsifier: matching `学校` with `がっこう` advances the meaning item's due date or
 * > strength meter."
 *
 * A pair carries its own `facet`, baked by the pack. A `reading` pair contributes a
 * `reading` target and NOTHING else — not the same lexeme's meaning row, not the Words
 * strength meter, which reads the meaning row. A five-pair grid mixing the two kinds
 * therefore produces two kinds of target, one per pair, and never promotes one to the
 * other.
 */
export function schedulerTargetsFor(
  item: GradableItem,
): readonly { readonly itemId: string; readonly facet: string }[] {
  const pairs = item.pairs ?? [];
  if (pairs.length === 0) {
    return [{ itemId: item.itemId, facet: item.schedulerFacet ?? 'meaning' }];
  }
  return pairs.map((pair) => ({ itemId: pair.leftLexemeId, facet: pair.facet }));
}
