import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ZONES, arbInstant, arbZoneId, PROPERTY_RUNS } from '@freelingo/testkit';
import { addCivilDays, localDayOf, weekKeyOf, toLocalDay, type LocalDay } from '../day/civil.js';
import { streakFromDispositions, type DayDisposition } from '../day/dispositions.js';
import { perfectStreakWeeks, perfectWeekVerdict } from './perfect.js';
import { STREAK_MILESTONES, isMilestone, milestonesCrossed } from './milestones.js';

/** `n` complete weeks of `completed` ending the week before `today`. */
function weeksOf(today: LocalDay, weeks: number): Map<LocalDay, DayDisposition> {
  const ledger = new Map<LocalDay, DayDisposition>();
  let cursor = addCivilDays(weekKeyOf(today), -7 * weeks);
  for (let i = 0; i < weeks * 7; i += 1) {
    ledger.set(cursor, 'completed');
    cursor = addCivilDays(cursor, 1);
  }
  return ledger;
}

describe('perfect streak', () => {
  it('[INV-FRZ-02] EC-STK-19: a frozen day resets the weekly Perfect Streak while the main streak survives', () => {
    // The founder ruling on a case with NO source anywhere: a freeze is insurance against
    // losing the streak, not a substitute for practising, so the harder counter is the one
    // it cannot buy.
    const today = toLocalDay('2026-09-11'); // a Friday; the current week never counts
    const clean = weeksOf(today, 3);
    // The streak number is read at the last day those weeks cover — the Sunday before
    // this week — because the days since are simply not decided yet.
    const lastCompleted = addCivilDays(weekKeyOf(today), -1);
    expect(perfectStreakWeeks(clean, today)).toBe(3);
    expect(streakFromDispositions(clean, lastCompleted, false)).toBe(21);

    // Freeze one day of the middle week. The main streak is untouched…
    const frozenDay = addCivilDays(weekKeyOf(today), -7 * 2 + 3);
    const withFreeze = new Map(clean);
    withFreeze.set(frozenDay, 'frozen');
    expect(streakFromDispositions(clean, lastCompleted, false)).toBe(
      streakFromDispositions(withFreeze, lastCompleted, false) + 1,
    );
    expect(streakFromDispositions(withFreeze, lastCompleted, false)).toBe(20);
    // …and the Perfect Streak is reset to the weeks after the frozen one.
    expect(perfectWeekVerdict(withFreeze, weekKeyOf(frozenDay))).toBe('broken');
    expect(perfectStreakWeeks(withFreeze, today)).toBe(1);

    // A `recovered` day resets it too, for the same reason and more obviously.
    const withRecovered = new Map(clean);
    withRecovered.set(frozenDay, 'recovered');
    expect(perfectWeekVerdict(withRecovered, weekKeyOf(frozenDay))).toBe('broken');

    // An `unlived` day is neither practised nor missed: the week is still perfect if
    // every date the device actually lived was completed.
    const withUnlived = new Map(clean);
    withUnlived.set(frozenDay, 'unlived');
    expect(perfectWeekVerdict(withUnlived, weekKeyOf(frozenDay))).toBe('perfect');
    expect(perfectStreakWeeks(withUnlived, today)).toBe(3);
  });

  it('[INV-FRZ-02] the main streak survives exactly the freezes the Perfect Streak does not', () => {
    for (const zone of ZONES) {
      fc.assert(
        fc.property(
          arbInstant(),
          fc.integer({ min: 1, max: 4 }),
          fc.integer({ min: 0, max: 27 }),
          (instant, weeks, frozenIndex) => {
            const today = localDayOf(instant, zone.id);
            const ledger = weeksOf(today, weeks);
            const days = [...ledger.keys()].sort();
            const index = frozenIndex % days.length;
            const frozen = new Map(ledger);
            frozen.set(days[index]!, 'frozen');
            const lastCompleted = days[days.length - 1]!;
            // The streak number drops by exactly the one day that did not happen…
            expect(streakFromDispositions(frozen, lastCompleted, false)).toBe(
              streakFromDispositions(ledger, lastCompleted, false) - 1,
            );
            // …and the week holding it is no longer perfect.
            expect(perfectWeekVerdict(frozen, weekKeyOf(days[index]!))).toBe('broken');
            expect(perfectStreakWeeks(frozen, today)).toBeLessThan(
              perfectStreakWeeks(ledger, today),
            );
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    }
  });

  it('[INV-REC-07] the milestone rail has no holes and is crossed one step at a time', () => {
    expect(STREAK_MILESTONES).toContain(7);
    expect(STREAK_MILESTONES).toContain(30);
    expect(STREAK_MILESTONES).toContain(100);
    expect(STREAK_MILESTONES).toContain(365);
    // Strictly increasing, no duplicates.
    for (let i = 1; i < STREAK_MILESTONES.length; i += 1) {
      expect(STREAK_MILESTONES[i]!).toBeGreaterThan(STREAK_MILESTONES[i - 1]!);
    }
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4000 }),
        fc.integer({ min: 0, max: 60 }),
        arbZoneId(ZONES),
        (from, growth, _zoneId) => {
          const to = from + growth;
          const crossed = milestonesCrossed(from, to);
          // Every crossed milestone is inside the interval, and none is missed.
          for (const m of crossed) {
            expect(m).toBeGreaterThan(from);
            expect(m).toBeLessThanOrEqual(to);
            expect(isMilestone(m)).toBe(true);
          }
          expect(crossed).toEqual(STREAK_MILESTONES.filter((m) => m > from && m <= to));
          // Growth of at most one day can never cross more than one milestone: this is
          // what makes a restore unable to vault past one (INV-REC-07).
          if (growth <= 1) expect(crossed.length).toBeLessThanOrEqual(1);
          // Walking one day at a time crosses exactly the same set.
          if (growth <= 8) {
            const stepwise: number[] = [];
            for (let n = from; n < to; n += 1) stepwise.push(...milestonesCrossed(n, n + 1));
            expect(stepwise).toEqual(crossed);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
