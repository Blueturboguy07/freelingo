import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ZONES,
  arbInstant,
  arbZoneId,
  PROPERTY_RUNS,
  PROPERTY_RUNS_PER_ZONE,
} from '@freelingo/testkit';
import {
  addCivilDays,
  civilDaysBetween,
  localDayOf,
  monthKeyOf,
  toLocalDay,
  type LocalDay,
} from './civil.js';
import { DAY_CONFIG } from './config.js';
import { dayCellOf, streakFromDispositions, type DayDisposition } from './dispositions.js';
import { frozenYesterday, wasFrozenOn } from './predicates.js';
import { freezesConsumed, freezesHeld } from './freeze.js';
import { rolloverDeferral, rolloverTo, type RolloverResult } from './rollover.js';
import { streakFromDays } from './streak.js';
import { newDayEngineState, type DayEngineState } from './state.js';
import { recoveryOffer } from './recovery.js';
import { unlivedDaysFromTransitions, type ZoneTransition } from './unlived.js';
import { resolveZone } from './zone.js';
import { distinctMonthsBetween, ledgerWith, stateWithStreak } from './__testsupport__.js';

/**
 * The committed falsifier input for an invariant (plan §Verification: "committed
 * falsifier inputs per invariant"). The file also records the falsifier sentence and its
 * source, so a fixture cannot drift away from the case it was written for; the test reads
 * the `input` block.
 */
const falsifier = (id: string): Record<string, unknown> => {
  const file = JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as { id: string; falsifier: string; input: Record<string, unknown> };
  expect(file.id, `${id}.json must name its own invariant`).toBe(id);
  expect(file.falsifier.length).toBeGreaterThan(0);
  return file.input;
};

/**
 * A device that opens the app on the days it practises, plus once at the end.
 *
 * This is the shape the walk is actually used in — `rolloverTo` runs at foreground and at
 * lesson completion, so an absence is a gap between two calls, not a parameter. Replaying
 * the whole history through one call would exercise only the collapse branch.
 */
function runTrace(
  start: LocalDay,
  pattern: readonly boolean[],
  freezes: number,
  opens?: ReadonlySet<number>,
): { state: DayEngineState; consumed: number; calls: number } {
  const completedDays = new Set<LocalDay>();
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i]) completedDays.add(addCivilDays(start, i));
  }
  let state: DayEngineState = {
    ...newDayEngineState(),
    ledger: ledgerWith(freezes, start, Math.max(freezes, 2)),
  };
  let consumed = 0;
  let calls = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const isOpen = opens === undefined ? pattern[i] === true : opens.has(i);
    if (!isOpen && i !== pattern.length - 1) continue;
    const result: RolloverResult = rolloverTo(state, addCivilDays(start, i), { completedDays });
    state = result.state;
    consumed += result.freezesConsumed;
    calls += 1;
  }
  return { state, consumed, calls };
}

/** Days with a disposition, in date order. */
function decidedDays(state: DayEngineState): LocalDay[] {
  return [...state.dispositions.keys()].sort();
}

function countDisposition(state: DayEngineState, want: DayDisposition): number {
  let n = 0;
  for (const d of state.dispositions.values()) if (d === want) n += 1;
  return n;
}

