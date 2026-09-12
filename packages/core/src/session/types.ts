/**
 * Session runtime — the vocabulary.
 *
 * Everything the lesson player can be in, serve, or write down. The app renders these
 * values and forwards taps; it never computes one (plan §Architecture).
 *
 * Screens: S029-S042, S044, S047, S049-S052, S056-S066.
 */

/* ===================================================== 1. the shell state machine */

/**
 * The DECLARED shell states (S029 + the `tips` state EC-SES-27 adds).
 *
 * INV-SESS-22: *every* transition out of the path lands in one of these. There is no
 * "other" and no implicit null state — `step()` returns one of these or throws, and the
 * property test enumerates the set from here rather than from a literal in the test.
 *
 * `banner.*` is a first-class state, not a rendering of `grading` (INV-SESS-04): a kill
 * between the verdict and CONTINUE restores the banner with CONTINUE armed.
 */
export const SHELL_STATES = [
  'loading',
  'tips',
  'challenge.idle',
  'challenge.armed',
  'grading',
  'banner.correct',
  'banner.softCorrect',
  'banner.wrong',
  'interstitial',
  'quitDialog',
  'outOfHearts',
  'mistakeReview',
  'complete',
] as const;

export type ShellState = (typeof SHELL_STATES)[number];

export const DECLARED_SHELL_STATES: ReadonlySet<string> = new Set<string>(SHELL_STATES);

export function isDeclaredShellState(value: string): value is ShellState {
  return DECLARED_SHELL_STATES.has(value);
}

/* ================================================================ 2. the flavours */

/**
 * The ten path flavours, S057-S066. One runtime, ten CONFIGURATIONS — the behaviour
 * differences live in `SESSION_FLAVOURS` (flavours.ts), never in a branch on this union
 * outside that table.
 */
export const SESSION_FLAVOURS = [
  'lesson', // S057
  'nodePractice', // S058
  'legendary', // S059
  'placement', // S060
  'jumpHere', // S061
  'sectionTest', // S062
  'unitReview', // S063
  'dailyRefresh', // S064
  'recovery', // S065
  'endgameReview', // S066
] as const;

export type SessionFlavour = (typeof SESSION_FLAVOURS)[number];

/**
 * The persisted-progress surfaces. `session_state` is keyed
 * `(course_id, session_kind, node_ref)` (INV-SESS-17) and only `graded` kinds count
 * against the one-in-flight rule; story and radio positions are their own rows.
 */
