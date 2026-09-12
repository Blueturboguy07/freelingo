import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ZONES,
  civilDayRange,
  arbDayOffsets,
  arbInstant,
  arbLocalDay,
  arbZoneId,
  daysFromOffsets,
  PROPERTY_RUNS,
  PROPERTY_RUNS_PER_ZONE,
} from '@freelingo/testkit';
import { addCivilDays, civilDaysBetween, localDayOf, toLocalDay, type LocalDay } from './civil.js';
import { streakFromDays } from './streak.js';

/**
 * P0 gate: INV-DAY-01 and INV-DAY-05 at `PROPERTY_RUNS` cases in each of the four zones.
 * P1 extends this file with freezes, `unlived`, grace and the recovery challenge.
 */

/**
 * An independent reference streak, written from the invariant TEXT rather than from
 * `streakFromDays`: sort the distinct days, find the run containing the anchor, count it.
 * Two implementations that disagree is the actual assertion; a property that re-derives
 * the code under test proves nothing.
 */
function referenceStreak(days: readonly LocalDay[], today: LocalDay): number {
  const distinct = [...new Set(days)].sort();
  const yesterday = addCivilDays(today, -1);
  const anchor = distinct.includes(today) ? today : distinct.includes(yesterday) ? yesterday : null;
  if (anchor === null) return 0;
  const end = distinct.indexOf(anchor);
  let start = end;
  while (start > 0 && civilDaysBetween(distinct[start - 1]!, distinct[start]!) === 1) start -= 1;
  return end - start + 1;
}

/**
 * The committed falsifier input for an invariant (plan §Verification: "committed
 * falsifier inputs per invariant"). Same helper as `boundary.test.ts`; the file also
 * records the falsifier sentence and its source, and `__falsifiers__.test.ts` gates the
 * shape and insists this call exists.
 */
const falsifier = (id: string): Record<string, unknown> => {
  const file = JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as { id: string; falsifier: string; input: Record<string, unknown> };
  expect(file.id).toBe(id);
  expect(file.falsifier.length).toBeGreaterThan(0);
  return file.input;
};

