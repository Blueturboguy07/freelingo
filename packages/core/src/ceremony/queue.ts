/**
 * The ceremony queue: an ordered candidate list, each row with a predicate, evaluated
 * ONCE when the session ends.
 *
 * "The ceremony is a filter, not a script" is the single most important structural finding
 * in `deep/02`, and the product map's Surface 4 row order is the canonical order
 * (S067 -> S087).
 *
 * INV-CER-02 / EC-PTH-11, EC-CER-04: the rendered chain is a duplicate-free **subsequence**
 * of the canonical order, and the path model is mutated **before** the return screen
 * renders - so the learner lands already scrolled to the next section rather than on a
 * stale canvas that re-renders under them.
 * INV-CER-03 / EC-CER-03: every predicate declares `scope in {account, course}`, and a
 * course-scoped predicate reads only `course_progress[active]`. Enforced structurally: the
 * runner hands each predicate a frozen view containing only its own scope's fields, so a
 * course-scoped predicate that reaches for the streak sees `undefined`. Falsifier: install
 * a second course, finish its first lesson, and assert the Score-unlock screen fires again
 * while the streak count-up does not.
 * INV-CER-13 / EC-CER-21: `Skip all` commits the identical ledger and still renders every
 * one-time screen.
 *
 * The single exclusive commit (INV-CER-01, `planCommit`) stays the one place rewards are
 * written: it runs before the first screen, so every screen here is presentation only.
 */
import { planCommit, type LedgerDelta, type SessionOutcome } from './commit.js';
import { collapseGoalChain, isEmptyBundle, mergeBundles, type RewardBundle } from './bundle.js';
import { achievementSlot, type AchievementSlot, type TierCrossing } from './achievements.js';
import { pickerShouldRender, type StreakGoalState } from './streakGoal.js';
import { takeoverEligible, type TakeoverState } from './legendaryTakeover.js';
import type { ScoreSlotEntry } from './score.js';

/* ------------------------------------------------------------- the slot order */

/**
 * Canonical order, product map Surface 4. S086 (the commit-failure sheet) is deliberately
 * absent: a failed commit suppresses the ceremony entirely rather than taking a slot in it.
 */
export const CEREMONY_SLOTS = [
  'S067_sessionComplete',
  'S068_scoreUnlock',
  'S069_scoreProgress',
  'S070_scoreMaxed',
  'S071_streakCountUp',
  'S072_streakGoalPicker',
  'S073_streakGoalCheckpoint',
  'S074_streakStartsTomorrow',
  'S075_streakMilestone',
  'S076_streakSociety',
  'S077_perfectStreak',
  'S078_quests',
  'S079_achievement',
  'S080_rewardBundle',
  'S081_nodeCompleteLegendaryOffer',
  'S082_unitComplete',
  'S083_sectionComplete',
  'S084_courseComplete',
  'S085_consolation',
  'S087_returnToPath',
] as const;
export type CeremonySlot = (typeof CEREMONY_SLOTS)[number];

/**
 * One-time screens, exempt from `Skip all` (EC-CER-21): Score unlock, the terminal Score
 * beat, the goal picker, the streak milestone, the legendary trophy, unit and section
 * complete, course complete, and the failure sheet.
 */
export const ONE_TIME_SLOTS: readonly CeremonySlot[] = [
  'S068_scoreUnlock',
  'S070_scoreMaxed',
  'S072_streakGoalPicker',
  'S075_streakMilestone',
  'S082_unitComplete',
  'S083_sectionComplete',
  'S084_courseComplete',
  'S085_consolation',
];

export type Scope = 'account' | 'course';

/* ------------------------------------------------------------------ the state */

/** Account-scoped state. Global: one streak, one goal, one quest board. */
export interface AccountCeremonyState {
  readonly streak: number;
  /**
   * The one discriminant behind rows 4 and 6. Mutually exclusive and jointly exhaustive
   * by construction (INV-CER-04): there is no pair of booleans to get out of step.
   */
  readonly streakBeat: 'extended' | 'already-extended';
  readonly streakGoal: StreakGoalState;
  readonly streakGoalCheckpointCrossed: boolean;
  readonly streakSocietyBeat: 'none' | 'induction' | 'reward';
  readonly perfectStreakBeat: 'none' | 'halfway' | 'earned' | 'reset';
  readonly questsProgressed: number;
  readonly achievementCrossings: readonly TierCrossing[];
  readonly bundle: RewardBundle;
  readonly dailyGoalReachedThisSession: boolean;
  readonly consecutiveGoalMetDays: number;
}

