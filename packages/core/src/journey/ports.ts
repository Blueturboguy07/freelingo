/**
 * What the journey driver needs from the engine, declared as ports.
 *
 * The driver is the one test in P1 that sees every module at once, and it is written
 * while the eight module lanes are still being written. Two things follow.
 *
 * **It binds by capability, not by import.** A static `import { rolloverTo } from
 * '../day/rollover.js'` makes the whole file — and therefore the whole journey — fail to
 * compile until the last lane lands, and it hard-codes one file path for something whose
 * home is that lane's decision. `bind.ts` resolves each capability from a list of
 * candidate modules and export names, and reports the ones it could not find. A missing
 * capability is then a *named, actionable* gate failure ("the recovery lane exports no
 * restore function") instead of a module-not-found stack trace.
 *
 * **The shapes are structural and local.** Each port below mirrors the shape the owning
 * lane publishes, written out here rather than imported, so this file stays compilable on
 * a tree where that lane has not landed. That is a real cost: these types are a copy, and
 * a lane that changes its shape makes the *bind* fail rather than the *typecheck*. The
 * trade is deliberate — the driver is a gate, and a gate that cannot run until everything
 * is perfect is a gate that never runs at all.
 *
 * Every port names the lane that owns it. When the journey refutes something, the report
 * names that lane rather than patching across the boundary (plan §The build workflow,
 * step 4).
 */

/* ------------------------------------------------------------------ day lane */

/** `YYYY-MM-DD` in some zone. The engine brands this; the port does not need the brand. */
export type Day = string;

/** A zone as the day lane stamps it on a row: an IANA id plus the offset in force. */
export interface ZoneStampPort {
  readonly tzId: string;
  readonly utcOffsetMinutes: number;
  readonly tzSource: string;
}

export type Disposition = 'completed' | 'frozen' | 'missed' | 'unlived' | 'recovered';

export interface BreakRecordPort {
  readonly brokenOn: Day;
  readonly previousStreak: number;
  readonly uncoveredDays: readonly Day[];
}

export interface RepairRecordPort {
  readonly monthKey: string;
  readonly onDay: Day;
  readonly restoredStreak: number;
}

export interface RecoveryChallengePort {
  readonly brokenOn: Day;
  readonly previousStreak: number;
  readonly expiresAfterDay: Day;
  readonly lessonsRequired: number;
  readonly lessonsDone: number;
}

/** The day engine's persisted state. Opaque to the driver except for these readings. */
export interface DayStatePort {
  readonly lastProcessedDay: Day | null;
  readonly dispositions: ReadonlyMap<Day, Disposition>;
  readonly brk: BreakRecordPort | null;
  readonly challenge: RecoveryChallengePort | null;
  readonly repairs: readonly RepairRecordPort[];
  readonly settlements: readonly { readonly month: string }[];
  readonly ledger: unknown;
}

export interface RolloverResultPort {
  readonly state: DayStatePort;
  readonly freezesConsumed: number;
  readonly daysProcessed: number;
  readonly events: readonly { readonly kind: string }[];
}

export interface SessionRowPort {
  readonly sessionId: string;
  readonly creditedLocalDay: Day | null;
  readonly rewardLocalDay: Day | null;
  readonly earnedXp: number;
  readonly earnedGems: number;
}

/**
 * The day lane (`packages/core/src/day/`), owner of §6 DAY and §7 FRZ/REC.
 *
 * `rolloverTo` is the one the journey replays: every simulated day is rolled over once,
 * then rolled over again with the same arguments, and the second call must change nothing.
 */
export interface DayPort {
  localDayOf(instant: Date, timeZone: string): Day;
  addCivilDays(day: Day, delta: number): Day;
  civilDaysBetween(a: Day, b: Day): number;
  resolveZone(instant: Date, tzId: string): ZoneStampPort;
  newState(options?: { readonly freezesOwnedFrom?: Day; readonly cap?: number }): DayStatePort;
  rolloverTo(
    state: DayStatePort,
    today: Day,
    ctx: { readonly completedDays: ReadonlySet<Day>; readonly unlivedDays?: ReadonlySet<Day> },
  ): RolloverResultPort;
  streakFromDispositions(state: DayStatePort, today: Day): number;
  commitSession(
    start: {
      readonly sessionId: string;
      readonly startedAtUtcMs: number;
      readonly startedAtMonotonicMs: number;
      readonly startZone: ZoneStampPort;
    },
    completion: {
      readonly completedAtUtcMs: number;
      readonly completedAtMonotonicMs: number;
      readonly completionZone: ZoneStampPort;
      readonly earnedXp: number;
      readonly earnedGems: number;
    },
    ctx: {
      readonly satisfiedDays: ReadonlySet<Day>;
      readonly committed?: ReadonlyMap<string, SessionRowPort>;
    },
  ): SessionRowPort;
  /** Bounded rollover deferral — INV-DAY-09's `maxRolloverDeferralSeconds` ceiling. */
  rolloverDeferral(
    nowMs: number,
    localMidnightMs: number,
    ctx: { readonly sessionInProgress: boolean; readonly lastCheckpointMs: number | null },
  ): { readonly defer: boolean; readonly untilMs: number };
  /** Civil dates a zone change jumped over. INV-DAY-03's `unlived`. */
  unlivedDaysFromTransitions(
    transitions: readonly {
      readonly atUtcMs: number;
      readonly from: ZoneStampPort;
      readonly to: ZoneStampPort;
    }[],
  ): ReadonlySet<Day>;
}

