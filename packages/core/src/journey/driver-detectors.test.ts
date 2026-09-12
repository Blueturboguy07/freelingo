/**
 * Does the journey actually detect anything?
 *
 * `journey.test.ts` asserts three empty lists. A driver that never fills them — because a
 * comparison is inverted, because a handler returns early, because the replay is run
 * against the wrong state — passes with three empty lists forever and proves nothing. So
 * every detector in `driver.ts` is executed here against a deliberately broken engine and
 * must fire.
 *
 * ## About the fixture engine below
 *
 * It is a REFERENCE ENGINE, and it is evidence about the DRIVER only. It is never
 * evidence about `packages/core`: `bind.ts` refuses to substitute anything, and nothing
 * in this file is reachable from `journey.test.ts`. What it is for is the same thing the
 * `--self-test` in `scripts/canonicalise-pbxproj.py` and the fixtures in
 * `property-gates.test.ts` are for — a gate whose red path has never been executed is a
 * gate nobody has checked.
 *
 * It is deliberately the simplest engine that can walk the trace: dispositions from a
 * set, freezes from a counter, a repair keyed by month. Where it and the real engine
 * disagree about a rule, the real engine is right and this file is not a second opinion.
 */
import { describe, expect, it } from 'vitest';
import { runJourney } from './driver.js';
import type {
  DataPort,
  Day,
  DayPort,
  DayStatePort,
  Disposition,
  EconomyPort,
  Engine,
  FreezePort,
  GradingPort,
  PacksPort,
  RecoveryPort,
  RepairRecordPort,
  SchedulerPort,
  SessionPort,
  SessionRowPort,
  ZoneStampPort,
} from './ports.js';

/* ------------------------------------------------------- the reference engine */

const DAY_MS = 86_400_000;

