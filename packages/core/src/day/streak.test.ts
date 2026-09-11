import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ZONES, civilDayRange, arbLocalDay } from '@freelingo/testkit';
import { addCivilDays, civilDaysBetween, localDayOf, toLocalDay } from './civil.js';
import { streakFromDays } from './streak.js';

/**
 * P0 seed coverage. The 10,000-case four-zone property gate is P0's exit criterion and
 * is extended here in P1 with freezes, `unlived`, grace and the recovery challenge.
 */
describe('streak', () => {
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
      fc.property(fc.array(arbLocalDay(), { maxLength: 40 }), arbLocalDay(), (days, today) => {
        const shuffled = [...days].reverse();
        const duplicated = [...days, ...days];
        const base = streakFromDays(days, today);
        expect(streakFromDays(shuffled, today)).toBe(base);
        expect(streakFromDays(duplicated, today)).toBe(base);
      }),
      { numRuns: 1000 },
    );
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
});