/** Freeze grants and the freeze economy — §7 FRZ, day lane. */
export interface FreezePort {
  grant(
    ledger: unknown,
    request: {
      readonly channel: string;
      readonly count: number;
      readonly grantKey: string;
      readonly onDay: Day;
    },
  ): { readonly ledger: unknown; readonly granted: number };
  held(ledger: unknown): number;
}

/** Recovery challenge and the monthly Streak Repair — §7 REC, day lane. */
export interface RecoveryPort {
  /** Record one completed recovery lesson; returns the new day state. */
  completeLesson(state: DayStatePort, onDay: Day): DayStatePort;
  /** Attempt the monthly Streak Repair; `granted: false` when the month is spent. */
  repair(
    state: DayStatePort,
    onDay: Day,
  ): { readonly state: DayStatePort; readonly granted: boolean };
}

/* -------------------------------------------------------------- session lane */

export interface SessionQueueItemPort {
  readonly itemId: string;
}

/** Session generation, the nine-field resume row and the in-flight guard — §1 SESS. */
export interface SessionPort {
  generate(input: {
    readonly courseId: string;
    readonly seed: number;
    readonly target: number;
    readonly duePool: readonly string[];
    readonly newPool: readonly string[];
  }): { readonly items: readonly SessionQueueItemPort[] };
  /** Serialise the resume row; the journey kills and restores through this. */
  checkpoint(session: unknown): unknown;
  restore(row: unknown): unknown;
}

/* -------------------------------------------------------------- grading lane */

/** Three tiers, the soft notes and the typo guards — §2 GRD. */
export interface GradingPort {
  grade(input: { readonly answer: string; readonly accepted: readonly string[] }): {
    readonly verdict: string;
  };
}

/* ------------------------------------------------------------ scheduler lane */

/** FSRS rows, the early-review guard and quarantine — §5 SCH. */
export interface SchedulerPort {
  review(input: { readonly row: unknown; readonly rating: number; readonly atMs: number }): unknown;
  /** Rows whose items vanished in a pack major bump are quarantined, never scheduled. */
  quarantine(
    rows: readonly unknown[],
    liveItemIds: ReadonlySet<string>,
  ): {
    readonly kept: readonly unknown[];
    readonly quarantined: readonly unknown[];
  };
}

/* -------------------------------------------------------------- economy lane */

/** A boost as the account holds it: expiry is a UTC instant, never a duration. */
export interface ActiveBoostPort {
  readonly kind: string;
  readonly multiplier: number;
  readonly startedAtUtc: string;
  readonly expiresAtUtc: string;
}

export interface SessionAwardPort {
  readonly baseXp: number;
  readonly recordedMultiplier: number;
  /**
   * What the commit applied. Equal to the recorded multiplier unless the session was
   * parked past `boostExpiry + boostGraceSeconds`, in which case it is 1 (EC-ECO-02).
   */
  readonly multiplierApplied: number;
  readonly awardedXp: number;
  readonly explanation: string;
}

/** The one config table, the boost grace window and the XP award — §8 ECO. */
export interface EconomyPort {
  /** The named goal tiers: 10/20/30/50 XP for Casual/Regular/Serious/Intense (EC-ECO-01). */
  goalXp(tier: string): number;
  /** `base (+ combo) x ladder x boost`, clamped to what is left of the mode's daily cap. */
  awardForSession(input: {
    readonly flavour: string;
    readonly outcome: string;
    readonly boostAtSessionStart: ActiveBoostPort | null;
    readonly committedAtUtc: string;
    readonly ladderStateToday: { readonly sessionsCompleted: number; readonly xpAwarded: number };
  }): SessionAwardPort;
  readonly boostGraceSeconds: number;
}

/* ---------------------------------------------------------- packs/data lanes */

/** Pack state and the major-bump quarantine — §14 PACK. */
export interface PacksPort {
  /** The six-value enum's state for a pack the journey installs. */
  stateOf(input: {
    readonly installedVersion: string | null;
    readonly signatureValid: boolean;
  }): string;
  isMajorBump(from: string, to: string): boolean;
}

/** Export, wipe and import — §13 DAT. */
export interface DataPort {
  exportProgress(db: unknown): unknown;
  importProgress(db: unknown, dump: unknown): unknown;
}

/* ------------------------------------------------------------------- bundle */

/**
 * Everything the driver may use. A capability the bind could not resolve is `null`, and
 * the journey names it in its failure rather than pretending it ran.
 */
export interface Engine {
  readonly day: DayPort | null;
  readonly freeze: FreezePort | null;
  readonly recovery: RecoveryPort | null;
  readonly session: SessionPort | null;
  readonly grading: GradingPort | null;
  readonly scheduler: SchedulerPort | null;
  readonly economy: EconomyPort | null;
  readonly packs: PacksPort | null;
  readonly data: DataPort | null;
}

/** Which lane owes a missing port, for the refutation report. */
export const PORT_OWNER: Readonly<Record<keyof Engine, string>> = {
  day: 'p1-day-freeze-recovery',
  freeze: 'p1-day-freeze-recovery',
  recovery: 'p1-day-freeze-recovery',
  session: 'p1-session-runtime',
  grading: 'p1-grading',
  scheduler: 'p1-scheduler',
  economy: 'p1-foundation-economy-schema',
  packs: 'p1-packs-data-security',
  data: 'p1-packs-data-security',
};
