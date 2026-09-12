/**
 * The headless 30-day, two-course, four-zone journey driver.
 *
 * One learner. Thirty simulated local days from `script.ts`. Two installed courses, four
 * IANA zones, three flights, one date-line crossing, two broken streaks, one recovery
 * challenge, one monthly Streak Repair, a boost that lapses, a pack major bump and an
 * export/wipe/import — driven through the real engine modules, never a local copy of
 * their rules (`bind.ts` refuses to substitute).
 *
 * ## What it asserts, and what it does not
 *
 * It asserts **end-state ledgers**, not screens. Three kinds of claim:
 *
 *  - **Idempotence.** Every day's rollover is run, then run again with the same
 *    arguments. The second call must decide nothing: no day processed, no freeze
 *    consumed, the same disposition map. That is INV-DAY-09 and INV-FRZ-05, and it is
 *    the single cheapest way to catch a walk that double-counts under a kill.
 *  - **Conservation.** Lifetime XP equals the sum of the awards the economy returned;
 *    freezes consumed equal freezes granted minus freezes held; the count of committed
 *    sessions equals the count of lesson events; goal chests equal the number of distinct
 *    local days whose XP crossed the goal in force on that day.
 *  - **Cross-checks against an independent reference.** The streak the day engine reports
 *    is recomputed here from the disposition ledger by a different route, and a
 *    disagreement is a refutation naming the day lane.
 *
 * It never patches across a module boundary. A disagreement is recorded in
 * `refutations` with the lane that owns it (plan §The build workflow, step 4: refuted
 * goes back to the owner, not into this file).
 *
 * ## Missing lanes
 *
 * A port that `bind.ts` could not resolve does not stop the journey: the events that
 * need it are recorded in `notProven` with the lane that owes them, and the rest of the
 * trace still runs. This matters because the journey is the LAST task in the P1 merge
 * queue and is written while the other eight lanes are still open — a driver that
 * refuses to run until everything is perfect is a driver nobody ever sees run. What it
 * must never do is *pretend*: `notProven` is non-empty exactly when a clause of the gate
 * was not executed, and `docs/P1-REPORT.md` prints it verbatim.
 */
import type {
  Day,
  DayStatePort,
  Disposition,
  Engine,
  RepairRecordPort,
  SessionRowPort,
  ZoneStampPort,
} from './ports.js';
import { PORT_OWNER } from './ports.js';
import {
  JOURNEY,
  PRIMARY_COURSE,
  USUAL_LESSON_HOUR,
  type JourneyDay,
  type JourneyEvent,
} from './script.js';

/* --------------------------------------------------------------- named config */

/** XP awarded per lesson is the engine's business; this is how many items a lesson has. */
const LESSON_ITEMS = 10;
/** Minutes a lesson takes, monotonic. Far short of the session-staleness timeout. */
const LESSON_MINUTES = 7;
/** The seed for every pseudo-random choice, so a failure is reproducible verbatim. */
export const DEFAULT_SEED = 0x5eed_1ec0;

/* ------------------------------------------------------------------ the ledger */

export interface DaySnapshot {
  readonly day: number;
  readonly localDay: Day;
  readonly zone: string;
  /** The disposition the rollover walk finally settled on for this civil date. */
  readonly disposition: Disposition | null;
  readonly streak: number;
  readonly lifetimeXp: number;
  readonly sessionsCommittedToday: number;
  readonly freezesConsumedToday: number;
  /** False when replaying this day's rollover changed anything. */
  readonly replayClean: boolean;
}

export interface JourneyLedger {
  readonly days: readonly DaySnapshot[];
  readonly account: {
    readonly lifetimeXp: number;
    readonly streakAtEnd: number;
    readonly freezesGranted: number;
    readonly freezesConsumed: number;
    readonly goalChestDays: readonly Day[];
    readonly repairs: readonly RepairRecordPort[];
    readonly settledMonths: readonly string[];
  };
  readonly courses: Readonly<Record<string, { readonly xp: number; readonly sessions: number }>>;
  readonly unlivedDays: readonly Day[];
  readonly dispositions: ReadonlyMap<Day, Disposition>;
  readonly committedSessions: readonly SessionRowPort[];
  /** A disagreement between the engine and an independent reference. Names the lane. */
  readonly refutations: readonly string[];
  /** A day whose rollover replay changed the ledger. Should always be empty. */
  readonly replayViolations: readonly string[];
  /** A gate clause that could not be executed, with the lane that owes it. */
  readonly notProven: readonly string[];
}

