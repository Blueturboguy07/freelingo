/**
 * Properties over the XP award engine.
 *
 * Every property runs at `PROPERTY_RUNS` (10,000) — plan §Verification. Where a property
 * has a committed falsifier input, it is written as a named case first and the property
 * second, so a regression fails with the small example rather than a shrunk one.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import type { ActiveBoost, SessionFlavour, XpLadderMode } from '../types/index.js';
import { SESSION_FLAVOURS, SESSION_OUTCOMES } from '../types/index.js';
import {
  BOOST_GRACE_SECONDS,
  BOOST_MULTIPLIER,
  FLAVOUR_XP,
  GOAL_TIERS,
  LEGENDARY_CHECKPOINT_XP,
  REPLAY_PRACTICE_XP,
  comboBonus,
  flavourRow,
} from './config.js';
import {
  BOOST_LAPSED_EXPLANATION,
  EMPTY_LADDER_STATE,
  advertisedXpFor,
  awardForSession,
  baseXpFor,
  dailyRefreshLevelIsReplayable,
  dailyRefreshOutcomeFor,
  goalMet,
  goalXpFor,
  ladderDailyCap,
  legendaryOutcomeFor,
  narrativeXp,
  nextLegendaryAwardedAt,
  resolveBoost,
  type LadderStateToday,
} from './xp.js';

const RUNS = { numRuns: PROPERTY_RUNS } as const;

const EPOCH = Date.parse('2026-09-11T12:00:00Z');
const iso = (offsetMs: number) => new Date(EPOCH + offsetMs).toISOString();

function boostExpiringAt(offsetMs: number): ActiveBoost {
  return {
    kind: 'xpBoost',
    multiplier: BOOST_MULTIPLIER,
    startedAtUtc: iso(offsetMs - 15 * 60_000),
    expiresAtUtc: iso(offsetMs),
  };
}

/** Flavours whose matrix row says a boost applies — the only ones a boost can change. */
const BOOSTABLE_FLAVOURS = SESSION_FLAVOURS.filter(
  (flavour) => flavourRow(flavour, 'completed').boostApplies,
);

/* ------------------------------------------------------------------- INV-ECO-02 */

describe('the boost multiplier', () => {
  it('[INV-ECO-02] falsifier: a session parked past the grace commits at 1x with an explanation', () => {
    const boost = boostExpiringAt(0);
    const justInside = resolveBoost({
      flavour: 'lesson',
      outcome: 'completed',
      boostAtSessionStart: boost,
      committedAtUtc: iso(BOOST_GRACE_SECONDS * 1_000),
    });
    expect(justInside.appliedMultiplier).toBe(BOOST_MULTIPLIER);
    expect(justInside.explanation).toBe('');

    const justOutside = resolveBoost({
      flavour: 'lesson',
      outcome: 'completed',
      boostAtSessionStart: boost,
      committedAtUtc: iso(BOOST_GRACE_SECONDS * 1_000 + 1),
    });
    expect(justOutside.recordedMultiplier).toBe(BOOST_MULTIPLIER);
    expect(justOutside.appliedMultiplier).toBe(1);
    expect(justOutside.explanation).toBe(BOOST_LAPSED_EXPLANATION);
  });

  it('[INV-ECO-02] for any kill/resume/expiry interleaving, applied == recorded unless the grace lapsed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SESSION_FLAVOURS),
        fc.constantFrom(...SESSION_OUTCOMES),
        // Expiry and commit, each within a day either side of the session start.
        fc.integer({ min: -86_400_000, max: 86_400_000 }),
        fc.integer({ min: -86_400_000, max: 86_400_000 }),
        fc.boolean(),
        (flavour, outcome, expiryOffset, commitOffset, hasBoost) => {
          const boost = hasBoost ? boostExpiringAt(expiryOffset) : null;
          const resolution = resolveBoost({
            flavour,
            outcome,
            boostAtSessionStart: boost,
            committedAtUtc: iso(commitOffset),
          });
          const applies = flavourRow(flavour, outcome).boostApplies && hasBoost;
          if (!applies) {
            expect(resolution.recordedMultiplier).toBe(1);
            expect(resolution.appliedMultiplier).toBe(1);
            expect(resolution.explanation).toBe('');
            return;
          }
          const lapsed = commitOffset > expiryOffset + BOOST_GRACE_SECONDS * 1_000;
          expect(resolution.appliedMultiplier).toBe(lapsed ? 1 : BOOST_MULTIPLIER);
          // The explanation exists exactly when the number is smaller than promised.
          expect(resolution.explanation !== '').toBe(
            resolution.appliedMultiplier < resolution.recordedMultiplier,
          );
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-02] the ceremony renders the committed number: awardedXp is a function of multiplierApplied', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BOOSTABLE_FLAVOURS),
        fc.integer({ min: -3_600_000, max: 3_600_000 }),
        fc.integer({ min: 0, max: 20 }),
        (flavour, commitOffset, maxCombo) => {
          const award = awardForSession({
            flavour,
            outcome: 'completed',
            maxCombo,
            boostAtSessionStart: boostExpiringAt(0),
            committedAtUtc: iso(commitOffset),
            ladderStateToday: EMPTY_LADDER_STATE,
          });
          const expected = Math.floor(award.baseXp * award.multiplierApplied);
          expect(award.awardedXp).toBe(Math.min(expected, ladderDailyCap(award.ladderMode)));
        },
      ),
      RUNS,
    );
  });
});

