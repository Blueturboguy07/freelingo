/**
 * Word bank and the multi-character select (INV-GRD-23, INV-GRD-24).
 *
 * > "Word-bank grading is a function of tapped tile ids alone, with a pack-declared join
 * > delimiter. Falsifier: the verdict changes when the rendered gap changes, or U+0020
 * > enters a `ja` answer string." (INV-GRD-23)
 *
 * "A function of tapped tile ids alone" is enforced by the signature: `gradeWordBank`
 * takes ids and the item, and there is no parameter carrying a rendered position, a
 * layout, a gap width or a writing direction. EC-GRD-14's RTL failure and EC-GRD-34's
 * Japanese gap are then the same bug and both are unreachable — the answer array is
 * tap-ordered because tap order is the only order the function can see.
 *
 * The join delimiter is the pack's: `' '` for Latin packs, `''` for `ja`, so "the strip
 * matches while the visual gap remains" (EC-GRD-34). A space in a Japanese answer string
 * would then be graded, and the learner would be told about a space their script cannot
 * have — which is the failure INV-GRD-16 forbids from the other direction.
 */
import { HEART_COST_SOFT_CORRECT, HEART_COST_WRONG } from './config.js';
import { gradeTypedAnswer, type GradeRequest } from './grade.js';
import type { GradableItem, GradingPack, Verdict } from './types.js';

/** Join tapped tiles into the answer string the checker sees. */
export function wordBankAnswer(
  item: GradableItem,
  tappedTileIds: readonly string[],
  pack: GradingPack,
): string {
  const textFor = new Map((item.tiles ?? []).map((tile) => [tile.tileId, tile.text]));
  return tappedTileIds.map((id) => textFor.get(id) ?? '').join(pack.wordBankJoinDelimiter);
}

/** Grade a word-bank answer. Same three-tier checker; only the input path differs. */
export function gradeWordBank(
  request: Omit<GradeRequest, 'answer'> & { readonly tappedTileIds: readonly string[] },
): Verdict {
  const { pack, unit, item, learner, tappedTileIds } = request;
  return gradeTypedAnswer({
    pack,
    unit,
    item,
    learner,
    answer: wordBankAnswer(item, tappedTileIds, pack),
  });
}

// ---------------------------------------------------------------------------
// The multi-character select (INV-GRD-24)
// ---------------------------------------------------------------------------

/**
 * > "The multi-character select type is order-sensitive, CHECK-gated, and costs at most
 * > one heart and one mistake row per item, never on an intermediate tap."
 *
 * CHECK is armed by the first tap and never by the Nth: EC-GRD-35 — "never auto-advance
 * at N taps, which leaks the answer length". A learner who can see CHECK light up on the
 * third tap has been told the answer is three characters long.
 */
export interface SelectState {
  readonly taps: readonly string[];
  /** CHECK is enabled. A function of "any tap at all", never of how many. */
  readonly armed: boolean;
  /** Hearts charged so far by tapping. Always zero; the field exists to be asserted. */
  readonly heartsSpentOnTaps: 0;
}

/** A fresh select item: nothing tapped, CHECK disabled. */
export const EMPTY_SELECT_STATE: SelectState = Object.freeze({
  taps: [],
  armed: false,
  heartsSpentOnTaps: 0,
});

/** Tap a tile. Costs nothing and grades nothing. */
export function tapCharacter(state: SelectState, tileId: string): SelectState {
  const taps = [...state.taps, tileId];
  return { taps, armed: true, heartsSpentOnTaps: 0 };
}

/** Remove the last tap. "taps removable in reverse order from a visible ordered strip." */
export function untapCharacter(state: SelectState): SelectState {
  const taps = state.taps.slice(0, -1);
  return { taps, armed: taps.length > 0, heartsSpentOnTaps: 0 };
}

/**
 * Grade at CHECK. Order-sensitive: the tapped id sequence must equal the authored one.
 *
 * One heart and one mistake row at most, charged here and nowhere else.
 */
export function gradeCharacterSelect(item: GradableItem, state: SelectState): Verdict {
  const expected = item.orderedTileIds ?? [];
  const correct =
    state.taps.length === expected.length && state.taps.every((id, i) => id === expected[i]);
  return {
    tier: correct ? 1 : 3,
    verdictClass: correct ? 'correct' : 'wrong',
    channel: null,
    note: null,
    alternateSolution: null,
    advisories: [],
    softCorrected: false,
    wrong: !correct,
    heartCost: correct ? HEART_COST_SOFT_CORRECT : HEART_COST_WRONG,
    comboReset: !correct,
    mistakeLexemeIds: correct || item.targetLexemeId === undefined ? [] : [item.targetLexemeId],
    matchedSurfaceId: null,
    highlights: [],
    schedulerTargets: [{ itemId: item.itemId, facet: item.schedulerFacet ?? 'reading' }],
    writesAttemptRow: true,
    notArmedReason: null,
    escape: null,
  };
}
