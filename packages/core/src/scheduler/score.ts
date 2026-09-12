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
import {
  DEFAULT_PACK_SCORE_CEILING,
  ITEMS_PER_SCORE_POINT,
  MASTERY_STABILITY_DAYS,
  SCORE_SCALE_MAX,
  type PackScoreCeiling,
} from './config.js';
import type { FsrsRow } from './fsrs.js';
import type { ItemId } from './types.js';

/**
 * THIS IS NOT `score_floor`. There is exactly one `score_floor` in the data model and it
 * belongs to `path/`: EC-PTH-09 / INV-PATH-06 define it as the floor of the TARGET
 * SECTION'S CEFR band, seeded by a passed jump-here or placement test, "stored apart from
 * mastery and never read back by FSRS as evidence of it".
 *
 * A previous draft of this file called the field below `scoreFloor`, with `displayedScore`
 * computing `max(floor, earned)` — the same formula INV-PATH-06 states, over a different
 * quantity. That merges silently and is then wrong in the worst available way: `path/`
 * writes a band floor into a field the scheduler is already using as a mastery high-water
 * mark, one of the two numbers is destroyed, and both invariants still read green in their
 * own file. Hence the rename, and hence `bandFloorPoints` arriving as a PARAMETER from
 * outside rather than living in this state.
 *
 * The full display rule, with all three terms, is in `displayedScore`.
 */
export interface ScoreState {
  /** Every item that has EVER crossed the mastery threshold. Nothing is ever removed. */
  readonly masteredItemIds: ReadonlySet<ItemId>;
  /**
   * The highest chip value mastery has ever earned. Scheduler-owned, mastery-derived.
   *
   * Strictly redundant while the mastered set only grows — and kept anyway, because it is
   * the one field that survives a future change to the threshold or to the ladder. Lower
   * `MASTERY_STABILITY_DAYS` in a release and every existing learner's set grows; RAISE it
   * and, without this high-water mark, everyone's Score drops overnight for a config edit.
   */
  readonly masteryHighWaterPoints: number;
}

export const EMPTY_SCORE_STATE: ScoreState = {
  masteredItemIds: new Set(),
  masteryHighWaterPoints: 0,
};

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
  if (mastered === null) return raiseMasteryHighWater(state);
  return raiseMasteryHighWater({ ...state, masteredItemIds: mastered });
}

function raiseMasteryHighWater(state: ScoreState): ScoreState {
  const points = rawScorePoints(state.masteredItemIds.size);
  if (points <= state.masteryHighWaterPoints) return state;
  return { ...state, masteryHighWaterPoints: points };
}

/** Mastery expressed in chip points, capped by the SCALE (never by a pack's ceiling). */
function rawScorePoints(masteredCount: number): number {
  return Math.min(SCORE_SCALE_MAX, Math.floor(masteredCount / ITEMS_PER_SCORE_POINT));
}

export interface DisplayedScore {
  /** The chip NUMERATOR. Never decreases while the installed pack holds still. */
  readonly points: number;
  /**
   * The chip DENOMINATOR: the scale, always 160.
   *
   * EC-PACK-55 spells the rendered chip out — "a chip reading `29 / 160`" for a completed
   * A1-band beta pack — so the pack's ceiling clamps the numerator and the denominator
   * stays the course-level 0–160 scale (EC-PTH-40 / INV-PATH-22: "one course-level 0–160
   * number"). A pack-sized denominator would be the second Score model those two refuse.
   */
  readonly scaleMax: number;
  /** What the installed pack declared it can take the learner to. `29` in that example. */
  readonly packCeiling: number;
  /** The bar under it, 0..1. Resets to 0 only on the step where `points` went up. */
  readonly fractionToNext: number;
  readonly masteredCount: number;
}

export interface DisplayedScoreOptions {
  /**
   * INV-PATH-06's `score_floor`: the floor of the target section's CEFR band, seeded by a
   * passed jump-here or placement test. Owned by `path/`, passed in, never stored here,
   * and never read back as evidence of mastery (EC-PTH-09).
   */
  readonly bandFloorPoints?: number;
  /** EC-PACK-55: the installed pack's declared ceiling. Defaults to the 0–160 scale. */
  readonly packCeiling?: PackScoreCeiling;
}

/**
 * The chip, with all three terms INV-PATH-06 and INV-SCH-09 need between them:
 *
 *   displayed = min(pack_ceiling, max(earned, band_floor, mastery_high_water))
 *
 * `earned` and `mastery_high_water` are this module's (INV-SCH-09: never falls).
 * `band_floor` is `path/`'s (INV-PATH-06: never falls).
 * `pack_ceiling` is `packs/`'s (EC-PACK-55: the chip may not out-read the pack).
 *
 * Monotonicity is exact for a FIXED ceiling, which is what INV-SCH-09's 400-day sequence
 * is: all three inner terms are non-decreasing and `min(c, ·)` is monotone. Replacing the
 * installed pack with one declaring a LOWER ceiling can lower the chip, and that is
 * EC-PACK-55's whole point — the alternative is completion copy contradicting the chip. It
 * is a pack event, not a learning event, and it is out of this invariant's scope by the
 * text ("reviews, absences, zone changes and clock moves").
 */
export function displayedScore(
  state: ScoreState,
  options: DisplayedScoreOptions = {},
): DisplayedScore {
  const packCeiling = (options.packCeiling ?? DEFAULT_PACK_SCORE_CEILING).declaredScoreCeiling;
  const masteredCount = state.masteredItemIds.size;
  const earned = Math.max(
    rawScorePoints(masteredCount),
    state.masteryHighWaterPoints,
    options.bandFloorPoints ?? 0,
  );
  const points = Math.min(packCeiling, earned);
  return {
    points,
    scaleMax: SCORE_SCALE_MAX,
    packCeiling,
    fractionToNext: fractionToNextPoint(points, packCeiling, masteredCount),
    masteredCount,
  };
}

/**
 * The bar under the chip.
 *
 * Three cases, and the middle one is the one a floor introduces. When the displayed point
 * came from a FLOOR rather than from mastery — a passed jump-here landing the learner at
 * the bottom of B1, or a mastery threshold raised in a later release — mastery's own
 * progress is BELOW the displayed point, so there is no honest fraction of the way to the
 * next one and the bar sits at the start of the band. Reporting `masteredCount % 20` there
 * instead would walk the bar backwards every time mastery crossed a multiple of 20 while
 * the chip stayed pinned at the floor, which is exactly the falsifier INV-SCH-09 names.
 */
function fractionToNextPoint(points: number, packCeiling: number, masteredCount: number): number {
  if (points >= packCeiling) return 1;
  if (points > rawScorePoints(masteredCount)) return 0;
  return (masteredCount % ITEMS_PER_SCORE_POINT) / ITEMS_PER_SCORE_POINT;
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
