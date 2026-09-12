/**
 * The day engine's whole persisted state, and the records it is made of.
 *
 * Everything here is a recorded FACT. Nothing in this file is ever recomputed from the
 * current clock — that is INV-DAY-06, and it is the reason a learner cannot un-break a
 * streak by winding the date back.
 */
import type { LocalDay } from './civil.js';
import { DAY_CONFIG } from './config.js';
import type { DayDisposition } from './dispositions.js';
import { newFreezeLedger, type FreezeLedger } from './freeze.js';

/**
 * A break, recorded once and never recomputed (INV-DAY-06, EC-STK-10).
 * `uncoveredDays` is what a restore repaints and what recovery eligibility counts —
 * freeze-covered days never appear here, because the streak never broke on them
 * (EC-FRZ-18).
 */
export interface BreakRecord {
  readonly brokenOn: LocalDay;
  readonly previousStreak: number;
  readonly uncoveredDays: readonly LocalDay[];
}

/**
 * A gap longer than `maxOfflineDays`, collapsed rather than enumerated: a "Welcome back"
 * state, not 45 animated grey cells (EC-FRZ-04). The days inside it are processed — they
 * are counted, their months are settled — but only the freeze-covered head and the single
 * breaking day get their own calendar cells.
 */
export interface LongAbsence {
  readonly from: LocalDay;
  readonly to: LocalDay;
  readonly days: number;
  readonly freezesConsumed: number;
}

/**
 * A month-keyed settlement: the monthly badge and the monthly Streak Repair allowance are
 * the only month-keyed events (EC-STK-25). Fired on the first PROCESSED local day whose
 * `YYYY-MM` differs from `lastProcessedMonth`, and guarded by the settled-month set so a
 * date-line hop over the 1st can neither skip nor double one (INV-DAY-16).
 */
export interface MonthSettlement {
  /** The month that opened. */
  readonly month: string;
  /** The month it settled, or null for the very first. */
  readonly settledMonth: string | null;
  readonly atDay: LocalDay;
}

/** A monthly Streak Repair, idempotent on `(year, month)` (INV-REC-01, EC-FRZ-13). */
export interface RepairRecord {
  /** `YYYY-MM` of `max_local_day_seen` — the month key EC-STK-25 settled. */
  readonly monthKey: string;
  readonly onDay: LocalDay;
  readonly restoredStreak: number;
  readonly repaintedDays: readonly LocalDay[];
}

/**
 * The 3-lesson recovery challenge. Its window is measured in LOCAL DAYS from `broken_on`,
 * never from acceptance, so it cannot drift across DST (EC-FRZ-15).
 */
export interface RecoveryChallenge {
  readonly brokenOn: LocalDay;
  readonly previousStreak: number;
  /** Inclusive last local day on which a lesson may be STARTED (INV-REC-04/05). */
  readonly expiresAfterDay: LocalDay;
  readonly lessonsRequired: number;
  /** Partial progress, persisted like any other session (EC-FRZ-10, INV-REC-03). */
  readonly lessonsDone: number;
  /**
   * The local day the LAST required lesson landed on, written once when `lessonsDone`
   * reaches `lessonsRequired` and null before that.
   *
   * INV-REC-05 deliberately lets a session STARTED inside the window finish late, so an
   * earned challenge has to outlive `expiresAfterDay`. Recording the day it was earned is
   * what keeps that from being unbounded: the row says when the learner actually did the
   * work, so a challenge earned in September cannot be cashed in December.
   */
  readonly earnedOnDay: LocalDay | null;
}

/**
 * NOTE — there is deliberately **no** `uncoveredDays` on the challenge row.
 *
 * It used to carry a copy taken at `armChallenge` time, and that copy went stale the
 * moment the learner missed another day inside the window: `rolloverTo` kept appending to
 * `BreakRecord.uncoveredDays` while the challenge still held the day-one snapshot, so a
 * completed challenge repainted only the first missed date, left the second one `missed`,
 * computed a streak of 1 instead of `previous_streak + 1`, and then cleared `brk` — losing
 * the streak AND the recovery offer while reporting success. The break record is the one
 * live copy; `completeChallenge` reads it at completion time.
 */

export interface DayEngineState {
  /** The last civil date whose disposition is decided. The rollover walk's marker. */
  readonly lastProcessedDay: LocalDay | null;
  /** The clock-tamper sentinel: the furthest civil date ever observed (EC-STK-12). */
  readonly maxLocalDaySeen: LocalDay | null;
  readonly dispositions: ReadonlyMap<LocalDay, DayDisposition>;
  /**
   * The civil dates whose `completed` disposition came from the midnight grace window
   * rather than from a session that finished inside the day (INV-DAY-08). Kept beside
   * the dispositions rather than inside them so the streak walk stays a three-way rule,
   * while S127 can still draw the `half-flame` cell that EC-STK-13 requires.
   */
  readonly graceCreditedDays: ReadonlySet<LocalDay>;
  /**
   * The best streak ever DECIDED by the rollover walk (S126 "Longest Streak").
   *
   * EC-FRZ-19: "Longest streak stays 22 until a lived day passes it." A restore repaints
   * history but does not move this number, because the walk only ever raises it on a day
   * it has decided — and `today`, the day a restore satisfies, is never decided until the
   * next rollover.
   */
  readonly longestStreak: number;
  readonly ledger: FreezeLedger;
  readonly brk: BreakRecord | null;
  readonly challenge: RecoveryChallenge | null;
  readonly repairs: readonly RepairRecord[];
  readonly settlements: readonly MonthSettlement[];
  readonly lastProcessedMonth: string | null;
  readonly longAbsences: readonly LongAbsence[];
  /**
   * Set when the first-ever session's local day precedes the build date: award XP and
   * gems, defer streak/goal/quest day keying, adopt the first sane day as day one with no
   * backfill (EC-STK-23, INV-DAY-14).
   */
  readonly clockUnreliable: boolean;
}

export function newDayEngineState(options?: {
  readonly freezesOwnedFrom?: LocalDay;
  readonly cap?: number;
}): DayEngineState {
  const ownedFrom = options?.freezesOwnedFrom;
  return {
    lastProcessedDay: null,
    maxLocalDaySeen: null,
    dispositions: new Map(),
    graceCreditedDays: new Set(),
    longestStreak: 0,
    ledger:
      ownedFrom === undefined
        ? {
            cap: options?.cap ?? DAY_CONFIG.freezeCapBase,
            grants: [],
            consumptions: [],
          }
        : newFreezeLedger(ownedFrom, options?.cap ?? DAY_CONFIG.freezeCapBase),
    brk: null,
    challenge: null,
    repairs: [],
    settlements: [],
    lastProcessedMonth: null,
    longAbsences: [],
    clockUnreliable: false,
  };
}
