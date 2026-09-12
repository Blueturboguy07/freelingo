/**
 * Day-keyed predicates: goal chests, quest windows, and the achievement predicates that
 * are about local time rather than counts.
 *
 * The rule that ties them together: **a predicate reads the zone stamped on the row, never
 * the zone the device is in now** (INV-DAY-10). A lesson at 22:30 in Tokyo is nocturnal
 * forever, even though that instant is 05:30 in Los Angeles. Weekday-keyed predicates
 * additionally iterate only the LIVED local days, so a week whose Sunday the clock jumped
 * over is skipped rather than reset (INV-DAY-13).
 */
import { addCivilDays, localMidnightUtcMs, weekKeyOf, weekdayOf, type LocalDay } from './civil.js';
import type { DayLedger } from './dispositions.js';
import { livedDays } from './dispositions.js';
import type { SessionRow } from './session.js';
import { localDayOfStamp, type ZoneStamp } from './zone.js';

/** The wall-clock fields the row itself recorded. Nothing here reads a current zone. */
export function localTimeOfRow(row: SessionRow): {
  readonly day: LocalDay;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
} {
  const day = row.completedLocalDay;
  const midnight = localMidnightUtcMs(day, row.completionZone.utcOffsetMinutes);
  const seconds = Math.floor((row.derivedCompletionUtcMs - midnight) / 1000);
  return {
    day,
    hour: Math.floor(seconds / 3600),
    minute: Math.floor((seconds % 3600) / 60),
    weekday: weekdayOf(day),
  };
}

/** Nocturnal: a lesson between 22:00 and 23:59 local, as the row recorded it. */
export function isNocturnal(row: SessionRow): boolean {
  const { hour } = localTimeOfRow(row);
  return hour >= 22 && hour <= 23;
}

/**
 * Weekend Warrior: lessons on Saturday AND Sunday of the same week.
 *
 * EC-STK-22: fly LA → Sydney on a Saturday and the civil Sunday is never lived. A week
 * with no lived Sunday is SKIPPED — no reset, no negative signal — and a doubled civil
 * Saturday awards once. Returns the week keys (the Monday of each week) that qualify.
 */
export function weekendWarriorWeeks(rows: Iterable<SessionRow>, ledger: DayLedger): LocalDay[] {
  const lived = livedDays(ledger);
  const completedOn = new Set<LocalDay>();
  for (const row of rows) {
    if (row.creditedLocalDay !== null) completedOn.add(row.creditedLocalDay);
  }
  const weeks = new Set<LocalDay>();
  for (const day of completedOn) weeks.add(weekKeyOf(day));
  const awarded: LocalDay[] = [];
  for (const week of [...weeks].sort()) {
    // Monday-keyed week: Saturday is +5, Sunday is +6.
    const saturday = addCivilDays(week, 5);
    const sunday = addCivilDays(week, 6);
    if (!lived.has(saturday) || !lived.has(sunday)) continue;
    if (completedOn.has(saturday) && completedOn.has(sunday)) awarded.push(week);
  }
  return awarded;
}

/**
 * The distinct local days whose XP crossed the daily goal — one goal chest each, never
 * more (INV-DAY-08). Keyed to `rewardLocalDay`, i.e. to completion time, so a lesson
 * credited to the previous day by the grace window still pays its chest on the new day.
 */
export function goalChestDays(rows: Iterable<SessionRow>, goalXp: number): Set<LocalDay> {
  const xpByDay = new Map<LocalDay, number>();
  for (const row of rows) {
    if (row.rewardLocalDay === null) continue;
    xpByDay.set(row.rewardLocalDay, (xpByDay.get(row.rewardLocalDay) ?? 0) + row.earnedXp);
  }
  const crossed = new Set<LocalDay>();
  for (const [day, xp] of xpByDay) if (xp >= goalXp) crossed.add(day);
  return crossed;
}

/** Daily Most XP, per `local_day` — two lessons straddling midnight land in two records. */
export function dailyMostXp(rows: Iterable<SessionRow>): { day: LocalDay; xp: number } | null {
  const xpByDay = new Map<LocalDay, number>();
  for (const row of rows) {
    if (row.rewardLocalDay === null) continue;
    xpByDay.set(row.rewardLocalDay, (xpByDay.get(row.rewardLocalDay) ?? 0) + row.earnedXp);
  }
  let best: { day: LocalDay; xp: number } | null = null;
  for (const [day, xp] of xpByDay) {
    if (best === null || xp > best.xp || (xp === best.xp && day < best.day)) best = { day, xp };
  }
  return best;
}

/**
 * The quest day and the instant its countdown runs out.
 *
 * INV-DAY-12: progress is keyed to `local_day`, so a zone change preserves it; the
 * countdown re-derives and **may lengthen, never shorten below the true remaining time**.
 * Quests never reset early because of travel — which is why the recorded expiry is the
 * MAXIMUM of what was promised and what the new zone computes.
 */
export interface QuestWindow {
  readonly day: LocalDay;
  readonly expiresAtUtcMs: number;
}

export function questWindow(
  previous: QuestWindow | null,
  nowUtcMs: number,
  stamp: ZoneStamp,
): QuestWindow {
  const day = localDayOfStamp(new Date(nowUtcMs), stamp);
  const trueExpiry = localMidnightUtcMs(addCivilDays(day, 1), stamp.utcOffsetMinutes);
  if (previous !== null && previous.day === day) {
    return { day, expiresAtUtcMs: Math.max(previous.expiresAtUtcMs, trueExpiry) };
  }
  return { day, expiresAtUtcMs: trueExpiry };
}

/** Seconds left on the quest countdown. Never negative. */
export function questCountdownSeconds(window: QuestWindow, nowUtcMs: number): number {
  return Math.max(0, Math.ceil((window.expiresAtUtcMs - nowUtcMs) / 1000));
}

/** Quest progress for a civil date: the rows keyed to it, whatever zone the device is in. */
export function questProgressXp(rows: Iterable<SessionRow>, day: LocalDay): number {
  let xp = 0;
  for (const row of rows) if (row.rewardLocalDay === day) xp += row.earnedXp;
  return xp;
}
