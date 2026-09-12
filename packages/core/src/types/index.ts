/**
 * The shared, dependency-free type surface.
 *
 * Every other P1 module imports its vocabulary from here, so no two modules invent a
 * second spelling of the same thing (plan §The build workflow, step 1). This file and
 * `economy/config.ts` land first and their public types stay stable.
 *
 * It imports nothing but `day/civil.js`, which owns `LocalDay`.
 */
import type { LocalDay } from '../day/civil.js';

export type { LocalDay };

/* ---------------------------------------------------------------- identifiers */

/**
 * A CONTENT-HASHED item id: the hash of the item's normalised content, so the same
 * lexeme taught by two packs is ONE id. Word counters can then take a set union rather
 * than a sum (INV-ECO-13, EC-ECO-16), and a pack upgrade keeps the FSRS rows of every
 * item whose content did not change.
 */
export type ItemId = string & { readonly __brand: 'ItemId' };
/** `en-es`, `en-ja`: the UI language and the language being learned. */
export type CourseId = string & { readonly __brand: 'CourseId' };
/** One learning session. Attempts and the reward commit are both keyed by it. */
export type SessionId = string & { readonly __brand: 'SessionId' };

export function asItemId(value: string): ItemId {
  return value as ItemId;
}
export function asCourseId(value: string): CourseId {
  return value as CourseId;
}
export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

/* ------------------------------------------------------------- exercise types */

/**
 * The exercise types of the product map §3.2 (S032–S042). S043 `Put the events in
 * order` is out of v1 by founder ruling: no grading contract, no taxonomy home.
 */
export const EXERCISE_TYPES = [
  'pictureSelect', //      S032
  'matchPairs', //         S033
  'meaningSelect', //      S034
  'wordBankTranslate', //  S035
  'typedTranslate', //     S036
  'completeTheChat', //    S037
  'listening', //          S038
  'gapFill', //            S039
  'readRespond', //        S040
  'speak', //              S041
  'character', //          S042
] as const;

export type ExerciseType = (typeof EXERCISE_TYPES)[number];

/**
 * Types that cost nothing and enter no accuracy denominator.
 *
 * `speak` is [DEPART D-SKIPSPEAK]: never a heart, never a combo reset, never a mistake
 * row. `readRespond` is non-binary and non-punitive by construction. `character`
 * tracing advances per stroke and a retried stroke is not a mistake (EC-ECO-40) — which
 * is exactly why INV-ECO-33 exists: a lesson made only of these has no mistakes
 * available to avoid, so avoiding them is not a perfect lesson, it is an empty one.
 */
export const NON_PUNITIVE_EXERCISE_TYPES: readonly ExerciseType[] = [
  'speak',
  'readRespond',
  'character',
] as const;

/** Whether a wrong answer here can cost a mistake allowance and block a perfect lesson. */
export function isPunitive(type: ExerciseType): boolean {
  return !NON_PUNITIVE_EXERCISE_TYPES.includes(type);
}

/** The banner states of S044, plus the skip a non-punitive exercise can produce. */
export const VERDICTS = ['correct', 'softCorrect', 'incorrect', 'skipped'] as const;
export type Verdict = (typeof VERDICTS)[number];

/* ------------------------------------------------------------ session flavours */

/**
 * The TEN session flavours of the product map §3.4 (S057–S066). One runtime, ten
 * configurations; `economy/config.ts` carries the matrix that says what each one does to
 * the streak, the goal, XP, quests, the boost and the mistake allowance.
 */
export const SESSION_FLAVOURS = [
  'lesson', //         S057
  'nodePractice', //   S058
  'legendary', //      S059
  'placement', //      S060
  'jumpHere', //       S061
  'sectionTest', //    S062
  'unitReview', //     S063
  'dailyRefresh', //   S064
  'recovery', //       S065
  'endgameReview', //  S066
] as const;

export type SessionFlavour = (typeof SESSION_FLAVOURS)[number];

/**
 * How a session ended. The matrix is keyed `(flavour, outcome)`, not flavour alone
 * (INV-ECO-19): a failed jump-here and a completed one are different rows, and
 * `replayed` is the sub-flavour that stops Legendary and Daily Refresh from paying
 * their first-completion award twice (INV-ECO-07, INV-ECO-08).
 */
export const SESSION_OUTCOMES = ['completed', 'replayed', 'failed', 'quit'] as const;
export type SessionOutcomeKind = (typeof SESSION_OUTCOMES)[number];

/**
 * The per-mode daily XP ladders (INV-ECO-06). Keyed GLOBALLY by `local_day`, never per
 * course: the rule's whole purpose is anti-farming and XP is global state (EC-ECO-06).
 */
export const XP_LADDER_MODES = [
  'lesson',
  'practice',
  'legendary',
  'test',
  'review',
  'dailyRefresh',
  'recovery',
  'endgameReview',
] as const;

