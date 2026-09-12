/**
 * Ceremony test fixtures and arbitraries. Test support, not engine API - `index.ts` does
 * not export it.
 */
import fc from 'fast-check';
import type {
  AccountCeremonyState,
  CeremonyState,
  CourseCeremonyState,
  SessionCeremonyState,
} from '../queue.js';
import { STREAK_MILESTONE_DAYS } from '../queue.js';
import { EMPTY_BUNDLE, type RewardBundle } from '../bundle.js';
import { FRESH_STREAK_GOAL_STATE } from '../streakGoal.js';
import { FRESH_TAKEOVER_STATE } from '../legendaryTakeover.js';
import type { ScoreSlotEntry } from '../score.js';

export const BASE_ACCOUNT: AccountCeremonyState = {
  streak: 1,
  streakBeat: 'extended',
  streakGoal: FRESH_STREAK_GOAL_STATE,
  streakGoalCheckpointCrossed: false,
  streakSocietyBeat: 'none',
  perfectStreakBeat: 'none',
  questsProgressed: 0,
  achievementCrossings: [],
  bundle: EMPTY_BUNDLE,
  dailyGoalReachedThisSession: false,
  consecutiveGoalMetDays: 0,
};

export const BASE_COURSE: CourseCeremonyState = {
  courseId: 'es',
  scoreEntries: [],
  nodeCompletedThisSession: false,
  nodeIsComplete: false,
  nodeIsLegendary: false,
  legendaryAvailable: true,
  takeover: FRESH_TAKEOVER_STATE,
  unitCompleted: false,
  sectionCompleted: false,
  courseCompleted: false,
};

export const BASE_SESSION: SessionCeremonyState = {
  sessionId: 's1',
  flavour: 'lesson',
  gradedItems: 12,
  mistakes: 1,
  xp: 13,
  outcome: 'passed',
  gated: false,
};

export function ceremonyState(
  account: Partial<AccountCeremonyState> = {},
  course: Partial<CourseCeremonyState> = {},
  session: Partial<SessionCeremonyState> = {},
): CeremonyState {
  return {
    account: { ...BASE_ACCOUNT, ...account },
    course: { ...BASE_COURSE, ...course },
    session: { ...BASE_SESSION, ...session },
    milestoneDays: STREAK_MILESTONE_DAYS,
  };
}

const bundleArb: fc.Arbitrary<RewardBundle> = fc.record({
  gems: fc.nat({ max: 40 }),
  freezes: fc.nat({ max: 3 }),
  boost: fc.option(
    fc.record({ multiplier: fc.constantFrom(2), durationMinutes: fc.constantFrom(15, 30) }),
    { nil: null },
  ),
  tierGrant: fc.option(fc.constantFrom('VIP Status', '3 Extra Freezes'), { nil: null }),
});

const scoreEntryArb: fc.Arbitrary<readonly ScoreSlotEntry[]> = fc.oneof(
  fc.constant([] as readonly ScoreSlotEntry[]),
  fc
    .record({
      slot: fc.constantFrom(
        'S068_scoreUnlock' as const,
        'S069_scoreProgress' as const,
        'S070_scoreMaxed' as const,
      ),
      bandBeats: fc.nat({ max: 2 }),
    })
    .map((e) => [e] as readonly ScoreSlotEntry[]),
);

/**
 * A ceremony state with every predicate a coin flip. Deliberately dense: a generator that
 * mostly produces the empty chain proves nothing about ordering or duplicates.
 */
export const ceremonyStateArb: fc.Arbitrary<CeremonyState> = fc
  .record({
    streak: fc.constantFrom(1, 2, 6, 7, 29, 30, 99, 100, 364, 365, 999, 1000),
    streakBeat: fc.constantFrom('extended' as const, 'already-extended' as const),
    goalPicked: fc.boolean(),
    presentations: fc.nat({ max: 3 }),
    checkpoint: fc.boolean(),
    society: fc.constantFrom('none' as const, 'induction' as const, 'reward' as const),
    perfect: fc.constantFrom('none' as const, 'halfway' as const, 'earned' as const),
    quests: fc.nat({ max: 3 }),
    crossings: fc.array(
      fc.record({
        achievementId: fc.constantFrom('sage', 'wildfire', 'nocturnal'),
        achievementName: fc.constantFrom('Sage', 'Wildfire', 'Nocturnal'),
        tier: fc.integer({ min: 1, max: 5 }),
        gems: fc.constantFrom(25),
      }),
      { maxLength: 4 },
    ),
    bundle: bundleArb,
    goalMetDays: fc.nat({ max: 8 }),
    scoreEntries: scoreEntryArb,
    nodeIsComplete: fc.boolean(),
    nodeIsLegendary: fc.boolean(),
    declines: fc.nat({ max: 3 }),
    unitCompleted: fc.boolean(),
    sectionCompleted: fc.boolean(),
    courseCompleted: fc.boolean(),
    flavour: fc.constantFrom('lesson', 'practice', 'story', 'legendary', 'unitReview'),
    mistakes: fc.nat({ max: 3 }),
    outcome: fc.constantFrom('passed' as const, 'failed' as const, 'abandoned' as const),
    gated: fc.boolean(),
    xp: fc.nat({ max: 40 }),
  })
  .map((r) =>
    ceremonyState(
      {
        streak: r.streak,
        streakBeat: r.streakBeat,
        streakGoal: {
          goal: r.goalPicked ? 7 : null,
          presentations: r.presentations,
          lastPicked: null,
        },
        streakGoalCheckpointCrossed: r.checkpoint,
        streakSocietyBeat: r.society,
        perfectStreakBeat: r.perfect,
        questsProgressed: r.quests,
        achievementCrossings: r.crossings,
        bundle: r.bundle,
        consecutiveGoalMetDays: r.goalMetDays,
      },
      {
        scoreEntries: r.scoreEntries,
        nodeIsComplete: r.nodeIsComplete,
        nodeIsLegendary: r.nodeIsLegendary,
        takeover: { consecutiveDeclines: r.declines },
        unitCompleted: r.unitCompleted,
        sectionCompleted: r.sectionCompleted,
        courseCompleted: r.courseCompleted,
      },
      {
        flavour: r.flavour,
        mistakes: r.mistakes,
        outcome: r.outcome,
        gated: r.gated,
        xp: r.xp,
      },
    ),
  );
