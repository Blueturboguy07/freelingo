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
  /** The streak as of `today`, over the disposition ledger. Today may be undecided. */
  streakFromDispositions(dispositions: ReadonlyMap<Day, Disposition>, today: Day): number;
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

/**
 * Freeze grants — §7 FRZ, day lane.
 *
 * `applied` rather than `granted`: the grant is clamped to `cap - held` and a replay on
 * the same `grantKey` applies nothing, so "how many the request asked for" and "how many
 * the balance actually gained" are different numbers and the port uses the second.
 */
export interface FreezePort {
  grant(
    ledger: unknown,
    request: {
      readonly grantKey: string;
      readonly channel: string;
      readonly ownedFromDay: Day;
      readonly amount: number;
    },
  ): { readonly ledger: unknown; readonly applied: number; readonly ceremony: boolean };
  held(ledger: unknown): number;
}

/** Recovery challenge and the monthly Streak Repair — §7 REC, day lane. */
export interface RecoveryPort {
  offer(
    state: DayStatePort,
    today: Day,
  ): {
    readonly challengeArmed: boolean;
    readonly repairArmed: boolean;
    readonly brokenOn: Day | null;
    readonly uncoveredDays: readonly Day[];
  };
  /** Arm the 3-lesson challenge from the recorded break. Idempotent. */
  arm(state: DayStatePort, today: Day): DayStatePort;
  /** One completed recovery lesson, keyed to the day the SESSION STARTED (INV-REC-05). */
  recordLesson(state: DayStatePort, startedOnDay: Day): DayStatePort;
  /** The third lesson: streak = previous_streak AND today satisfied (INV-REC-02). */
  completeChallenge(
    state: DayStatePort,
    today: Day,
  ): { readonly state: DayStatePort; readonly restored: boolean; readonly streakAfter: number };
  /** The monthly repair: streak = previous_streak, today left unsatisfied (INV-REC-01). */
  repair(
    state: DayStatePort,
    today: Day,
  ): {
    readonly state: DayStatePort;
    readonly restored: boolean;
    readonly declinedBecause: string | null;
  };
}

/* -------------------------------------------------------------- session lane */

export interface QueuedItemPort {
  readonly id: string;
  readonly itemId: string;
}

export interface GeneratedSessionPort {
  readonly offered: boolean;
  readonly reason: string;
  readonly queue: readonly QueuedItemPort[];
  readonly optionSeeds: Readonly<Record<string, number>>;
}

/**
 * Session generation, the nine-field resume row and the in-flight guard - §1 SESS.
 *
 * `generate` needs a whole `GenerationRequest`: authored candidates plus an audio, pack,
 * modality and scheduler port. The journey builds one from the lane's own fixture
 * builders and test doubles rather than inventing them - `modality/` is P3 and does not
 * exist yet, and a double the lane wrote is that lane's answer to "what does absent look
 * like", not the journey's guess at it.
 */
export interface SessionPort {
  generate(request: Readonly<Record<string, unknown>>): GeneratedSessionPort;
  /** `items(count, options)` in the lane's fixture module: authored candidates. */
  items(count: number, options?: Readonly<Record<string, unknown>>): readonly QueuedItemPort[];
  /** Write the resume checkpoint at a monotonic instant. */
  checkpoint(state: unknown, monotonicMs: number): unknown;
  serialise(state: unknown): string;
  deserialise(raw: string): unknown;
  /** A fresh runtime state for the resume round trip. */
  freshSession(options: Readonly<Record<string, unknown>>): unknown;
  /** The lane's own test doubles for the ports the journey has no engine for yet. */
  readonly doubles: {
    readonly audio: new (unavailable?: readonly string[]) => unknown;
    readonly pack: new (options?: Readonly<Record<string, unknown>>) => unknown;
    readonly modality: new (gated?: readonly string[]) => unknown;
    readonly scheduler: new () => unknown;
  };
}

/* -------------------------------------------------------------- grading lane */

export interface GradingVerdictPort {
  /** 1 exact, 2 soft-corrected, 3 wrong. 0 is "CHECK was never armed". */
  readonly tier: number;
  readonly verdictClass: string;
  readonly wrong: boolean;
  readonly softCorrected: boolean;
  readonly heartCost: number;
}

/**
 * Three tiers, the soft notes and the typo guards - §2 GRD.
 *
 * The journey grades real Spanish through the lane's own `ES_PACK`/`ES_UNIT` fixtures
 * rather than a made-up pack: the normalisation table, the equivalence classes and the
 * word list are part of what a verdict means, and a pack invented here would grade
 * against rules no course has.
 */
export interface GradingPort {
  grade(request: Readonly<Record<string, unknown>>): GradingVerdictPort;
  readonly pack: unknown;
  readonly unit: unknown;
}

/* ------------------------------------------------------------ scheduler lane */

/**
 * FSRS rows, the attempt ledger and the early-review guard - §5 SCH.
 *
 * The journey uses it for one thing the other lanes cannot show: INV-SCH-03, "a replayed
 * commit is idempotent". Every answered exercise is applied once and then applied again
 * with the same `(session_id, exercise_index)`, and the second call must write nothing.
 */
export interface SchedulerPort {
  emptyState(timeZone: string): unknown;
  registerRows(
    state: unknown,
    specs: readonly {
      readonly itemId: string;
      readonly surface: string;
      readonly kind: string;
    }[],
  ): unknown;
  introduce(state: unknown, itemId: string, surface: string, at: Date): unknown;
  applyEncounter(
    state: unknown,
    encounter: Readonly<Record<string, unknown>>,
  ): { readonly state: unknown; readonly wroteAttempt: boolean };
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

/** The one config table, the boost grace window and the XP award - §8 ECO. */
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

export interface ScheduledItemPort {
  readonly itemId: string;
  readonly quarantined: boolean;
}

/** Pack state and the major-bump quarantine - §14 PACK. */
export interface PacksPort {
  /** Facts -> one of the six states. Total: every combination resolves. */
  resolveState(facts: {
    readonly catalogue: string;
    readonly dbPresent: boolean;
    readonly signature: string;
    readonly integrity: string;
    readonly audioBytesPresent: number;
    readonly audioBytesExpected: number;
  }): string;
  /** Across a major bump, rows whose items vanished are quarantined, never deleted. */
  applyPackUpdate(
    rows: readonly ScheduledItemPort[],
    change: {
      readonly fromMajor: number;
      readonly toMajor: number;
      readonly itemIds: ReadonlySet<string>;
    },
  ): {
    readonly rows: readonly ScheduledItemPort[];
    readonly retired: number;
    readonly restored: number;
  };
}

export interface AppliedImportPort {
  readonly streak: number;
  readonly lifetimeXp: number;
  readonly freezes: number;
  /** Days that were re-stamped. Always empty (INV-DAT-04). */
  readonly restampedDays: readonly string[];
  /** Gap days, all classified `missed`. */
  readonly missedDays: readonly string[];
  /** Never `unlived`. Always empty (the EC-PER-08 ruling). */
  readonly unlivedDays: readonly string[];
  readonly writtenFields: readonly string[];
  readonly provenance: string;
}

/** Export, wipe and import - §13 DAT. */
export interface DataPort {
  applyImport(
    archive: Readonly<Record<string, unknown>>,
    confirm: Readonly<Record<string, unknown>>,
    device: Readonly<Record<string, unknown>>,
  ): AppliedImportPort;
  /** Fields no import may ever write. The gate is the list, not a reviewer's memory. */
  readonly economyConfigFields: readonly string[];
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
