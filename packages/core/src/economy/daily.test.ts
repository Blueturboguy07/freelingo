/**
 * Day-keyed economy properties: the goal chest (INV-ECO-05), `active_ms` (INV-ECO-20)
 * and personal-record celebrations (INV-ECO-23).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { toLocalDay, addCivilDays } from '../day/civil.js';
import { DAILY_GOAL_CHEST_GEMS, GOAL_TIERS } from './config.js';
import {
  CEREMONY_CHAIN_SCREEN_IDS,
  PERSONAL_RECORD_KINDS,
  PERSONAL_RECORD_SCREEN_ID,
  RECORD_CELEBRATION_COOLDOWN_DAYS,
  accumulateActiveMs,
  activeMinutesString,
  celebratedRecords,
  marginIsCelebrationWorthy,
  changeDailyGoal,
  goalDayIsMet,
  recordGoalXp,
  type GoalLedger,
} from './daily.js';

const RUNS = { numRuns: PROPERTY_RUNS } as const;
const DAY = toLocalDay('2026-09-11');
const EMPTY: GoalLedger = new Map();

describe('the daily-goal chest', () => {
  it('[INV-ECO-05] falsifier: replaying the same commit pays the chest once, not twice', () => {
    const first = recordGoalXp(EMPTY, DAY, 20, 20, '2026-09-11T10:00:00Z');
    expect(first.chestFired).toBe(true);
    expect(first.gemsAwarded).toBe(DAILY_GOAL_CHEST_GEMS);

    const replay = recordGoalXp(first.ledger, DAY, 20, 20, '2026-09-11T10:00:01Z');
    expect(replay.chestFired).toBe(false);
    expect(replay.gemsAwarded).toBe(0);
    expect(goalDayIsMet(replay.ledger, DAY)).toBe(true);
  });

  it('[INV-ECO-05] lowering the goal mid-day does not re-fire the chest', () => {
    const met = recordGoalXp(EMPTY, DAY, 50, 50, '2026-09-11T10:00:00Z');
    expect(met.chestFired).toBe(true);
    const afterChange = recordGoalXp(
      changeDailyGoal(met.ledger),
      DAY,
      0,
      10,
      '2026-09-11T11:00:00Z',
    );
    expect(afterChange.chestFired).toBe(false);
    expect(afterChange.gemsAwarded).toBe(0);
  });

  it('[INV-ECO-05] raising the goal mid-day does not un-meet the day', () => {
    const met = recordGoalXp(EMPTY, DAY, 10, 10, '2026-09-11T10:00:00Z');
    expect(met.chestFired).toBe(true);
    const raised = recordGoalXp(changeDailyGoal(met.ledger), DAY, 0, 50, '2026-09-11T11:00:00Z');
    expect(raised.dayMet).toBe(true);
    expect(goalDayIsMet(raised.ledger, DAY)).toBe(true);
  });

  it('[INV-ECO-05] over any sequence of commits and goal changes, a day pays at most one chest', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            xp: fc.integer({ min: 0, max: 60 }),
            goal: fc.constantFrom(...GOAL_TIERS.map((t) => t.xp)),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        (commits) => {
          let ledger: GoalLedger = EMPTY;
          let chests = 0;
          let gems = 0;
          let metOnce = false;
          for (const [index, commit] of commits.entries()) {
            const result = recordGoalXp(
              ledger,
              DAY,
              commit.xp,
              commit.goal,
              `2026-09-11T${String(index % 24).padStart(2, '0')}:00:00Z`,
            );
            ledger = result.ledger;
            if (result.chestFired) chests += 1;
            gems += result.gemsAwarded;
            metOnce = metOnce || result.dayMet;
            // Once met, never un-met — whatever the goal does afterwards.
            if (metOnce) expect(goalDayIsMet(ledger, DAY)).toBe(true);
          }
          expect(chests).toBeLessThanOrEqual(1);
          expect(gems).toBe(chests * DAILY_GOAL_CHEST_GEMS);
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-05] two local days are two chests: the ledger is keyed by the day', () => {
    const day1 = recordGoalXp(EMPTY, DAY, 20, 20, '2026-09-11T23:58:00Z');
    const day2 = recordGoalXp(day1.ledger, addCivilDays(DAY, 1), 20, 20, '2026-09-12T00:10:00Z');
    expect(day1.chestFired).toBe(true);
    expect(day2.chestFired).toBe(true);
  });
});

describe('active_ms', () => {
  it('[INV-ECO-20] falsifier: a weekly figure from wall-clock spans — backgrounded and modal time never counts', () => {
    const spans = [
      { ms: 60_000, backgrounded: false, modal: false },
      { ms: 3_600_000, backgrounded: true, modal: false },
      { ms: 120_000, backgrounded: false, modal: true },
      { ms: 30_000, backgrounded: false, modal: false },
    ];
    expect(accumulateActiveMs(spans)).toBe(90_000);
  });

  it('[INV-ECO-20] active_ms is non-null, non-negative and never exceeds the wall clock', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ms: fc.integer({ min: -1_000, max: 600_000 }),
            backgrounded: fc.boolean(),
            modal: fc.boolean(),
          }),
          { maxLength: 40 },
        ),
        (spans) => {
          const active = accumulateActiveMs(spans);
          const wall = spans.reduce((sum, s) => sum + Math.max(0, s.ms), 0);
          expect(Number.isFinite(active)).toBe(true);
          expect(active).toBeGreaterThanOrEqual(0);
          expect(active).toBeLessThanOrEqual(wall);
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-20] every minutes-shaped string reads active_ms', () => {
    expect(activeMinutesString(0)).toBe('0 minutes');
    expect(activeMinutesString(60_000)).toBe('1 minute');
    expect(activeMinutesString(5 * 60_000)).toBe('5 minutes');
    // INV-ECO-21's second falsifier: this string is never a progress bar's denominator.
    expect(activeMinutesString(5 * 60_000)).not.toMatch(/\d\s*\/\s*\d/);
  });
});

describe('personal records', () => {
  it('[INV-ECO-23] falsifier: twelve consecutive record days produce two celebrations, not twelve', () => {
    const events = Array.from({ length: 12 }, (_, dayIndex) => ({
      localDay: addCivilDays(DAY, dayIndex),
      kind: 'dailyMostXp' as const,
      dayIndex,
    }));
    expect(celebratedRecords(events)).toHaveLength(2);
  });

  it('[INV-ECO-23] over any 30-day history the celebration count is <= ceil(days / 7)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dayIndex: fc.integer({ min: 0, max: 29 }),
            kind: fc.constantFrom(...PERSONAL_RECORD_KINDS),
          }),
          { maxLength: 90 },
        ),
        (rows) => {
          const events = rows.map((row) => ({
            localDay: addCivilDays(DAY, row.dayIndex),
            kind: row.kind,
            dayIndex: row.dayIndex,
          }));
          const celebrated = celebratedRecords(events);
          expect(celebrated.length).toBeLessThanOrEqual(
            Math.ceil(30 / RECORD_CELEBRATION_COOLDOWN_DAYS),
          );
          // And no two celebrations sit closer than the cooldown.
          for (let i = 1; i < celebrated.length; i += 1) {
            const previous = celebrated[i - 1]!.dayIndex;
            expect(celebrated[i]!.dayIndex - previous).toBeGreaterThanOrEqual(
              RECORD_CELEBRATION_COOLDOWN_DAYS,
            );
          }
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-23] a record beaten by a hair is not celebrated at all (EC-ECO-27 margin)', () => {
    // EC-ECO-27: "celebrate at most once per 7 local days ... and ONLY when the margin
    // exceeds a configured threshold". The cooldown alone still celebrates a one-point
    // improvement every seventh day forever, which is the same non-event twice a month.
    expect(marginIsCelebrationWorthy(140, 141)).toBe(false);
    expect(marginIsCelebrationWorthy(140, 160)).toBe(true);
    // Small absolute jumps on a small record are not "records" either.
    expect(marginIsCelebrationWorthy(10, 12)).toBe(false);
    expect(marginIsCelebrationWorthy(10, 15)).toBe(true);
    // The first record ever always counts, and a regression never does.
    expect(marginIsCelebrationWorthy(0, 1)).toBe(true);
    expect(marginIsCelebrationWorthy(200, 200)).toBe(false);
    expect(marginIsCelebrationWorthy(200, 199)).toBe(false);

    // End to end: twelve consecutive one-XP bests produce ZERO cards, not two.
    const hairline = Array.from({ length: 12 }, (_, i) => ({
      localDay: toLocalDay('2026-09-11'),
      kind: 'dailyMostXp' as const,
      dayIndex: i,
      previousValue: 140 + i,
      value: 141 + i,
    }));
    expect(celebratedRecords(hairline)).toHaveLength(0);
  });

  it('[INV-ECO-23] zero record screens appear in the ceremony chain', () => {
    expect(CEREMONY_CHAIN_SCREEN_IDS).not.toContain(PERSONAL_RECORD_SCREEN_ID);
    expect(PERSONAL_RECORD_KINDS).toHaveLength(3);
  });
});
