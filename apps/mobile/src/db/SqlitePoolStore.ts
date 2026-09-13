import type { Db } from '@freelingo/schema';
import { toLocalDay, type LocalDay } from '@freelingo/core/day';
import {
  dailyRefreshSetForDay,
  DAILY_REFRESH_SET_SIZE,
  type DailyRefreshSet,
} from '@freelingo/core/economy';
import {
  asItemId,
  openPoolDay,
  serveItemsFromPool,
  type ItemId,
  type PoolSurface,
  type ReviewPoolDay,
} from '@freelingo/core/scheduler';
import { LearningDataError } from './SqliteSchedulerStore';

export interface PersistedReviewPool {
  readonly pool: ReviewPoolDay;
  readonly refresh: DailyRefreshSet;
}
function fail(field: string): never {
  throw new LearningDataError('Invalid daily pool: ' + field);
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return fail('item');
  return value;
}
/** The day header is the explicit freeze, including an empty selection. Both entry points
 * read the same SQL spent marker. Runtime launch may supply a transaction-scoped Db view
 * so reserving items and saving its session checkpoint have one rollback boundary. */
export class SqlitePoolStore {
  constructor(private readonly db: Db) {}
  private course(courseId: string): void {
    if (!this.db.get('SELECT course_id FROM course_progress WHERE course_id=?', [courseId]))
      throw new LearningDataError('The course no longer exists.');
  }
  load(courseId: string, localDay: LocalDay): PersistedReviewPool | null {
    this.course(courseId);
    toLocalDay(localDay);
    const header = this.db.get(
      'SELECT opened_at_utc_ms FROM course_review_pool_day WHERE course_id=? AND local_day=?',
      [courseId, localDay],
    );
    if (!header) return null;
    if (
      !Number.isSafeInteger(header.opened_at_utc_ms) ||
      !Number.isFinite(new Date(header.opened_at_utc_ms as number).getTime())
    )
      return fail('opened timestamp');
    const itemIds: ItemId[] = [],
      spentBy = new Map<ItemId, PoolSurface>();
    for (const row of this.db.all(
      'SELECT * FROM course_review_pool_item WHERE course_id=? AND local_day=? ORDER BY position',
      [courseId, localDay],
    )) {
      if (row.position !== itemIds.length) return fail('serving order');
      const id = asItemId(text(row.item_id));
      itemIds.push(id);
      if (row.spent_by !== null) {
        if (row.spent_by !== 'todaysReview' && row.spent_by !== 'dailyRefresh')
          return fail('spent marker');
        spentBy.set(id, row.spent_by);
      }
    }
    const refreshIds: ItemId[] = [];
    for (const row of this.db.all(
      'SELECT * FROM course_daily_refresh_item WHERE course_id=? AND local_day=? ORDER BY position',
      [courseId, localDay],
    )) {
      if (row.position !== refreshIds.length) return fail('refresh order');
      const id = asItemId(text(row.item_id));
      if (!itemIds.includes(id)) return fail('refresh membership');
      refreshIds.push(id);
    }
    if (refreshIds.length !== Math.min(DAILY_REFRESH_SET_SIZE, itemIds.length))
      return fail('refresh set size');
    return {
      pool: { localDay, itemIds, spentBy },
      refresh: {
        localDay,
        itemIds: refreshIds,
        spentItemIds: refreshIds.filter((id) => spentBy.has(id)),
      },
    };
  }
  open(
    courseId: string,
    localDay: LocalDay,
    seed: string,
    eligible: readonly ItemId[],
    openedAtUtcMs: number,
  ): PersistedReviewPool {
    return this.db.withExclusiveTransaction(() => {
      const existing = this.load(courseId, localDay);
      if (existing) return existing;
      if (
        !Number.isSafeInteger(openedAtUtcMs) ||
        !Number.isFinite(new Date(openedAtUtcMs).getTime())
      )
        return fail('opened timestamp');
      const pool = openPoolDay(
        localDay,
        eligible.map((id) => asItemId(text(id))),
      );
      const refresh = dailyRefreshSetForDay(localDay, seed, pool.itemIds);
      this.db.run(
        'INSERT INTO course_review_pool_day(course_id,local_day,opened_at_utc_ms) VALUES(?,?,?)',
        [courseId, localDay, openedAtUtcMs],
      );
      pool.itemIds.forEach((id, position) =>
        this.db.run(
          'INSERT INTO course_review_pool_item(course_id,local_day,item_id,position) VALUES(?,?,?,?)',
          [courseId, localDay, id, position],
        ),
      );
      refresh.forEach((id, position) =>
        this.db.run(
          'INSERT INTO course_daily_refresh_item(course_id,local_day,item_id,position) VALUES(?,?,?,?)',
          [courseId, localDay, id, position],
        ),
      );
      return this.load(courseId, localDay)!;
    });
  }
  reserve(
    courseId: string,
    localDay: LocalDay,
    surface: PoolSurface,
    requested: readonly ItemId[],
  ): { readonly snapshot: PersistedReviewPool; readonly served: readonly ItemId[] } {
    return this.db.withExclusiveTransaction(() => {
      if (surface !== 'todaysReview' && surface !== 'dailyRefresh') return fail('entry point');
      const current = this.load(courseId, localDay);
      if (!current) return fail('unopened day');
      // The path can only consume its frozen six; Hub can consume any eligible pool item.
      const candidates =
        surface === 'dailyRefresh'
          ? requested.filter((id) => current.refresh.itemIds.includes(id))
          : requested;
      const result = serveItemsFromPool(current.pool, surface, candidates);
      for (const id of result.served)
        this.db.run(
          'UPDATE course_review_pool_item SET spent_by=? WHERE course_id=? AND local_day=? AND item_id=? AND spent_by IS NULL',
          [surface, courseId, localDay, id],
        );
      return { snapshot: this.load(courseId, localDay)!, served: result.served };
    });
  }
}
