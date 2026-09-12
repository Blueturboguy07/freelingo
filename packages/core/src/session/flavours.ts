/**
 * The TEN FLAVOURS, S057-S066, as a CONFIG TABLE.
 *
 * One runtime, ten configurations — not ten code paths. Everything downstream of this
 * file branches on a FIELD of `SessionFlavourConfig`, never on the flavour name. The
 * property that keeps it honest is in `flavours.test.ts`: no module under `session/`
 * outside this file may compare a value against a flavour literal.
 *
 * LANE NOTE. The plan puts the flavour matrix in `packages/core/src/economy`
 * (`SESSION_FLAVOUR_MATRIX`, `FLAVOUR_XP`) and that module is another P1 task's lane, not
 * on `origin/main` yet. So the session runtime reads the table through
 * `FlavourMatrixPort` and ships `DEFAULT_FLAVOUR_MATRIX` as the in-lane source; at
 * integration the port is pointed at economy's table and this default is deleted. The XP
 * numbers below are the session-shape ones the runtime itself needs (floor, proration);
 * the economy owns the award, the ladders and the boost multiplier.
 */
import type { SessionFlavour } from './types.js';
import { SESSION_FLAVOURS } from './types.js';

/* ============================================================== 1. the config shape */

export type StepUpKind = 'production' | 'audio';

export interface SessionFlavourConfig {
  readonly flavour: SessionFlavour;
  /** Product-map id. Present so a config row can be traced to the spec row. */
  readonly screen: string;
  /** Nominal main-queue length before padding/shortening. */
  readonly targetLength: number;
  /**
   * INV-SESS-26: no session shorter than this is offered; the node reads
   * `nothing due right now` instead. One constant, used by every flavour.
   */
  readonly minLength: number;
  /** INV-MIS-03: the three test flavours recycle nothing. */
  readonly recyclesMistakes: boolean;
  /** S059/S061/S062: hints and dotted underlines off. */
  readonly hintsEnabled: boolean;
  /** `null` = infinite (Super default); a number = the PIP row of S056. */
  readonly mistakeAllowance: number | null;
  /** INV-COM-12: at most ONE escalation per session, and never the audio copy here. */
  readonly stepUp: StepUpKind | null;
  /** INV-SESS-13: may the generator pad a short queue from the due pool? */
  readonly padsFromDuePool: boolean;
  /** May the generator serve an item the learner has never met? (INV-SCH-06) */
  readonly mayIntroduceNewItems: boolean;
  /** Base XP for a full-length session. Prorated by gradeable items served. */
  readonly baseXp: number;
  /** S060: a placement test pays 0 XP and still satisfies the day. */
  readonly advancesNodeRing: boolean;
  /** INV-COM-03 pool cap, per flavour so a Daily Refresh block cannot outrun it. */
  readonly maxComboInterstitials: number;
  /**
   * How many further MAIN-queue answers must pass after a miss before its FIRST recycle
   * is served MID-LESSON (S049, `deep/01` §S16: "recycled twice — mid-lesson in a
   * different format, at the end in the original").
   *
   * The corpus publishes no number, so this is a named constant, not a magic literal:
   * 0 would replay the item on the very next screen (an echo, not recall) and a large
   * value would push every recycle past the end of the queue, which is the bug a refuter
   * already caught. Irrelevant when `recyclesMistakes` is false (INV-MIS-03).
   */
  readonly midLessonRecycleGap: number;
}

export type FlavourMatrix = Readonly<Record<SessionFlavour, SessionFlavourConfig>>;

/** The port integration repoints at `packages/core/src/economy`. */
export interface FlavourMatrixPort {
  row(flavour: SessionFlavour): SessionFlavourConfig;
}

/* ==================================================== 2. the constants, each named */

/** EC-SES-31: "a session-length floor in config (suggest 6) below which it is not offered". */
export const MIN_SESSION_LENGTH = 6;

/** EC-COM-03: `maxComboInterstitialsPerSession = 7`, the pool size. */
export const MAX_COMBO_INTERSTITIALS_PER_SESSION = 7;

