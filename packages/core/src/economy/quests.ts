/**
 * Daily quests (S118), the monthly badge (S119) and Strategist.
 *
 * Owns INV-ECO-10 (targets scale from a trailing 7-day median, clamped; a cleared tab is
 * never empty), INV-ECO-11 (the day's quests are a pure function of `(local_day, seed)`),
 * INV-ECO-22 (badge rows are keyed by the `YYYY-MM` of `max_local_day_seen`, derived once
 * at month start) and INV-ECO-29 (Strategist needs a guidebook open AND a session).
 */
import type { LocalDay } from '../day/civil.js';
import { seededPrng } from './prng.js';
import {
  MONTHLY_BADGE_TIERS,
  QUEST_CHEST_GEMS_MAX,
  QUEST_SESSION_DIVISOR,
  QUEST_SLOT_MULTIPLES,
  QUEST_TARGET_MAX_XP,
  QUEST_TARGET_MIN_XP,
  QUEST_TEMPLATES,
  QUEST_TREND_WINDOW_DAYS,
  QUESTS_PER_DAY,
  type QuestTemplate,
  type QuestUnit,
} from './config.js';

/* ------------------------------------------------------------------- the trend */

/**
 * The trailing median of daily XP over the trend window (INV-ECO-10).
 *
 * A MEDIAN, not a mean, and that is the whole point: one 1,400 XP Saturday must not set
 * Sunday's targets, or the learner is punished for a good day. An empty history is 0,
 * which the clamp turns into the floor.
 */
export function trailingMedianDailyXp(dailyXp: readonly number[]): number {
  const window = dailyXp.slice(-QUEST_TREND_WINDOW_DAYS);
  if (window.length === 0) return 0;
  const sorted = [...window].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Clamp a scaling base into the shipped band. A returning learner gets the floor. */
export function clampQuestBase(value: number): number {
  if (!Number.isFinite(value)) return QUEST_TARGET_MIN_XP;
  return Math.max(QUEST_TARGET_MIN_XP, Math.min(QUEST_TARGET_MAX_XP, Math.round(value)));
}

/* -------------------------------------------------------------------- the quests */

export interface Quest {
  readonly templateId: string;
  readonly unit: QuestUnit;
  readonly target: number;
  /** The template's copy with `{{n}}` already interpolated. Never shown unfilled. */
  readonly copy: string;
}

/** The target for one template in one slot, derived from the clamped scaling base. */
export function questTarget(template: QuestTemplate, base: number, slot: number): number {
  const scaled = base * (QUEST_SLOT_MULTIPLES[slot] ?? 1);
  switch (template.unit) {
    case 'xp':
      return clampQuestBase(scaled);
    case 'sessions':
      return Math.max(1, Math.ceil(scaled / QUEST_SESSION_DIVISOR));
    case 'gems':
      return QUEST_CHEST_GEMS_MAX;
    case 'streak':
      return Math.max(1, Math.round(scaled / QUEST_TARGET_MIN_XP));
  }
}

/**
 * INV-ECO-11: a pure function of `(local_day, seed)` and the learner's own trend.
 *
 * Identical across a kill, a relaunch and a course switch on the same day, because the
 * only entropy is a hash of the day and the device seed. Missed days are never generated
 * at all — no backlog, no catch-up quests (EC-ECO-12).
 */
export function questsForDay(day: LocalDay, seed: string, medianDailyXp: number): Quest[] {
  const base = clampQuestBase(medianDailyXp);
  const chosen = seededPrng(`${seed}|${day}`).shuffle(QUEST_TEMPLATES).slice(0, QUESTS_PER_DAY);
  return chosen.map((template, slot) => {
    const target = questTarget(template, base, slot);
    return {
      templateId: template.id,
      unit: template.unit,
      target,
      copy: template.copy.replace('{{n}}', String(target)),
    };
  });
}

/**
 * INV-ECO-10's last clause: a fully cleared tab renders completed cards and a countdown,
 * never an empty state. There is no `empty` member to return, which is the executable
 * form of the rule.
 */
export type QuestTabState = 'active' | 'partial' | 'all-complete';

export function questTabState(completed: number, total: number): QuestTabState {
  if (total > 0 && completed >= total) return 'all-complete';
  if (completed > 0) return 'partial';
  return 'active';
}

/* -------------------------------------------------------------- the monthly badge */

/**
 * The badge's ONLY key: the `YYYY-MM` of `max_local_day_seen`, never the live clock
 * (INV-ECO-22 / EC-ECO-25), so winding the clock across a boundary can neither mint a
 * second challenge nor silently discard a month of progress.
 */
export function badgeMonthKey(day: LocalDay): string {
  return day.slice(0, 7);
}

export interface MonthlyBadgeRow {
  readonly monthKey: string;
  /** Progress is a COUNT OF COMPLETED QUESTS, not cumulative XP (EC-ECO-11). */
  readonly questsCompleted: number;
  readonly targetQuests: number;
  readonly tier: string;
}

/** The tier and target for a month, derived ONCE from the trend at month start. */
export function badgeTargetForMonth(medianDailyXp: number): {
  readonly quests: number;
  readonly tier: string;
} {
  const base = clampQuestBase(medianDailyXp);
  const index = base >= 100 ? 2 : base >= 40 ? 1 : 0;
  const tier = MONTHLY_BADGE_TIERS[index] ?? MONTHLY_BADGE_TIERS[0];
  if (tier === undefined) throw new Error('monthly badge: no tiers configured');
  return { quests: tier.quests, tier: tier.tier };
}

export interface BadgeRollResult {
  readonly row: MonthlyBadgeRow;
  /** The month that just ended, so a summary can be armed. Never a silent reset. */
  readonly archived: MonthlyBadgeRow | null;
}

/**
 * Roll the badge to the month of `maxLocalDaySeen` (INV-ECO-22).
 *
 * Within the same month this returns the SAME ROW OBJECT: the target is derived once at
 * month start and never re-derived, so a mid-month change of trend cannot move the goal
 * posts under a learner who is halfway to gold. A month that has gone BACKWARDS (a clock
 * or zone move) is ignored for the same reason.
 */
export function rollBadgeMonth(
  row: MonthlyBadgeRow | null,
  maxLocalDaySeen: LocalDay,
  medianDailyXp: number,
): BadgeRollResult {
  const monthKey = badgeMonthKey(maxLocalDaySeen);
  if (row !== null && monthKey <= row.monthKey) return { row, archived: null };
  const target = badgeTargetForMonth(medianDailyXp);
  return {
    row: { monthKey, questsCompleted: 0, targetQuests: target.quests, tier: target.tier },
    archived: row,
  };
}

/* ----------------------------------------------------------------- Strategist */

/** A guidebook open, or a completed session, tagged with where and when it happened. */
export interface UnitDayEvent {
  readonly localDay: LocalDay;
  readonly unitId: string;
  readonly atUtc: string;
}

/**
 * INV-ECO-29 / EC-ECO-34: Strategist fires only on a guidebook open FOLLOWED BY a
 * completed session in the SAME unit on the SAME local day. A guidebook opened alone
 * never earns it — that is the named falsifier — and neither does a session that
 * happened before the guidebook was opened.
 */
export function strategistFires(
  guidebookOpens: readonly UnitDayEvent[],
  completedSessions: readonly UnitDayEvent[],
): boolean {
  return guidebookOpens.some((open) =>
    completedSessions.some(
      (session) =>
        session.unitId === open.unitId &&
        session.localDay === open.localDay &&
        Date.parse(session.atUtc) > Date.parse(open.atUtc),
    ),
  );
}
