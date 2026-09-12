/**
 * INV-ECO-11's second half: "the day's quests AND the day's Daily Refresh set are pure
 * functions of `(local_day, seed)` — identical across a kill, a relaunch and a course
 * switch on the same day".
 *
 * `quests.test.ts` covers the first half. This file covers the half that had no test at
 * all while the coverage map reported the id green.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { addCivilDays, toLocalDay } from '../day/civil.js';
import { asItemId, type ItemId } from '../types/index.js';
import {
  DAILY_REFRESH_SET_SIZE,
  dailyRefreshIsExhausted,
  dailyRefreshRemaining,
  dailyRefreshSetForDay,
  spendDailyRefreshItem,
  type DailyRefreshSet,
} from './daily-refresh.js';

const RUNS = { numRuns: PROPERTY_RUNS } as const;
const DAY = toLocalDay('2026-09-11');

function pool(size: number): ItemId[] {
  return Array.from({ length: size }, (_, i) => asItemId(`it_${String(i).padStart(4, '0')}`));
}

describe("the day's Daily Refresh set", () => {
  it('[INV-ECO-11] the set is identical across a kill, a relaunch and a course switch', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 1, max: 60 }),
        (dayOffset, poolSize) => {
          const day = addCivilDays(DAY, dayOffset);
          const items = pool(poolSize);
          const first = dailyRefreshSetForDay(day, 'device-seed', items);
          expect(dailyRefreshSetForDay(day, 'device-seed', items)).toEqual(first);
          // A course switch reorders nothing the learner can see, but it does reorder the
          // rows SQLite hands back. The set must not depend on that.
          expect(dailyRefreshSetForDay(day, 'device-seed', [...items].reverse())).toEqual(first);
          expect(first.length).toBe(Math.min(DAILY_REFRESH_SET_SIZE, poolSize));
          expect(new Set(first).size).toBe(first.length);
          for (const item of first) expect(items).toContain(item);
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-11] a constant implementation fails: different days and seeds give different sets', () => {
    const items = pool(40);
    const shapes = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      shapes.add(dailyRefreshSetForDay(addCivilDays(DAY, i), 'seed', items).join(','));
      shapes.add(dailyRefreshSetForDay(DAY, `seed-${i}`, items).join(','));
    }
    expect(shapes.size).toBeGreaterThan(50);
  });

  it('[INV-ECO-11] the spent-marker is shared and idempotent: two entry points drain one slot (EC-SCH-05)', () => {
    const items = dailyRefreshSetForDay(DAY, 'seed', pool(20));
    const first = items[0] as ItemId;
    let set: DailyRefreshSet = { localDay: DAY, itemIds: items, spentItemIds: [] };
    expect(dailyRefreshRemaining(set)).toBe(DAILY_REFRESH_SET_SIZE);
    // The path level and the hub hero are two entry points to ONE pool.
    set = spendDailyRefreshItem(set, first);
    set = spendDailyRefreshItem(set, first);
    expect(dailyRefreshRemaining(set)).toBe(DAILY_REFRESH_SET_SIZE - 1);
    // An item outside the day's set is not silently added to it.
    set = spendDailyRefreshItem(set, asItemId('it_not_in_set'));
    expect(set.spentItemIds).toHaveLength(1);
    for (const item of items) set = spendDailyRefreshItem(set, item);
    expect(dailyRefreshIsExhausted(set)).toBe(true);
    expect(dailyRefreshRemaining(set)).toBe(0);
  });

  it('[INV-ECO-11] an empty eligible pool is an empty set, never a throw', () => {
    expect(dailyRefreshSetForDay(DAY, 'seed', [])).toEqual([]);
  });
});