/** Course-scoped state: exactly `course_progress[active]`, nothing else. */
export interface CourseCeremonyState {
  readonly courseId: string;
  readonly scoreEntries: readonly ScoreSlotEntry[];
  readonly nodeCompletedThisSession: boolean;
  readonly nodeIsComplete: boolean;
  readonly nodeIsLegendary: boolean;
  readonly legendaryAvailable: boolean;
  readonly takeover: TakeoverState;
  readonly unitCompleted: boolean;
  readonly sectionCompleted: boolean;
  readonly courseCompleted: boolean;
}

/** Facts about the session itself, used to pick the S067 variant and the failure branch. */
export interface SessionCeremonyState {
  readonly sessionId: string;
  readonly flavour: string;
  readonly gradedItems: number;
  readonly mistakes: number;
  readonly xp: number;
  readonly outcome: 'passed' | 'failed' | 'abandoned';
  /** Was this a gated challenge (legendary, jump-here, section test)? */
  readonly gated: boolean;
}

export interface CeremonyState {
  readonly account: AccountCeremonyState;
  readonly course: CourseCeremonyState;
  readonly session: SessionCeremonyState;
  /** Milestone days: `{7, 30, 100, 365, 1000}` - 50 was contamination (ADV 02/A6). */
  readonly milestoneDays: readonly number[];
}

export const STREAK_MILESTONE_DAYS: readonly number[] = [7, 30, 100, 365, 1000];

/** Lesson flavours, for the `Perfect lesson!` branch (INV-CER-05). */
export const LESSON_FLAVOURS: readonly string[] = ['lesson', 'recovery'];

/* ------------------------------------------------------------------- the rows */

export interface QueueRow {
  readonly slot: CeremonySlot;
  readonly scope: Scope;
  readonly predicate: (
    view: AccountCeremonyState | CourseCeremonyState,
    ctx: QueueContext,
  ) => boolean;
}

/** Scope-free facts every predicate may read: the session and the config. */
export interface QueueContext {
  readonly session: SessionCeremonyState;
  readonly milestoneDays: readonly number[];
  readonly collapseGoalChain: boolean;
}

const account = (state: AccountCeremonyState | CourseCeremonyState): AccountCeremonyState =>
  state as AccountCeremonyState;
const course = (state: AccountCeremonyState | CourseCeremonyState): CourseCeremonyState =>
  state as CourseCeremonyState;

/** A failed gated challenge replaces the session card with the consolation screen. */
function isFailedChallenge(ctx: QueueContext): boolean {
  return ctx.session.outcome === 'failed' && ctx.session.gated;
}

export const QUEUE: readonly QueueRow[] = [
  {
    slot: 'S067_sessionComplete',
    scope: 'course',
    predicate: (_s, ctx) => !isFailedChallenge(ctx),
  },
  {
    slot: 'S068_scoreUnlock',
    scope: 'course',
    predicate: (s) => course(s).scoreEntries.some((e) => e.slot === 'S068_scoreUnlock'),
  },
  {
    slot: 'S069_scoreProgress',
    scope: 'course',
    predicate: (s) => course(s).scoreEntries.some((e) => e.slot === 'S069_scoreProgress'),
  },
  {
    slot: 'S070_scoreMaxed',
    scope: 'course',
    predicate: (s) => course(s).scoreEntries.some((e) => e.slot === 'S070_scoreMaxed'),
  },
  {
    slot: 'S071_streakCountUp',
    scope: 'account',
    predicate: (s) => account(s).streakBeat === 'extended',
  },
  {
    slot: 'S072_streakGoalPicker',
    scope: 'account',
    predicate: (s) => pickerShouldRender(account(s).streakGoal),
  },
  {
    slot: 'S073_streakGoalCheckpoint',
    scope: 'account',
    predicate: (s) => account(s).streakGoalCheckpointCrossed,
  },
  {
    slot: 'S074_streakStartsTomorrow',
    scope: 'account',
    predicate: (s) => account(s).streakBeat === 'already-extended',
  },
  {
    slot: 'S075_streakMilestone',
    scope: 'account',
    predicate: (s, ctx) => ctx.milestoneDays.includes(account(s).streak),
  },
  {
    slot: 'S076_streakSociety',
    scope: 'account',
    predicate: (s) => account(s).streakSocietyBeat !== 'none',
  },
  {
    slot: 'S077_perfectStreak',
    scope: 'account',
    predicate: (s) => account(s).perfectStreakBeat !== 'none',
  },
  {
    slot: 'S078_quests',
    scope: 'account',
    predicate: (s, ctx) => account(s).questsProgressed > 0 && !ctx.collapseGoalChain,
  },
  {
    slot: 'S079_achievement',
    scope: 'account',
    predicate: (s) => achievementSlot(account(s).achievementCrossings).screens.length > 0,
  },
  {
    slot: 'S080_rewardBundle',
    scope: 'account',
    predicate: (s, ctx) => !isEmptyBundle(account(s).bundle) && !ctx.collapseGoalChain,
  },
  {
    slot: 'S081_nodeCompleteLegendaryOffer',
    scope: 'course',
    // An ELIGIBILITY test on the node, re-evaluated after ANY session on it - not a
    // completed-by-this-session edge trigger (ADV 02/A10: the offer was observed again
    // after a Practice session on an already-complete node).
    predicate: (s) => {
      const c = course(s);
      return (
        c.nodeIsComplete &&
        !c.nodeIsLegendary &&
        c.legendaryAvailable &&
        takeoverEligible(c.takeover)
      );
    },
  },
  { slot: 'S082_unitComplete', scope: 'course', predicate: (s) => course(s).unitCompleted },
  { slot: 'S083_sectionComplete', scope: 'course', predicate: (s) => course(s).sectionCompleted },
  { slot: 'S084_courseComplete', scope: 'course', predicate: (s) => course(s).courseCompleted },
  { slot: 'S085_consolation', scope: 'course', predicate: (_s, ctx) => isFailedChallenge(ctx) },
  { slot: 'S087_returnToPath', scope: 'course', predicate: () => true },
];

