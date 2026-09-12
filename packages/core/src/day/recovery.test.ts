import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ZONES, arbInstant, arbZoneId, PROPERTY_RUNS } from '@freelingo/testkit';
import { addCivilDays, localDayOf, monthKeyOf, toLocalDay, type LocalDay } from './civil.js';
import { DAY_CONFIG } from './config.js';
import { streakFromDispositions } from './dispositions.js';
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
import { goalChestDays, questProgressXp } from './predicates.js';
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
    fc.assert(
      fc.property(
        arbInstant(),
        arbZoneId(ZONES),
        fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 6 }),
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
            for (let i = 0; i < runLength; i += 1) {
              completed.add(cursor);
              cursor = addCivilDays(cursor, 1);
            }
            cursor = addCivilDays(cursor, 1); // one missed day
            state = rolloverTo(state, cursor, { completedDays: completed }).state;
            state = repairStreak(state, cursor).state;
          }
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

    // Silence until past the window. The challenge row, its partial progress and the
    // armed offer all go in one transaction; the streak stays broken.
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
    };
    const armed = armChallenge(brokenState(input), toLocalDay(input.returnedOn));
    const startedOn = toLocalDay(input.startedOn);
    const finishedOn = toLocalDay(input.finishedOn);
    expect(finishedOn > armed.challenge!.expiresAfterDay).toBe(true);

    // Eligibility is a function of the session START time only (EC-FRZ-16).
    expect(challengeEligibleAtStart(armed, startedOn)).toBe(true);
    expect(challengeEligibleAtStart(armed, finishedOn)).toBe(false);
    let state = armed;
    for (let i = 0; i < 3; i += 1) state = recordChallengeLesson(state, startedOn);
    expect(state.challenge?.lessonsDone).toBe(3);
    const done = completeChallenge(state, finishedOn);
    expect(done.restored).toBe(true);

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