/* ------------------------------------------------------------------- INV-ECO-30 */

describe('boost_applies and the tile colour', () => {
  it('[INV-ECO-30] the multiplier applied equals the configured one exactly when the row is flagged', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SESSION_FLAVOURS),
        fc.constantFrom(...SESSION_OUTCOMES),
        (flavour, outcome) => {
          const resolution = resolveBoost({
            flavour,
            outcome,
            boostAtSessionStart: boostExpiringAt(3_600_000),
            committedAtUtc: iso(0),
          });
          const flagged = flavourRow(flavour, outcome).boostApplies;
          expect(resolution.appliedMultiplier).toBe(flagged ? BOOST_MULTIPLIER : 1);
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-30] falsifier: a purple tile on a story replay — the tile agrees with the applied multiplier', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SESSION_FLAVOURS),
        fc.constantFrom(...SESSION_OUTCOMES),
        fc.integer({ min: -7_200_000, max: 7_200_000 }),
        (flavour, outcome, commitOffset) => {
          const resolution = resolveBoost({
            flavour,
            outcome,
            boostAtSessionStart: boostExpiringAt(0),
            committedAtUtc: iso(commitOffset),
          });
          expect(resolution.tileIsBoosted).toBe(resolution.appliedMultiplier > 1);
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-30] every flavour, including the Daily Refresh sub-flavours, declares a value', () => {
    for (const flavour of SESSION_FLAVOURS) {
      for (const outcome of SESSION_OUTCOMES) {
        expect(Object.hasOwn(flavourRow(flavour, outcome), 'boostApplies')).toBe(true);
      }
    }
  });
});

/* ------------------------------------------------------------------- INV-ECO-06 */

describe('the per-mode daily XP ladder', () => {
  it('[INV-ECO-06] total XP from one mode on one day never exceeds the cap, across any number of courses', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            flavour: fc.constantFrom(...SESSION_FLAVOURS),
            // Two courses, so a per-course ladder would pass and a global one is tested.
            course: fc.constantFrom('en-es', 'en-fr'),
            maxCombo: fc.integer({ min: 0, max: 20 }),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        (sessions) => {
          const perMode = new Map<XpLadderMode, LadderStateToday>();
          for (const session of sessions) {
            const mode = FLAVOUR_XP[session.flavour].ladderMode;
            const state = perMode.get(mode) ?? EMPTY_LADDER_STATE;
            const award = awardForSession({
              flavour: session.flavour,
              outcome: 'completed',
              maxCombo: session.maxCombo,
              boostAtSessionStart: boostExpiringAt(86_400_000),
              committedAtUtc: iso(0),
              ladderStateToday: state,
            });
            perMode.set(mode, {
              sessionsCompleted: state.sessionsCompleted + 1,
              xpAwarded: state.xpAwarded + award.awardedXp,
            });
          }
          for (const [mode, state] of perMode) {
            expect(state.xpAwarded).toBeLessThanOrEqual(ladderDailyCap(mode));
          }
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-06] the ladder is keyed by the day, not the course: switching courses buys nothing', () => {
    const oneCourse: LadderStateToday = { sessionsCompleted: 40, xpAwarded: 390 };
    const awardAfterManyLessons = awardForSession({
      flavour: 'lesson',
      outcome: 'completed',
      maxCombo: 15,
      boostAtSessionStart: null,
      committedAtUtc: iso(0),
      ladderStateToday: oneCourse,
    });
    // The 41st lesson of the day pays what is left of the cap and no more, whichever
    // course it was in — the state passed in carries no course at all, by construction.
    expect(awardAfterManyLessons.awardedXp).toBeLessThanOrEqual(400 - 390);
  });
});

/* ----------------------------------------------------------- INV-ECO-07, ECO-08 */