/**
 * S049 / INV-MIS-01: the mid-lesson replay lands two main exercises after the miss —
 * far enough that answering it is recall rather than echo, near enough that it is still
 * "mid-lesson" on a 12-item queue. When fewer than this many main items remain, there is
 * no mid-lesson slot and BOTH recycles are served at the end in the original format; the
 * product map calls the different-format mid-lesson replay "best-effort" for exactly this
 * case. The COUNT is always two.
 */
export const MID_LESSON_RECYCLE_GAP = 2;

/** S057: ~9-14 exercises including replays; the main queue before replays is 12. */
export const LESSON_TARGET_LENGTH = 12;
/** S058: 11 exercises, first-hand measurement. */
export const NODE_PRACTICE_TARGET_LENGTH = 11;
/** S059: two halves plus a mid checkpoint. */
export const LEGENDARY_TARGET_LENGTH = 20;
/** S060: adaptive 15-25, stopping on a stable estimate; 20 is the nominal. */
export const PLACEMENT_TARGET_LENGTH = 20;
/** S061 duoplanet 2022-09-17. */
export const JUMP_HERE_TARGET_LENGTH = 20;
/** S062 duoplanet 2022-09-13. */
export const SECTION_TEST_TARGET_LENGTH = 30;
/** S063 founder ruling: 15 across the unit weighted by FSRS due-ness. */
export const UNIT_REVIEW_TARGET_LENGTH = 15;
export const DAILY_REFRESH_TARGET_LENGTH = 12;
/** S065: ordinary lesson content. */
export const RECOVERY_TARGET_LENGTH = 12;
export const ENDGAME_REVIEW_TARGET_LENGTH = 12;

/** S061: 5 allowed mistakes. S062: 4. S059: a config constant, unpublished. */
export const JUMP_HERE_ALLOWANCE = 5;
export const SECTION_TEST_ALLOWANCE = 4;
export const LEGENDARY_ALLOWANCE = 3;

export const LESSON_BASE_XP = 10;
export const NODE_PRACTICE_BASE_XP = 10;
export const LEGENDARY_BASE_XP = 40;
export const PLACEMENT_BASE_XP = 0;
export const JUMP_HERE_BASE_XP = 0;
export const SECTION_TEST_BASE_XP = 50;
export const UNIT_REVIEW_BASE_XP = 10;
export const DAILY_REFRESH_BASE_XP = 10;
export const RECOVERY_BASE_XP = 10;
export const ENDGAME_REVIEW_BASE_XP = 5;

/* ======================================================== 3. the table, ten rows */

function row(
  flavour: SessionFlavour,
  screen: string,
  targetLength: number,
  recyclesMistakes: boolean,
  hintsEnabled: boolean,
  mistakeAllowance: number | null,
  stepUp: StepUpKind | null,
  padsFromDuePool: boolean,
  mayIntroduceNewItems: boolean,
  baseXp: number,
  advancesNodeRing: boolean,
): SessionFlavourConfig {
  return {
    flavour,
    screen,
    targetLength,
    minLength: MIN_SESSION_LENGTH,
    recyclesMistakes,
    hintsEnabled,
    mistakeAllowance,
    stepUp,
    padsFromDuePool,
    mayIntroduceNewItems,
    baseXp,
    advancesNodeRing,
    maxComboInterstitials: MAX_COMBO_INTERSTITIALS_PER_SESSION,
    midLessonRecycleGap: MID_LESSON_RECYCLE_GAP,
  };
}

/**
 * `Record<SessionFlavour, …>`: a flavour with no row fails the build, which is the
 * cheapest place for "every flavour is a configuration" to stop being true.
 */
