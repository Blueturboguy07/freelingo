/**
 * Session rows and the credited day.
 *
 * Every completed session writes `tz_id` and `local_day` at BOTH start and completion
 * (INV-DAY-04), and the day the streak is credited to is decided ONCE, at the S1a commit,
 * under the `session_id` idempotency key (INV-DAY-15). Two rules decide it, and they are
 * different rules for different reasons:
 *
 * 1. **The zone changed during the session** (EC-STK-05: Tokyo 23:52 → LA 07:03, the
 *    previous civil date). Credit the day that is NOT already satisfied, preferring the
 *    START day. A zone change alone must never produce a `local_day` regression.
 * 2. **Local midnight passed during the session** (EC-STK-12, `deep/04` case 42). If the
 *    session started before midnight, finishes within `graceSeconds` of it, and the start
 *    day is otherwise unsatisfied, the STREAK is credited to the start day — "Just made
 *    it!". XP, quests, the goal chest and Daily Most XP stay keyed to completion time
 *    (INV-DAY-08), which is why this file returns two different days per row.
 *
 * And one rule about HOW the completion instant is read: never two wall-clock reads across
 * an NTP sync (EC-STK-24). The grace decision is computed from the start instant plus
 * MONOTONIC elapsed, with a negative elapsed clamped to zero, so a clock correction
 * mid-session cannot move the credited day.
 */
import {
  addCivilDays,
  localMidnightUtcMs,
  secondsPastLocalMidnight,
  type LocalDay,
} from './civil.js';
import { DAY_CONFIG } from './config.js';
import { localDayOfStamp, sameZone, type ZoneStamp } from './zone.js';

/** What the app knows when a session STARTS. Written at row creation (EC-STK-24). */
export interface SessionStart {
  readonly sessionId: string;
  readonly startedAtUtcMs: number;
  /** A never-decreasing device counter. The only elapsed measurement that is trusted. */
  readonly startedAtMonotonicMs: number;
  readonly startZone: ZoneStamp;
}

/** What the app knows at the S1a commit. */
export interface SessionCompletion {
  /** The wall clock at completion. Recorded, but NOT used to derive the credited day. */
  readonly completedAtUtcMs: number;
  readonly completedAtMonotonicMs: number;
  readonly completionZone: ZoneStamp;
  readonly earnedXp: number;
  readonly earnedGems: number;
}

export interface SessionRow {
  readonly sessionId: string;
  readonly startedAtUtcMs: number;
  readonly startZone: ZoneStamp;
  readonly startedLocalDay: LocalDay;
  readonly completedAtUtcMs: number;
  readonly completionZone: ZoneStamp;
  readonly completedLocalDay: LocalDay;
  /**
   * The instant the commit believes it happened at: start + monotonic elapsed. Grace,
   * boost expiry and the completion day are all read off this and never off the wall
   * clock at commit time.
   */
  readonly derivedCompletionUtcMs: number;
  /** The STREAK day. Written once; every later rollover reproduces it (INV-DAY-15). */
  readonly creditedLocalDay: LocalDay | null;
  /** XP, quests, goal chest, Daily Most XP. Strictly completion-keyed (INV-DAY-08). */
  readonly rewardLocalDay: LocalDay | null;
  /** True when the streak landed on the start day through the grace window. */
  readonly creditedByGrace: boolean;
  /**
   * True when the clock was not trustworthy at all (INV-DAY-14): XP and gems are still
   * awarded, every day-keyed reward is deferred, and both day fields are null.
   */
  readonly dayKeyingDeferred: boolean;
  readonly earnedXp: number;
  readonly earnedGems: number;
}

export interface CommitContext {
  /** Civil dates already satisfied — the input to "the day that is not already satisfied". */
  readonly satisfiedDays: ReadonlySet<LocalDay>;
  /** Rows already committed, keyed by `session_id`. A replay returns the stored row. */
  readonly committed?: ReadonlyMap<string, SessionRow>;
  /** Overrides `DAY_CONFIG.buildLocalDay` in tests that need a different build date. */
  readonly buildLocalDay?: string;
}

/**
 * Commit a session. Idempotent on `session_id`: a replay returns the row already written,
 * byte for byte, so a kill during the ceremony commit cannot move the credited day, double
 * the XP or mint a second chest (`deep/04` case 29, INV-DAY-15).
 */