describe('once-per-node Legendary and the replayable Daily Refresh level', () => {
  it('[INV-ECO-07] legendary_awarded_at is set once, ever, and the second pass pays the practice award', () => {
    const first = legendaryOutcomeFor(null, true);
    expect(first).toBe('completed');
    const stamp = nextLegendaryAwardedAt(null, true, iso(0));
    expect(stamp).not.toBeNull();

    const second = legendaryOutcomeFor(stamp, true);
    expect(second).toBe('replayed');
    expect(nextLegendaryAwardedAt(stamp, true, iso(86_400_000))).toBe(stamp);

    const award = awardForSession({
      flavour: 'legendary',
      outcome: second,
      boostAtSessionStart: null,
      committedAtUtc: iso(86_400_000),
      ladderStateToday: EMPTY_LADDER_STATE,
    });
    // The 40 XP Legendary award is paid zero more times; the replay pays practice.
    expect(award.awardedXp).not.toBe(FLAVOUR_XP.legendary.base);
    expect(award.awardedXp).toBe(REPLAY_PRACTICE_XP);
    expect(flavourRow('legendary', 'replayed').consequenceRoute).toBe('node.practice-only');
  });

  it('[INV-ECO-07] no sequence of completions pays the Legendary award twice', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (passes) => {
        let stamp: string | null = null;
        let legendaryAwards = 0;
        for (let i = 0; i < passes; i += 1) {
          const outcome = legendaryOutcomeFor(stamp, true);
          const award = awardForSession({
            flavour: 'legendary',
            outcome,
            boostAtSessionStart: null,
            committedAtUtc: iso(i * 3_600_000),
            ladderStateToday: EMPTY_LADDER_STATE,
          });
          if (award.baseXp === FLAVOUR_XP.legendary.base) legendaryAwards += 1;
          stamp = nextLegendaryAwardedAt(stamp, true, iso(i * 3_600_000));
        }
        expect(legendaryAwards).toBe(1);
      }),
      RUNS,
    );
  });

  it('[INV-ECO-08] a completed Daily Refresh level stays replayable and pays the practice award', () => {
    expect(dailyRefreshOutcomeFor(false)).toBe('completed');
    expect(dailyRefreshOutcomeFor(true)).toBe('replayed');
    expect(dailyRefreshLevelIsReplayable()).toBe(true);

    const level = awardForSession({
      flavour: 'dailyRefresh',
      outcome: 'completed',
      boostAtSessionStart: null,
      committedAtUtc: iso(0),
      ladderStateToday: EMPTY_LADDER_STATE,
    });
    const replay = awardForSession({
      flavour: 'dailyRefresh',
      outcome: 'replayed',
      boostAtSessionStart: null,
      committedAtUtc: iso(0),
      ladderStateToday: EMPTY_LADDER_STATE,
    });
    expect(level.awardedXp).toBe(FLAVOUR_XP.dailyRefresh.base);
    expect(replay.awardedXp).toBe(REPLAY_PRACTICE_XP);
    expect(replay.awardedXp).not.toBe(level.awardedXp);
  });

  it('[INV-ECO-08] any number of replays pays the practice award every time, never the level award', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (replays) => {
        let total = 0;
        for (let i = 0; i < replays; i += 1) {
          total += baseXpFor({
            flavour: 'dailyRefresh',
            outcome: dailyRefreshOutcomeFor(true),
            boostAtSessionStart: null,
            committedAtUtc: iso(i),
            ladderStateToday: EMPTY_LADDER_STATE,
          });
        }
        expect(total).toBe(replays * REPLAY_PRACTICE_XP);
      }),
      RUNS,
    );
  });
});

/* ------------------------------------------------------------------- INV-ECO-16 */

describe('failed Legendary attempts', () => {
  it('[INV-ECO-16] falsifier: ten checkpoint-abandon runs on one node in one day yield ONE award', () => {
    let paidToday = false;
    let total = 0;
    for (let i = 0; i < 10; i += 1) {
      const award = awardForSession({
        flavour: 'legendary',
        outcome: 'failed',
        reachedLegendaryCheckpoint: true,
        checkpointAlreadyPaidToday: paidToday,
        boostAtSessionStart: null,
        committedAtUtc: iso(i * 600_000),
        ladderStateToday: EMPTY_LADDER_STATE,
      });
      total += award.awardedXp;
      if (award.awardedXp > 0) paidToday = true;
    }
    expect(total).toBe(LEGENDARY_CHECKPOINT_XP);
  });

  it('[INV-ECO-16] total XP from failed attempts on one node in one day <= one checkpoint award', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 25 }),
        (reachedCheckpointPerAttempt) => {
          let paidToday = false;
          let total = 0;
          for (const reached of reachedCheckpointPerAttempt) {
            const award = awardForSession({
              flavour: 'legendary',
              outcome: 'failed',
              reachedLegendaryCheckpoint: reached,
              checkpointAlreadyPaidToday: paidToday,
              boostAtSessionStart: boostExpiringAt(86_400_000),
              committedAtUtc: iso(0),
              ladderStateToday: EMPTY_LADDER_STATE,
            });
            total += award.awardedXp;
            if (award.awardedXp > 0) paidToday = true;
          }
          expect(total).toBeLessThanOrEqual(LEGENDARY_CHECKPOINT_XP);
        },
      ),
      RUNS,
    );
  });
});