export const SESSION_KINDS = ['graded', 'story', 'radio'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/* =========================================================== 3. exercises + items */

export const ITEM_FAMILIES = [
  'recognition',
  'production',
  'listening',
  'speaking',
  'character',
  'discourse',
] as const;
export type ItemFamily = (typeof ITEM_FAMILIES)[number];

export const EXERCISE_TYPES = [
  'pictureSelect', // S032
  'matchPairs', // S033
  'meaningSelect', // S034
  'wordBankTranslate', // S035
  'typedTranslate', // S036
  'completeChat', // S037
  'listenTapWhatYouHear', // S038
  'listenTypeWhatYouHear', // S038
  'listenMissingWord', // S038
  'listenRepeat', // S038
  'listenAndRespond', // S040
  'gapFillSelect', // S039
  'gapFillTyped', // S039
  'completeWord', // S039
  'typeWordEnding', // S039
  'readAndRespond', // S040
  'speakSentence', // S041
  'pronunciationSelect', // S041
  'characterSelect', // S042
  'characterTrace', // S042
  'characterBuild', // S042
  'learnCharacters', // S042
] as const;
export type ExerciseType = (typeof EXERCISE_TYPES)[number];

/** One queued challenge. `itemId` is the content-hashed ledger id FSRS schedules. */
export interface QueuedItem {
  /** Unique within a session — the same `itemId` may be queued twice in different slots. */
  readonly id: string;
  readonly itemId: string;
  readonly type: ExerciseType;
  readonly family: ItemFamily;
  readonly conceptId: string;
  readonly nodeRef: string;
  /** True when the item cannot render without a baked clip or a system voice. */
  readonly requiresAudio: boolean;
  /** Set by generation when the clip is gone and the item degraded (INV-PACK-05). */
  readonly degraded?: 'noAudio' | 'noImage';
}

/* ============================================================== 4. answers, hearts */

export const VERDICT_KINDS = [
  'correct',
  'softCorrect',
  'wrong',
  /** Non-binary accept: read/listen-and-respond, never punitive (INV-GRD-08). */
  'accepted',
  /** No verdict at all: a zero-in-script answer (INV-GRD-14), an aborted ASR attempt. */
  'noVerdict',
] as const;
export type VerdictKind = (typeof VERDICT_KINDS)[number];

export interface Verdict {
  readonly kind: VerdictKind;
  /** Tier-2 note; wins the banner headline when present (INV-COM-09). */
  readonly note?: string;
}

/** A recorded answer. One per answered exercise index (INV-SCH-03 keys on the index). */
export interface Answer {
  readonly exerciseIndex: number;
  readonly slotId: string;
  readonly itemId: string;
  readonly type: ExerciseType;
  readonly verdict: VerdictKind;
  /** INV-GRD-04: two independent flags. `soft_corrected` never creates a mistake row. */
  readonly softCorrected: boolean;
  readonly wrong: boolean;
  /** Hearts/pips actually charged. Never charged twice for one index (INV-SESS-15). */
  readonly costPaid: number;
  /** True for a `Can't speak now` / `Can't listen now` skip (INV-COM-10). */
  readonly skipped: boolean;
  /** Counts toward the accuracy denominator (INV-GRD-06). */
  readonly scorable: boolean;
  /** Which queue served it. Mid/end replays never consume a progress segment. */
  readonly queue: 'main' | 'mistakes';
}

/**
 * The mistake allowance. Super default is infinite hearts; the test flavours render a
 * PIP row that is never the heart glyph and never a refill (S056, INV-ECO-17).
 */
export type Allowance =
  | { readonly kind: 'infinite' }
  | { readonly kind: 'pips'; readonly total: number; readonly remaining: number };

export function allowanceRemaining(a: Allowance): number {
  return a.kind === 'infinite' ? Number.POSITIVE_INFINITY : a.remaining;
}

export function spendAllowance(a: Allowance, cost: number): Allowance {
  if (a.kind === 'infinite' || cost <= 0) return a;
  return { kind: 'pips', total: a.total, remaining: Math.max(0, a.remaining - cost) };
}

/* ============================================================== 5. input modality */

/** S035/S036: `Use keyboard` / `Use word bank`, persisted per session (INV-SESS-20). */
export const INPUT_MODES = ['keyboard', 'bank'] as const;
export type InputMode = (typeof INPUT_MODES)[number];

/**
 * Ungraded in-flight input — the tenth persisted field (EC-SES-20).
 * `partialState` is OPAQUE to the runtime: stroke index, tapped-tile order, matched-pair
 * set. The runtime stores and restores it and never reads inside it.
 */
export interface InFlightInput {
  readonly text: string;
  readonly caret: number;
  readonly partialState: Readonly<Record<string, unknown>>;
  /** Listening items: CHECK stays disabled until the clip completes (INV-SESS-24). */
  readonly audioHeardToEnd: boolean;
}

export const EMPTY_IN_FLIGHT: InFlightInput = {
  text: '',
  caret: 0,
  partialState: {},
  audioHeardToEnd: false,
};

/* ================================================================ 6. the mistakes */

/** A queued mistake awaiting its recycles inside the session that created it. */
export interface QueuedMistake {
  readonly itemId: string;
  readonly slotId: string;
  /** The original authored form; the end replay uses it verbatim (S049). */
  readonly originalType: ExerciseType;
  /** Serves still budgeted. Strictly decreasing — the termination measure (INV-MIS-02). */
  readonly servesRemaining: number;
  /** How many of the two scheduled recycles have been served. */
  readonly recyclesServed: number;
}

/** A durable mistake row, the thing the Practice Hub counts (INV-MIS-04/05). */
export interface MistakeRow {
  readonly itemId: string;
  readonly courseId: string;
  readonly conceptId: string;
  /** Session that created it; a correct answer THERE never retires it (EC-MIS-09). */
  readonly createdInSessionId: string;
  readonly reviewStreak: number;
}

/** A trace that needed repeated stroke rejections: never a mistake row (INV-MIS-08). */
export interface WeakItemRow {
  readonly itemId: string;
  readonly courseId: string;
  readonly rejections: number;
}

/* ================================================================== 7. the writes */

/**
 * Everything a session can persist, as data.
 *
 * The runtime never writes: it returns these and a caller hands them to the scheduler and
 * the ledger. That is what makes "X on the first unanswered exercise writes ZERO rows of
 * any kind" (INV-SESS-12) and "zero graded attempts writes no session row and no
 * day-keyed reward" (INV-SESS-23) executable rather than aspirational.
 */
export type ProgressWrite =
  | { readonly kind: 'attempt'; readonly sessionId: string; readonly answer: Answer }
  | { readonly kind: 'mistake'; readonly row: MistakeRow }
  | { readonly kind: 'weakItem'; readonly row: WeakItemRow }
  | { readonly kind: 'itemReport'; readonly itemId: string; readonly reason: string }
  | {
      readonly kind: 'session';
      readonly sessionId: string;
      readonly courseId: string;
      readonly flavour: SessionFlavour;
      readonly xp: number;
      readonly advancesNodeRing: boolean;
    }
  /** The day-keyed reward: streak day, goal XP, quests. Never written without a session. */
  | { readonly kind: 'dayReward'; readonly sessionId: string; readonly xp: number }
  | { readonly kind: 'sessionState'; readonly key: string }
  | { readonly kind: 'sessionStateDelete'; readonly key: string };

/* ============================================================ 8. exit routes (S050) */

/**
 * Every way out of a player surface. INV-SESS-14 and INV-SESS-25: all of them resolve
 * through ONE quit contract. The union is exhaustive on purpose — a new route is a type
 * error in `quitContract`, not a silent second exit path.
 */
export const EXIT_ROUTES = [
  'closeButton', // the X
  'androidSystemBack',
  'hardwareBack',
  'iosInteractivePop',
  'slideDownDismiss',
  'storyCloseControl',
  'radioCloseControl',
  'hubCloseControl',
] as const;
export type ExitRoute = (typeof EXIT_ROUTES)[number];
