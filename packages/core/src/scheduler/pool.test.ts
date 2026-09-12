/**
 * INV-SCH-05: `Today's Review` and `Daily Refresh` are one pool with a shared
 * per-`local_day` spent-marker, and no item is served by both surfaces on the same day.
 *
 * EC-SCH-05 names the harm and it is not a UI harm: "without the shared marker the same
 * due item is reviewed twice inside twenty minutes at a near-zero interval, inflating
 * retrievability". So the property below asserts disjointness item by item, and then
 * asserts the thing disjointness is FOR — that a pool without the marker manufactures the
 * exact early re-encounter INV-SCH-01 exists to refuse.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS, ZONES, arbInstant } from '@freelingo/testkit';
import { localDayOf, type LocalDay } from '../day/civil.js';
import { introduceRow, newRow, reviewRow, dueAt } from './fsrs.js';
import {
  openPoolDay,
  poolExhausted,
  poolRemaining,
  rollPoolTo,
  servedBy,
  serveFromPool,
  serveItemsFromPool,
  type PoolSurface,
  type ReviewPoolDay,
} from './pool.js';
import { asItemId, type ItemId } from './types.js';

function items(n: number): ItemId[] {
  return Array.from({ length: n }, (_, i) => asItemId(`lex:es:${i.toString().padStart(3, '0')}`));
}

describe('scheduler/pool', () => {
  it('[INV-SCH-05] two surfaces, one pool: an item served by one is never offered by the other', () => {
    const day = localDayOf(new Date('2026-09-11T12:00:00Z'), 'Asia/Tokyo');
    let pool = openPoolDay(day, items(10));

    const hub = serveFromPool(pool, 'todaysReview', 4);
    pool = hub.pool;
    const path = serveFromPool(pool, 'dailyRefresh', 6);
    pool = path.pool;

    expect(hub.served).toHaveLength(4);
    expect(path.served).toHaveLength(6);
    expect(new Set([...hub.served, ...path.served]).size).toBe(10);
    for (const id of hub.served) expect(servedBy(pool, id)).toBe('todaysReview');
    for (const id of path.served) expect(servedBy(pool, id)).toBe('dailyRefresh');
    // Once exhausted, the hub hero falls through rather than re-serving (`6/6` on S025).
    expect(poolExhausted(pool)).toBe(true);
    expect(serveFromPool(pool, 'todaysReview', 3).served).toHaveLength(0);
  });

  for (const zone of ZONES) {
    it(`[INV-SCH-05] no interleaving of the two surfaces ever serves one item twice (${zone.id})`, () => {
      fc.assert(
        fc.property(
          arbInstant(),
          fc.integer({ min: 0, max: 30 }),
          fc.array(
            fc.record({
              surface: fc.constantFrom<PoolSurface>('todaysReview', 'dailyRefresh'),
              count: fc.integer({ min: 0, max: 8 }),
              byName: fc.boolean(),
            }),
            { minLength: 1, maxLength: 20 },
          ),
          (instant, poolSize, calls) => {
            const day = localDayOf(instant, zone.id);
            const all = items(poolSize);
            let pool = openPoolDay(day, all);

            const servedTo: Record<PoolSurface, ItemId[]> = {
              todaysReview: [],
              dailyRefresh: [],
            };
            for (const call of calls) {
              const result = call.byName
                ? serveItemsFromPool(pool, call.surface, all.slice(0, call.count))
                : serveFromPool(pool, call.surface, call.count);
              pool = result.pool;
              servedTo[call.surface].push(...result.served);
            }

            const hub = new Set(servedTo.todaysReview);
            const path = new Set(servedTo.dailyRefresh);
            // The invariant, stated exactly: the intersection is empty.
            for (const id of hub) {
              expect(path.has(id), `${zone.id} (${zone.why})`).toBe(false);
            }
            // And nothing is served twice even by the SAME surface — a re-entry into the
            // hub after a kill must not hand the same six items back.
            expect(servedTo.todaysReview).toHaveLength(hub.size);
            expect(servedTo.dailyRefresh).toHaveLength(path.size);
            expect(hub.size + path.size + poolRemaining(pool).length).toBe(all.length);
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  for (const zone of ZONES) {
    it(`[INV-SCH-05] the spent-marker resets at the local-day boundary and nowhere else (${zone.id})`, () => {
      fc.assert(
        fc.property(arbInstant(), fc.integer({ min: 0, max: 47 }), (instant, laterHours) => {
          const all = items(6);
          const firstDay = localDayOf(instant, zone.id);
          let pool = openPoolDay(firstDay, all);
          pool = serveFromPool(pool, 'todaysReview', 3).pool;
          expect(poolRemaining(pool)).toHaveLength(3);

          const later = new Date(instant.getTime() + laterHours * 3_600_000);
          const laterDay = localDayOf(later, zone.id);
          const rolled: ReviewPoolDay = rollPoolTo(pool, laterDay, all);

          if (laterDay === firstDay) {
            // Same civil date: a relaunch, a course switch, a zone change that did not
            // cross the boundary. The marker survives, by identity.
            expect(rolled, `${zone.id} (${zone.why})`).toBe(pool);
            expect(poolRemaining(rolled)).toHaveLength(3);
          } else {
            expect(poolRemaining(rolled)).toHaveLength(6);
            expect(rolled.localDay).toBe(laterDay);
          }
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });
  }

  it('[INV-SCH-05] falsifier: the same due item served twice inside twenty minutes', () => {
    const zone = 'Asia/Tokyo';
    const start = new Date('2026-09-11T00:00:00Z');
    const day: LocalDay = localDayOf(start, zone);
    const itemId = asItemId('lex:es:gato');

    // A row carrying a real interval, genuinely due today.
    let row = introduceRow(newRow({ itemId, surface: 'gato', kind: 'lexeme' }), start);
    let at = start;
    for (let i = 0; i < 5; i += 1) {
      row = reviewRow(row, { grade: 3, now: at }).row;
      at = dueAt(row);
    }
    // The hub's session answers it now, at its due date: `last_review` is this instant.
    row = reviewRow(row, { grade: 3, now: at }).row;

    let pool = openPoolDay(day, [itemId]);
    const hub = serveFromPool(pool, 'todaysReview', 1);
    pool = hub.pool;
    expect(hub.served).toEqual([itemId]);

    // Twenty minutes later the path surface asks for the same day's set. Without the
    // shared marker it would hand back the same item; with it, the set is empty and S025
    // shows `6/6`.
    const twentyMinutesLater = new Date(at.getTime() + 20 * 60_000);
    const path = serveItemsFromPool(pool, 'dailyRefresh', [itemId]);
    expect(path.served).toHaveLength(0);
    expect(poolExhausted(path.pool)).toBe(true);

    // What the marker prevented: that second encounter would have been an early review at
    // a near-zero interval, which is the retrievability inflation EC-SCH-05 is about.
    const wouldHaveBeen = reviewRow(row, { grade: 3, now: twentyMinutesLater });
    expect(wouldHaveBeen.kind).toBe('early');
  });
});
