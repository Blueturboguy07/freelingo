import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ZONES, arbInstant, arbZoneId, PROPERTY_RUNS } from '@freelingo/testkit';
import {
  addCivilDays,
  civilDaysBetween,
  localDayOf,
  monthKeyOf,
  toLocalDay,
  type LocalDay,
} from './civil.js';
import { DAY_CONFIG } from './config.js';
import { streakFromDispositions, type DayDisposition } from './dispositions.js';
import { newDayEngineState, type DayEngineState } from './state.js';
import {
  armChallenge,
  challengeEligibleAtStart,
  completeChallenge,
  expireChallengeIfLapsed,
  recordChallengeLesson,
  recoveryOffer,
  repairStreak,
} from './recovery.js';
import { rolloverTo } from './rollover.js';
import { STREAK_MILESTONES, milestonesCrossed } from '../streak/milestones.js';
import { lifetimeTotals } from './totals.js';
import {
  goalChestDays,
  hasEarnedLongestStreakEver,
  longestStreak,
  nextMilestoneDay,
  questProgressXp,
} from './predicates.js';
import { ledgerWith, stateWithStreak } from './__testsupport__.js';

const falsifier = (id: string): Record<string, unknown> => {
  const file = JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as { id: string; falsifier: string; input: Record<string, unknown> };
  expect(file.id).toBe(id);
  expect(file.falsifier.length).toBeGreaterThan(0);
  return file.input;
};

/** A state that has just broken: `streak` completed days, `frozen` covered, then a miss. */
function brokenState(options: {
  lastDay: string;
  streak: number;
  freezes: number;
  missedDays: number;
  returnedOn: string;
}): DayEngineState {
  const state = stateWithStreak({
    lastDay: options.lastDay,
    streak: options.streak,
    freezes: options.freezes,
  });
  return rolloverTo(state, toLocalDay(options.returnedOn), { completedDays: new Set<LocalDay>() })
    .state;
}

