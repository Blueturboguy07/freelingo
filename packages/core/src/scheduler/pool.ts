/**
 * ONE review pool, two entry points (INV-SCH-05).
 *
 * EC-SCH-05: "`Today's Review` (hub) and `Daily Refresh` (path) are ONE POOL WITH TWO
 * ENTRY POINTS and a shared spent-marker... Never let two surfaces own overlapping
 * selections of one pool... the FSRS harm is the point — without the shared marker the
 * same due item is reviewed twice inside twenty minutes at a near-zero interval, inflating
 * retrievability."
 *
 * So the spent-marker is not bookkeeping for the two screens; it is the thing that stops
 * the app manufacturing the exact encounter INV-SCH-01 exists to refuse. Two surfaces each
 * holding their own "six due items" would be a scheduler fault wearing a UI costume.
 *
 * Division of labour, so nothing is owned twice:
 *   - `economy/daily-refresh.ts` owns WHICH six items a given `local_day` and seed pick
 *     out of the eligible pool, and that the pick is stable across a kill (INV-ECO-11).
 *   - this file owns the pool those six are picked FROM, the shared spent-marker across
 *     both surfaces, and the reset at the `local_day` boundary.
 * At integration, `spendDailyRefreshItem` should delegate here rather than keep a second
 * spent list; see `docs/owned/scheduler.json` -> `requests`.
 */
import type { LocalDay } from '../day/civil.js';
import type { ItemId } from './types.js';

/** The two surfaces that draw from the pool. There is never a third without a ruling. */
export const POOL_SURFACES = ['todaysReview', 'dailyRefresh'] as const;
export type PoolSurface = (typeof POOL_SURFACES)[number];

export interface ReviewPoolDay {
  readonly localDay: LocalDay;
  /**
   * The day's eligible items, in serving order. De-duplicated at construction: the same
   * item reached through two units is one item, because ids are content-hashed.
   */
  readonly itemIds: readonly ItemId[];
  /** item -> the surface that consumed it TODAY. The shared spent-marker. */
  readonly spentBy: ReadonlyMap<ItemId, PoolSurface>;
}

/**
 * Open the pool for a local day.
 *
 * `eligible` arrives in the scheduler's own order (most overdue first — `orderByOverdue`
 * in `endgame.ts`). Duplicates are dropped while KEEPING that order; sorting here would
 * throw away the overdue-ness ranking that made the order worth computing.
 */
export function openPoolDay(localDay: LocalDay, eligible: Iterable<ItemId>): ReviewPoolDay {
  return { localDay, itemIds: [...new Set(eligible)], spentBy: new Map() };
}

export function isSpent(pool: ReviewPoolDay, itemId: ItemId): boolean {
  return pool.spentBy.has(itemId);
}

export function servedBy(pool: ReviewPoolDay, itemId: ItemId): PoolSurface | null {
  return pool.spentBy.get(itemId) ?? null;
}

/** What either surface can still offer today. `6/6` on S025 is this reaching zero. */
export function poolRemaining(pool: ReviewPoolDay): ItemId[] {
  return pool.itemIds.filter((id) => !pool.spentBy.has(id));
}

export function poolExhausted(pool: ReviewPoolDay): boolean {
  return poolRemaining(pool).length === 0;
}

export interface PoolServeResult {
  readonly pool: ReviewPoolDay;
  readonly served: readonly ItemId[];
}

/**
 * Serve up to `count` unspent items to one surface and mark them spent.
 *
 * Marking happens at SERVE time, not at completion time: EC-SCH-05's harm is the same item
 * appearing on both surfaces "inside twenty minutes", and a marker written only when the
 * session commits leaves a window in which the hub and the path both hold it. An abandoned
 * session therefore burns its slice for the day, which is the conservative direction — the
 * cost is a slightly shorter refresh, not a corrupted memory model.
 */
export function serveFromPool(
  pool: ReviewPoolDay,
  surface: PoolSurface,
  count: number,
): PoolServeResult {
  if (count <= 0) return { pool, served: [] };
  const served: ItemId[] = [];
  const spentBy = new Map(pool.spentBy);
  for (const id of pool.itemIds) {
    if (served.length >= count) break;
    if (spentBy.has(id)) continue;
    spentBy.set(id, surface);
    served.push(id);
  }
  if (served.length === 0) return { pool, served: [] };
  return { pool: { ...pool, spentBy }, served };
}

/**
 * Serve specific items — the path entry point, which already knows the six the day's
 * seeded set chose (`economy/daily-refresh.ts`).
 *
 * An item the other surface already took is silently skipped rather than refused: the hub
 * may legitimately have drained it a minute ago, and the right answer on S025 is a shorter
 * level, not an error.
 */
export function serveItemsFromPool(
  pool: ReviewPoolDay,
  surface: PoolSurface,
  itemIds: readonly ItemId[],
): PoolServeResult {
  const served: ItemId[] = [];
  const spentBy = new Map(pool.spentBy);
  const inPool = new Set(pool.itemIds);
  for (const id of itemIds) {
    if (!inPool.has(id) || spentBy.has(id)) continue;
    spentBy.set(id, surface);
    served.push(id);
  }
  if (served.length === 0) return { pool, served: [] };
  return { pool: { ...pool, spentBy }, served };
}

/**
 * Roll the pool to a new local day.
 *
 * "Both surfaces reset at the same `local_day` boundary as quests and goal chests"
 * (EC-SCH-05). Same day in -> the pool is returned unchanged by identity, so a relaunch,
 * a course switch or a zone change that does NOT cross the boundary cannot silently
 * refill the marker and hand the learner the same six items twice.
 */
export function rollPoolTo(
  pool: ReviewPoolDay,
  localDay: LocalDay,
  eligible: Iterable<ItemId>,
): ReviewPoolDay {
  if (pool.localDay === localDay) return pool;
  return openPoolDay(localDay, eligible);
}