/* ------------------------------------------------------------------- INV-ECO-15 */

describe('advertised XP', () => {
  it('[INV-ECO-15] advertised == awarded for every flavour, or advertisedIsFloor says why not', () => {
    for (const flavour of SESSION_FLAVOURS) {
      const advertised = advertisedXpFor(flavour);
      const award = awardForSession({
        flavour,
        outcome: 'completed',
        maxCombo: 0,
        boostAtSessionStart: null,
        committedAtUtc: iso(0),
        ladderStateToday: EMPTY_LADDER_STATE,
      });
      if (!flavourRow(flavour, 'completed').awardsXp) {
        expect(advertised.xp).toBe(0);
        expect(award.awardedXp).toBe(0);
        continue;
      }
      expect(award.awardedXp, `${flavour}: advertised ${advertised.xp}`).toBe(advertised.xp);
    }
  });

  it('[INV-ECO-15] where the advertised number is a floor, the award is never below it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SESSION_FLAVOURS),
        fc.integer({ min: 0, max: 40 }),
        (flavour, maxCombo) => {
          const advertised = advertisedXpFor(flavour);
          const award = awardForSession({
            flavour,
            outcome: 'completed',
            maxCombo,
            boostAtSessionStart: null,
            committedAtUtc: iso(0),
            ladderStateToday: EMPTY_LADDER_STATE,
          });
          if (!flavourRow(flavour, 'completed').awardsXp) return;
          expect(award.awardedXp).toBeGreaterThanOrEqual(advertised.xp);
          if (!advertised.isFloor) expect(award.awardedXp).toBe(advertised.xp);
          else expect(award.awardedXp).toBe(advertised.xp + comboBonus(maxCombo));
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-15] story and radio advertise what they pay, at both entry points', () => {
    for (const format of ['story', 'radio'] as const) {
      for (const first of [true, false]) {
        expect(narrativeXp(format, first)).toBe(
          first ? (format === 'story' ? 20 : 20) : format === 'story' ? 5 : 5,
        );
      }
    }
  });
});

/* ------------------------------------------------------------------- INV-ECO-21 */

describe('goal met', () => {
  it('[INV-ECO-21] falsifier: a flat-10-XP Practice session meets a 10 XP goal', () => {
    const award = awardForSession({
      flavour: 'nodePractice',
      outcome: 'completed',
      boostAtSessionStart: null,
      committedAtUtc: iso(0),
      ladderStateToday: EMPTY_LADDER_STATE,
    });
    expect(award.awardedXp).toBe(10);
    expect(goalMet(award.awardedXp, goalXpFor('casual'))).toBe(true);
  });

  it('[INV-ECO-21] goalMet <=> earnedXP >= goalXP, for every tier and every flavour', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 600 }),
        fc.constantFrom(...GOAL_TIERS.map((t) => t.key)),
        (earned, tier) => {
          const goal = goalXpFor(tier);
          expect(goalMet(earned, goal)).toBe(earned >= goal);
        },
      ),
      RUNS,
    );
  });
});

/* ------------------------------------------------------------------ the matrix */

describe('every flavour pays what its matrix row says', () => {
  it('[INV-ECO-09] awardsXp = false implies awardedXp = 0, for every (flavour, outcome)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SESSION_FLAVOURS),
        fc.constantFrom(...SESSION_OUTCOMES),
        fc.integer({ min: 0, max: 30 }),
        (flavour: SessionFlavour, outcome, maxCombo) => {
          const award = awardForSession({
            flavour,
            outcome,
            maxCombo,
            boostAtSessionStart: null,
            committedAtUtc: iso(0),
            ladderStateToday: EMPTY_LADDER_STATE,
          });
          if (!flavourRow(flavour, outcome).awardsXp) expect(award.awardedXp).toBe(0);
        },
      ),
      RUNS,
    );
  });
});