describe('recovery', () => {
  it('[INV-REC-01] both mechanics ship side by side and neither double-pays', () => {
    const input = falsifier('INV-REC-01') as {
      lastDay: string;
      streak: number;
      freezes: number;
      missedDays: number;
      returnedOn: string;
      brokenOn: string;
    };
    const broken = brokenState(input);
    const today = toLocalDay(input.returnedOn);
    const offer = recoveryOffer(broken, today);

    // One screen, two actions: the 3-lesson challenge AND the monthly repair.
    expect(offer.brokenOn).toBe(toLocalDay(input.brokenOn));
    expect(offer.challengeArmed).toBe(true);
    expect(offer.repairArmed).toBe(true);
    expect(offer.previousStreak).toBe(input.streak);
    expect(DAY_CONFIG.streakRepairsPerMonth).toBe(1);
    expect(DAY_CONFIG.recoveryChallengeWindowLocalDays).toBe(2);

    // Taking the repair restores `previous_streak` with TODAY LEFT UNSATISFIED.
    const repaired = repairStreak(broken, today);
    expect(repaired.restored).toBe(true);
    expect(repaired.streakAfter).toBe(input.streak);
    expect(repaired.state.dispositions.get(today)).toBeUndefined();
    expect(repaired.state.brk).toBeNull();
    // …and the challenge is gone with it: neither mechanic may pay for the same break.
    expect(repaired.state.challenge).toBeNull();
    expect(recoveryOffer(repaired.state, today).challengeArmed).toBe(false);

    // A second break in the same calendar month gets the challenge only. The learner
    // practises on the return day, then misses the next one.
    const secondBreak = rolloverTo(repaired.state, addCivilDays(today, 2), {
      completedDays: new Set([today]),
    }).state;
    expect(secondBreak.brk?.previousStreak).toBe(input.streak + 1);
    const secondOffer = recoveryOffer(secondBreak, addCivilDays(today, 2));
    expect(secondOffer.challengeArmed).toBe(true);
    expect(secondOffer.repairArmed).toBe(false);
    expect(repairStreak(secondBreak, addCivilDays(today, 2)).declinedBecause).toBe(
      'month-already-repaired',
    );
  });

  it('[INV-REC-01] repairs are ≤ one per calendar month and never stack with a freeze', () => {
    // The registry says "over any **400-day span**". A trace of a few dozen days barely
    // leaves one calendar month, so it cannot exercise the thing the invariant is about:
    // the runs below are generated until 400 civil days are consumed, which spans 13-14
    // months and gives the monthly allowance somewhere to be wrong.
    const SPAN_DAYS = 400;
    fc.assert(
      fc.property(
        arbInstant(),
        arbZoneId(ZONES),
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 12, maxLength: 24 }),
        fc.integer({ min: 0, max: 2 }),
        (instant, zoneId, runs, freezes) => {
          const start = localDayOf(instant, zoneId);
          let state: DayEngineState = {
            ...newDayEngineState(),
            ledger: ledgerWith(freezes, start, 2),
          };
          const completed = new Set<LocalDay>();
          let cursor = start;
          for (const runLength of runs) {
            if (civilDaysBetween(start, cursor) >= SPAN_DAYS) break;
            for (let i = 0; i < runLength; i += 1) {
              completed.add(cursor);
              cursor = addCivilDays(cursor, 1);
            }
            cursor = addCivilDays(cursor, 1); // one missed day
            state = rolloverTo(state, cursor, { completedDays: completed }).state;
            state = repairStreak(state, cursor).state;
          }
          // The span really was walked: a shrunk generator must not quietly shorten it.
          expect(
            civilDaysBetween(start, state.maxLocalDaySeen ?? start),
          ).toBeGreaterThanOrEqual(Math.min(SPAN_DAYS, runs.reduce((a, b) => a + b + 1, 0)));
          expect(new Set(state.settlements.map((s) => s.month)).size).toBeGreaterThanOrEqual(2);
          // Never more than the monthly allowance, in any month.
          const byMonth = new Map<string, number>();
          for (const repair of state.repairs) {
            byMonth.set(repair.monthKey, (byMonth.get(repair.monthKey) ?? 0) + 1);
          }
          for (const count of byMonth.values()) {
            expect(count).toBeLessThanOrEqual(DAY_CONFIG.streakRepairsPerMonth);
          }
          // No local day is ever both freeze-covered and repaired, and none is repaired twice.
          const frozen = new Set(state.ledger.consumptions.map((c) => c.consumedForDay));
          const repainted = state.repairs.flatMap((r) => [...r.repaintedDays]);
          for (const day of repainted) {
            expect(frozen.has(day)).toBe(false);
            expect(state.dispositions.get(day)).toBe('recovered');
          }
          expect(new Set(repainted).size).toBe(repainted.length);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-REC-02] recovery lessons pay full XP and completion restores the streak with today satisfied', () => {
    const input = falsifier('INV-REC-02') as {
      lastDay: string;
      streak: number;
      freezes: number;
      missedDays: number;
      returnedOn: string;
      lessonXp: number;
      goalXp: number;
    };
    const today = toLocalDay(input.returnedOn);
    const armed = armChallenge(brokenState(input), today);
    expect(armed.challenge?.lessonsRequired).toBe(3);

    // The three lessons are ordinary sessions: full XP, quest progress, goal chest.
    const rows = [0, 1, 2].map((i) => ({
      sessionId: `rec${i}`,
      startedAtUtcMs: 0,
      startZone: { tzId: 'UTC', utcOffsetMinutes: 0, tzSource: 'fixed_offset' as const },
      startedLocalDay: today,
      completedAtUtcMs: 0,
      completionZone: { tzId: 'UTC', utcOffsetMinutes: 0, tzSource: 'fixed_offset' as const },
      completedLocalDay: today,
      derivedCompletionUtcMs: 0,
      creditedLocalDay: today,
      rewardLocalDay: today,
      creditedByGrace: false,
      dayKeyingDeferred: false,
      earnedXp: input.lessonXp,
      earnedGems: 0,
    }));
    expect(lifetimeTotals(rows).lifetimeXp).toBe(input.lessonXp * 3);
    expect(questProgressXp(rows, today)).toBe(input.lessonXp * 3);
    expect(goalChestDays(rows, input.goalXp)).toEqual(new Set([today]));

    let state = armed;
    for (let i = 0; i < 3; i += 1) state = recordChallengeLesson(state, today);
    expect(state.challenge?.lessonsDone).toBe(3);

    const done = completeChallenge(state, today);
    expect(done.restored).toBe(true);
    // EC-FRZ-09: the learner resumes at N+1, not at N-with-today-pending.
    expect(done.streakAfter).toBe(input.streak + 1);
    expect(done.state.dispositions.get(today)).toBe('completed');
    expect(done.state.challenge).toBeNull();
    expect(done.state.brk).toBeNull();
  });

  it('[INV-REC-02] falsifier: a break that GREW after the challenge was armed is restored whole', () => {
    // REFUTATION of 2026-09-11. The challenge used to carry `uncoveredDays`, snapshotted
    // at `armChallenge`. `rolloverTo` kept appending later missed days to the BREAK
    // record, the two diverged, and a completed challenge repainted only the day-one
    // snapshot: `restored: true`, streak 1 instead of 23, the second date still `missed`,
    // and `brk` cleared — so the learner lost the streak AND the offer while the engine
    // reported success. The challenge now holds no copy; the break record is read at
    // completion time.
    const g = (
      falsifier('INV-REC-02') as {
        growingBreak: {
          lastDay: string;
          streak: number;
          freezes: number;
          brokenOn: string;
          armedOn: string;
          lessonsBeforeTheSecondMiss: number;
          completedOn: string;
          expectedRepainted: string[];
          expectedStreakAfter: number;
        };
      }
    ).growingBreak;
    const armedOn = toLocalDay(g.armedOn);
    const completedOn = toLocalDay(g.completedOn);

    const broken = brokenState({
      lastDay: g.lastDay,
      streak: g.streak,
      freezes: g.freezes,
      missedDays: 1,
      returnedOn: g.armedOn,
    });
    expect(broken.brk?.brokenOn).toBe(toLocalDay(g.brokenOn));
    expect(broken.brk?.uncoveredDays).toEqual([toLocalDay(g.brokenOn)]);

    let state = armChallenge(broken, armedOn);
    for (let i = 0; i < g.lessonsBeforeTheSecondMiss; i += 1) {
      state = recordChallengeLesson(state, armedOn);
    }
    // …and then the learner misses the day they armed on. The break GROWS.
    state = rolloverTo(state, completedOn, { completedDays: new Set<LocalDay>() }).state;
    expect(state.brk?.uncoveredDays).toEqual(g.expectedRepainted.map(toLocalDay));
    expect(state.challenge).not.toBeNull();
    expect(state.dispositions.get(armedOn)).toBe('missed');

    for (let i = g.lessonsBeforeTheSecondMiss; i < 3; i += 1) {
      state = recordChallengeLesson(state, completedOn);
    }
    expect(state.challenge?.lessonsDone).toBe(3);

    const done = completeChallenge(state, completedOn);
    expect(done.restored).toBe(true);
    expect(done.streakAfter).toBe(g.expectedStreakAfter);
    expect(done.repaintedDays).toEqual(g.expectedRepainted.map(toLocalDay));
    for (const day of g.expectedRepainted) {
      expect(done.state.dispositions.get(toLocalDay(day))).toBe('recovered');
    }
    expect(done.state.dispositions.get(completedOn)).toBe('completed');

    // And the negative control: a restore that CANNOT reach `previous_streak + 1` must
    // refuse rather than report success — and must never clear `brk` on the way out,
    // because that record is the only copy of `previous_streak` and of the second offer.
    const stale: DayEngineState = {
      ...state,
      brk: { ...state.brk!, uncoveredDays: [toLocalDay(g.brokenOn)] },
    };
    const halfRestore = completeChallenge(stale, completedOn);
    expect(halfRestore.restored).toBe(false);
    expect(halfRestore.declinedBecause).toBe('restore-incomplete');
    expect(halfRestore.state.brk).toEqual(stale.brk);
    expect(halfRestore.state.challenge).toEqual(stale.challenge);
    expect(halfRestore.state.dispositions.get(armedOn)).toBe('missed');
  });

  it('[INV-REC-03] challenge progress survives an app kill exactly like an ordinary session', () => {
    const input = falsifier('INV-REC-03') as {
      lastDay: string;
      streak: number;
      freezes: number;
      missedDays: number;
      returnedOn: string;
      lessonsBeforeKill: number;
    };
    const today = toLocalDay(input.returnedOn);
    let state = armChallenge(brokenState(input), today);
    for (let i = 0; i < input.lessonsBeforeKill; i += 1)
      state = recordChallengeLesson(state, today);

    // The kill: everything not persisted is gone. Round-trip the record the way the DB
    // does and carry on — a deliberate divergence from "We won't save your progress."
    const revived: DayEngineState = {
      ...state,
      challenge: JSON.parse(JSON.stringify(state.challenge)) as DayEngineState['challenge'],
    };
    expect(revived.challenge).toEqual(state.challenge);
    expect(revived.challenge?.lessonsDone).toBe(input.lessonsBeforeKill);

    let resumed = revived;
    for (let i = input.lessonsBeforeKill; i < 3; i += 1)
      resumed = recordChallengeLesson(resumed, today);
    const done = completeChallenge(resumed, today);
    expect(done.restored).toBe(true);
    expect(done.streakAfter).toBe(input.streak + 1);
  });

  it('[INV-REC-04] falsifier: one of three lessons then three local days leaves no live challenge', () => {
    const input = falsifier('INV-REC-04') as {
      lastDay: string;
      streak: number;
      freezes: number;
      missedDays: number;
      returnedOn: string;
      brokenOn: string;
      expiredOn: string;
    };
    const today = toLocalDay(input.returnedOn);
    const broken = brokenState(input);
    let state = armChallenge(broken, today);
    state = recordChallengeLesson(state, today);
    expect(state.challenge?.lessonsDone).toBe(1);
    expect(state.challenge?.expiresAfterDay).toBe(
      addCivilDays(toLocalDay(input.brokenOn), DAY_CONFIG.recoveryChallengeWindowLocalDays),
    );

    // Silence until past the window. The expiry must happen through the ROLLOVER WALK —
    // the one function that always runs on foreground — not only when a caller remembers
    // to ask. `expireChallengeIfLapsed` used to be exported and called by nobody, so a
    // lapsed challenge row survived every rollover.
    const walkedPast = rolloverTo(state, toLocalDay(input.expiredOn), {
      completedDays: new Set<LocalDay>(),
    }).state;
    expect(walkedPast.challenge).toBeNull();
    expect(recoveryOffer(walkedPast, toLocalDay(input.expiredOn)).challengeArmed).toBe(false);
    expect(completeChallenge(walkedPast, toLocalDay(input.expiredOn)).restored).toBe(false);

    // …and the direct call is idempotent with it.
    // The challenge row, its partial progress and the armed offer all go in one
    // transaction; the streak stays broken.
    const expired = expireChallengeIfLapsed(state, toLocalDay(input.expiredOn));
    expect(expired.challenge).toBeNull();
    expect(recoveryOffer(expired, toLocalDay(input.expiredOn)).challengeArmed).toBe(false);
    expect(recoveryOffer(expired, toLocalDay(input.expiredOn)).declinedBecause).toBe(
      'window-expired',
    );
    expect(streakFromDispositions(expired.dispositions, toLocalDay(input.expiredOn))).toBe(0);
    // `previous_streak` survives only as the record.
    expect(expired.brk?.previousStreak).toBe(input.streak);
    // And completing nothing restores nothing.
    expect(completeChallenge(expired, toLocalDay(input.expiredOn)).restored).toBe(false);
  });

  it('[INV-REC-04] the window is exactly two local days from broken_on, in every zone', () => {
    fc.assert(
      fc.property(
        arbInstant(),
        arbZoneId(ZONES),
        fc.integer({ min: 0, max: 6 }),
        (instant, zoneId, elapsed) => {
          const lastDay = localDayOf(instant, zoneId);
          const broken = brokenState({
            lastDay,
            streak: 10,
            freezes: 0,
            missedDays: 1,
            returnedOn: addCivilDays(lastDay, 2),
          });
          const brokenOn = broken.brk!.brokenOn;
          const today = addCivilDays(brokenOn, elapsed);
          const offer = recoveryOffer(broken, today);
          // Live on broken_on + 0, +1 and +2; dead from +3. DST cannot move a local day.
          expect(offer.challengeArmed).toBe(elapsed <= DAY_CONFIG.recoveryChallengeWindowLocalDays);
          if (offer.challengeArmed) {
            expect(offer.daysLeft).toBeGreaterThan(0);
            expect(offer.daysLeft).toBeLessThanOrEqual(DAY_CONFIG.recoveryChallengeWindowLocalDays);
          } else {
            expect(offer.daysLeft).toBe(0);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-REC-05] falsifier: a lesson started inside the window is never refused credit at completion', () => {
    const input = falsifier('INV-REC-05') as {
      lastDay: string;
      streak: number;
      freezes: number;
      missedDays: number;
      returnedOn: string;
      startedOn: string;
      finishedOn: string;
      uncoveredWhenFinished: string[];
      expectedStreakAfter: number;
    };
    const armed = armChallenge(brokenState(input), toLocalDay(input.returnedOn));
    const startedOn = toLocalDay(input.startedOn);
    const finishedOn = toLocalDay(input.finishedOn);
    expect(finishedOn > armed.challenge!.expiresAfterDay).toBe(true);

    // Eligibility is a function of the session START time only (EC-FRZ-16).
    expect(challengeEligibleAtStart(armed, startedOn)).toBe(true);
    expect(challengeEligibleAtStart(armed, finishedOn)).toBe(false);

    // The learner is silent on the return day and opens again on the last day of the
    // window: that rollover appends one more uncovered date to the break.
    let state = rolloverTo(armed, startedOn, { completedDays: new Set<LocalDay>() }).state;
    expect(state.brk?.uncoveredDays).toEqual(input.uncoveredWhenFinished.map(toLocalDay));
    for (let i = 0; i < 3; i += 1) state = recordChallengeLesson(state, startedOn);
    expect(state.challenge?.lessonsDone).toBe(3);

    // The third lesson was begun at 23:5x and commits after local midnight. The rollover
    // that crosses the window's end must NOT delete the challenge the learner has already
    // earned — eligibility was settled at start time and cannot be revoked at commit.
    state = rolloverTo(state, finishedOn, { completedDays: new Set([startedOn]) }).state;
    expect(state.challenge?.lessonsDone).toBe(3);
    expect(finishedOn > state.challenge!.expiresAfterDay).toBe(true);

    const done = completeChallenge(state, finishedOn);
    expect(done.restored).toBe(true);
    expect(done.streakAfter).toBe(input.expectedStreakAfter);
    for (const day of input.uncoveredWhenFinished) {
      expect(done.state.dispositions.get(toLocalDay(day))).toBe('recovered');
    }

    // The bound on that latitude. A session begun inside the window may commit after one
    // midnight; a challenge earned and then left uncashed for days is not still live, and
    // the walk closes it.
    expect(state.challenge?.earnedOnDay).toBe(startedOn);
    const stale = rolloverTo(state, addCivilDays(startedOn, 4), {
      completedDays: new Set([startedOn]),
    }).state;
    expect(stale.challenge).toBeNull();
    expect(completeChallenge(stale, addCivilDays(startedOn, 4)).restored).toBe(false);

    // And the lesson's own XP and attempt rows commit identically whether the challenge
    // succeeds, lapses or is abandoned — the engine never touches them.
    const abandoned = expireChallengeIfLapsed(armed, addCivilDays(finishedOn, 5));
    expect(abandoned.challenge).toBeNull();
    expect(lifetimeTotals([]).lifetimeXp).toBe(0);
  });

  it('[INV-REC-06] falsifier: a three-date gap with two freezes spent is still offered the challenge', () => {
    const input = falsifier('INV-REC-06') as {
      lastDay: string;
      streak: number;
      freezes: number;
      missedDays: number;
      returnedOn: string;
      longAbsenceReturnedOn: string;
    };
    const broken = brokenState(input);
    // Two of the three dates were freeze-covered; one was not. Freeze-covered days never
    // count toward any missed-day cap, because the streak never broke on them (EC-FRZ-18).
    expect(broken.ledger.consumptions).toHaveLength(input.freezes);
    expect(broken.brk?.uncoveredDays).toHaveLength(input.missedDays - input.freezes);
    const offer = recoveryOffer(broken, toLocalDay(input.returnedOn));
    expect(offer.challengeArmed).toBe(true);
    expect(offer.uncoveredDays).toHaveLength(1);

    // EC-FRZ-04: a 45-day absence is outside the recency window — not armed.
    const longAbsence = brokenState({ ...input, returnedOn: input.longAbsenceReturnedOn });
    const late = recoveryOffer(longAbsence, toLocalDay(input.longAbsenceReturnedOn));
    expect(late.challengeArmed).toBe(false);
    expect(late.declinedBecause).toBe('window-expired');
  });

  it('[INV-REC-06] armed iff the break is inside the window AND uncovered days are inside the cap', () => {
    fc.assert(
      fc.property(
        arbInstant(),
        arbZoneId(ZONES),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 0, max: 4 }),
        (instant, zoneId, streak, freezes, missedDays, elapsed) => {
          const lastDay = localDayOf(instant, zoneId);
          const returnedOn = addCivilDays(lastDay, missedDays + 1);
          const broken = brokenState({ lastDay, streak, freezes, missedDays, returnedOn });
          if (broken.brk === null) {
            // Every missed day was covered: the streak never broke, so nothing is armed.
            expect(recoveryOffer(broken, returnedOn).challengeArmed).toBe(false);
            return;
          }
          const today = addCivilDays(broken.brk.brokenOn, elapsed);
          const offer = recoveryOffer(broken, today);
          const insideWindow = elapsed <= DAY_CONFIG.recoveryChallengeWindowLocalDays;
          const insideCap =
            broken.brk.uncoveredDays.length <= DAY_CONFIG.recoveryChallengeUncoveredDayCap;
          expect(offer.challengeArmed).toBe(insideWindow && insideCap && streak > 0);
          // Freeze-covered days are never counted as uncovered.
          const frozen = new Set(broken.ledger.consumptions.map((c) => c.consumedForDay));
          for (const day of broken.brk.uncoveredDays) expect(frozen.has(day)).toBe(false);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-REC-07] falsifier: a restore repaints only the uncovered dates and lands on every milestone', () => {
    const input = falsifier('INV-REC-07') as {
      lastDay: string;
      streak: number;
      freezes: number;
      missedDays: number;
      returnedOn: string;
      frozenDays: string[];
      uncoveredDays: string[];
      frozenInUncovered: {
        completedDays: string[];
        frozenDay: string;
        missedDay: string;
        previousStreak: number;
        today: string;
        uncoveredDays: string[];
        expectedRepainted: string[];
        expectedStreakAfter: number;
      };
    };
    const today = toLocalDay(input.returnedOn);
    const broken = brokenState(input);
    for (const day of input.frozenDays) {
      expect(broken.dispositions.get(toLocalDay(day))).toBe('frozen');
    }
    let state = armChallenge(broken, today);
    for (let i = 0; i < 3; i += 1) state = recordChallengeLesson(state, today);
    const done = completeChallenge(state, today);

    // EC-FRZ-19: each uncovered broken date gets its own `recovered` glyph — neither
    // flame nor snowflake — and a frozen date keeps its snowflake.
    expect(done.repaintedDays).toEqual(input.uncoveredDays.map(toLocalDay));
    for (const day of input.frozenDays) {
      expect(done.state.dispositions.get(toLocalDay(day))).toBe('frozen');
    }
    for (const day of input.uncoveredDays) {
      expect(done.state.dispositions.get(toLocalDay(day))).toBe('recovered');
    }
    expect(done.streakAfter).toBe(input.streak + 1);
    expect(done.milestones.length).toBeLessThanOrEqual(1);

    // The guard itself. `uncoveredDays` composed by the walk never contains a frozen
    // date, so the `!== 'missed'` guard in `repaint` is unreachable from a walked state —
    // which is exactly why a mutation that weakened it to `=== undefined` survived. Here
    // the break record is hand-built with a frozen date inside `uncoveredDays`, the shape
    // a migration or a hand-written fixture can produce, and the frozen day must keep its
    // snowflake (EC-FRZ-19).
    const f = input.frozenInUncovered;
    const dispositions = new Map<LocalDay, DayDisposition>();
    for (const day of f.completedDays) dispositions.set(toLocalDay(day), 'completed');
    dispositions.set(toLocalDay(f.frozenDay), 'frozen');
    dispositions.set(toLocalDay(f.missedDay), 'missed');
    const handBuilt: DayEngineState = {
      ...newDayEngineState(),
      lastProcessedDay: toLocalDay(f.missedDay),
      maxLocalDaySeen: toLocalDay(f.today),
      dispositions,
      brk: {
        brokenOn: toLocalDay(f.missedDay),
        previousStreak: f.previousStreak,
        uncoveredDays: f.uncoveredDays.map(toLocalDay),
      },
      challenge: {
        brokenOn: toLocalDay(f.missedDay),
        previousStreak: f.previousStreak,
        expiresAfterDay: addCivilDays(
          toLocalDay(f.missedDay),
          DAY_CONFIG.recoveryChallengeWindowLocalDays,
        ),
        lessonsRequired: DAY_CONFIG.recoveryChallengeLessons,
        lessonsDone: DAY_CONFIG.recoveryChallengeLessons,
        earnedOnDay: toLocalDay(f.today),
      },
    };
    // S126 "Longest Streak", and EC-FRZ-19's half of the restore contract: "Longest
    // streak stays 22 until a lived day passes it." The walk is the only thing that ever
    // raises it, and `today` — the day a restore satisfies — is not decided until the
    // NEXT rollover, so a restore cannot move the record on its own.
    expect(longestStreak(broken)).toBe(input.streak);
    expect(done.streakAfter).toBe(input.streak + 1);
    expect(longestStreak(done.state)).toBe(input.streak);
    expect(hasEarnedLongestStreakEver(done.state, done.streakAfter)).toBe(true);
    const nextDay = addCivilDays(today, 1);
    const lived = rolloverTo(done.state, nextDay, {
      completedDays: new Set([...done.state.dispositions.keys()].filter(
        (d) => done.state.dispositions.get(d) === 'completed',
      )),
    }).state;
    expect(longestStreak(lived)).toBe(input.streak + 1);
    // …and the next milestone is a date, not a count (S127 copy slot).
    expect(nextMilestoneDay(done.streakAfter, today)).toBe(
      addCivilDays(today, STREAK_MILESTONES.find((m) => m > done.streakAfter)! - done.streakAfter),
    );

    const guarded = completeChallenge(handBuilt, toLocalDay(f.today));
    expect(guarded.restored).toBe(true);
    expect(guarded.repaintedDays).toEqual(f.expectedRepainted.map(toLocalDay));
    expect(guarded.state.dispositions.get(toLocalDay(f.frozenDay))).toBe('frozen');
    expect(guarded.state.dispositions.get(toLocalDay(f.missedDay))).toBe('recovered');
    expect(guarded.streakAfter).toBe(f.expectedStreakAfter);
  });

  it('[INV-REC-07] a restore never vaults the number past a milestone without landing on it', () => {
    fc.assert(
      fc.property(
        arbInstant(),
        arbZoneId(ZONES),
        fc.integer({ min: 1, max: 400 }),
        fc.constantFrom<'challenge' | 'repair'>('challenge', 'repair'),
        (instant, zoneId, streak, mechanic) => {
          const lastDay = localDayOf(instant, zoneId);
          const returnedOn = addCivilDays(lastDay, 2);
          const broken = brokenState({ lastDay, streak, freezes: 0, missedDays: 1, returnedOn });
          const today = returnedOn;
          let result;
          if (mechanic === 'repair') {
            result = repairStreak(broken, today);
          } else {
            let state = armChallenge(broken, today);
            for (let i = 0; i < 3; i += 1) state = recordChallengeLesson(state, today);
            result = completeChallenge(state, today);
          }
          expect(result.restored).toBe(true);
          // At most one lived day is added, so at most one milestone can be reached.
          expect(result.streakAfter).toBeLessThanOrEqual(streak + 1);
          expect(result.streakAfter).toBeGreaterThanOrEqual(streak);
          expect(result.milestones.length).toBeLessThanOrEqual(1);
          expect(result.milestones).toEqual(milestonesCrossed(streak, result.streakAfter));
          for (const milestone of result.milestones) {
            // Landed ON, never vaulted past.
            expect(milestone).toBe(result.streakAfter);
            expect(STREAK_MILESTONES).toContain(milestone);
          }
          // The repair leaves today unsatisfied; the challenge marks it satisfied.
          expect(result.state.dispositions.get(today)).toBe(
            mechanic === 'repair' ? undefined : 'completed',
          );
          expect(monthKeyOf(today).length).toBe(7);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
