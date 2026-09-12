/**
 * The Score (INV-SCH-09).
 *
 * "Displayed Score is non-decreasing over any 400-day sequence of reviews, absences, zone
 * changes and clock moves. Falsifier: three days offline lowering the Score chip or the
 * Score fraction."
 *
 * EC-SCH-10 gives the model, and it is the only model that can hold: "Define Score over a
 * PERSISTED HIGH-WATER SET OF EVER-MASTERED ITEMS, never live retrievability: an item that
 * once crossed mastery counts forever, while FSRS due-ness drives only session selection
 * and the hub. A long absence must never walk the Score chip backwards."
 *
 * The temptation this refuses is computing the Score at render time from the same
 * retrievability the hub shows. It costs nothing, it is always current, and it means three
 * days offline take a number away from someone for not opening an app. EC-HUB-07 settles
 * what the two surfaces each mean: strength bars render retrievability and say `Ready to
 * review`; Score is documented as LEARNED, not REMEMBERED.
 *
 * The set only ever grows, so everything downstream of it is monotone by construction. The
 * property then hunts for the ways a derived number can still walk backwards: the integer
 * chip, and the fraction under it.
 */
import { ITEMS_PER_SCORE_POINT, MASTERY_STABILITY_DAYS, SCORE_MAX } from './config.js';
import type { FsrsRow } from './fsrs.js';
import type { ItemId } from './types.js';

export interface ScoreState {
  /** Every item that has EVER crossed the mastery threshold. Nothing is ever removed. */
  readonly masteredItemIds: ReadonlySet<ItemId>;
  /**
   * `score_floor` from the plan's data model: the highest chip value ever displayed.
   *
   * Strictly redundant while the mastered set only grows — and kept anyway, because it is
   * the one field that survives a future change to the threshold or to the ladder. Lower
   * `MASTERY_STABILITY_DAYS` in a release and every existing learner's set grows; RAISE it
   * and, without this floor, everyone's Score drops overnight for a config edit.
   */
  readonly scoreFloor: number;
}

export const EMPTY_SCORE_STATE: ScoreState = { masteredItemIds: new Set(), scoreFloor: 0 };

/** Has this row crossed mastery? Stability in days against one named threshold. */
export function rowIsMastered(row: FsrsRow): boolean {
  return row.introducedAt !== null && row.card.stability >= MASTERY_STABILITY_DAYS;
}

/**
 * Fold rows into the high-water set. Union only — there is no path that removes an id.
 *
 * Mastery is keyed by ITEM, not by `(item, surface)`: EC-SCH-12 holds scheduling state per
 * surface so that a kana-only learner is never shown a kanji, but the Score counts words
 * the learner has learned, and one accepted surface reaching strength is the word reaching
 * strength. Counting rows instead would make the Score depend on how many surfaces a pack
 * happened to enumerate, which INV-ECO-27's `ja`-vs-`es` falsifier already refuses for the
 * word counters.
 */
export function observeMastery(state: ScoreState, rows: Iterable<FsrsRow>): ScoreState {
  let mastered: Set<ItemId> | null = null;
  for (const row of rows) {
    if (!rowIsMastered(row)) continue;
    if (state.masteredItemIds.has(row.itemId)) continue;
    mastered ??= new Set(state.masteredItemIds);
    mastered.add(row.itemId);
  }
  if (mastered === null) return raiseFloor(state);
  return raiseFloor({ ...state, masteredItemIds: mastered });
}

function raiseFloor(state: ScoreState): ScoreState {
  const points = rawScorePoints(state.masteredItemIds.size);
  if (points <= state.scoreFloor) return state;
  return { ...state, scoreFloor: points };
}

function rawScorePoints(masteredCount: number): number {
  return Math.min(SCORE_MAX, Math.floor(masteredCount / ITEMS_PER_SCORE_POINT));
}

export interface DisplayedScore {
  /** The chip. Never decreases. */
  readonly points: number;
  /** The bar under it, 0..1. Resets to 0 only on the step where `points` went up. */
  readonly fractionToNext: number;
  readonly masteredCount: number;
}

export function displayedScore(state: ScoreState): DisplayedScore {
  const masteredCount = state.masteredItemIds.size;
  const points = Math.max(state.scoreFloor, rawScorePoints(masteredCount));
  const fractionToNext =
    points >= SCORE_MAX ? 1 : (masteredCount % ITEMS_PER_SCORE_POINT) / ITEMS_PER_SCORE_POINT;
  return { points, fractionToNext, masteredCount };
}

/**
 * Is `next` a legal successor of `prev` on screen?
 *
 * The falsifier names two surfaces — "the Score chip OR the Score fraction" — so the pair
 * is ordered lexicographically: the chip never falls, and the fraction never falls EXCEPT
 * on the step where the chip rose, which is the bar resetting for the next point rather
 * than progress being taken away.
 */
export function scoreDisplayIsNonDecreasing(prev: DisplayedScore, next: DisplayedScore): boolean {
  if (next.points < prev.points) return false;
  if (next.points > prev.points) return true;
  return next.fractionToNext >= prev.fractionToNext;
}