export type XpLadderMode = (typeof XP_LADDER_MODES)[number];

/* --------------------------------------------------------------------- boosts */

/** Boost kinds. Only `xpBoost` ships; the rest are types with no catalogue entry. */
export type BoostKind = 'xpBoost' | 'timerBoost' | 'happyHour' | 'earlyBird';

/**
 * A granted boost. Duration rides the GRANT (S122: `+1 XP Boost for {{n}} minute(s)`),
 * never a module constant, because a milestone grants 30 minutes and a chest grants 15.
 */
export interface BoostGrant {
  readonly kind: BoostKind;
  readonly multiplier: number;
  readonly durationMinutes: number;
  readonly grantedAtUtc: string;
}

/** The running boost. Expiry is a UTC instant, so a DST jump does not lengthen it. */
export interface ActiveBoost {
  readonly kind: BoostKind;
  readonly multiplier: number;
  readonly startedAtUtc: string;
  readonly expiresAtUtc: string;
}

/* -------------------------------------------------------------------- attempts */

/**
 * One append-only attempt event, keyed `(session_id, exercise_index)`.
 *
 * Plan §Architecture: "attempts are append-only events … every counter is recomputable
 * from them." `firstTry` is what accuracy reads, so a mistake recovered on the
 * end-of-lesson replay still counts as a mistake (deep/02 EC2).
 */
export interface AttemptRow {
  readonly sessionId: SessionId;
  readonly exerciseIndex: number;
  readonly itemId: ItemId;
  readonly exerciseType: ExerciseType;
  readonly verdict: Verdict;
  readonly firstTry: boolean;
  readonly answeredAtUtc: string;
  /** Foregrounded, challenge-on-screen time only (INV-ECO-20). */
  readonly activeMs: number;
}

/** A queued mistake. Recycles at most twice (S049), then retires to the hub backlog. */
export interface MistakeRow {
  readonly sessionId: SessionId;
  readonly exerciseIndex: number;
  readonly itemId: ItemId;
  readonly courseId: CourseId;
  readonly recycleCount: number;
  readonly createdAtUtc: string;
}

/* ----------------------------------------------------------------------- packs */

/** The six-value pack state (plan §Architecture): a bad signature is `unverified`. */
export type PackState =
  'not-downloaded' | 'partial' | 'installed' | 'corrupt' | 'unverified' | 'withdrawn';

/**
 * The manifest a pack ships with. `majorVersion` is the one that matters here: a major
 * bump is a MIGRATION, not a download (INV-PACK-35).
 */
export interface PackManifest {
  readonly courseId: CourseId;
  /** One locale per course by ruling EC-PACK-17: es-ES, fr-FR, de-DE, ja-JP. */
  readonly locale: string;
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly contentHash: string;
  readonly itemCount: number;
  readonly audioBytes: number;
  /** Measured wrong-item rate from the paid native-speaker sample. Gate: <= 0.02. */
  readonly defectRate: number;
  readonly machineAuthoredShare: number;
  /** es/fr only, per the licence split: `A1 · CEFR-checked` vs `Beginner`. */
  readonly cefrChecked: boolean;
}

/* ------------------------------------------------------------- progress regions */

/**
 * The per-course region (INV-ECO-04). Course XP, Score, path state, mistakes and FSRS
 * rows live HERE and are destroyed with the course.
 */
export interface CourseProgress {
  readonly courseId: CourseId;
  readonly xp: number;
  readonly score: number;
  /** The Score never decreases; this is the floor it is clamped up to. */
  readonly scoreFloor: number;
  readonly completedNodeIds: readonly string[];
  readonly legendaryNodeIds: readonly string[];
  /** Content-hashed ids, so a union across courses is meaningful (INV-ECO-13). */
  readonly introducedItemIds: readonly ItemId[];
  readonly learnedItemIds: readonly ItemId[];
}

/**
 * The account region (INV-ECO-04): global and course-agnostic. A boost bought in
 * Spanish is live in French (EC-ECO-05), and `lifetimeXp` survives course removal
 * (INV-ECO-13, EC-ECO-17).
 */
export interface AccountState {
  readonly lifetimeXp: number;
  readonly gems: number;
  readonly streak: number;
  readonly longestStreak: number;
  readonly freezesOwned: number;
  /** Stored as XP; the picker's minutes are a LABEL (INV-ECO-21, EC-ECO-24). */
  readonly dailyGoalXp: number;
  readonly boostInventory: readonly BoostGrant[];
  readonly activeBoost: ActiveBoost | null;
  readonly ownedCosmeticIds: readonly string[];
  /** The tamper guard every day-keyed award is checked against (deep/04 case 12). */
  readonly maxLocalDaySeen: LocalDay;
  /** Achievement counter columns, by name. The registry cross-checks these exist. */
  readonly achievementCounters: Readonly<Record<string, number>>;
}