function civilDate(instant: Date, timeZone: string): Day {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

function shift(day: Day, delta: number): Day {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']) % 24,
    Number(parts['minute']),
    Number(parts['second']),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

interface RefLedger {
  held: number;
  cap: number;
  consumed: number;
}

interface RefState extends DayStatePort {
  readonly dispositions: Map<Day, Disposition>;
  readonly ledger: RefLedger;
  readonly repairs: RepairRecordPort[];
  readonly settlements: { month: string }[];
}

function refStreak(dispositions: ReadonlyMap<Day, Disposition>, today: Day): number {
  let count = 0;
  let cursor = today;
  let first = true;
  for (;;) {
    const disposition = dispositions.get(cursor);
    if (disposition === 'completed' || disposition === 'recovered') count += 1;
    else if (disposition === 'frozen' || disposition === 'unlived') {
      /* the chain holds */
    } else if (first && disposition === undefined) {
      /* today is not over */
    } else break;
    first = false;
    cursor = shift(cursor, -1);
  }
  return count;
}

interface Broken {
  brokenOn: Day;
  previousStreak: number;
  uncoveredDays: Day[];
}

/** Options that break exactly one rule, so the matching detector can be shown to fire. */
interface Mutants {
  /**
   * The walk never advances its marker, so every call re-decides the same civil dates and
   * spends their freezes again. This is EC-FRZ-14's double-decrement, and it is the reason
   * every day of the trace is rolled over twice.
   */
  readonly rolloverNotIdempotent?: boolean;
  /** The commit is not keyed by session id: a replay writes a different row. */
  readonly commitNotIdempotent?: boolean;
  /** The reported streak is one more than the ledger supports. */
  readonly streakOffByOne?: boolean;
  /** The rollover deferral has no ceiling. */
  readonly unboundedDeferral?: boolean;
  /** A boost applies for ever, grace window or not. */
  readonly boostNeverLapses?: boolean;
  /** A second Streak Repair in the same month is granted. */
  readonly repairEveryTime?: boolean;
  /** Quarantined rows are handed back as live. */
  readonly quarantineForgets?: boolean;
  /** The import does not round-trip the export. */
  readonly importLosesData?: boolean;
  /** A lane changed a signature under the port: the call throws. */
  readonly signatureMoved?: boolean;
}

function referenceEngine(mutants: Mutants = {}): Engine {
  let broken: Broken | null = null;
  let challengeLessons = 0;

  const dayPort: DayPort = {
    localDayOf: (instant, timeZone) => civilDate(instant, timeZone),
    addCivilDays: (d, delta) => shift(d, delta),
    civilDaysBetween: (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS),
    resolveZone: (instant, tzId): ZoneStampPort => ({
      tzId,
      utcOffsetMinutes: offsetMinutes(instant, tzId),
      tzSource: 'iana',
    }),
    newState: (options): DayStatePort => {
      const state: RefState = {
        lastProcessedDay: null,
        dispositions: new Map(),
        brk: null,
        challenge: null,
        repairs: [],
        settlements: [],
        ledger: { held: options?.cap ?? 2, cap: options?.cap ?? 2, consumed: 0 },
      };
      return state;
    },
    rolloverTo: (state, today, ctx) => {
      const s = state as RefState;
      const dispositions = new Map(s.dispositions);
      const settlements = [...s.settlements];
      const settled = new Set(settlements.map((entry) => entry.month));
      const ledger = { ...s.ledger };
      let freezesConsumed = 0;
      let daysProcessed = 0;

      const settle = (d: Day): void => {
        const month = d.slice(0, 7);
        if (!settled.has(month)) {
          settled.add(month);
          settlements.push({ month });
        }
      };

      if (s.lastProcessedDay === null) {
        settle(today);
        return {
          state: { ...s, dispositions, settlements, lastProcessedDay: today },
          events: [],
          freezesConsumed: 0,
          daysProcessed: 0,
        };
      }

      for (let cursor = s.lastProcessedDay; cursor < today; cursor = shift(cursor, 1)) {
        if (dispositions.has(cursor) && mutants.rolloverNotIdempotent !== true) continue;
        settle(cursor);
        if (ctx.unlivedDays?.has(cursor) === true) {
          dispositions.set(cursor, 'unlived');
        } else if (ctx.completedDays.has(cursor)) {
          dispositions.set(cursor, 'completed');
        } else if (ledger.held > 0) {
          ledger.held -= 1;
          ledger.consumed += 1;
          freezesConsumed += 1;
          dispositions.set(cursor, 'frozen');
        } else {
          const previousStreak = refStreak(dispositions, shift(cursor, -1));
          dispositions.set(cursor, 'missed');
          broken = { brokenOn: cursor, previousStreak, uncoveredDays: [cursor] };
          challengeLessons = 0;
        }
        daysProcessed += 1;
      }
      settle(today);
      return {
        state: {
          ...s,
          dispositions,
          settlements,
          ledger,
          lastProcessedDay:
            mutants.rolloverNotIdempotent === true
              ? s.lastProcessedDay
              : today > s.lastProcessedDay
                ? today
                : s.lastProcessedDay,
        },
        events: [],
        freezesConsumed,
        daysProcessed,
      };
    },
    streakFromDispositions: (dispositions, today) =>
      refStreak(dispositions, today) + (mutants.streakOffByOne === true ? 1 : 0),
    commitSession: (start, completion, ctx): SessionRowPort => {
      const existing = ctx.committed?.get(start.sessionId);
      if (existing !== undefined && mutants.commitNotIdempotent !== true) return existing;
      const startedLocalDay = civilDate(new Date(start.startedAtUtcMs), start.startZone.tzId);
      const elapsed = Math.max(0, completion.completedAtMonotonicMs - start.startedAtMonotonicMs);
      const completedLocalDay = civilDate(
        new Date(start.startedAtUtcMs + elapsed),
        completion.completionZone.tzId,
      );
      const credited = ctx.satisfiedDays.has(startedLocalDay) ? completedLocalDay : startedLocalDay;
      return {
        sessionId: start.sessionId,
        creditedLocalDay: credited,
        rewardLocalDay: completedLocalDay,
        earnedXp:
          completion.earnedXp +
          (mutants.commitNotIdempotent === true && existing !== undefined ? 1 : 0),
        earnedGems: completion.earnedGems,
      };
    },
    rolloverDeferral: (nowMs, localMidnightMs, ctx) => {
      const ceiling = localMidnightMs + 300_000;
      const wanted =
        ctx.lastCheckpointMs === null ? localMidnightMs : ctx.lastCheckpointMs + DAY_MS;
      const untilMs = mutants.unboundedDeferral === true ? wanted : Math.min(ceiling, wanted);
      return { defer: nowMs < untilMs, untilMs };
    },
    unlivedDaysFromTransitions: (transitions) => {
      const skipped = new Set<Day>();
      for (const transition of transitions) {
        const before = civilDate(new Date(transition.atUtcMs), transition.from.tzId);
        const after = civilDate(new Date(transition.atUtcMs), transition.to.tzId);
        for (let cursor = shift(before, 1); cursor < after; cursor = shift(cursor, 1)) {
          skipped.add(cursor);
        }
      }
      return skipped;
    },
  };

  const freezePort: FreezePort = {
    grant: (ledger, request) => {
      const l = ledger as RefLedger;
      const granted = Math.max(0, Math.min(request.count, l.cap - l.held));
      return { ledger: { ...l, held: l.held + granted }, granted };
    },
    held: (ledger) => (ledger as RefLedger).held,
  };

  const recoveryPort: RecoveryPort = {
    completeLesson: (state, onDay) => {
      const s = state as RefState;
      challengeLessons += 1;
      if (challengeLessons < 3 || broken === null) return s;
      const dispositions = new Map(s.dispositions);
      for (const d of broken.uncoveredDays) dispositions.set(d, 'recovered');
      dispositions.set(onDay, 'completed');
      broken = null;
      challengeLessons = 0;
      return { ...s, dispositions, brk: null, challenge: null };
    },
    repair: (state, onDay) => {
      const s = state as RefState;
      const monthKey = onDay.slice(0, 7);
      const spent = s.repairs.some((r) => r.monthKey === monthKey);
      if ((spent && mutants.repairEveryTime !== true) || broken === null) {
        return { state: s, granted: false };
      }
      const dispositions = new Map(s.dispositions);
      for (const d of broken.uncoveredDays) dispositions.set(d, 'recovered');
      const record: RepairRecordPort = {
        monthKey,
        onDay,
        restoredStreak: broken.previousStreak,
      };
      broken = null;
      return {
        state: { ...s, dispositions, repairs: [...s.repairs, record], brk: null },
        granted: true,
      };
    },
  };

  const sessionPort: SessionPort = {
    generate: ({ target, duePool, newPool }) => {
      if (mutants.signatureMoved === true)
        throw new TypeError('request.modality is not a function');
      return {
        items: [...duePool, ...newPool].slice(0, target).map((itemId) => ({ itemId })),
      };
    },
    checkpoint: (session) => JSON.parse(JSON.stringify(session)) as unknown,
    restore: (row) => JSON.parse(JSON.stringify(row)) as unknown,
  };

  const gradingPort: GradingPort = {
    grade: ({ answer, accepted }) => ({
      verdict: accepted.includes(answer) ? 'correct' : 'wrong',
    }),
  };

  const schedulerPort: SchedulerPort = {
    review: ({ row }) => row,
    quarantine: (rows, liveItemIds) => {
      const isLive = (row: unknown): boolean => liveItemIds.has((row as { id: string }).id);
      if (mutants.quarantineForgets === true) return { kept: rows, quarantined: [] };
      return { kept: rows.filter(isLive), quarantined: rows.filter((row) => !isLive(row)) };
    },
  };

  const economyPort: EconomyPort = {
    goalXp: (tier) => ({ casual: 10, regular: 20, serious: 30, intense: 50 })[tier] ?? 20,
    awardForSession: (input) => {
      const boost = input.boostAtSessionStart;
      const recorded = boost?.multiplier ?? 1;
      const lapsed =
        boost !== null &&
        mutants.boostNeverLapses !== true &&
        Date.parse(input.committedAtUtc) > Date.parse(boost.expiresAtUtc) + 120_000;
      const applied = lapsed ? 1 : recorded;
      return {
        baseXp: 10,
        recordedMultiplier: recorded,
        multiplierApplied: applied,
        awardedXp: 10 * applied,
        explanation: lapsed ? 'the boost ran out while this was parked' : '',
      };
    },
    boostGraceSeconds: 120,
  };

  const packsPort: PacksPort = {
    stateOf: ({ installedVersion, signatureValid }) =>
      !signatureValid ? 'unverified' : installedVersion === null ? 'not-downloaded' : 'installed',
    isMajorBump: (from, to) => from.split('.')[0] !== to.split('.')[0],
  };

  const dataPort: DataPort = {
    exportProgress: (db) => JSON.parse(JSON.stringify(db)) as unknown,
    importProgress: (_db, dump) =>
      mutants.importLosesData === true ? {} : (JSON.parse(JSON.stringify(dump)) as unknown),
  };

  return {
    day: dayPort,
    freeze: freezePort,
    recovery: recoveryPort,
    session: sessionPort,
    grading: gradingPort,
    scheduler: schedulerPort,
    economy: economyPort,
    packs: packsPort,
    data: dataPort,
  };
}

/* ----------------------------------------------------------------- the tests */

describe('the journey driver detects what it claims to detect', () => {
  const clean = runJourney({ engine: referenceEngine() });

  it('the reference engine walks the whole trace with nothing to report', () => {
    // The baseline. Without it, "the mutant made the list non-empty" means nothing.
    expect(clean.notProven).toEqual([]);
    expect(clean.replayViolations).toEqual([]);
    expect(clean.refutations).toEqual([]);
    expect(clean.days).toHaveLength(30);
    expect(clean.days.every((d) => d.disposition !== null)).toBe(true);
  });

  it('the baseline ledger is the one the trace describes', () => {
    // Three freezes granted (2 owned from day 1, 1 bought on day 5) and three consumed on
    // days 3, 12 and 13; days 14 and 20 break. One date is never lived.
    expect(clean.account.freezesGranted).toBe(3);
    expect(clean.account.freezesConsumed).toBe(3);
    expect(clean.unlivedDays).toEqual(['2026-10-05']);
    expect(clean.account.settledMonths).toEqual(['2026-09', '2026-10']);
    expect(clean.account.repairs.map((r) => r.monthKey)).toEqual(['2026-10']);
    expect(Object.keys(clean.courses).sort()).toEqual(['es', 'fr']);
    expect(clean.account.lifetimeXp).toBe(
      Object.values(clean.courses).reduce((total, c) => total + c.xp, 0),
    );
  });

  it('a rollover that decides the same days twice is caught as a replay violation', () => {
    const broken = runJourney({ engine: referenceEngine({ rolloverNotIdempotent: true }) });
    expect(broken.replayViolations.length).toBeGreaterThan(0);
    expect(broken.replayViolations[0]).toContain('replaying rollover decided');
  });

  it('a reward commit that is not idempotent on session_id is caught', () => {
    const broken = runJourney({ engine: referenceEngine({ commitNotIdempotent: true }) });
    expect(broken.refutations.some((line) => line.includes('not idempotent on session_id'))).toBe(
      true,
    );
  });

  it('a streak that disagrees with the disposition ledger is caught', () => {
    const broken = runJourney({ engine: referenceEngine({ streakOffByOne: true }) });
    expect(broken.refutations.some((line) => line.includes('independent reference'))).toBe(true);
  });

  it('an unbounded rollover deferral is caught (a killed session starving rollover)', () => {
    const broken = runJourney({ engine: referenceEngine({ unboundedDeferral: true }) });
    expect(broken.refutations.some((line) => line.includes('maxRolloverDeferralSeconds'))).toBe(
      true,
    );
  });

  it('a boost that never lapses is caught at the commit past the grace window', () => {
    const broken = runJourney({ engine: referenceEngine({ boostNeverLapses: true }) });
    expect(broken.refutations.some((line) => line.includes('the trace expects x1'))).toBe(true);
  });

  it('a second Streak Repair in the same calendar month is caught', () => {
    const broken = runJourney({ engine: referenceEngine({ repairEveryTime: true }) });
    expect(broken.refutations.some((line) => line.includes('Streak Repair granted=true'))).toBe(
      true,
    );
  });

  it('a quarantine that hands vanished rows back as live is caught', () => {
    const broken = runJourney({ engine: referenceEngine({ quarantineForgets: true }) });
    expect(broken.refutations.some((line) => line.includes('rows quarantined'))).toBe(true);
  });

  it('an import that does not round-trip the export is caught', () => {
    const broken = runJourney({ engine: referenceEngine({ importLosesData: true }) });
    expect(broken.refutations.some((line) => line.includes('did not round-trip'))).toBe(true);
  });

  it('a lane that moved a signature is one named finding per day, not a dead gate', () => {
    const broken = runJourney({ engine: referenceEngine({ signatureMoved: true }) });
    expect(broken.refutations.some((line) => line.includes('the port shape and the lane'))).toBe(
      true,
    );
    // The trace still finished: one broken port must not hide the other twenty-nine days.
    expect(broken.days).toHaveLength(30);
  });

  it('a missing lane is reported as NOT PROVEN, naming the task that owes it', () => {
    const engine = { ...referenceEngine(), recovery: null, data: null };
    const partial = runJourney({ engine });
    expect(partial.notProven.some((line) => line.includes('p1-day-freeze-recovery'))).toBe(true);
    expect(partial.notProven.some((line) => line.includes('p1-packs-data-security'))).toBe(true);
    // And the rest of the trace still ran, so one missing lane does not hide the others.
    expect(partial.days).toHaveLength(30);
  });

  it('with no day lane at all, the journey reports that and runs nothing', () => {
    const none = runJourney({
      engine: {
        day: null,
        freeze: null,
        recovery: null,
        session: null,
        grading: null,
        scheduler: null,
        economy: null,
        packs: null,
        data: null,
      },
    });
    expect(none.days).toEqual([]);
    expect(none.notProven).toEqual(['the whole journey: p1-day-freeze-recovery has not landed']);
  });
});