describe('streak', () => {
  /**
   * INV-DAY-01's committed falsifier, run rather than filed.
   *
   * Added at P1 integration: INV-DAY-01 is a P0 id that shipped with three green tests
   * and no falsifying input, and the phase gate's "committed falsifier inputs per
   * invariant" clause was red on it. The case is the one an imperative counter cannot
   * survive — a duplicated day and a day that arrives late — and both halves are asserted
   * off the committed numbers, not off numbers retyped here.
   */
  it('[INV-DAY-01] falsifier: a duplicated day adds nothing and a LATE day still re-joins the run', () => {
    const input = falsifier('INV-DAY-01') as {
      today: string;
      daysWithDuplicate: string[];
      insertedLate: string;
      expectedBeforeLateInsert: number;
      expectedAfterLateInsert: number;
    };
    const today = toLocalDay(input.today);
    const days = input.daysWithDuplicate.map(toLocalDay);

    // The duplicate must not buy a day: the run ending today is 09-08..09-11.
    expect(streakFromDays(days, today)).toBe(input.expectedBeforeLateInsert);

    // The late row arrives out of order. A counter that had already moved past 09-07
    // cannot revisit it; a function of the set closes the gap and the run becomes 7.
    const withLate = [...days, toLocalDay(input.insertedLate)];
    expect(streakFromDays(withLate, today)).toBe(input.expectedAfterLateInsert);

    // And order is still irrelevant, which is the property the two numbers rest on.
    expect(streakFromDays([...withLate].reverse(), today)).toBe(input.expectedAfterLateInsert);
  });

  it('[INV-DAY-01] streak is the maximal contiguous run of distinct days ending today-or-yesterday', () => {
    const today = toLocalDay('2026-09-11');
    expect(streakFromDays([], today)).toBe(0);
    expect(streakFromDays([today], today)).toBe(1);
    expect(streakFromDays(civilDayRange('2026-09-05', 7), today)).toBe(7);
    // A gap truncates the run; days before the gap do not count.
    expect(
      streakFromDays([...civilDayRange('2026-09-01', 3), ...civilDayRange('2026-09-10', 2)], today),
    ).toBe(2);
    // Yesterday-anchored: today not yet met, the streak still stands.
    expect(streakFromDays(civilDayRange('2026-09-05', 6), today)).toBe(6);
    // Two days ago is too old.
    expect(streakFromDays(civilDayRange('2026-09-05', 5), today)).toBe(0);
  });

  it('[INV-DAY-01] streak is a function of the SET: duplicates and order never change it', () => {
    fc.assert(
      fc.property(arbLocalDay(), arbDayOffsets(), (today, offsets) => {
        const days = daysFromOffsets(today, offsets);
        const base = streakFromDays(days, today);
        expect(streakFromDays([...days].reverse(), today)).toBe(base);
        expect(streakFromDays([...days, ...days], today)).toBe(base);
        expect(streakFromDays(new Set(days), today)).toBe(base);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-DAY-01] streak agrees with an independent reference, in every zone', () => {
    for (const zone of ZONES) {
      fc.assert(
        fc.property(arbInstant(), arbDayOffsets(), (instant, offsets) => {
          // `today` is derived from an instant IN THIS ZONE, so DST days and the date
          // line are part of the generated input rather than an afterthought; the
          // history is then built by civil-date offsets from it.
          const today = localDayOf(instant, zone.id);
          const days = daysFromOffsets(today, offsets);

          const actual = streakFromDays(days, today);
          expect(actual, `${zone.id} (${zone.why})`).toBe(referenceStreak(days, today));
          // Bounds that hold whatever the input: never negative, never more days than exist.
          expect(actual).toBeGreaterThanOrEqual(0);
          expect(actual).toBeLessThanOrEqual(new Set(days).size);
          // Non-zero iff the run is anchored at today or yesterday.
          const anchored = days.includes(today) || days.includes(addCivilDays(today, -1));
          expect(actual > 0).toBe(anchored);
          // Days after today are never counted, so dropping them changes nothing.
          const notFuture = days.filter((d) => d <= today);
          expect(streakFromDays(notFuture, today)).toBe(actual);
        }),
        { numRuns: PROPERTY_RUNS_PER_ZONE },
      );
    }
  });

  it('[INV-DAY-05] day boundaries come from civil-date arithmetic, never from adding 86,400 s', () => {
    // 2026-03-08 is a 23-hour day in America/Los_Angeles; 2026-11-01 is a 25-hour day.
    const cases = [
      { zone: 'America/Los_Angeles', day: '2026-03-08', next: '2026-03-09' },
      { zone: 'America/Los_Angeles', day: '2026-11-01', next: '2026-11-02' },
    ] as const;
    for (const { zone, day, next } of cases) {
      const start = toLocalDay(day);
      expect(addCivilDays(start, 1)).toBe(toLocalDay(next));
      expect(civilDaysBetween(start, toLocalDay(next))).toBe(1);
      // Local midnight + 86,400 s does NOT reliably land on the next civil date.
      const midnightUtcOfLocalDay = new Date(`${day}T08:00:00Z`);
      expect(localDayOf(midnightUtcOfLocalDay, zone)).toBe(start);
    }
  });

  /**
   * Committed falsifier inputs (plan §Verification: "committed falsifier inputs per
   * invariant"). These are the two instants where an 86,400 s implementation is provably
   * wrong in both directions, measured 2026-09-11, not guessed.
   */
  it('[INV-DAY-05] falsifier: adding 86,400 s skips a civil date and also fails to advance one', () => {
    const zone = 'America/Los_Angeles';
    const addSeconds = (t: Date, s: number) => new Date(t.getTime() + s * 1000);

    // Spring forward: 23-hour day. 86,400 s jumps 2026-03-07 straight to 2026-03-09.
    const springEve = new Date('2026-03-08T07:30:00Z');
    expect(localDayOf(springEve, zone)).toBe(toLocalDay('2026-03-07'));
    expect(localDayOf(addSeconds(springEve, 86_400), zone)).toBe(toLocalDay('2026-03-09'));
    expect(addCivilDays(localDayOf(springEve, zone), 1)).toBe(toLocalDay('2026-03-08'));

    // Fall back: 25-hour day. 86,400 s does not leave 2026-11-01 at all.
    const fallEve = new Date('2026-11-01T07:30:00Z');
    expect(localDayOf(fallEve, zone)).toBe(toLocalDay('2026-11-01'));
    expect(localDayOf(addSeconds(fallEve, 86_400), zone)).toBe(toLocalDay('2026-11-01'));
    expect(addCivilDays(localDayOf(fallEve, zone), 1)).toBe(toLocalDay('2026-11-02'));
  });

  it('[INV-DAY-05] civil arithmetic is exact and reversible for every generated instant and zone', () => {
    fc.assert(
      fc.property(
        arbInstant(),
        arbZoneId(ZONES),
        fc.integer({ min: -400, max: 400 }),
        (instant, zoneId, delta) => {
          const day = localDayOf(instant, zoneId);
          const moved = addCivilDays(day, delta);
          // Distance is exactly the delta, DST or not.
          expect(civilDaysBetween(day, moved)).toBe(delta);
          // And the walk is reversible: no day is ever lost or invented.
          expect(addCivilDays(moved, -delta)).toBe(day);
          // One step at a time lands in the same place as one jump.
          const step = delta >= 0 ? 1 : -1;
          let walked = day;
          for (let i = 0; i < Math.min(Math.abs(delta), 3); i += 1) {
            walked = addCivilDays(walked, step);
          }
          expect(civilDaysBetween(day, walked)).toBe(step * Math.min(Math.abs(delta), 3));
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-DAY-05] a 400-day walk in every zone advances exactly one civil date per step', () => {
    for (const zone of ZONES) {
      let day = localDayOf(new Date('2026-01-01T12:00:00Z'), zone.id);
      let steps = 0;
      for (let i = 0; i < 400; i += 1) {
        const next = addCivilDays(day, 1);
        expect(civilDaysBetween(day, next)).toBe(1);
        day = next;
        steps += 1;
      }
      expect(steps).toBe(400);
    }
  });

  it('[INV-DAY-05] local_day is monotonic in the instant, in every zone', () => {
    for (const zone of ZONES) {
      fc.assert(
        fc.property(arbInstant(), arbInstant(), (a, b) => {
          const [earlier, later] = a <= b ? [a, b] : [b, a];
          // Civil dates sort lexicographically, so string comparison is date comparison.
          expect(localDayOf(earlier, zone.id) <= localDayOf(later, zone.id)).toBe(true);
        }),
        { numRuns: PROPERTY_RUNS_PER_ZONE },
      );
    }
  });
});
