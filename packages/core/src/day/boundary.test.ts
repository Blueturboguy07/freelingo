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
  localDayFromOffset,
  localDayOf,
  localMidnightUtcMs,
  secondsPastLocalMidnight,
  toLocalDay,
  type LocalDay,
} from './civil.js';
import { DAY_CONFIG } from './config.js';
import { streakFromDispositions, type DayDisposition } from './dispositions.js';
import {
  calendarCells,
  dailyMostXp,
  goalChestDays,
  isNocturnal,
  localTimeOfRow,
  questCountdownSeconds,
  questProgressXp,
  questWindow,
  weekendWarriorWeeks,
} from './predicates.js';
import { rolloverTo } from './rollover.js';
import {
  classifyDayKey,
  commitSession,
  mayMintDayKeyedReward,
  type SessionRow,
} from './session.js';
import { lifetimeTotals } from './totals.js';
import { unlivedDaysFromTransitions, type ZoneTransition } from './unlived.js';
import { fixedOffsetZone, localDayOfStamp, offsetMinutesOf, resolveZone } from './zone.js';
import { rowAt, stateWithStreak, zoneAt } from './__testsupport__.js';

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

describe('day boundary', () => {
  /* ------------------------------------------------------------------ INV-DAY-02 */

  it('[INV-DAY-02] a local_day regression is honoured iff UTC is monotonic AND the zone changed', () => {
    const input = falsifier('INV-DAY-02') as {
      maxLocalDaySeen: string;
      lastCompletedAtUtc: string;
      lastTzId: string;
      travel: { completedAtUtc: string; tzId: string; day: string };
      tamper: { completedAtUtc: string; tzId: string; day: string };
    };
    const guard = {
      maxLocalDaySeen: toLocalDay(input.maxLocalDaySeen),
      lastCompletedAtUtcMs: new Date(input.lastCompletedAtUtc).getTime(),
      lastZone: zoneAt(input.lastTzId, input.lastCompletedAtUtc),
    };

    // Genuine westward date-line crossing: the instant moved forward, the zone changed.
    const travel = {
      completedAtUtcMs: new Date(input.travel.completedAtUtc).getTime(),
      completionZone: zoneAt(input.travel.tzId, input.travel.completedAtUtc),
      day: toLocalDay(input.travel.day),
    };
    expect(travel.day < guard.maxLocalDaySeen).toBe(true);
    expect(classifyDayKey(guard, travel)).toBe('travel-regression');
    // EC-STK-02: the re-lived civil date still pays its unclaimed chest.
    expect(mayMintDayKeyedReward(guard, travel)).toBe(true);

    // The falsifier: the clock alone moved back, in the same zone. Nothing is minted.
    const tamper = {
      completedAtUtcMs: new Date(input.tamper.completedAtUtc).getTime(),
      completionZone: zoneAt(input.tamper.tzId, input.tamper.completedAtUtc),
      day: toLocalDay(input.tamper.day),
    };
    expect(classifyDayKey(guard, tamper)).toBe('tamper');
    expect(mayMintDayKeyedReward(guard, tamper)).toBe(false);
  });

  it('[INV-DAY-02] no pure clock manipulation mints a day-keyed reward, in every zone', () => {
    for (const zone of ZONES) {
      fc.assert(
        fc.property(
          arbInstant(),
          fc.integer({ min: -400, max: -1 }),
          fc.integer({ min: -86_400_000, max: 86_400_000 }),
          (instant, backwardDays, instantDelta) => {
            const stamp = resolveZone(instant, zone.id);
            const seen = localDayOfStamp(instant, stamp);
            const guard = {
              maxLocalDaySeen: seen,
              lastCompletedAtUtcMs: instant.getTime(),
              lastZone: stamp,
            };
            const rewound = addCivilDays(seen, backwardDays);
            // Same zone: whatever the instant did, this is tampering and is refused.
            expect(
              classifyDayKey(guard, {
                completedAtUtcMs: instant.getTime() + instantDelta,
                completionZone: stamp,
                day: rewound,
              }),
            ).toBe('tamper');
          },
        ),
        { numRuns: PROPERTY_RUNS_PER_ZONE },
      );
    }
  });

  it('[INV-DAY-02] no genuine westward crossing is ever refused a day-keyed reward', () => {
    fc.assert(
      fc.property(
        arbInstant(),
        fc.integer({ min: 1, max: 86_400_000 }),
        fc.integer({ min: -1, max: -1 }),
        (instant, forwardMs, backwardDays) => {
          // Kiritimati (+14) → Los Angeles (−7/−8) is the widest real westward hop there
          // is: the civil date genuinely goes backwards while the instant moves forward.
          const before = resolveZone(instant, 'Pacific/Kiritimati');
          const later = new Date(instant.getTime() + forwardMs);
          const after = resolveZone(later, 'America/Los_Angeles');
          const guard = {
            maxLocalDaySeen: localDayOfStamp(instant, before),
            lastCompletedAtUtcMs: instant.getTime(),
            lastZone: before,
          };
          const day = localDayOfStamp(later, after);
          if (day >= guard.maxLocalDaySeen) return; // not a regression on this draw
          expect(
            classifyDayKey(guard, {
              completedAtUtcMs: later.getTime(),
              completionZone: after,
              day,
            }),
          ).toBe('travel-regression');
          expect(addCivilDays(day, -backwardDays)).not.toBe(day);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  /* ------------------------------------------------------------------ INV-DAY-03 */

  it('[INV-DAY-03] falsifier: a three-date powered-off gap is lived and missed, never unlived', () => {
    const input = falsifier('INV-DAY-03') as {
      poweredOff: {
        lastDay: string;
        streak: number;
        freezes: number;
        returnedOn: string;
        gap: string[];
      };
      dateLineHop: { atUtc: string; fromTz: string; toTz: string; skipped: string[] };
    };
    // A phone that is simply off emits NO zone transitions, so nothing can be unlived.
    expect(unlivedDaysFromTransitions([])).toEqual(new Set());

    const state = stateWithStreak({
      lastDay: input.poweredOff.lastDay,
      streak: input.poweredOff.streak,
      freezes: input.poweredOff.freezes,
    });
    const walked = rolloverTo(state, toLocalDay(input.poweredOff.returnedOn), {
      completedDays: new Set<LocalDay>(),
      unlivedDays: unlivedDaysFromTransitions([]),
    });
    // EC-STK-21: freezes cover days 1-2, day 3 breaks. Not one of them is `unlived`.
    const dispositions = input.poweredOff.gap.map((d) =>
      walked.state.dispositions.get(toLocalDay(d)),
    );
    expect(dispositions).toEqual(['frozen', 'frozen', 'missed']);
    expect(walked.freezesConsumed).toBe(input.poweredOff.freezes);
    expect(walked.state.brk?.brokenOn).toBe(toLocalDay(input.poweredOff.gap[2]!));
    expect(walked.state.brk?.previousStreak).toBe(input.poweredOff.streak);
    expect(
      streakFromDispositions(walked.state.dispositions, toLocalDay(input.poweredOff.returnedOn)),
    ).toBe(0);

    // And the one thing that IS unlived: a date the clock jumped over via a zone change.
    const hop: ZoneTransition = {
      atUtcMs: new Date(input.dateLineHop.atUtc).getTime(),
      from: zoneAt(input.dateLineHop.fromTz, input.dateLineHop.atUtc),
      to: zoneAt(input.dateLineHop.toTz, input.dateLineHop.atUtc),
    };
    expect(unlivedDaysFromTransitions([hop])).toEqual(
      new Set(input.dateLineHop.skipped.map(toLocalDay)),
    );
  });

  it('[INV-DAY-03] an unlived date consumes no freeze and is transparent to the streak walk', () => {
    // EC-STK-04 and EC-STK-03: streak 19 → 20 across a skipped civil date.
    const state = stateWithStreak({ lastDay: '2026-09-11', streak: 19, freezes: 2 });
    const skipped = toLocalDay('2026-09-12');
    const after = rolloverTo(state, toLocalDay('2026-09-13'), {
      completedDays: new Set<LocalDay>(),
      unlivedDays: new Set([skipped]),
    });
    expect(after.freezesConsumed).toBe(0);
    expect(after.state.dispositions.get(skipped)).toBe('unlived');
    expect(after.state.brk).toBeNull();
    const withToday = new Map<LocalDay, DayDisposition>(after.state.dispositions);
    withToday.set(toLocalDay('2026-09-13'), 'completed');
    expect(streakFromDispositions(withToday, toLocalDay('2026-09-13'))).toBe(20);
  });

  /* ------------------------------------------------------------------ INV-DAY-04 */

  it('[INV-DAY-04] a session stores tz and local_day at both ends and credits the unsatisfied day', () => {
    const input = falsifier('INV-DAY-04') as {
      startUtc: string;
      durationMs: number;
      startTz: string;
      completionTz: string;
      startDay: string;
      completionDay: string;
      sameZone: {
        tz: string;
        startUtc: string;
        durationMs: number;
        startDay: string;
        completionDay: string;
      };
    };
    const unsatisfied = rowAt({
      sessionId: 's1',
      startUtc: input.startUtc,
      durationMs: input.durationMs,
      tzId: input.startTz,
      completionTzId: input.completionTz,
    });
    // EC-STK-05: Tokyo 23:52 → Los Angeles 07:03 on the PREVIOUS civil date.
    expect(unsatisfied.startedLocalDay).toBe(toLocalDay(input.startDay));
    expect(unsatisfied.completedLocalDay).toBe(toLocalDay(input.completionDay));
    expect(unsatisfied.startZone.tzId).toBe(input.startTz);
    expect(unsatisfied.completionZone.tzId).toBe(input.completionTz);
    expect(unsatisfied.creditedLocalDay).toBe(toLocalDay(input.startDay));

    // Start day already satisfied → the credit falls to the other unsatisfied day.
    const startSatisfied = rowAt({
      sessionId: 's2',
      startUtc: input.startUtc,
      durationMs: input.durationMs,
      tzId: input.startTz,
      completionTzId: input.completionTz,
      satisfied: [toLocalDay(input.startDay)],
    });
    expect(startSatisfied.creditedLocalDay).toBe(toLocalDay(input.completionDay));

    // Both satisfied → the start day, and no double count either way.
    const bothSatisfied = rowAt({
      sessionId: 's3',
      startUtc: input.startUtc,
      durationMs: input.durationMs,
      tzId: input.startTz,
      completionTzId: input.completionTz,
      satisfied: [toLocalDay(input.startDay), toLocalDay(input.completionDay)],
    });
    expect(bothSatisfied.creditedLocalDay).toBe(toLocalDay(input.startDay));

    // The recorded DEVIATION (see the comment in session.ts). With NO zone change, the
    // "prefer the start day" rule does not apply: a four-hour session begun at 21:00 and
    // finished at 01:00 credits the day it FINISHED on, even though the start day is
    // unsatisfied and the completion day is not. EC-STK-12 is the reason — otherwise a
    // learner holds a streak forever by opening a lesson each evening.
    const sameZone = rowAt({
      sessionId: 's4',
      startUtc: input.sameZone.startUtc,
      durationMs: input.sameZone.durationMs,
      tzId: input.sameZone.tz,
    });
    expect(sameZone.startZone.tzId).toBe(sameZone.completionZone.tzId);
    expect(sameZone.startedLocalDay).toBe(toLocalDay(input.sameZone.startDay));
    expect(sameZone.completedLocalDay).toBe(toLocalDay(input.sameZone.completionDay));
    expect(sameZone.creditedLocalDay).toBe(toLocalDay(input.sameZone.completionDay));
    expect(sameZone.creditedByGrace).toBe(false);
  });

  it('[INV-DAY-04] a zone change alone never produces a local_day regression, in every zone', () => {
    for (const zone of ZONES) {
      fc.assert(
        fc.property(
          arbInstant(),
          arbZoneId(ZONES),
          fc.integer({ min: 0, max: 3_600_000 }),
          (instant, otherZoneId, duration) => {
            const start = zoneAt(zone.id, instant);
            const completionInstant = new Date(instant.getTime() + duration);
            const completion = zoneAt(otherZoneId, completionInstant);
            const row = commitSession(
              {
                sessionId: 'z',
                startedAtUtcMs: instant.getTime(),
                startedAtMonotonicMs: 0,
                startZone: start,
              },
              {
                completedAtUtcMs: completionInstant.getTime(),
                completedAtMonotonicMs: duration,
                completionZone: completion,
                earnedXp: 13,
                earnedGems: 0,
              },
              { satisfiedDays: new Set<LocalDay>(), buildLocalDay: '1970-01-01' },
            );
            // The credited day is one of the two the row recorded, never invented, and when
            // they differ and nothing is satisfied it is the START day — so a zone change on
            // its own can never move the credit backwards past where the session began.
            expect([row.startedLocalDay, row.completedLocalDay]).toContain(row.creditedLocalDay);
            if (row.startedLocalDay !== row.completedLocalDay && start.tzId !== completion.tzId) {
              expect(row.creditedLocalDay).toBe(row.startedLocalDay);
            }
            expect(row.creditedLocalDay! >= row.startedLocalDay).toBe(true);
          },
        ),
        { numRuns: PROPERTY_RUNS_PER_ZONE },
      );
    }
  });

  /* ------------------------------------------------------------------ INV-DAY-08 */

  it('[INV-DAY-08] the grace window credits the STREAK only; XP and chests stay on completion time', () => {
    const input = falsifier('INV-DAY-08') as {
      tz: string;
      startUtc: string;
      durationMs: number;
      startDay: string;
      completionDay: string;
      goalXp: number;
      twoMidnights: {
        startUtc: string;
        durationMs: number;
        startDay: string;
        completionDay: string;
      };
    };
    const graced = rowAt({
      sessionId: 'g1',
      startUtc: input.startUtc,
      durationMs: input.durationMs,
      tzId: input.tz,
      xp: input.goalXp,
    });
    expect(graced.startedLocalDay).toBe(toLocalDay(input.startDay));
    expect(graced.completedLocalDay).toBe(toLocalDay(input.completionDay));
    expect(graced.creditedByGrace).toBe(true);
    // Streak → the start day. XP, quests, goal chest, Daily Most XP → completion day.
    expect(graced.creditedLocalDay).toBe(toLocalDay(input.startDay));
    expect(graced.rewardLocalDay).toBe(toLocalDay(input.completionDay));
    expect(goalChestDays([graced], input.goalXp)).toEqual(
      new Set([toLocalDay(input.completionDay)]),
    );
    expect(dailyMostXp([graced])?.day).toBe(toLocalDay(input.completionDay));
    expect(questProgressXp([graced], toLocalDay(input.startDay))).toBe(0);
    expect(questProgressXp([graced], toLocalDay(input.completionDay))).toBe(input.goalXp);

    // Past the window the start day is not saved at all: strict completion-time credit.
    const late = rowAt({
      sessionId: 'g2',
      startUtc: input.startUtc,
      durationMs: input.durationMs + (DAY_CONFIG.graceSeconds + 60) * 1000,
      tzId: input.tz,
      xp: input.goalXp,
    });
    expect(late.creditedByGrace).toBe(false);
    expect(late.creditedLocalDay).toBe(toLocalDay(input.completionDay));

    // The grace window is ONE midnight wide. A session whose monotonic elapsed spans two
    // or more local midnights and lands within `graceSeconds` of the LAST one must not
    // reach back and save the day it began on — the mutation that drops the
    // `addCivilDays(startedLocalDay, 1) === completedLocalDay` clause dies here.
    const twoMidnights = rowAt({
      sessionId: 'g3',
      startUtc: input.twoMidnights.startUtc,
      durationMs: input.twoMidnights.durationMs,
      tzId: input.tz,
      xp: input.goalXp,
    });
    expect(twoMidnights.startedLocalDay).toBe(toLocalDay(input.twoMidnights.startDay));
    expect(twoMidnights.completedLocalDay).toBe(toLocalDay(input.twoMidnights.completionDay));
    expect(
      civilDaysBetween(twoMidnights.startedLocalDay, twoMidnights.completedLocalDay),
    ).toBeGreaterThanOrEqual(2);
    // …and it did land inside the window of the last midnight, so only the one-midnight
    // clause can be what refuses it.
    expect(
      secondsPastLocalMidnight(
        new Date(twoMidnights.derivedCompletionUtcMs),
        twoMidnights.completionZone.utcOffsetMinutes,
      ),
    ).toBeLessThanOrEqual(DAY_CONFIG.graceSeconds);
    expect(twoMidnights.creditedByGrace).toBe(false);
    expect(twoMidnights.creditedLocalDay).toBe(toLocalDay(input.twoMidnights.completionDay));

    // S127: the grace-credited day is a DISTINCT cell, not an ordinary flame. EC-STK-13
    // (retired by this invariant) rules it renders as a half-flame with `Just made it!`
    // provenance — otherwise the learner sees a flame on a day whose XP row is empty.
    // The flag therefore has to survive the session row and reach the calendar.
    const startDay = toLocalDay(input.startDay);
    const completionDay = toLocalDay(input.completionDay);
    const ordinaryDay = addCivilDays(startDay, -1);
    const base = stateWithStreak({ lastDay: ordinaryDay, streak: 3, freezes: 0 });
    const walked = rolloverTo(base, addCivilDays(completionDay, 1), {
      completedDays: new Set([startDay, completionDay]),
      graceCreditedDays: new Set(
        [graced].filter((row) => row.creditedByGrace).map((row) => row.creditedLocalDay!),
      ),
    }).state;
    expect(walked.graceCreditedDays.has(startDay)).toBe(true);
    const cells = new Map(calendarCells(walked, ordinaryDay, completionDay).map((c) => [c.day, c]));
    expect(cells.get(startDay)?.cell).toBe('half-flame');
    expect(cells.get(startDay)?.provenance).toBe('Just made it!');
    expect(cells.get(ordinaryDay)?.cell).toBe('flame');
    expect(cells.get(completionDay)?.cell).toBe('flame');
    // A grace-credited day still counts for the streak exactly like any completed day.
    expect(streakFromDispositions(walked.dispositions, completionDay)).toBe(5);
  });

  it('[INV-DAY-08] goal chests over a 400-day span equal the distinct days whose XP crossed the goal', () => {
    fc.assert(
      fc.property(
        arbInstant(),
        arbZoneId(ZONES),
        fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 400 }),
        fc.integer({ min: 1, max: 50 }),
        (instant, zoneId, xpPerDay, goalXp) => {
          const stamp = zoneAt(zoneId, instant);
          const first = localDayOfStamp(instant, stamp);
          const rows: SessionRow[] = [];
          let expected = 0;
          for (let i = 0; i < xpPerDay.length; i += 1) {
            const day = addCivilDays(first, i);
            const xp = xpPerDay[i]!;
            if (xp === 0) continue;
            // Two sessions on the day, so "crossed the goal" is about the day's TOTAL.
            rows.push(dayRow(`a${i}`, day, stamp, Math.ceil(xp / 2)));
            rows.push(dayRow(`b${i}`, day, stamp, Math.floor(xp / 2)));
            if (xp >= goalXp) expected += 1;
          }
          expect(goalChestDays(rows, goalXp).size).toBe(expected);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  /* ------------------------------------------------------------------ INV-DAY-10/13 */

  it('[INV-DAY-10] time-of-day predicates read the zone stamped on the row, never the current one', () => {
    const input = falsifier('INV-DAY-10') as {
      startUtc: string;
      rowTz: string;
      otherTz: string;
      rowLocalHour: number;
      otherLocalHour: number;
    };
    const row = rowAt({
      sessionId: 'n1',
      startUtc: input.startUtc,
      durationMs: 0,
      tzId: input.rowTz,
    });
    expect(localTimeOfRow(row).hour).toBe(input.rowLocalHour);
    expect(isNocturnal(row)).toBe(true);
    // The same instant read in the other zone is not nocturnal at all — which is exactly
    // why the predicate must never be recomputed against wherever the device is now.
    expect(offsetMinutesOf(new Date(input.startUtc), input.otherTz) / 60).not.toBe(
      offsetMinutesOf(new Date(input.startUtc), input.rowTz) / 60,
    );
    const elsewhere = rowAt({
      sessionId: 'n2',
      startUtc: input.startUtc,
      durationMs: 0,
      tzId: input.otherTz,
    });
    expect(localTimeOfRow(elsewhere).hour).toBe(input.otherLocalHour);
    expect(isNocturnal(elsewhere)).toBe(false);
    // And re-reading the original row is stable however many zones later.
    expect(isNocturnal(row)).toBe(true);
  });

  it('[INV-DAY-13] falsifier: a date-line fixture neither resets nor double-awards Weekend Warrior', () => {
    const input = falsifier('INV-DAY-13') as {
      saturday: string;
      sunday: string;
      weekKey: string;
      tz: string;
    };
    const saturday = toLocalDay(input.saturday);
    const sunday = toLocalDay(input.sunday);
    const stamp = zoneAt(input.tz, `${input.saturday}T12:00:00Z`);

    const lived = new Map<LocalDay, DayDisposition>([
      [saturday, 'completed'],
      [sunday, 'completed'],
    ]);
    const rows = [dayRow('sa', saturday, stamp, 13), dayRow('su', sunday, stamp, 13)];
    expect(weekendWarriorWeeks(rows, lived)).toEqual([toLocalDay(input.weekKey)]);

    // A doubled civil Saturday (westward travel) awards ONCE, not twice.
    const doubled = [...rows, dayRow('sa2', saturday, stamp, 13)];
    expect(weekendWarriorWeeks(doubled, lived)).toEqual([toLocalDay(input.weekKey)]);

    // EC-STK-22: the Sunday was jumped over, so the week is SKIPPED — not reset, not
    // awarded. A predicate that iterated civil dates instead of lived ones would reset it.
    const sundayUnlived = new Map<LocalDay, DayDisposition>([
      [saturday, 'completed'],
      [sunday, 'unlived'],
    ]);
    expect(weekendWarriorWeeks(rows, sundayUnlived)).toEqual([]);
    expect(weekendWarriorWeeks([rows[0]!], sundayUnlived)).toEqual([]);
  });

  /* ------------------------------------------------------------------ INV-DAY-11 */

  it('[INV-DAY-11] Score, gems and lifetime XP are invariant under every clock and zone move', () => {
    const seed = falsifier('INV-DAY-11') as {
      instantUtc: string;
      awards: [number, number][];
      zoneIds: string[];
      skewDays: number;
    };
    const seedInstant = new Date(seed.instantUtc);
    const seedDay = localDayOf(seedInstant, 'UTC');
    const seedRows = seed.awards.map(([xp, gems], i) =>
      dayRow(
        `seed${i}`,
        seedDay,
        zoneAt(seed.zoneIds[i % seed.zoneIds.length]!, seedInstant),
        xp,
        gems,
      ),
    );
    const seedTotals = lifetimeTotals(seedRows);
    expect(seedTotals.lifetimeXp).toBe(seed.awards.reduce((n, [xp]) => n + xp, 0));
    expect(seedTotals.gems).toBe(seed.awards.reduce((n, [, gems]) => n + gems, 0));
    // Move every row into a different zone and shove the clock a whole year: unchanged.
    expect(
      lifetimeTotals(
        seedRows.map((row, i) => ({
          ...row,
          completionZone: zoneAt(seed.zoneIds[(i + 1) % seed.zoneIds.length]!, seedInstant),
          completedAtUtcMs: row.completedAtUtcMs + seed.skewDays * 86_400_000,
          completedLocalDay: addCivilDays(row.completedLocalDay, seed.skewDays),
          rewardLocalDay: addCivilDays(row.completedLocalDay, seed.skewDays),
        })),
      ),
    ).toEqual(seedTotals);

    fc.assert(
      fc.property(
        arbInstant(),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 30 })), {
          minLength: 1,
          maxLength: 40,
        }),
        fc.array(arbZoneId(ZONES), { minLength: 1, maxLength: 40 }),
        fc.integer({ min: -400 * 86_400_000, max: 400 * 86_400_000 }),
        (instant, awards, zoneIds, skew) => {
          const base = awards.map(([xp, gems], i) =>
            dayRow(
              `s${i}`,
              localDayOf(instant, 'UTC'),
              zoneAt(zoneIds[i % zoneIds.length]!, instant),
              xp,
              gems,
            ),
          );
          const totals = lifetimeTotals(base);
          // Restamp every row into a different zone and shove the wall clock around.
          const moved = base.map((row, i) => ({
            ...row,
            completionZone: zoneAt(zoneIds[(i + 1) % zoneIds.length]!, instant),
            startZone: zoneAt(zoneIds[(i + 2) % zoneIds.length]!, instant),
            completedAtUtcMs: row.completedAtUtcMs + skew,
            derivedCompletionUtcMs: row.derivedCompletionUtcMs + skew,
            completedLocalDay: addCivilDays(row.completedLocalDay, skew > 0 ? 3 : -3),
            rewardLocalDay: addCivilDays(row.completedLocalDay, skew > 0 ? 3 : -3),
          }));
          expect(lifetimeTotals(moved)).toEqual(totals);
          // A replayed commit is the same session, not a second one.
          expect(lifetimeTotals([...base, ...base])).toEqual(totals);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  /* ------------------------------------------------------------------ INV-DAY-12 */

  it('[INV-DAY-12] a quest countdown may lengthen across a zone change but never shorten', () => {
    fc.assert(
      fc.property(
        arbInstant(),
        arbZoneId(ZONES),
        arbZoneId(ZONES),
        (instant, fromZoneId, toZoneId) => {
          const from = zoneAt(fromZoneId, instant);
          const to = zoneAt(toZoneId, instant);
          const before = questWindow(null, instant.getTime(), from);
          const after = questWindow(before, instant.getTime(), to);
          if (after.day === before.day) {
            // Same quest day: the promised expiry never moves earlier, so the countdown
            // can only lengthen. Progress is keyed to the day and therefore untouched.
            expect(after.expiresAtUtcMs).toBeGreaterThanOrEqual(before.expiresAtUtcMs);
            expect(questCountdownSeconds(after, instant.getTime())).toBeGreaterThanOrEqual(
              questCountdownSeconds(before, instant.getTime()),
            );
            // …and never below the true remaining time in the new zone.
            const trueRemaining = Math.max(
              0,
              Math.ceil(
                (localMidnightUtcMs(addCivilDays(after.day, 1), to.utcOffsetMinutes) -
                  instant.getTime()) /
                  1000,
              ),
            );
            expect(questCountdownSeconds(after, instant.getTime())).toBeGreaterThanOrEqual(
              trueRemaining,
            );
          }
          expect(questCountdownSeconds(after, instant.getTime())).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-DAY-12] quest progress is keyed to local_day, so a zone change preserves it', () => {
    const input = falsifier('INV-DAY-12') as {
      instantUtc: string;
      fromTz: string;
      toTz: string;
      xp: number[];
    };
    const instant = new Date(input.instantUtc);
    const tokyo = zoneAt(input.fromTz, instant);
    const la = zoneAt(input.toTz, instant);
    const day = localDayOfStamp(instant, tokyo);
    const rows = input.xp.map((xp, i) => dayRow(`q${i}`, day, tokyo, xp));
    const before = questWindow(null, instant.getTime(), tokyo);
    const total = input.xp.reduce((n, xp) => n + xp, 0);
    expect(questProgressXp(rows, before.day)).toBe(total);
    const after = questWindow(before, instant.getTime(), la);
    // UTC+9 → UTC−7 moves the civil date back, so this is a NEW quest day; the Tokyo day's
    // progress is still exactly where it was and nothing was reset early.
    expect(questProgressXp(rows, before.day)).toBe(total);
    expect(questCountdownSeconds(after, instant.getTime())).toBeGreaterThan(0);
  });

  /* ------------------------------------------------------------------ INV-DAY-14 */

  it('[INV-DAY-14] falsifier: a 1970 install mints no day-keyed reward and walks no 20,000 days', () => {
    const input = falsifier('INV-DAY-14') as {
      deadBatteryUtc: string;
      tz: string;
      buildLocalDay: string;
      correctedTo: string;
      goalXp: number;
    };
    const row = rowAt({
      sessionId: 'dead-battery',
      startUtc: input.deadBatteryUtc,
      durationMs: 5 * 60_000,
      tzId: input.tz,
      xp: 40,
      gems: 5,
      buildLocalDay: input.buildLocalDay,
    });
    // XP and gems are awarded; every day-keyed reward is deferred (EC-STK-23).
    expect(row.dayKeyingDeferred).toBe(true);
    expect(row.creditedLocalDay).toBeNull();
    expect(row.rewardLocalDay).toBeNull();
    expect(row.earnedXp).toBe(40);
    expect(row.earnedGems).toBe(5);
    expect(goalChestDays([row], input.goalXp)).toEqual(new Set());
    expect(lifetimeTotals([row]).lifetimeXp).toBe(40);

    // Then the OS corrects the clock. The first sane day becomes day one, with no
    // backfill: no 20,000 cells, and at most one freeze consumed.
    const state = {
      ...stateWithStreak({ lastDay: row.startedLocalDay, streak: 1, freezes: 2 }),
      clockUnreliable: true,
    };
    const adopted = rolloverTo(state, toLocalDay(input.correctedTo), {
      completedDays: new Set<LocalDay>(),
    });
    expect(adopted.freezesConsumed).toBeLessThanOrEqual(1);
    expect(adopted.daysProcessed).toBe(0);
    expect(adopted.state.clockUnreliable).toBe(false);
    // The marker is the day BEFORE the first sane day, so that day itself is still
    // decidable — adopting it outright would skip it forever.
    expect(adopted.state.lastProcessedDay).toBe(addCivilDays(toLocalDay(input.correctedTo), -1));
    expect(adopted.state.dispositions.size).toBeLessThanOrEqual(state.dispositions.size);
    expect(adopted.events.some((e) => e.kind === 'clock-adopted')).toBe(true);
  });

  /* ------------------------------------------------------------------ INV-DAY-15 */

  it('[INV-DAY-15] the credited day is written once at commit and survives any wall-clock perturbation', () => {
    fc.assert(
      fc.property(
        arbInstant(),
        arbZoneId(ZONES),
        fc.integer({ min: 0, max: 3 * 3_600_000 }),
        fc.integer({ min: -6 * 3_600_000, max: 6 * 3_600_000 }),
        (instant, zoneId, durationMs, wallClockSkewMs) => {
          const start = {
            sessionId: 'one',
            startedAtUtcMs: instant.getTime(),
            startedAtMonotonicMs: 1_000,
            startZone: zoneAt(zoneId, instant),
          };
          const completionZone = zoneAt(zoneId, new Date(instant.getTime() + durationMs));
          const clean = commitSession(
            start,
            {
              completedAtUtcMs: instant.getTime() + durationMs,
              completedAtMonotonicMs: 1_000 + durationMs,
              completionZone,
              earnedXp: 13,
              earnedGems: 0,
            },
            { satisfiedDays: new Set<LocalDay>(), buildLocalDay: '1970-01-01' },
          );
          // An NTP correction lands mid-session: the wall clock at commit is wrong by
          // `wallClockSkewMs`, the monotonic elapsed is not (EC-STK-24).
          const perturbed = commitSession(
            start,
            {
              completedAtUtcMs: instant.getTime() + durationMs + wallClockSkewMs,
              completedAtMonotonicMs: 1_000 + durationMs,
              completionZone,
              earnedXp: 13,
              earnedGems: 0,
            },
            { satisfiedDays: new Set<LocalDay>(), buildLocalDay: '1970-01-01' },
          );
          expect(perturbed.creditedLocalDay).toBe(clean.creditedLocalDay);
          expect(perturbed.completedLocalDay).toBe(clean.completedLocalDay);
          expect(perturbed.creditedByGrace).toBe(clean.creditedByGrace);
          expect(perturbed.derivedCompletionUtcMs).toBe(clean.derivedCompletionUtcMs);

          // A replay under the same `session_id` returns the stored row, byte for byte.
          const committed = new Map([[clean.sessionId, clean]]);
          const replay = commitSession(
            start,
            {
              completedAtUtcMs: instant.getTime() + durationMs + 999_999,
              completedAtMonotonicMs: 1_000 + durationMs + 999_999,
              completionZone: zoneAt('Pacific/Kiritimati', instant),
              earnedXp: 999,
              earnedGems: 999,
            },
            { satisfiedDays: new Set<LocalDay>(), committed, buildLocalDay: '1970-01-01' },
          );
          expect(replay).toEqual(clean);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-DAY-15] a negative monotonic elapsed is clamped to zero, never trusted', () => {
    const input = falsifier('INV-DAY-15') as {
      instantUtc: string;
      tz: string;
      startedAtMonotonicMs: number;
      completedAtMonotonicMs: number;
      wallClockDeltaMs: number;
    };
    const instant = new Date(input.instantUtc);
    const row = commitSession(
      {
        sessionId: 'reset',
        startedAtUtcMs: instant.getTime(),
        startedAtMonotonicMs: input.startedAtMonotonicMs,
        startZone: zoneAt(input.tz, instant),
      },
      {
        completedAtUtcMs: instant.getTime() + input.wallClockDeltaMs,
        completedAtMonotonicMs: input.completedAtMonotonicMs, // the counter was reset
        completionZone: zoneAt(input.tz, instant),
        earnedXp: 13,
        earnedGems: 0,
      },
      { satisfiedDays: new Set<LocalDay>() },
    );
    expect(row.derivedCompletionUtcMs).toBe(instant.getTime());
    expect(row.completedLocalDay).toBe(row.startedLocalDay);
  });

  /* ------------------------------------------------------------------ INV-DAY-17 */

  it('[INV-DAY-17] falsifier: local_day does not shift when the identifier changes but the offset does not', () => {
    const input = falsifier('INV-DAY-17') as {
      instant: string;
      sameOffsetIds: string[];
      utcIds: string[];
    };
    const instant = new Date(input.instant);
    const days = input.sameOffsetIds.map((id) =>
      localDayOfStamp(instant, resolveZone(instant, id)),
    );
    expect(new Set(days).size).toBe(1);
    const offsets = input.sameOffsetIds.map((id) => offsetMinutesOf(instant, id));
    expect(new Set(offsets).size).toBe(1);
    // `Etc/GMT-5` is UTC+5 — a number wearing a name — and must agree with a real zone.
    expect(resolveZone(instant, 'Etc/GMT-5').tzSource).toBe('fixed_offset');
    expect(resolveZone(instant, 'Asia/Karachi').tzSource).toBe('iana');
    expect(resolveZone(instant, 'Not/AZone').tzSource).toBe('unknown');

    const utcDays = input.utcIds.map((id) => localDayOfStamp(instant, resolveZone(instant, id)));
    expect(new Set([...utcDays, localDayFromOffset(instant, 0)]).size).toBe(1);
  });

  it('[INV-DAY-17] any two identifiers sharing one offset produce the same local_day', () => {
    fc.assert(
      fc.property(
        arbInstant(),
        fc.integer({ min: -12 * 60, max: 14 * 60 }),
        arbZoneId(ZONES),
        (instant, offsetMinutes, zoneId) => {
          // Two stamps, different identifiers, one offset.
          const a = fixedOffsetZone(offsetMinutes);
          const b = {
            tzId: `Made/Up_${offsetMinutes}`,
            utcOffsetMinutes: offsetMinutes,
            tzSource: 'unknown' as const,
          };
          expect(localDayOfStamp(instant, a)).toBe(localDayOfStamp(instant, b));
          // And a real zone agrees with a bare offset equal to its own at that instant.
          const real = resolveZone(instant, zoneId);
          expect(localDayOfStamp(instant, real)).toBe(
            localDayOfStamp(instant, fixedOffsetZone(real.utcOffsetMinutes)),
          );
          // The offset-derived day equals what the calendar says in that zone.
          expect(localDayOfStamp(instant, real)).toBe(localDayOf(instant, zoneId));
          expect(real.tzSource).toBe('iana');
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

/** A committed row completing at 12:00 local on `day`, in `stamp`'s zone. */
function dayRow(
  sessionId: string,
  day: LocalDay,
  stamp: ReturnType<typeof zoneAt>,
  xp: number,
  gems = 0,
): SessionRow {
  const utcMs = localMidnightUtcMs(day, stamp.utcOffsetMinutes) + 12 * 3_600_000;
  return {
    sessionId,
    startedAtUtcMs: utcMs,
    startZone: stamp,
    startedLocalDay: day,
    completedAtUtcMs: utcMs,
    completionZone: stamp,
    completedLocalDay: day,
    derivedCompletionUtcMs: utcMs,
    creditedLocalDay: day,
    rewardLocalDay: day,
    creditedByGrace: false,
    dayKeyingDeferred: false,
    earnedXp: xp,
    earnedGems: gems,
  };
}