export const DEFAULT_FLAVOUR_MATRIX: FlavourMatrix = {
  // S057 Lesson — ~9-14 incl. replays, recycled twice, 10 + combo bonus.
  lesson: row(
    'lesson',
    'S057',
    LESSON_TARGET_LENGTH,
    true,
    true,
    null,
    'production',
    true,
    true,
    LESSON_BASE_XP,
    true,
  ),
  // S058 Node practice — 11 exercises, can escalate to hard, flat 10.
  nodePractice: row(
    'nodePractice',
    'S058',
    NODE_PRACTICE_TARGET_LENGTH,
    true,
    true,
    null,
    'production',
    true,
    false,
    NODE_PRACTICE_BASE_XP,
    false,
  ),
  // S059 Legendary — no hints, no dotted underlines, mistake-allowance gated.
  legendary: row(
    'legendary',
    'S059',
    LEGENDARY_TARGET_LENGTH,
    true,
    false,
    LEGENDARY_ALLOWANCE,
    null,
    false,
    false,
    LEGENDARY_BASE_XP,
    true,
  ),
  // S060 Placement — adaptive, 0 XP, satisfies the day.
  placement: row(
    'placement',
    'S060',
    PLACEMENT_TARGET_LENGTH,
    false,
    false,
    null,
    null,
    false,
    true,
    PLACEMENT_BASE_XP,
    false,
  ),
  // S061 Jump-here — hints off, 5 allowed, not recycled.
  jumpHere: row(
    'jumpHere',
    'S061',
    JUMP_HERE_TARGET_LENGTH,
    false,
    false,
    JUMP_HERE_ALLOWANCE,
    null,
    false,
    false,
    JUMP_HERE_BASE_XP,
    false,
  ),
  // S062 Section test — 30, hints off, 4 allowed, not recycled.
  sectionTest: row(
    'sectionTest',
    'S062',
    SECTION_TEST_TARGET_LENGTH,
    false,
    false,
    SECTION_TEST_ALLOWANCE,
    null,
    false,
    false,
    SECTION_TEST_BASE_XP,
    false,
  ),
  // S063 Unit review — 15 weighted by FSRS due-ness.
  unitReview: row(
    'unitReview',
    'S063',
    UNIT_REVIEW_TARGET_LENGTH,
    true,
    true,
    null,
    'production',
    true,
    false,
    UNIT_REVIEW_BASE_XP,
    false,
  ),
  // S064 Daily Refresh — recycled material only, zero new.
  dailyRefresh: row(
    'dailyRefresh',
    'S064',
    DAILY_REFRESH_TARGET_LENGTH,
    true,
    true,
    null,
    null,
    true,
    false,
    DAILY_REFRESH_BASE_XP,
    false,
  ),
  // S065 Recovery lesson — ordinary lesson content, full XP + quests + goal.
  recovery: row(
    'recovery',
    'S065',
    RECOVERY_TARGET_LENGTH,
    true,
    true,
    null,
    'production',
    true,
    true,
    RECOVERY_BASE_XP,
    true,
  ),
  // S066 Endgame review — unbounded FSRS-due pull, NEVER introduces a new item.
  endgameReview: row(
    'endgameReview',
    'S066',
    ENDGAME_REVIEW_TARGET_LENGTH,
    true,
    true,
    null,
    null,
    true,
    false,
    ENDGAME_REVIEW_BASE_XP,
    false,
  ),
};

export const defaultFlavourMatrixPort: FlavourMatrixPort = {
  row(flavour: SessionFlavour): SessionFlavourConfig {
    const found = DEFAULT_FLAVOUR_MATRIX[flavour];
    if (found === undefined) throw new Error(`flavour matrix: no row for ${String(flavour)}`);
    return found;
  },
};

/** The three test flavours (INV-MIS-03) — derived from the table, never re-listed. */
export const TEST_FLAVOURS: readonly SessionFlavour[] = SESSION_FLAVOURS.filter(
  (f) => !DEFAULT_FLAVOUR_MATRIX[f].recyclesMistakes,
);

/* ==================================================== 4. base XP, non-decreasing */

/**
 * INV-SESS-26, second half: "base XP is non-decreasing in gradeable items served".
 *
 * EC-SES-31 says a legitimately shortened session prorates rather than paying full, "as
 * the Mistakes set already does". Proration must never make a longer session pay less, so
 * it is `floor(base * served / target)` clamped to `[0, base]` — monotone in `served` by
 * construction, and equal to `base` once the target is reached.
 */
export function baseSessionXp(config: SessionFlavourConfig, gradeableItemsServed: number): number {
  if (gradeableItemsServed <= 0) return 0;
  if (config.targetLength <= 0) return config.baseXp;
  const prorated = Math.floor((config.baseXp * gradeableItemsServed) / config.targetLength);
  return Math.max(0, Math.min(config.baseXp, prorated));
}
