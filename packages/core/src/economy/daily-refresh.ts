/**
 * The Daily Refresh set — the second half of INV-ECO-11.
 *
 * The invariant reads "the day's quests **and the day's Daily Refresh set** are pure
 * functions of `(local_day, seed)` — identical across a kill, a relaunch and a course
 * switch on the same day". `quests.ts` owns the first half; this file owns the second,
 * and until it existed the id was half-covered while the coverage map reported it green.
 *
 * EC-SCH-05 is the reason the set is a stored, day-keyed function rather than a query:
 * `Today's Review` in the hub and `Daily Refresh` on the path are ONE pool with two entry
 * points and a shared spent-marker. Two surfaces independently selecting "six due items"
 * re-serve the same item twice inside twenty minutes at a near-zero interval, which
 * inflates retrievability and is the one place FSRS is harmed rather than merely annoyed.
 *
 * The scheduler task owns which items are *eligible*; this file owns only the rule that,
 * given the same day, seed and eligible pool, the answer never changes.
 */
import type { LocalDay } from '../day/civil.js';
import type { ItemId } from '../types/index.js';
import { seededPrng } from './prng.js';

/** [S096, six levels] the size of one day's set. One constant, read by both surfaces. */
export const DAILY_REFRESH_SET_SIZE = 6;

export interface DailyRefreshSet {
  readonly localDay: LocalDay;
  readonly itemIds: readonly ItemId[];
  /** Items consumed so far, by either entry point. The shared spent-marker of EC-SCH-05. */
  readonly spentItemIds: readonly ItemId[];
}

/**
 * The day's set: a seeded shuffle of the eligible pool, truncated to the set size.
 *
 * Pure in `(day, seed, pool)`. The pool is de-duplicated and sorted first, so two callers
 * that assembled the same items in a different order still get the same set — otherwise
 * "identical across a course switch" would depend on SQLite's row order.
 */
export function dailyRefreshSetForDay(
  day: LocalDay,
  seed: string,
  eligiblePool: readonly ItemId[],
): ItemId[] {
  const pool = [...new Set(eligiblePool)].sort();
  if (pool.length === 0) return [];
  return seededPrng(`${seed}|refresh|${day}`).shuffle(pool).slice(0, DAILY_REFRESH_SET_SIZE);
}

/**
 * Consume one item from the day's set (EC-SCH-05's shared spent-marker).
 *
 * Idempotent: consuming the same item twice marks it once, so a hub entry and a path
 * entry for the same level cannot drain two slots. An item outside the set is ignored
 * rather than added — the set is the day's set, not a running list.
 */
export function spendDailyRefreshItem(set: DailyRefreshSet, itemId: ItemId): DailyRefreshSet {
  if (!set.itemIds.includes(itemId)) return set;
  if (set.spentItemIds.includes(itemId)) return set;
  return { ...set, spentItemIds: [...set.spentItemIds, itemId] };
}

/** `6/6` once the day's set is drained; the hub hero then falls through (EC-SCH-05). */
export function dailyRefreshRemaining(set: DailyRefreshSet): number {
  return Math.max(0, set.itemIds.length - set.spentItemIds.length);
}

export function dailyRefreshIsExhausted(set: DailyRefreshSet): boolean {
  return dailyRefreshRemaining(set) === 0;
}
