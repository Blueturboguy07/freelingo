/**
 * Quest and badge properties: INV-ECO-10 (median-scaled, clamped targets; badge counts
 * quests; no empty state), INV-ECO-11 (quests are a pure function of `(local_day, seed)`),
 * INV-ECO-22 (badge month keyed by `max_local_day_seen`) and INV-ECO-29 (Strategist).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS, seededPrng } from '@freelingo/testkit';
import { addCivilDays, toLocalDay } from '../day/civil.js';
import {
  GOAL_TIERS,
  QUEST_SESSION_DIVISOR,
  QUEST_TARGET_MAX_XP,
  QUEST_TARGET_MIN_XP,
  QUEST_TREND_WINDOW_DAYS,
  QUESTS_PER_DAY,
} from './config.js';
import {
  badgeMonthKey,
  badgeTargetForMonth,
  clampQuestBase,
  questBaseFor,
  questTabState,
  questsForDay,
  rederiveQuestsOnGoalChange,
  toQuestRow,
  rollBadgeMonth,
  strategistFires,
  trailingMedianDailyXp,
  type MonthlyBadgeRow,
} from './quests.js';

const RUNS = { numRuns: PROPERTY_RUNS } as const;
const DAY = toLocalDay('2026-09-11');

describe('quest targets', () => {
  it('[INV-ECO-10] targets derive from a trailing 7-day median, clamped to [10, 200]', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 2_000 }), { maxLength: 30 }), (dailyXp) => {
        const median = trailingMedianDailyXp(dailyXp);
        const clamped = clampQuestBase(median);
        expect(clamped).toBeGreaterThanOrEqual(QUEST_TARGET_MIN_XP);
        expect(clamped).toBeLessThanOrEqual(QUEST_TARGET_MAX_XP);

        const quests = questsForDay(DAY, 'seed', { trailingDailyXp: [median], goalXp: 20 });
        expect(quests).toHaveLength(QUESTS_PER_DAY);
        for (const quest of quests) {
          expect(quest.target).toBeGreaterThan(0);
          expect(quest.copy).not.toContain('{{n}}');
        }
        const xpQuest = quests.find((q) => q.unit === 'xp');
        if (xpQuest !== undefined) {
          expect(xpQuest.target).toBeLessThanOrEqual(QUEST_TARGET_MAX_XP);
          expect(xpQuest.target).toBeGreaterThanOrEqual(QUEST_TARGET_MIN_XP);
        }
      }),
      RUNS,
    );
  });

  it('[INV-ECO-10] falsifier: a 20-lesson-a-day learner is capped, a returning learner is floored', () => {
    const heavy = trailingMedianDailyXp(new Array(QUEST_TREND_WINDOW_DAYS).fill(900));
    expect(clampQuestBase(heavy)).toBe(QUEST_TARGET_MAX_XP);
    const returning = trailingMedianDailyXp([]);
    expect(clampQuestBase(returning)).toBe(QUEST_TARGET_MIN_XP);
  });

  it('[INV-ECO-10] one heavy day does not set tomorrow: the trend is a MEDIAN, not a mean', () => {
    const spiky = [0, 0, 0, 0, 0, 0, 1_400];
    expect(trailingMedianDailyXp(spiky)).toBe(0);
  });

  it('[INV-ECO-10] a fully-cleared tab renders completed cards and a countdown, never an empty state', () => {
    expect(questTabState(0, QUESTS_PER_DAY)).toBe('active');
    expect(questTabState(1, QUESTS_PER_DAY)).toBe('partial');
    expect(questTabState(QUESTS_PER_DAY, QUESTS_PER_DAY)).toBe('all-complete');
    // There is no 'empty' state to return, which is the executable form of the rule.
    const states = [0, 1, 2, 3].map((n) => questTabState(n, QUESTS_PER_DAY));
    expect(states).not.toContain('empty');
  });
});

describe('the cold start (EC-ECO-10)', () => {
  it('[INV-ECO-10] day one has no median, so the base is the stored goal — not the clamp floor', () => {
    // The bug this test exists for: `trailingMedianDailyXp([])` is 0 and
    // `clampQuestBase(0)` is QUEST_TARGET_MIN_XP, so every learner — Casual, Regular,
    // Serious, Intense — got the same 10 XP quest on day one. EC-ECO-10 says the cold
    // start "falls back to multiples of the stored goalXP (1x, 1x, 1.5x)".
    for (const tier of GOAL_TIERS) {
      const cold = questBaseFor({ trailingDailyXp: [], goalXp: tier.xp });
      expect(cold.isColdStart, tier.key).toBe(true);
      expect(cold.base, tier.key).toBe(tier.xp);
    }
    const intense = GOAL_TIERS[GOAL_TIERS.length - 1] as (typeof GOAL_TIERS)[number];
    const casual = GOAL_TIERS[0] as (typeof GOAL_TIERS)[number];
    expect(questBaseFor({ trailingDailyXp: [], goalXp: intense.xp }).base).toBeGreaterThan(
      questBaseFor({ trailingDailyXp: [], goalXp: casual.xp }).base,
    );
  });

  it('[INV-ECO-10] cold-start session quests are capped at ceil(goalXp / 13)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...GOAL_TIERS.map((t) => t.xp)), (goalXp) => {
        const cap = Math.max(1, Math.ceil(goalXp / QUEST_SESSION_DIVISOR));
        expect(questBaseFor({ trailingDailyXp: [], goalXp }).sessionCap).toBe(cap);
        for (const quest of questsForDay(DAY, 'seed', { trailingDailyXp: [], goalXp })) {
          if (quest.unit === 'sessions') expect(quest.target).toBeLessThanOrEqual(cap);
        }
      }),
      RUNS,
    );
  });

  it('[INV-ECO-10] the median takes over as soon as there IS one', () => {
    const warm = questBaseFor({ trailingDailyXp: [100, 120, 140], goalXp: 20 });
    expect(warm.isColdStart).toBe(false);
    expect(warm.sessionCap).toBeNull();
    expect(warm.base).toBe(120);
  });

  it('[INV-ECO-10] a goal change re-derives the day, and never un-completes an earned quest', () => {
    // EC-ECO-10's last clause, verbatim: "re-derived on a goal change and never
    // un-completing a quest already earned".
    const before = questsForDay(DAY, 'seed', { trailingDailyXp: [], goalXp: 10 }).map(toQuestRow);
    const earned = before.map((row, index) =>
      index === 0 ? { ...row, progress: row.target, completedAtUtc: '2026-09-11T09:00:00Z' } : row,
    );
    const after = rederiveQuestsOnGoalChange(earned, DAY, 'seed', {
      trailingDailyXp: [],
      goalXp: 50,
    });
    // The earned row is frozen exactly as it was: same target, same stamp.
    expect(after[0]).toEqual(earned[0]);
    // The rest moved with the new goal, and none of them is complete.
    const fresh = questsForDay(DAY, 'seed', { trailingDailyXp: [], goalXp: 50 });
    for (let i = 1; i < after.length; i += 1) {
      expect(after[i]?.target).toBe(fresh[i]?.target);
      expect(after[i]?.completedAtUtc).toBeNull();
    }
    // Lowering the goal again still cannot take the earned quest back.
    const lowered = rederiveQuestsOnGoalChange(after, DAY, 'seed', {
      trailingDailyXp: [],
      goalXp: 10,
    });
    expect(lowered[0]).toEqual(earned[0]);
  });

  it('[INV-ECO-10] progress on an unearned quest survives the re-derivation', () => {
    const rows = questsForDay(DAY, 'seed', { trailingDailyXp: [], goalXp: 10 }).map(toQuestRow);
    const withProgress = rows.map((row, i) => (i === 1 ? { ...row, progress: 3 } : row));
    const after = rederiveQuestsOnGoalChange(withProgress, DAY, 'seed', {
      trailingDailyXp: [],
      goalXp: 30,
    });
    expect(after[1]?.progress).toBe(3);
  });
});

describe('quest determinism', () => {
  it("[INV-ECO-11] the day's quests are identical across a kill, a relaunch and a course switch", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 900 }),
        fc.integer({ min: 0, max: 400 }),
        (medianXp, dayOffset) => {
          const day = addCivilDays(DAY, dayOffset);
          const first = questsForDay(day, 'device-seed', {
            trailingDailyXp: [medianXp],
            goalXp: 20,
          });
          const afterKill = questsForDay(day, 'device-seed', {
            trailingDailyXp: [medianXp],
            goalXp: 20,
          });
          const afterCourseSwitch = questsForDay(day, 'device-seed', {
            trailingDailyXp: [medianXp],
            goalXp: 20,
          });
          expect(afterKill).toEqual(first);
          expect(afterCourseSwitch).toEqual(first);
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-11] different days and different seeds do not all return the same three quests', () => {
    // A "deterministic" function that returns one constant is also deterministic. This is
    // the half of the property that a constant implementation fails.
    const prng = seededPrng('quest-spread');
    const shapes = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      const day = addCivilDays(DAY, i);
      const quests = questsForDay(day, `seed-${prng.int(0, 9)}`, {
        trailingDailyXp: [120],
        goalXp: 20,
      });
      shapes.add(quests.map((q) => q.templateId).join(','));
    }
    expect(shapes.size).toBeGreaterThan(3);
  });

  it('[INV-ECO-11] the three quests of a day are distinct templates', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 }), (dayOffset) => {
        const quests = questsForDay(addCivilDays(DAY, dayOffset), 'seed', {
          trailingDailyXp: [100],
          goalXp: 20,
        });
        expect(new Set(quests.map((q) => q.templateId)).size).toBe(quests.length);
      }),
      RUNS,
    );
  });
});

describe('the monthly badge', () => {
  it('[INV-ECO-22] badge rows are keyed by the YYYY-MM of max_local_day_seen', () => {
    expect(badgeMonthKey(toLocalDay('2026-09-30'))).toBe('2026-09');
    expect(badgeMonthKey(toLocalDay('2026-10-01'))).toBe('2026-10');
  });

  it('[INV-ECO-22] falsifier: a clock or zone move across a month boundary neither mints nor destroys progress', () => {
    const september: MonthlyBadgeRow = {
      monthKey: '2026-09',
      questsCompleted: 22,
      targetQuests: 45,
      tier: 'silver',
    };
    // Same month, seen again after a zone move: the row is untouched, nothing archived.
    const sameMonth = rollBadgeMonth(september, toLocalDay('2026-09-12'), 120);
    expect(sameMonth.row).toBe(september);
    expect(sameMonth.archived).toBeNull();

    // A real rollover archives the prior tier and arms a fresh row at zero.
    const october = rollBadgeMonth(september, toLocalDay('2026-10-01'), 120);
    expect(october.row.monthKey).toBe('2026-10');
    expect(october.row.questsCompleted).toBe(0);
    expect(october.archived).toBe(september);
  });

  it('[INV-ECO-22] the target is derived once at month start and never re-derived', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 0, max: 600 }),
        (medianAtStart, medianLater) => {
          const start = rollBadgeMonth(null, toLocalDay('2026-09-01'), medianAtStart);
          const midMonth = rollBadgeMonth(start.row, toLocalDay('2026-09-20'), medianLater);
          expect(midMonth.row.targetQuests).toBe(start.row.targetQuests);
          expect(midMonth.row.tier).toBe(start.row.tier);
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-22] badge progress counts COMPLETED QUESTS, not cumulative XP', () => {
    const row = rollBadgeMonth(null, toLocalDay('2026-09-01'), 200).row;
    expect(Object.hasOwn(row, 'questsCompleted')).toBe(true);
    expect(Object.hasOwn(row, 'targetQuests')).toBe(true);
    expect(Object.keys(row)).not.toContain('xpEarned');
    expect(badgeTargetForMonth(200).quests).toBeGreaterThan(0);
  });
});

describe('Strategist', () => {
  it('[INV-ECO-29] falsifier: opening the guidebook alone does not earn the badge', () => {
    const opens = [{ localDay: DAY, unitId: 'u1', atUtc: '2026-09-11T09:00:00Z' }];
    expect(strategistFires(opens, [])).toBe(false);
  });

  it('[INV-ECO-29] fires only on a guidebook-open then a completed session in the SAME unit and day', () => {
    const open = { localDay: DAY, unitId: 'u1', atUtc: '2026-09-11T09:00:00Z' };
    const otherUnit = { localDay: DAY, unitId: 'u2', atUtc: '2026-09-11T10:00:00Z' };
    const otherDay = {
      localDay: addCivilDays(DAY, 1),
      unitId: 'u1',
      atUtc: '2026-09-12T10:00:00Z',
    };
    const before = { localDay: DAY, unitId: 'u1', atUtc: '2026-09-11T08:00:00Z' };
    const match = { localDay: DAY, unitId: 'u1', atUtc: '2026-09-11T10:00:00Z' };

    expect(strategistFires([open], [otherUnit])).toBe(false);
    expect(strategistFires([open], [otherDay])).toBe(false);
    expect(strategistFires([open], [before])).toBe(false);
    expect(strategistFires([open], [match])).toBe(true);
  });
});