describe('rollover', () => {
  it('[INV-DAY-05] a 400-day walk in each zone consumes exactly one freeze per missed civil date', () => {
    const input = falsifier('INV-DAY-05') as {
      days: number;
      practiseEveryNth: number;
      freezes: number;
      expectedConsumed: number;
      startInstantUtc: string;
    };
    for (const zone of ZONES) {
      const start = localDayOf(new Date(input.startInstantUtc), zone.id);
      // Practise every third day for 400 days, holding 5 freezes: the first two misses are
      // frozen, the third breaks, and no day is ever decided twice.
      const pattern = Array.from(
        { length: input.days },
        (_, i) => i % input.practiseEveryNth === 0,
      );
      const { state, consumed } = runTrace(start, pattern, input.freezes);
      const decided = decidedDays(state);
      expect(decided.length, zone.id).toBe(input.days - 1);
      // Exactly one disposition per civil date, no gaps and no repeats.
      for (let i = 0; i < decided.length; i += 1) {
        expect(decided[i]).toBe(addCivilDays(start, i));
      }
      // One consumption per frozen day, and never two for one date.
      expect(countDisposition(state, 'frozen')).toBe(consumed);
      const forDays = state.ledger.consumptions.map((c) => c.consumedForDay);
      expect(new Set(forDays).size).toBe(forDays.length);
      for (const day of forDays) expect(state.dispositions.get(day)).toBe('frozen');
      expect(consumed).toBe(input.expectedConsumed);
    }
  });

  it('[INV-DAY-01] the disposition walk agrees with P0 streakFromDays when every day is completed', () => {
    for (const zone of ZONES) {
      fc.assert(
        fc.property(
          arbInstant(),
          fc.array(fc.boolean(), { minLength: 1, maxLength: 40 }),
          (instant, pattern) => {
            const start = localDayOf(instant, zone.id);
            const today = addCivilDays(start, pattern.length - 1);
            const { state } = runTrace(start, pattern, 0);
            const completed = [...state.dispositions.entries()]
              .filter(([, d]) => d === 'completed')
              .map(([day]) => day);
            if (pattern[pattern.length - 1] === true) completed.push(today);
            // With no freezes there is nothing to preserve, so the whole-day-boundary walk
            // must reduce to the P0 rule over the set of completed days (INV-DAY-01).
            const ledger = new Map(state.dispositions);
            if (pattern[pattern.length - 1] === true) ledger.set(today, 'completed');
            expect(streakFromDispositions(ledger, today)).toBe(streakFromDays(completed, today));
          },
        ),
        { numRuns: PROPERTY_RUNS_PER_ZONE },
      );
    }
  });

  it('[INV-FRZ-01] freezes consumed over an absence = min(missed days, freezes owned when it began)', () => {
    fc.assert(
      fc.property(
        arbInstant(),
        arbZoneId(ZONES),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 25 }),
        fc.integer({ min: 0, max: 5 }),
        (instant, zoneId, streakLength, missedDays, freezes) => {
          const start = localDayOf(instant, zoneId);
          // A live streak, then an absence of `missedDays`, then the return.
          const pattern = [
            ...Array.from({ length: streakLength }, () => true),
            ...Array.from({ length: missedDays }, () => false),
            true,
          ];
          const { state, consumed } = runTrace(start, pattern, freezes);
          expect(consumed).toBe(Math.min(missedDays, freezes));
          expect(freezesConsumed(state.ledger)).toBe(consumed);
          expect(countDisposition(state, 'frozen')).toBe(consumed);
          expect(freezesHeld(state.ledger)).toBe(freezes - consumed);
          // The break lands on the first uncovered day, or there is no break at all.
          if (missedDays > freezes) {
            expect(state.brk?.brokenOn).toBe(addCivilDays(start, streakLength + freezes));
            expect(state.brk?.previousStreak).toBe(streakLength);
          } else {
            expect(state.brk).toBeNull();
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-FRZ-02] a frozen day preserves the streak number, never increments it, and arms nothing', () => {
    // EC-FRZ-02: streak 40, 2 freezes, one day missed. Streak reads 40, not 41.
    const input = falsifier('INV-FRZ-02') as {
      lastDay: string;
      streak: number;
      freezes: number;
      openedOn: string;
      frozenDay: string;
    };
    const state = stateWithStreak({
      lastDay: input.lastDay,
      streak: input.streak,
      freezes: input.freezes,
    });
    const openedOn = toLocalDay(input.openedOn);
    const { state: after, freezesConsumed: spent } = rolloverTo(state, openedOn, {
      completedDays: new Set<LocalDay>(),
    });
    expect(spent).toBe(1);
    expect(after.dispositions.get(toLocalDay(input.frozenDay))).toBe('frozen');
    expect(streakFromDispositions(after.dispositions, openedOn)).toBe(input.streak);
    expect(freezesHeld(after.ledger)).toBe(input.freezes - 1);
    // EC-FRZ-12: the streak never broke, so no challenge is offered.
    expect(after.brk).toBeNull();
    expect(recoveryOffer(after, openedOn).challengeArmed).toBe(false);
    // S127 / S143. The frozen date's cell is a snowflake, and the morning notice is a
    // day-scoped query rather than a scan of a rollover event log that may be several
    // foregrounds old. The copy must not congratulate: the learner did not earn that day.
    const frozenDay = toLocalDay(input.frozenDay);
    expect(dayCellOf(after.dispositions.get(frozenDay))).toBe('snowflake');
    expect(wasFrozenOn(after, frozenDay)).toBe(true);
    expect(frozenYesterday(after, addCivilDays(frozenDay, 1))).toBe(true);
    expect(frozenYesterday(after, addCivilDays(frozenDay, 2))).toBe(false);
    // A frozen day is never grace-credited, and never renders as any kind of flame.
    expect(after.graceCreditedDays.has(frozenDay)).toBe(false);
  });

  it('[INV-DAY-06] a break is a recorded fact: winding the clock back never un-breaks it', () => {
    const input = falsifier('INV-DAY-06') as {
      lastDay: string;
      streak: number;
      openedOn: string;
      clockSetBackTo: string;
    };
    const before = stateWithStreak({ lastDay: input.lastDay, streak: input.streak, freezes: 0 });
    const broken = rolloverTo(before, toLocalDay(input.openedOn), {
      completedDays: new Set<LocalDay>(),
    }).state;
    expect(broken.brk).not.toBeNull();
    expect(broken.brk?.previousStreak).toBe(input.streak);
    const brokenOn = broken.brk!.brokenOn;

    // The learner sets the device date back behind the break.
    const rewound = rolloverTo(broken, toLocalDay(input.clockSetBackTo), {
      completedDays: new Set<LocalDay>(),
    }).state;
    expect(rewound.brk?.brokenOn).toBe(brokenOn);
    expect(rewound.brk?.previousStreak).toBe(input.streak);
    expect(rewound.lastProcessedDay).toBe(broken.lastProcessedDay);
    // And `max_local_day_seen` does not regress with the clock, so the streak is still
    // read at the furthest day ever seen — where it is 0 — not at the rewound one.
    expect(rewound.maxLocalDaySeen).toBe(broken.maxLocalDaySeen);
    expect(streakFromDispositions(rewound.dispositions, rewound.maxLocalDaySeen!)).toBe(0);
    // The rewound day itself is not re-decided and not re-credited.
    expect(rewound.dispositions.get(toLocalDay(input.clockSetBackTo))).toBe('completed');
  });

  it('[INV-DAY-07] falsifier: a 400-day jump resolves to one break, never 400 missed days', () => {
    const input = falsifier('INV-DAY-07') as {
      lastDay: string;
      streak: number;
      freezes: number;
      jumpedTo: string;
    };
    const state = stateWithStreak({
      lastDay: input.lastDay,
      streak: input.streak,
      freezes: input.freezes,
      cap: 5,
    });
    const result = rolloverTo(state, toLocalDay(input.jumpedTo), {
      completedDays: new Set<LocalDay>(),
    });
    const gap =
      civilDaysBetween(
        addCivilDays(toLocalDay(input.lastDay), 1),
        addCivilDays(toLocalDay(input.jumpedTo), -1),
      ) + 1;
    expect(gap).toBeGreaterThan(DAY_CONFIG.maxOfflineDays);
    expect(result.freezesConsumed).toBe(Math.min(gap, input.freezes, DAY_CONFIG.maxOfflineDays));
    // One break, and one collapsed absence — not `gap` calendar cells.
    expect(countDisposition(result.state, 'missed')).toBe(1);
    expect(result.state.longAbsences).toHaveLength(1);
    expect(result.state.longAbsences[0]?.days).toBe(gap);
    expect(result.daysProcessed).toBeLessThanOrEqual(DAY_CONFIG.maxOfflineDays + 1);
    expect(result.state.dispositions.size).toBeLessThanOrEqual(
      input.streak + DAY_CONFIG.maxOfflineDays + 1,
    );
  });

  it('[INV-DAY-07] freeze consumption over any gap is min(gap days, freezes owned, max_offline_days)', () => {
    fc.assert(
      fc.property(
        arbInstant(),
        arbZoneId(ZONES),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 900 }),
        fc.integer({ min: 0, max: 5 }),
        (instant, zoneId, streakLength, gapDays, freezes) => {
          const lastDay = localDayOf(instant, zoneId);
          const state = stateWithStreak({ lastDay, streak: streakLength, freezes, cap: 5 });
          const today = addCivilDays(lastDay, gapDays + 1);
          const result = rolloverTo(state, today, { completedDays: new Set<LocalDay>() });
          expect(result.freezesConsumed).toBe(
            Math.min(gapDays, freezes, DAY_CONFIG.maxOfflineDays),
          );
          // However large the gap, at most one break is recorded.
          if (gapDays > freezes) {
            expect(result.state.brk).not.toBeNull();
            expect(result.state.brk?.previousStreak).toBe(streakLength);
          }
          // And the walk always terminates in bounded work.
          expect(result.daysProcessed).toBeLessThanOrEqual(DAY_CONFIG.maxOfflineDays + 1);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-DAY-09] rolloverTo is idempotent and terminates for any today, in every zone', () => {
    for (const zone of ZONES) {
      fc.assert(
        fc.property(
          arbInstant(),
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: -40, max: 120 }),
          fc.integer({ min: 0, max: 3 }),
          (instant, streakLength, offset, freezes) => {
            const lastDay = localDayOf(instant, zone.id);
            const state = stateWithStreak({ lastDay, streak: streakLength, freezes });
            const today = addCivilDays(lastDay, offset);
            const once = rolloverTo(state, today, { completedDays: new Set<LocalDay>() }).state;
            const twice = rolloverTo(once, today, { completedDays: new Set<LocalDay>() }).state;
            expect(twice).toEqual(once);
            // A third call changes nothing either: the marker, not the call count, decides.
            const thrice = rolloverTo(twice, today, { completedDays: new Set<LocalDay>() }).state;
            expect(thrice).toEqual(once);
          },
        ),
        { numRuns: PROPERTY_RUNS_PER_ZONE },
      );
    }
  });

  it('[INV-DAY-09] falsifier: a session killed mid-lesson cannot starve rollover past 300 s', () => {
    const input = falsifier('INV-DAY-09') as {
      localMidnightUtc: string;
      lastCheckpointUtc: string;
      killedHoursAgo: number;
      raisedCeilingSeconds: number;
    };
    const midnight = new Date(input.localMidnightUtc).getTime();
    const checkpoint = new Date(input.lastCheckpointUtc).getTime();
    const cap = DAY_CONFIG.maxRolloverDeferralSeconds * 1000;

    // Inside the window a live session still defers the freeze decision (deep/04 case 43).
    expect(
      rolloverDeferral(midnight + 10_000, midnight, {
        sessionInProgress: true,
        lastCheckpointMs: checkpoint,
      }).defer,
    ).toBe(true);

    // A session that was killed hours ago — `session_in_progress` stuck true forever —
    // never holds rollover past the cap. This is the bug EC-STK-14 names.
    const killed = rolloverDeferral(midnight + cap + 1, midnight, {
      sessionInProgress: true,
      lastCheckpointMs: midnight - input.killedHoursAgo * 3_600_000,
    });
    expect(killed.defer).toBe(false);
    expect(killed.untilMs).toBeLessThanOrEqual(midnight + cap);

    // The shipped `graceSeconds` and `maxRolloverDeferralSeconds` are BOTH 300, so the
    // ceiling always binds and the session-staleness term is arithmetically invisible:
    // every assertion above passes with the session logic deleted. Raise the ceiling —
    // the one number EC-STK-14 says would start to matter if it moved — and the two
    // halves separate: a LIVE session extends the deferral past the grace end, a session
    // killed hours ago does not, and the cap still binds above both.
    const raised = {
      graceSeconds: DAY_CONFIG.graceSeconds,
      sessionTimeoutSeconds: DAY_CONFIG.sessionTimeoutSeconds,
      maxRolloverDeferralSeconds: input.raisedCeilingSeconds,
    };
    const graceEnd = midnight + DAY_CONFIG.graceSeconds * 1000;
    const liveAtRaisedCeiling = rolloverDeferral(
      midnight,
      midnight,
      { sessionInProgress: true, lastCheckpointMs: checkpoint },
      raised,
    );
    const killedAtRaisedCeiling = rolloverDeferral(
      midnight,
      midnight,
      {
        sessionInProgress: true,
        lastCheckpointMs: midnight - input.killedHoursAgo * 3_600_000,
      },
      raised,
    );
    const noSessionAtRaisedCeiling = rolloverDeferral(
      midnight,
      midnight,
      { sessionInProgress: false, lastCheckpointMs: checkpoint },
      raised,
    );
    expect(liveAtRaisedCeiling.untilMs).toBeGreaterThan(graceEnd);
    expect(killedAtRaisedCeiling.untilMs).toBe(graceEnd);
    expect(noSessionAtRaisedCeiling.untilMs).toBe(graceEnd);
    // …and the ceiling still binds, whatever the session claims.
    expect(liveAtRaisedCeiling.untilMs).toBeLessThanOrEqual(
      midnight + input.raisedCeilingSeconds * 1000,
    );

    fc.assert(
      fc.property(
        fc.integer({ min: -86_400_000, max: 86_400_000 }),
        fc.integer({ min: 0, max: 86_400_000 }),
        fc.boolean(),
        (checkpointOffset, nowOffset, live) => {
          const deferral = rolloverDeferral(midnight + nowOffset, midnight, {
            sessionInProgress: live,
            lastCheckpointMs: midnight + checkpointOffset,
          });
          // The bound, whatever the session did.
          expect(deferral.untilMs).toBeLessThanOrEqual(midnight + cap);
          if (nowOffset > cap) expect(deferral.defer).toBe(false);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-FRZ-05] falsifier: a kill after every write in a walk never double-decrements', () => {
    const input = falsifier('INV-FRZ-05') as {
      lastDay: string;
      streak: number;
      freezes: number;
      gapDays: number;
    };
    const start = stateWithStreak({
      lastDay: input.lastDay,
      streak: input.streak,
      freezes: input.freezes,
    });
    const days: LocalDay[] = [];
    for (let i = 1; i <= input.gapDays + 1; i += 1)
      days.push(addCivilDays(toLocalDay(input.lastDay), i));
    const empty = new Set<LocalDay>();

    const uninterrupted = days.reduce<DayEngineState>(
      (state, day) => rolloverTo(state, day, { completedDays: empty }).state,
      start,
    );

    // Kill after each committed day in turn and resume from the committed marker: the
    // ledger is keyed by the day it covers, so every replay is a no-op.
    for (let killAfter = 0; killAfter < days.length; killAfter += 1) {
      let state = start;
      for (let i = 0; i <= killAfter; i += 1) {
        state = rolloverTo(state, days[i]!, { completedDays: empty }).state;
      }
      // …the process dies here, and the next foreground replays from `state`.
      for (const day of days) {
        state = rolloverTo(state, day, { completedDays: empty }).state;
      }
      expect(state.ledger.consumptions).toEqual(uninterrupted.ledger.consumptions);
      expect(freezesHeld(state.ledger)).toBe(freezesHeld(uninterrupted.ledger));
      expect(state.dispositions).toEqual(uninterrupted.dispositions);
      expect(state.brk).toEqual(uninterrupted.brk);
    }
    expect(freezesConsumed(uninterrupted.ledger)).toBe(Math.min(input.gapDays, input.freezes));
  });

  it('[INV-DAY-16] monthly settlements equal the distinct YYYY-MM values of the processed days', () => {
    fc.assert(
      fc.property(
        arbInstant(),
        arbZoneId(ZONES),
        fc.oneof(
          fc.array(fc.boolean(), { minLength: 30, maxLength: 45 }),
          fc.array(fc.boolean(), { minLength: 120, maxLength: 400 }),
        ),
        fc.integer({ min: 0, max: 3 }),
        (instant, zoneId, pattern, freezes) => {
          const start = localDayOf(instant, zoneId);
          // Long traces open sparsely (a device that is used now and then); short ones
          // open every day. Both shapes decide every civil date exactly once.
          const opens =
            pattern.length > 60
              ? new Set([0, Math.floor(pattern.length / 3), Math.floor((2 * pattern.length) / 3)])
              : undefined;
          const { state } = runTrace(start, pattern, freezes, opens);
          const first = state.settlements[0]?.atDay ?? start;
          const expected = distinctMonthsBetween(first, state.maxLocalDaySeen ?? start);
          expect(state.settlements).toHaveLength(expected.size);
          expect(new Set(state.settlements.map((s) => s.month))).toEqual(expected);
          // Each settlement names the month it closed, in order, with no repeats.
          const months = state.settlements.map((s) => s.month);
          expect([...months].sort()).toEqual(months);
          for (let i = 1; i < state.settlements.length; i += 1) {
            expect(state.settlements[i]!.settledMonth).toBe(state.settlements[i - 1]!.month);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-DAY-16] falsifier: a date-line hop over the 1st neither skips nor doubles a settlement', () => {
    interface Hop {
      atUtc: string;
      fromTz: string;
      toTz: string;
      expectedUnlived: string[];
      landedOn: string;
    }
    const input = falsifier('INV-DAY-16') as {
      lastDay: string;
      streak: number;
      unlivedTransition: Hop;
      livedControlTransition: Hop;
    };

    // The `unlived` set is DERIVED from the stamps, never hand-written. The fixture used
    // to hard-code `['2026-10-01']` and inject it, which asserted a state its own source
    // case could not produce: LA -> Sydney advances the civil date by exactly one, so
    // under the corrected INV-DAY-03 nothing is unlived there. Deriving it is the only
    // way the fixture cannot drift away from the engine.
    const derive = (hop: Hop): Set<LocalDay> => {
      const at = new Date(hop.atUtc);
      const transition: ZoneTransition = {
        atUtcMs: at.getTime(),
        from: resolveZone(at, hop.fromTz),
        to: resolveZone(at, hop.toTz),
      };
      return unlivedDaysFromTransitions([transition]);
    };

    const control = derive(input.livedControlTransition);
    expect([...control]).toEqual(input.livedControlTransition.expectedUnlived);
    expect(control.size).toBe(0);

    const hop = input.unlivedTransition;
    const unlived = derive(hop);
    expect([...unlived].sort()).toEqual(hop.expectedUnlived.map(toLocalDay));

    const state = stateWithStreak({ lastDay: input.lastDay, streak: input.streak, freezes: 2 });
    const result = rolloverTo(state, toLocalDay(hop.landedOn), {
      completedDays: new Set<LocalDay>(),
      unlivedDays: unlived,
    });
    // 2026-10-01 was never lived, and September still settles — at the first processed day
    // of October, which is the 2nd (EC-STK-25).
    const months = result.state.settlements.map((s) => s.month);
    expect(months).toContain(monthKeyOf(toLocalDay(hop.landedOn)));
    expect(new Set(months).size).toBe(months.length);
    for (const day of hop.expectedUnlived) {
      expect(result.state.dispositions.get(toLocalDay(day))).toBe('unlived');
    }
    // An unlived date consumes no freeze (EC-STK-04).
    expect(result.freezesConsumed).toBe(0);

    // The control hop, run through the SAME walk: 2026-10-01 is lived and missed, so it
    // costs a freeze and September still settles exactly once.
    const lived = rolloverTo(state, toLocalDay(input.livedControlTransition.landedOn), {
      completedDays: new Set<LocalDay>(),
      unlivedDays: control,
    });
    expect(lived.state.dispositions.get(toLocalDay('2026-10-01'))).toBe('frozen');
    expect(lived.freezesConsumed).toBeGreaterThan(0);
    const controlMonths = lived.state.settlements.map((s) => s.month);
    expect(new Set(controlMonths).size).toBe(controlMonths.length);
  });
});