/* ------------------------------------------------------------------- internals */

/**
 * A tiny deterministic PRNG (xorshift32), NOT fast-check.
 *
 * `property-gates.test.ts` holds every `numRuns` in the tree at 10,000, and a 30-day
 * two-course journey cannot run 10,000 times in any budget anybody would accept. So the
 * "random instant" the task asks for is *pseudo-random and seeded*: one trace, fully
 * reproducible from `DEFAULT_SEED`, and a failure quotes the seed rather than a shrunk
 * counterexample. The property-shaped coverage of the same modules lives in the lanes.
 */
function prng(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

interface CourseWorld {
  xp: number;
  sessions: number;
  /** At most one parked session row per course — INV-SESS-07. */
  parked: ParkedSession | null;
  liveItemIds: Set<string>;
  quarantinedItemIds: Set<string>;
  packVersion: string;
}

interface ParkedSession {
  readonly sessionId: string;
  readonly courseId: string;
  readonly startedAtUtcMs: number;
  readonly startedAtMonotonicMs: number;
  readonly startZone: ZoneStampPort;
  readonly checkpoint: unknown;
  readonly boostAtStart: ActiveBoostLike | null;
  readonly answeredIndex: number;
}

interface ActiveBoostLike {
  readonly kind: string;
  readonly multiplier: number;
  readonly startedAtUtc: string;
  readonly expiresAtUtc: string;
}

interface World {
  state: DayStatePort;
  freezeLedger: unknown;
  lifetimeXp: number;
  freezesGranted: number;
  goalTier: string;
  goalXp: number;
  activeBoost: ActiveBoostLike | null;
  courses: Record<string, CourseWorld>;
  completedDays: Set<Day>;
  unlived: Set<Day>;
  committed: Map<string, SessionRowPort>;
  /** XP earned per local day, for the goal-chest conservation check. */
  xpByDay: Map<Day, number>;
  /** The goal in force on a local day, captured when the day's first session commits. */
  goalByDay: Map<Day, number>;
  /** Sessions completed per local day, for the per-mode ladder the economy applies. */
  sessionsByDay: Map<Day, { count: number; xp: number }>;
  monotonicMs: number;
  sequence: number;
}

function newCourse(): CourseWorld {
  return {
    xp: 0,
    sessions: 0,
    parked: null,
    liveItemIds: new Set(),
    quarantinedItemIds: new Set(),
    packVersion: '1.4.0',
  };
}

/**
 * The UTC instant at `hour` local time on `localDate` in `tzId`.
 *
 * Resolved by fixed point rather than by arithmetic: the offset depends on the instant,
 * and the instant depends on the offset. Two iterations settle every zone in the matrix
 * including Lord Howe's half hour; the caller checks the answer by asking the engine what
 * local day the instant lands on, so a zone this does not settle is a refutation and not
 * a silent off-by-one.
 */
function utcForLocal(engine: Engine, localDate: string, hour: number, tzId: string): number {
  const day = engine.day!;
  let instant = Date.parse(`${localDate}T${String(hour).padStart(2, '0')}:00:00Z`);
  for (let i = 0; i < 3; i += 1) {
    const stamp = day.resolveZone(new Date(instant), tzId);
    const candidate =
      Date.parse(`${localDate}T${String(hour).padStart(2, '0')}:00:00Z`) -
      stamp.utcOffsetMinutes * 60_000;
    if (candidate === instant) break;
    instant = candidate;
  }
  return instant;
}

/** An independent streak reference: the maximal run of preserving days ending at today. */
function referenceStreak(dispositions: ReadonlyMap<Day, Disposition>, today: Day): number {
  const contributes = (d: Disposition | undefined): boolean =>
    d === 'completed' || d === 'recovered';
  const preserves = (d: Disposition | undefined): boolean =>
    d === 'completed' || d === 'frozen' || d === 'recovered' || d === 'unlived';

  // Anchor at today-or-yesterday (INV-DAY-01), then walk back while the day preserves.
  const yesterday = shiftDate(today, -1);
  let cursor = contributes(dispositions.get(today))
    ? today
    : contributes(dispositions.get(yesterday))
      ? yesterday
      : null;
  if (cursor === null) return 0;

  let run = 0;
  while (preserves(dispositions.get(cursor))) {
    if (contributes(dispositions.get(cursor))) run += 1;
    cursor = shiftDate(cursor, -1);
  }
  return run;
}

/** Civil-date arithmetic for the reference only. The engine has its own. */
function shiftDate(day: Day, delta: number): Day {
  const at = Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}

/* --------------------------------------------------------------------- driver */

export interface JourneyOptions {
  readonly engine: Engine;
  readonly script?: readonly JourneyDay[];
  readonly seed?: number;
}

export function runJourney(options: JourneyOptions): JourneyLedger {
  const { engine } = options;
  const script = options.script ?? JOURNEY;
  const random = prng(options.seed ?? DEFAULT_SEED);
  const refutations: string[] = [];
  const replayViolations: string[] = [];
  const notProven: string[] = [];
  const days: DaySnapshot[] = [];

  if (engine.day === null) {
    return {
      days: [],
      account: {
        lifetimeXp: 0,
        streakAtEnd: 0,
        freezesGranted: 0,
        freezesConsumed: 0,
        goalChestDays: [],
        repairs: [],
        settledMonths: [],
      },
      courses: {},
      unlivedDays: [],
      dispositions: new Map(),
      committedSessions: [],
      refutations: [],
      replayViolations: [],
      notProven: [`the whole journey: ${PORT_OWNER.day} has not landed`],
    };
  }
  const day = engine.day;

  /** Record a clause that could not be executed, once per (kind, lane). */
  const cannot = (port: keyof Engine, clause: string): void => {
    const line = `${clause} — owed by ${PORT_OWNER[port]} (port \`${port}\` unresolved)`;
    if (!notProven.includes(line)) notProven.push(line);
  };

  const world: World = {
    state: day.newState({ freezesOwnedFrom: script[0]!.localDate, cap: 2 }),
    freezeLedger: null,
    lifetimeXp: 0,
    freezesGranted: 0,
    goalTier: 'regular',
    goalXp: 20,
    activeBoost: null,
    courses: {},
    completedDays: new Set(),
    unlived: new Set(),
    committed: new Map(),
    xpByDay: new Map(),
    goalByDay: new Map(),
    sessionsByDay: new Map(),
    monotonicMs: 1_000_000,
    sequence: 0,
  };
  world.freezeLedger = (world.state as { ledger: unknown }).ledger;
  const freezesGrantedAtStart = engine.freeze?.held(world.freezeLedger) ?? 0;

  let freezesConsumedTotal = 0;
  let previousZone: ZoneStampPort | null = null;

  for (const scripted of script) {
    const zoneId = scripted.zone;
    const noon = utcForLocal(engine, scripted.localDate, 12, zoneId);
    const stamp = day.resolveZone(new Date(noon), zoneId);
    const observedDay = day.localDayOf(new Date(noon), zoneId);
    if (observedDay !== scripted.localDate) {
      refutations.push(
        `day ${scripted.day}: local noon in ${zoneId} resolves to ${observedDay}, ` +
          `the script says ${scripted.localDate} — ${PORT_OWNER.day}`,
      );
    }

    /* -- travel: a zone change may jump over a civil date (INV-DAY-03) ---------- */
    if (scripted.travelledFrom !== undefined && previousZone !== null) {
      // The instant is declared by the trace, never guessed here: WHEN the zone changed
      // decides which civil dates are skipped, and a default hour chosen by the driver
      // would make the unlived date an accident of the driver rather than a property of
      // the flight (see script.ts, "the arithmetic that fixed this trace once already").
      const atUtcMs =
        scripted.travelAtUtc === undefined
          ? utcForLocal(engine, scripted.localDate, 2, zoneId)
          : Date.parse(scripted.travelAtUtc);
      const transition = {
        atUtcMs,
        from: day.resolveZone(new Date(atUtcMs), scripted.travelledFrom),
        to: day.resolveZone(new Date(atUtcMs), zoneId),
      };
      for (const jumped of day.unlivedDaysFromTransitions([transition])) world.unlived.add(jumped);
    }
    previousZone = stamp;

    /* -- rollover, then replay it (INV-DAY-09, INV-FRZ-05) --------------------- */
    const ctx = { completedDays: world.completedDays, unlivedDays: world.unlived };
    const first = day.rolloverTo(world.state, scripted.localDate, ctx);
    const replay = day.rolloverTo(first.state, scripted.localDate, ctx);
    const replayClean =
      replay.daysProcessed === 0 &&
      replay.freezesConsumed === 0 &&
      sameDispositions(first.state.dispositions, replay.state.dispositions);
    if (!replayClean) {
      replayViolations.push(
        `day ${scripted.day} (${scripted.localDate}): replaying rollover decided ` +
          `${replay.daysProcessed} more day(s) and spent ${replay.freezesConsumed} more freeze(s)` +
          ` — ${PORT_OWNER.day}`,
      );
    }
    world.state = first.state;
    world.freezeLedger = (world.state as { ledger: unknown }).ledger;
    freezesConsumedTotal += first.freezesConsumed;

    /* -- the day's events ------------------------------------------------------ */
    const xpBefore = world.lifetimeXp;
    let sessionsToday = 0;
    for (const event of scripted.events) {
      sessionsToday += applyEvent({
        engine,
        world,
        event,
        scripted,
        stamp,
        random,
        refutations,
        cannot,
      });
    }

    /* -- the snapshot ---------------------------------------------------------- */
    const streak = day.streakFromDispositions(world.state, scripted.localDate);
    const reference = referenceStreak(world.state.dispositions, scripted.localDate);
    if (streak !== reference) {
      refutations.push(
        `day ${scripted.day} (${scripted.localDate}): the engine reports streak ${streak}, ` +
          `the independent reference over the same disposition ledger says ${reference} — ${PORT_OWNER.day}`,
      );
    }
    days.push({
      day: scripted.day,
      localDay: scripted.localDate,
      zone: zoneId,
      disposition: world.state.dispositions.get(scripted.localDate) ?? null,
      streak,
      lifetimeXp: world.lifetimeXp,
      sessionsCommittedToday: sessionsToday,
      freezesConsumedToday: first.freezesConsumed,
      replayClean,
    });
    void xpBefore;
  }

  /* -- close the trace: roll over one more day so the last day is decided ------- */
  const lastDay = script[script.length - 1]!;
  const closing = day.rolloverTo(world.state, shiftDate(lastDay.localDate, 1), {
    completedDays: world.completedDays,
    unlivedDays: world.unlived,
  });
  world.state = closing.state;
  freezesConsumedTotal += closing.freezesConsumed;

  const goalChestDays = [...world.xpByDay.entries()]
    .filter(([localDay, xp]) => xp >= (world.goalByDay.get(localDay) ?? world.goalXp))
    .map(([localDay]) => localDay)
    .sort();

  const courses: Record<string, { xp: number; sessions: number }> = {};
  for (const [id, course] of Object.entries(world.courses)) {
    courses[id] = { xp: course.xp, sessions: course.sessions };
  }

  return {
    days,
    account: {
      lifetimeXp: world.lifetimeXp,
      streakAtEnd: day.streakFromDispositions(world.state, lastDay.localDate),
      freezesGranted: freezesGrantedAtStart + world.freezesGranted,
      freezesConsumed: freezesConsumedTotal,
      goalChestDays,
      repairs: world.state.repairs,
      settledMonths: world.state.settlements.map((s) => s.month),
    },
    courses,
    unlivedDays: [...world.unlived].sort(),
    dispositions: world.state.dispositions,
    committedSessions: [...world.committed.values()],
    refutations,
    replayViolations,
    notProven,
  };
}

function sameDispositions(
  a: ReadonlyMap<Day, Disposition>,
  b: ReadonlyMap<Day, Disposition>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/* -------------------------------------------------------------- event handlers */

interface EventContext {
  readonly engine: Engine;
  readonly world: World;
  readonly event: JourneyEvent;
  readonly scripted: JourneyDay;
  readonly stamp: ZoneStampPort;
  readonly random: () => number;
  readonly refutations: string[];
  readonly cannot: (port: keyof Engine, clause: string) => void;
}

/** Returns the number of sessions this event committed. */
function applyEvent(ctx: EventContext): number {
  const { engine, world, event, scripted } = ctx;
  const courseId = event.course ?? PRIMARY_COURSE;

  switch (event.kind) {
    case 'install-course': {
      world.courses[courseId] = newCourse();
      for (let i = 0; i < 60; i += 1) world.courses[courseId]!.liveItemIds.add(`${courseId}-${i}`);
      if (engine.packs === null) {
        ctx.cannot('packs', 'the installed-pack state of a freshly installed course');
      } else {
        const state = engine.packs.stateOf({ installedVersion: '1.4.0', signatureValid: true });
        if (state !== 'installed') {
          ctx.refutations.push(
            `day ${scripted.day}: a verified pack installs as "${state}", not "installed" — ${PORT_OWNER.packs}`,
          );
        }
      }
      return 0;
    }

    case 'set-goal':
    case 'change-goal-mid-day': {
      const tier = String(event.detail?.['to'] ?? event.detail?.['goal'] ?? 'regular');
      if (engine.economy === null) {
        ctx.cannot('economy', 'the named daily-goal tiers (10/20/30/50 XP)');
        return 0;
      }
      world.goalTier = tier;
      world.goalXp = engine.economy.goalXp(tier);
      // The goal in force on a day is captured the moment it changes, so a mid-day
      // change cannot retroactively un-meet a goal already met (EC-ECO-01).
      const already = world.goalByDay.get(scripted.localDate);
      world.goalByDay.set(scripted.localDate, Math.min(already ?? world.goalXp, world.goalXp));
      return 0;
    }

    case 'buy-freeze': {
      if (engine.freeze === null) {
        ctx.cannot('freeze', 'buying a Streak Freeze with gems, clamped to the cap');
        return 0;
      }
      const before = engine.freeze.held(world.freezeLedger);
      const outcome = engine.freeze.grant(world.freezeLedger, {
        channel: 'reward_chest',
        count: 1,
        grantKey: `purchase-${scripted.localDate}`,
        onDay: scripted.localDate,
      });
      world.freezeLedger = outcome.ledger;
      world.state = { ...world.state, ledger: outcome.ledger } as DayStatePort;
      world.freezesGranted += outcome.granted;
      const after = engine.freeze.held(world.freezeLedger);
      if (after < before) {
        ctx.refutations.push(
          `day ${scripted.day}: granting a freeze lowered the balance ${before} -> ${after} — ${PORT_OWNER.freeze}`,
        );
      }
      return 0;
    }

    case 'activate-boost': {
      const minutes = Number(event.detail?.['minutes'] ?? 15);
      const multiplier = Number(event.detail?.['multiplier'] ?? 2);
      const startMs = utcForLocal(engine, scripted.localDate, USUAL_LESSON_HOUR - 1, scripted.zone);
      world.activeBoost = {
        kind: 'xpBoost',
        multiplier,
        startedAtUtc: new Date(startMs).toISOString(),
        expiresAtUtc: new Date(startMs + minutes * 60_000).toISOString(),
      };
      return 0;
    }

    case 'idle':
      return 0;

    case 'park-session': {
      const parked = startSession(ctx, courseId, Number(event.detail?.['stopAfter'] ?? 4));
      if (parked === null) return 0;
      const course = world.courses[courseId];
      if (course === undefined) return 0;
      if (course.parked !== null) {
        ctx.refutations.push(
          `day ${scripted.day}: ${courseId} already had a parked session — ` +
            `count(session_state WHERE course_id) must be <= 1 — ${PORT_OWNER.session}`,
        );
      }
      course.parked = parked;
      return 0;
    }

    case 'switch-course': {
      // Switching must not delete the other course's parked row (INV-SESS-07).
      const parkedElsewhere = Object.entries(world.courses).filter(
        ([id, course]) => id !== courseId && course.parked !== null,
      );
      if (parkedElsewhere.length === 0) {
        ctx.refutations.push(
          `day ${scripted.day}: switching to ${courseId} found no parked session on the other ` +
            `course — the park either never happened or was deleted — ${PORT_OWNER.session}`,
        );
      }
      return 0;
    }

    case 'resume-parked': {
      const course = world.courses[courseId];
      const parked = course?.parked ?? null;
      if (course === undefined || parked === null) {
        ctx.cannot('session', 'resuming a session parked on another course, after travel');
        return 0;
      }
      if (engine.session !== null) {
        const restored = engine.session.restore(parked.checkpoint);
        if (JSON.stringify(restored) !== JSON.stringify(parked.checkpoint)) {
          ctx.refutations.push(
            `day ${scripted.day}: the resumed session is not byte-identical to its checkpoint ` +
              `(all nine fields, INV-SESS-01) — ${PORT_OWNER.session}`,
          );
        }
      } else {
        ctx.cannot('session', 'the nine-field resume row surviving a park and a zone change');
      }
      course.parked = null;
      return completeSession(ctx, courseId, parked);
    }

    case 'kill-and-resume': {
      const killAt = 1 + Math.floor(ctx.random() * (LESSON_ITEMS - 1));
      const parked = startSession(ctx, courseId, killAt);
      if (parked === null) return 0;
      if (engine.session !== null) {
        const restored = engine.session.restore(parked.checkpoint);
        if (JSON.stringify(restored) !== JSON.stringify(parked.checkpoint)) {
          ctx.refutations.push(
            `day ${scripted.day}: kill at item ${killAt} did not restore byte-identically — ${PORT_OWNER.session}`,
          );
        }
      } else {
        ctx.cannot('session', 'a kill at a pseudo-random instant inside a lesson');
      }
      return completeSession(ctx, courseId, parked);
    }

    case 'lesson': {
      const parked = startSession(ctx, courseId, LESSON_ITEMS);
      if (parked === null) return 0;
      return completeSession(ctx, courseId, parked);
    }

    case 'commit-after-boost-expiry': {
      const parked = startSession(ctx, courseId, LESSON_ITEMS);
      if (parked === null) return 0;
      const grace = ctx.engine.economy?.boostGraceSeconds ?? 0;
      const boost = parked.boostAtStart;
      if (boost === null) {
        ctx.refutations.push(
          `day ${scripted.day}: the boost-expiry event started with no boost in force — ` +
            `the trace cannot prove EC-ECO-02 — ${PORT_OWNER.economy}`,
        );
        return completeSession(ctx, courseId, parked);
      }
      // Hold the session past expiry + grace, on the MONOTONIC clock.
      const expiry = Date.parse(boost.expiresAtUtc);
      const holdMs = expiry + (grace + 60) * 1000 - parked.startedAtUtcMs;
      const expected = Number(event.detail?.['expectMultiplier'] ?? 1);
      return completeSession(ctx, courseId, parked, { holdMs, expectMultiplier: expected });
    }

    case 'open-session-across-midnight': {
      const startHour = Number(event.detail?.['startHour'] ?? 23);
      const minutesHeld = Number(event.detail?.['minutesHeld'] ?? 40);
      const startMs = utcForLocal(engine, scripted.localDate, startHour, scripted.zone);
      const midnightMs = utcForLocal(engine, shiftDate(scripted.localDate, 1), 0, scripted.zone);
      const nowMs = startMs + minutesHeld * 60_000;
      const deferral = engine.day!.rolloverDeferral(nowMs, midnightMs, {
        sessionInProgress: true,
        lastCheckpointMs: nowMs - 60_000,
      });
      // INV-DAY-09: the deferral is bounded whatever the session does.
      const ceilingMs = midnightMs + 300 * 1000;
      if (deferral.untilMs > ceilingMs) {
        ctx.refutations.push(
          `day ${scripted.day}: rollover deferred to ${new Date(deferral.untilMs).toISOString()}, ` +
            `past midnight + maxRolloverDeferralSeconds — a killed session starves rollover — ${PORT_OWNER.day}`,
        );
      }
      const parked = startSession(ctx, courseId, LESSON_ITEMS, startHour);
      if (parked === null) return 0;
      return completeSession(ctx, courseId, parked, { holdMs: minutesHeld * 60_000 });
    }

    case 'recovery-lesson': {
      if (engine.recovery === null) {
        ctx.cannot('recovery', 'the 3-lesson recovery challenge inside its 2-local-day window');
        // The lesson itself still pays full XP (INV-REC-02), so run it as a lesson.
        const parked = startSession(ctx, courseId, LESSON_ITEMS);
        return parked === null ? 0 : completeSession(ctx, courseId, parked);
      }
      const parked = startSession(ctx, courseId, LESSON_ITEMS);
      const committed = parked === null ? 0 : completeSession(ctx, courseId, parked);
      world.state = engine.recovery.completeLesson(world.state, scripted.localDate);
      return committed;
    }

    case 'streak-repair': {
      if (engine.recovery === null) {
        ctx.cannot('recovery', 'the monthly Streak Repair, idempotent on (year, month)');
        return 0;
      }
      const expected = event.detail?.['expectGranted'] === true;
      const outcome = engine.recovery.repair(world.state, scripted.localDate);
      world.state = outcome.state;
      if (outcome.granted !== expected) {
        ctx.refutations.push(
          `day ${scripted.day}: Streak Repair granted=${outcome.granted}, the trace expects ` +
            `${expected} (one per calendar month, INV-REC-01) — ${PORT_OWNER.recovery}`,
        );
      }
      return 0;
    }

    case 'pack-major-bump': {
      const course = world.courses[courseId];
      if (course === undefined) return 0;
      const from = String(event.detail?.['from'] ?? '1.4.0');
      const to = String(event.detail?.['to'] ?? '2.0.0');
      if (engine.packs === null) {
        ctx.cannot('packs', 'a pack major bump being a migration rather than a download');
      } else if (!engine.packs.isMajorBump(from, to)) {
        ctx.refutations.push(
          `day ${scripted.day}: ${from} -> ${to} is not reported as a major bump — ${PORT_OWNER.packs}`,
        );
      }
      // Three items vanish in the bump. Their scheduler rows must be quarantined.
      const vanished = [...course.liveItemIds].slice(0, Number(event.detail?.['quarantined'] ?? 3));
      for (const id of vanished) {
        course.liveItemIds.delete(id);
        course.quarantinedItemIds.add(id);
      }
      course.packVersion = to;
      if (engine.scheduler === null) {
        ctx.cannot('scheduler', 'quarantining FSRS rows whose items vanished in a major bump');
      } else {
        const rows = [...course.quarantinedItemIds, ...course.liveItemIds].map((id) => ({ id }));
        const split = engine.scheduler.quarantine(rows, course.liveItemIds);
        if (split.quarantined.length !== course.quarantinedItemIds.size) {
          ctx.refutations.push(
            `day ${scripted.day}: ${split.quarantined.length} rows quarantined, ` +
              `${course.quarantinedItemIds.size} items vanished — ${PORT_OWNER.scheduler}`,
          );
        }
      }
      return 0;
    }

    case 'export-wipe-import': {
      if (engine.data === null) {
        ctx.cannot('data', 'the export -> wipe -> import round trip');
        return 0;
      }
      const before = snapshotForRoundTrip(world);
      const dump = engine.data.exportProgress(before);
      const restored = engine.data.importProgress({}, dump);
      if (JSON.stringify(restored) !== JSON.stringify(before)) {
        ctx.refutations.push(
          `day ${scripted.day}: export -> import did not round-trip the progress ledger — ${PORT_OWNER.data}`,
        );
      }
      return 0;
    }

    default:
      return 0;
  }
}

/** The subset of the world an export must carry back verbatim. */
function snapshotForRoundTrip(world: World): unknown {
  return {
    lifetimeXp: world.lifetimeXp,
    goalXp: world.goalXp,
    dispositions: [...world.state.dispositions.entries()].sort(),
    courses: Object.fromEntries(
      Object.entries(world.courses).map(([id, c]) => [id, { xp: c.xp, sessions: c.sessions }]),
    ),
  };
}

/**
 * Start a session: generate the queue, grade `answered` items, and checkpoint.
 *
 * Returns the parked row. Every session in the journey goes through this, so a lane that
 * has not landed is reported once per clause rather than once per day.
 */
function startSession(
  ctx: EventContext,
  courseId: string,
  answered: number,
  hour = USUAL_LESSON_HOUR,
): ParkedSession | null {
  const { engine, world, scripted } = ctx;
  const course = world.courses[courseId];
  if (course === undefined) {
    ctx.refutations.push(
      `day ${scripted.day}: a session on ${courseId}, which was never installed — driver bug`,
    );
    return null;
  }

  world.sequence += 1;
  const sessionId = `s${String(world.sequence).padStart(3, '0')}-${courseId}`;
  const startedAtUtcMs = utcForLocal(engine, scripted.localDate, hour, scripted.zone);
  world.monotonicMs += 60_000;
  const startedAtMonotonicMs = world.monotonicMs;

  let queue: readonly { readonly itemId: string }[] = [];
  if (engine.session === null) {
    ctx.cannot('session', 'generating a session queue from the due and new pools');
  } else {
    const generated = engine.session.generate({
      courseId,
      seed: Math.floor(ctx.random() * 2 ** 31),
      target: LESSON_ITEMS,
      duePool: [...course.liveItemIds].slice(0, 20),
      newPool: [...course.liveItemIds].slice(20),
    });
    queue = generated.items;
    for (const item of queue) {
      if (course.quarantinedItemIds.has(item.itemId)) {
        ctx.refutations.push(
          `day ${scripted.day}: a quarantined item (${item.itemId}) was scheduled — ${PORT_OWNER.scheduler}`,
        );
      }
    }
  }

  if (engine.grading === null) {
    ctx.cannot('grading', 'grading each answered item through the three-tier grader');
  } else {
    const wrong = Number(ctx.event.detail?.['wrong'] ?? 0);
    for (let i = 0; i < answered; i += 1) {
      const accepted = ['la respuesta'];
      const answer = i < wrong ? 'nope' : 'la respuesta';
      const { verdict } = engine.grading.grade({ answer, accepted });
      const shouldBeCorrect = i >= wrong;
      if (shouldBeCorrect && verdict !== 'correct') {
        ctx.refutations.push(
          `day ${scripted.day}: an exact-match answer graded "${verdict}" — ${PORT_OWNER.grading}`,
        );
      }
    }
  }

  const checkpoint =
    engine.session === null
      ? { sessionId, index: answered }
      : engine.session.checkpoint({ sessionId, courseId, index: answered, queue });

  return {
    sessionId,
    courseId,
    startedAtUtcMs,
    startedAtMonotonicMs,
    startZone: ctx.stamp,
    checkpoint,
    boostAtStart: world.activeBoost,
    answeredIndex: answered,
  };
}

/** Complete and commit a started session. Returns 1 when a row was committed. */
function completeSession(
  ctx: EventContext,
  courseId: string,
  parked: ParkedSession,
  options: { readonly holdMs?: number; readonly expectMultiplier?: number } = {},
): number {
  const { engine, world, scripted } = ctx;
  const course = world.courses[courseId];
  if (course === undefined) return 0;

  const holdMs = options.holdMs ?? LESSON_MINUTES * 60_000;
  world.monotonicMs = parked.startedAtMonotonicMs + holdMs;
  const completedAtUtcMs = parked.startedAtUtcMs + holdMs;
  const committedAtUtc = new Date(completedAtUtcMs).toISOString();

  let awardedXp = 0;
  let appliedMultiplier = 1;
  if (engine.economy === null) {
    ctx.cannot('economy', 'the session award: base XP x ladder x boost, clamped to the cap');
  } else {
    const todaySoFar = world.sessionsByDay.get(scripted.localDate) ?? { count: 0, xp: 0 };
    const award = engine.economy.awardForSession({
      flavour: 'lesson',
      outcome: 'completed',
      boostAtSessionStart: parked.boostAtStart,
      committedAtUtc,
      ladderStateToday: { sessionsCompleted: todaySoFar.count, xpAwarded: todaySoFar.xp },
    });
    awardedXp = award.awardedXp;
    appliedMultiplier = award.multiplierApplied;
    if (options.expectMultiplier !== undefined && appliedMultiplier !== options.expectMultiplier) {
      ctx.refutations.push(
        `day ${scripted.day}: the commit applied x${appliedMultiplier}, the trace expects ` +
          `x${options.expectMultiplier} (boost expiry + boostGraceSeconds, EC-ECO-02) — ${PORT_OWNER.economy}`,
      );
    }
  }

  const row = engine.day!.commitSession(
    {
      sessionId: parked.sessionId,
      startedAtUtcMs: parked.startedAtUtcMs,
      startedAtMonotonicMs: parked.startedAtMonotonicMs,
      startZone: parked.startZone,
    },
    {
      completedAtUtcMs,
      completedAtMonotonicMs: world.monotonicMs,
      completionZone: ctx.stamp,
      earnedXp: awardedXp,
      earnedGems: 0,
    },
    { satisfiedDays: world.completedDays, committed: world.committed },
  );

  // INV-CER-01 / INV-DAY-15: replaying the commit writes nothing and reproduces the row.
  world.committed.set(row.sessionId, row);
  const replayed = engine.day!.commitSession(
    {
      sessionId: parked.sessionId,
      startedAtUtcMs: parked.startedAtUtcMs,
      startedAtMonotonicMs: parked.startedAtMonotonicMs,
      startZone: parked.startZone,
    },
    {
      completedAtUtcMs: completedAtUtcMs + 5_000,
      completedAtMonotonicMs: world.monotonicMs + 5_000,
      completionZone: ctx.stamp,
      earnedXp: awardedXp,
      earnedGems: 0,
    },
    { satisfiedDays: world.completedDays, committed: world.committed },
  );
  if (JSON.stringify(replayed) !== JSON.stringify(row)) {
    ctx.refutations.push(
      `day ${scripted.day}: replaying the commit for ${parked.sessionId} produced a different row ` +
        `— the reward commit is not idempotent on session_id (INV-CER-01) — ${PORT_OWNER.day}`,
    );
  }

  if (row.creditedLocalDay !== null) world.completedDays.add(row.creditedLocalDay);
  const rewardDay = row.rewardLocalDay ?? scripted.localDate;
  world.lifetimeXp += row.earnedXp;
  course.xp += row.earnedXp;
  course.sessions += 1;
  world.xpByDay.set(rewardDay, (world.xpByDay.get(rewardDay) ?? 0) + row.earnedXp);
  if (!world.goalByDay.has(rewardDay)) world.goalByDay.set(rewardDay, world.goalXp);
  const ladder = world.sessionsByDay.get(scripted.localDate) ?? { count: 0, xp: 0 };
  world.sessionsByDay.set(scripted.localDate, {
    count: ladder.count + 1,
    xp: ladder.xp + row.earnedXp,
  });
  return 1;
}