/* --------------------------------------------------------------- scoped views */

const ACCOUNT_KEYS: readonly (keyof AccountCeremonyState)[] = [
  'streak',
  'streakBeat',
  'streakGoal',
  'streakGoalCheckpointCrossed',
  'streakSocietyBeat',
  'perfectStreakBeat',
  'questsProgressed',
  'achievementCrossings',
  'bundle',
  'dailyGoalReachedThisSession',
  'consecutiveGoalMetDays',
];

const COURSE_KEYS: readonly (keyof CourseCeremonyState)[] = [
  'courseId',
  'scoreEntries',
  'nodeCompletedThisSession',
  'nodeIsComplete',
  'nodeIsLegendary',
  'legendaryAvailable',
  'takeover',
  'unitCompleted',
  'sectionCompleted',
  'courseCompleted',
];

/**
 * Build the view a predicate of this scope is allowed to see. Frozen and key-restricted:
 * a course-scoped predicate cannot read the streak even by accident, which is what makes
 * INV-CER-03 a structural property rather than a code-review promise.
 */
export function viewFor(
  scope: Scope,
  state: CeremonyState,
): AccountCeremonyState | CourseCeremonyState {
  if (scope === 'account') {
    const out: Record<string, unknown> = {};
    for (const key of ACCOUNT_KEYS) out[key] = state.account[key];
    return Object.freeze(out) as unknown as AccountCeremonyState;
  }
  const out: Record<string, unknown> = {};
  for (const key of COURSE_KEYS) out[key] = state.course[key];
  return Object.freeze(out) as unknown as CourseCeremonyState;
}

/* --------------------------------------------------------------- the evaluator */

export interface CeremonyResult {
  /** The rendered chain, in canonical order, duplicate-free. */
  readonly chain: readonly CeremonySlot[];
  /** The one commit. `null` when this session_id was already on the ledger. */
  readonly committed: LedgerDelta | null;
  /** Everything the chest pays, achievements folded in. */
  readonly bundle: RewardBundle;
  readonly achievements: AchievementSlot;
  /** A row on S067 instead of S078 + S080, per ruling EC-CER-14. */
  readonly collapsedGoalRow: string | null;
  /** How many times each predicate ran. Every entry must be 1 (INV-CER-02). */
  readonly predicateEvaluations: Readonly<Record<string, number>>;
  /** Repeating screens `Skip all` collapsed into a path toast. */
  readonly skippedToToast: readonly CeremonySlot[];
}

export interface CeremonyOptions {
  readonly skipAll?: boolean;
  readonly committedSessionIds?: readonly string[];
}

/**
 * Evaluate the queue once and return the chain.
 *
 * Order of operations, and it matters: the reward commit runs FIRST (INV-CER-01), then the
 * predicates run exactly once each, then the chain is assembled. The caller applies the
 * path-model mutation before rendering S087 - `pathMutationDue` says so explicitly.
 */