export function commitSession(
  start: SessionStart,
  completion: SessionCompletion,
  ctx: CommitContext,
): SessionRow {
  const existing = ctx.committed?.get(start.sessionId);
  if (existing !== undefined) return existing;

  const startedLocalDay = localDayOfStamp(new Date(start.startedAtUtcMs), start.startZone);
  // Monotonic elapsed, clamped: a negative elapsed means the counter was reset and is
  // logged as zero rather than trusted (EC-STK-24).
  const elapsedMs = Math.max(0, completion.completedAtMonotonicMs - start.startedAtMonotonicMs);
  const derivedCompletionUtcMs = start.startedAtUtcMs + elapsedMs;
  const completedLocalDay = localDayOfStamp(
    new Date(derivedCompletionUtcMs),
    completion.completionZone,
  );

  const buildLocalDay = ctx.buildLocalDay ?? DAY_CONFIG.buildLocalDay;
  if (startedLocalDay < buildLocalDay) {
    // The 1970 install. Award XP and gems; defer every day-keyed reward (INV-DAY-14).
    return {
      sessionId: start.sessionId,
      startedAtUtcMs: start.startedAtUtcMs,
      startZone: start.startZone,
      startedLocalDay,
      completedAtUtcMs: completion.completedAtUtcMs,
      completionZone: completion.completionZone,
      completedLocalDay,
      derivedCompletionUtcMs,
      creditedLocalDay: null,
      rewardLocalDay: null,
      creditedByGrace: false,
      dayKeyingDeferred: true,
      earnedXp: completion.earnedXp,
      earnedGems: completion.earnedGems,
    };
  }

  const zoneChanged = !sameZone(start.startZone, completion.completionZone);
  let creditedLocalDay = completedLocalDay;
  let creditedByGrace = false;

  if (startedLocalDay !== completedLocalDay) {
    if (zoneChanged) {
      // INV-DAY-04: the day not already satisfied, preferring the start day.
      creditedLocalDay = !ctx.satisfiedDays.has(startedLocalDay)
        ? startedLocalDay
        : !ctx.satisfiedDays.has(completedLocalDay)
          ? completedLocalDay
          : startedLocalDay;
    } else if (
      startedLocalDay < completedLocalDay &&
      !ctx.satisfiedDays.has(startedLocalDay) &&
      secondsPastLocalMidnight(
        new Date(derivedCompletionUtcMs),
        completion.completionZone.utcOffsetMinutes,
      ) <= DAY_CONFIG.graceSeconds &&
      // The grace window is one midnight wide: it saves the day the session started on,
      // never a day two boundaries back.
      addCivilDays(startedLocalDay, 1) === completedLocalDay
    ) {
      creditedLocalDay = startedLocalDay;
      creditedByGrace = true;
    }
  }

  return {
    sessionId: start.sessionId,
    startedAtUtcMs: start.startedAtUtcMs,
    startZone: start.startZone,
    startedLocalDay,
    completedAtUtcMs: completion.completedAtUtcMs,
    completionZone: completion.completionZone,
    completedLocalDay,
    derivedCompletionUtcMs,
    creditedLocalDay,
    // Strictly completion-keyed, whatever the streak did (INV-DAY-08).
    rewardLocalDay: completedLocalDay,
    creditedByGrace,
    dayKeyingDeferred: false,
    earnedXp: completion.earnedXp,
    earnedGems: completion.earnedGems,
  };
}

/** How a day-keyed reward request was classified against the tamper sentinel. */
export type DayKeyVerdict = 'forward' | 'travel-regression' | 'tamper';

export interface DayKeyGuardState {
  readonly maxLocalDaySeen: LocalDay | null;
  readonly lastCompletedAtUtcMs: number | null;
  readonly lastZone: ZoneStamp | null;
}

/**
 * EC-STK-02, the contradiction the plan settled and "the most likely real bug for the
 * stated traveller profile": `deep/04` case 1 calls a westward `local_day` regression
 * benign, case 12's anti-tamper rule refuses EVERY day-keyed reward for exactly that
 * condition.
 *
 * **Ruling: a regression is honoured iff `completed_at_utc` is monotonically increasing
 * AND the zone changed.** Travel is honoured — the re-lived civil date still pays its
 * unclaimed goal or quest chest and never arms the tamper flag. A stalled or reversed
 * instant, or a regression with no zone change, is tampering and is refused.
 */
export function classifyDayKey(
  guard: DayKeyGuardState,
  row: {
    readonly completedAtUtcMs: number;
    readonly completionZone: ZoneStamp;
    readonly day: LocalDay;
  },
): DayKeyVerdict {
  if (guard.maxLocalDaySeen === null || row.day >= guard.maxLocalDaySeen) return 'forward';
  const utcMonotonic =
    guard.lastCompletedAtUtcMs === null || row.completedAtUtcMs > guard.lastCompletedAtUtcMs;
  const zoneChanged = guard.lastZone === null || !sameZone(guard.lastZone, row.completionZone);
  return utcMonotonic && zoneChanged ? 'travel-regression' : 'tamper';
}

/** May this row mint a day-keyed reward (goal chest, quest chest, Early Bird)? */
export function mayMintDayKeyedReward(
  guard: DayKeyGuardState,
  row: {
    readonly completedAtUtcMs: number;
    readonly completionZone: ZoneStamp;
    readonly day: LocalDay;
  },
): boolean {
  return classifyDayKey(guard, row) !== 'tamper';
}

/** The UTC instant of the local midnight that opens `day` under `stamp`. */
export function midnightOpening(day: LocalDay, stamp: ZoneStamp): number {
  return localMidnightUtcMs(day, stamp.utcOffsetMinutes);
}
