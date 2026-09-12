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
import {
  addCivilDays,
  civilDaysBetween,
  localMidnightUtcMs,
  weekKeyOf,
  weekdayOf,
  type LocalDay,
} from './civil.js';
import { DAY_CONFIG } from './config.js';
import type { DayCell, DayLedger } from './dispositions.js';
import { DAY_CELL_PROVENANCE, dayCellOf, livedDays } from './dispositions.js';
import { freezesHeld, type FreezeLedger } from './freeze.js';
import type { SessionRow } from './session.js';
import type { DayEngineState } from './state.js';
import { STREAK_MILESTONES } from '../streak/milestones.js';
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

/* ------------------------------------------------------- the screens these facts feed */

/**
 * S127, the streak calendar: one cell per civil date in `[from, to]`.
 *
 * The whole point of routing this through the engine is that the six product-map cell
 * states are decided here, from recorded facts, and the view only draws them. In
 * particular `half-flame` comes from `state.graceCreditedDays`, which is why the grace
 * window has to survive rollover rather than dying on the session row.
 */
export function calendarCells(
  state: Pick<DayEngineState, 'dispositions' | 'graceCreditedDays'>,
  from: LocalDay,
  to: LocalDay,
): { readonly day: LocalDay; readonly cell: DayCell; readonly provenance: string | null }[] {
  const cells: { day: LocalDay; cell: DayCell; provenance: string | null }[] = [];
  let cursor = from;
  while (cursor <= to) {
    const cell = dayCellOf(state.dispositions.get(cursor), state.graceCreditedDays.has(cursor));
    cells.push({ day: cursor, cell, provenance: DAY_CELL_PROVENANCE[cell] });
    cursor = addCivilDays(cursor, 1);
  }
  return cells;
}

/**
 * S143 / S127: `Streak frozen yesterday. Extend your streak now!`
 *
 * A day-scoped query rather than a scan of the rollover event log, because the notice
 * fires on a morning that may be several foregrounds after the walk that spent the
 * freeze. The copy must not congratulate: the learner did not earn that day.
 */
export function wasFrozenOn(
  state: Pick<DayEngineState, 'dispositions'>,
  day: LocalDay,
): boolean {
  return state.dispositions.get(day) === 'frozen';
}

export function frozenYesterday(
  state: Pick<DayEngineState, 'dispositions'>,
  today: LocalDay,
): boolean {
  return wasFrozenOn(state, addCivilDays(today, -1));
}

/**
 * S126 "Longest Streak", and the S127 banner `You've earned your longest streak ever!`.
 *
 * EC-FRZ-19 rules that the longest streak "stays 22 until a lived day passes it", so a
 * restore never moves it: `state.longestStreak` is only ever raised by the rollover walk,
 * on a day it has decided.
 */
export function longestStreak(state: Pick<DayEngineState, 'longestStreak'>): number {
  return state.longestStreak;
}

export function hasEarnedLongestStreakEver(
  state: Pick<DayEngineState, 'longestStreak'>,
  currentStreak: number,
): boolean {
  return currentStreak > 0 && currentStreak >= state.longestStreak;
}

/** S127: `You'll reach your next streak milestone on {{date}}!` — null past the last one. */
export function nextMilestoneDay(currentStreak: number, today: LocalDay): LocalDay | null {
  const next = STREAK_MILESTONES.find((m) => m > currentStreak);
  return next === undefined ? null : addCivilDays(today, next - currentStreak);
}

/**
 * S121: `Refills in {{n}} day(s)`.
 *
 * Null at a full balance — there is nothing to refill and the card shows the count
 * instead. Otherwise the civil days until the `timed_refill` channel's next tick, counted
 * from the most recent timed refill (or, on a fresh account that has never had one, from
 * the first grant the ledger holds).
 */
export function daysUntilFreezeRefill(ledger: FreezeLedger, today: LocalDay): number | null {
  if (freezesHeld(ledger) >= ledger.cap) return null;
  const period = DAY_CONFIG.freezeRefillIntervalDays;
  const timed = ledger.grants
    .filter((g) => g.channel === 'timed_refill')
    .map((g) => g.ownedFromDay)
    .sort();
  const anchor = timed.at(-1) ?? [...ledger.grants].map((g) => g.ownedFromDay).sort()[0];
  if (anchor === undefined) return period;
  const elapsed = civilDaysBetween(anchor, today);
  if (elapsed < 0) return period;
  const remaining = period - (elapsed % period);
  return remaining === 0 ? period : remaining;
}