export function runCeremony(state: CeremonyState, options: CeremonyOptions = {}): CeremonyResult {
  const achievements = achievementSlot(state.account.achievementCrossings);
  const bundle = mergeBundles(state.account.bundle, {
    gems: achievements.gems,
    freezes: 0,
    boost: null,
    tierGrant: null,
  });
  /**
   * Achievement gems are folded into the bundle BEFORE the predicates run, not after, so
   * the chest screen renders for a session whose only reward was a tier crossing
   * (EC-CER-26: "gems for every tier crossed credit atomically at the reward commit
   * whether or not a screen renders, and are paid once - folded into the chest bundle or
   * on the achievement card, never both"). Folding after evaluation credited the gems and
   * showed no chest, which is the invisible-credit failure INV-CER-07 is about.
   */
  const effective: CeremonyState = { ...state, account: { ...state.account, bundle } };
  const collapse = collapseGoalChain(state.account.consecutiveGoalMetDays, bundle);

  // Zero-award abandonment renders no ceremony at all (EC-CER-10): straight to the path.
  const zeroAward =
    state.session.outcome === 'abandoned' && state.session.xp === 0 && isEmptyBundle(bundle);

  const outcome: SessionOutcome = {
    sessionId: state.session.sessionId,
    xp: state.session.xp,
    gems: bundle.gems,
  };
  const committed = planCommit(outcome, options.committedSessionIds ?? []);

  const ctx: QueueContext = {
    session: state.session,
    milestoneDays: state.milestoneDays,
    collapseGoalChain: collapse,
  };

  const evaluations: Record<string, number> = {};
  const chain: CeremonySlot[] = [];
  if (!zeroAward) {
    for (const row of QUEUE) {
      evaluations[row.slot] = (evaluations[row.slot] ?? 0) + 1;
      const view = viewFor(row.scope, effective);
      if (row.predicate(view, ctx)) chain.push(row.slot);
    }
  }

  const skippedToToast: CeremonySlot[] = [];
  let finalChain: readonly CeremonySlot[] = chain;
  if (options.skipAll === true && chain.length > 0) {
    const kept: CeremonySlot[] = [];
    for (const slot of chain) {
      if (ONE_TIME_SLOTS.includes(slot) || slot === 'S087_returnToPath') kept.push(slot);
      else skippedToToast.push(slot);
    }
    finalChain = kept;
  }

  return {
    chain: finalChain,
    committed,
    bundle,
    achievements,
    collapsedGoalRow: collapse ? `+${bundle.gems} gems - daily goal and quests complete` : null,
    predicateEvaluations: evaluations,
    skippedToToast,
  };
}

/**
 * The path-model mutation is due **before** S087 renders (INV-CER-02, EC-PTH-11): the
 * section switch is applied to the model first, so the return lands already scrolled.
 */
export function pathMutationIndex(chain: readonly CeremonySlot[]): number {
  return chain.indexOf('S087_returnToPath');
}

/** Is `chain` a duplicate-free subsequence of the canonical order? */
export function isCanonicalSubsequence(chain: readonly CeremonySlot[]): boolean {
  if (new Set(chain).size !== chain.length) return false;
  let cursor = -1;
  for (const slot of chain) {
    const at = CEREMONY_SLOTS.indexOf(slot);
    if (at <= cursor) return false;
    cursor = at;
  }
  return true;
}

/* ------------------------------------------------------- the S067 card variant */

export type SessionCardVariant =
  'Lesson Complete!' | 'Perfect lesson!' | 'Practice Complete!' | 'Story complete!' | 'Legendary!';

export interface SessionCard {
  readonly variant: SessionCardVariant;
  readonly subtitle: string | null;
  /** `Perfect lesson!` terminates on the single COMBO tile (EC-CER-08). */
  readonly terminal: boolean;
  readonly tileCount: 1 | 2;
}

/**
 * INV-CER-05 / EC-CER-08, EC-CER-09: the perfect-lesson layout fires only for lesson
 * flavours. A 100% Practice run renders `Practice Complete!` + `AMAZING`, not
 * `Perfect lesson!` - perfection is celebrated for new material, merely scored for review.
 */
export function sessionCard(session: SessionCeremonyState): SessionCard {
  const perfect = session.mistakes === 0 && LESSON_FLAVOURS.includes(session.flavour);
  if (perfect) {
    return {
      variant: 'Perfect lesson!',
      subtitle: 'You made no mistakes in this lesson',
      terminal: true,
      tileCount: 1,
    };
  }
  const variant: SessionCardVariant =
    session.flavour === 'practice'
      ? 'Practice Complete!'
      : session.flavour === 'story'
        ? 'Story complete!'
        : session.flavour === 'legendary'
          ? 'Legendary!'
          : 'Lesson Complete!';
  return { variant, subtitle: null, terminal: false, tileCount: 2 };
}
