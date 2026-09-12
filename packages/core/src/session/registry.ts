/**
 * The exercise-type registry — INV-PACK-19.
 *
 * "Every exercise-type string the node-type registry can emit has a declared state
 * machine, heart cost and grading rule." The falsifier is `Build the character` reaching
 * generation with no declaration, so the registry is a TOTAL `Record<ExerciseType, …>`:
 * a type with no row is a compile error, and `NODE_TYPE_EMITS` is checked against it by a
 * test rather than by eye.
 *
 * Costs come from `deep/01` §S20 "Heart decrement by type"; the state machines from
 * `deep/01` §S1-S12 and the product map §3.2.
 */
import type { ExerciseType, ItemFamily, ShellState } from './types.js';
import { EXERCISE_TYPES, isDeclaredShellState } from './types.js';

/* ============================================================= 1. state machines */

/**
 * The declared per-challenge machine. `states` are SHELL states (INV-SESS-22): a
 * challenge cannot invent one of its own, which is why they are validated against
 * `DECLARED_SHELL_STATES` at module load by the registry test.
 */
export interface ChallengeMachine {
  readonly id: 'check' | 'autoAdvance' | 'readThenCheck' | 'perStroke' | 'asrRetryLadder';
  readonly states: readonly ShellState[];
  /** What moves the challenge into `grading`. */
  readonly gradeOn: 'check' | 'lastPair' | 'lastStroke' | 'asrResult';
}

const CHECK_STATES: readonly ShellState[] = [
  'challenge.idle',
  'challenge.armed',
  'grading',
  'banner.correct',
  'banner.softCorrect',
  'banner.wrong',
];

/** CHECK-gated: idle until gradeable, armed, CHECK, verdict, banner. */
const MACHINE_CHECK: ChallengeMachine = { id: 'check', states: CHECK_STATES, gradeOn: 'check' };

/**
 * Match pairs (S033): no CHECK. A wrong pair charges immediately, the last correct pair
 * grades the exercise and auto-advances.
 */
const MACHINE_AUTO_ADVANCE: ChallengeMachine = {
  id: 'autoAdvance',
  states: ['challenge.idle', 'grading', 'banner.correct', 'banner.wrong'],
  gradeOn: 'lastPair',
};

/** Complete the chat (S037): the footer shows NEXT until the reading step is dismissed. */
const MACHINE_READ_THEN_CHECK: ChallengeMachine = {
  id: 'readThenCheck',
  states: CHECK_STATES,
  gradeOn: 'check',
};

/** Trace (S042): per stroke; `Let's move on to the next stroke.` */
const MACHINE_PER_STROKE: ChallengeMachine = {
  id: 'perStroke',
  states: ['challenge.idle', 'grading', 'banner.correct'],
  gradeOn: 'lastStroke',
};

/** Speak (S041): `Hmm… that doesn't sound right.` → retry → offer skip. Never punitive. */
const MACHINE_ASR: ChallengeMachine = {
  id: 'asrRetryLadder',
  states: ['challenge.idle', 'challenge.armed', 'grading', 'banner.correct', 'banner.wrong'],
  gradeOn: 'asrResult',
};

/* =============================================================== 2. grading rules */

export const GRADING_RULES = [
  'exactId',
  'perPairExactId',
  'threeTier',
  'perGapAllOrNothing',
  'tokenF1',
  'lengthAndKeywords',
  'strokeSequence',
  'orderedComposition',
  'presentationOnly',
] as const;
export type GradingRule = (typeof GRADING_RULES)[number];

/* ================================================================ 3. the registry */

export interface ExerciseTypeSpec {
  readonly type: ExerciseType;
  readonly family: ItemFamily;
  readonly machine: ChallengeMachine;
  /**
   * Cost of ONE checked answer. `perWrongPair` is match's immediate charge (S033) —
   * a number would hide that the charge lands with no CHECK press.
   */
  readonly heartCost: 0 | 1 | 'perWrongPair';
  readonly grading: GradingRule;
  /** False ⇒ never a heart, never a combo break, never a mistake row (D-SKIPSPEAK). */
  readonly punitive: boolean;
  /** Counts toward the accuracy denominator (INV-GRD-06). */
  readonly scorable: boolean;
  /** Needs a baked clip or a system voice to render at all (INV-AUD-01). */
  readonly requiresAudio: boolean;
  /** INV-MIS-07: the declared recycle targets. Trace appears in none of them. */
  readonly recycleTargets: readonly ExerciseType[];
  readonly screen: string;
}

function spec(
  type: ExerciseType,
  family: ItemFamily,
  machine: ChallengeMachine,
  heartCost: 0 | 1 | 'perWrongPair',
  grading: GradingRule,
  punitive: boolean,
  scorable: boolean,
  requiresAudio: boolean,
  recycleTargets: readonly ExerciseType[],
  screen: string,
): ExerciseTypeSpec {
  return {
    type,
    family,
    machine,
    heartCost,
    grading,
    punitive,
    scorable,
    requiresAudio,
    recycleTargets,
    screen,
  };
}

/**
 * Total by construction: `Record<ExerciseType, …>`. Adding a string to `EXERCISE_TYPES`
 * without a row here fails `pnpm typecheck`, which is the cheapest possible place for
 * INV-PACK-19 to fail.
 */
export const EXERCISE_REGISTRY: Record<ExerciseType, ExerciseTypeSpec> = {
  pictureSelect: spec(
    'pictureSelect',
    'recognition',
    MACHINE_CHECK,
    1,
    'exactId',
    true,
    true,
    false,
    ['meaningSelect', 'wordBankTranslate'],
    'S032',
  ),
  matchPairs: spec(
    'matchPairs',
    'recognition',
    MACHINE_AUTO_ADVANCE,
    'perWrongPair',
    'perPairExactId',
    true,
    true,
    false,
    ['meaningSelect', 'pictureSelect'],
    'S033',
  ),
  meaningSelect: spec(
    'meaningSelect',
    'recognition',
    MACHINE_CHECK,
    1,
    'exactId',
    true,
    true,
    false,
    ['wordBankTranslate', 'pictureSelect'],
    'S034',
  ),
  wordBankTranslate: spec(
    'wordBankTranslate',
    'production',
    MACHINE_CHECK,
    1,
    'threeTier',
    true,
    true,
    false,
    ['typedTranslate', 'meaningSelect'],
    'S035',
  ),
  typedTranslate: spec(
    'typedTranslate',
    'production',
    MACHINE_CHECK,
    1,
    'threeTier',
    true,
    true,
    false,
    ['wordBankTranslate', 'gapFillTyped'],
    'S036',
  ),
  completeChat: spec(
    'completeChat',
    'discourse',
    MACHINE_READ_THEN_CHECK,
    1,
    'exactId',
    true,
    true,
    false,
    ['meaningSelect'],
    'S037',
  ),
  listenTapWhatYouHear: spec(
    'listenTapWhatYouHear',
    'listening',
    MACHINE_CHECK,
    1,
    'exactId',
    true,
    true,
    true,
    ['listenTypeWhatYouHear', 'meaningSelect'],
    'S038',
  ),
  listenTypeWhatYouHear: spec(
    'listenTypeWhatYouHear',
    'listening',
    MACHINE_CHECK,
    1,
    'threeTier',
    true,
    true,
    true,
    ['listenTapWhatYouHear'],
    'S038',
  ),
  listenMissingWord: spec(
    'listenMissingWord',
    'listening',
    MACHINE_CHECK,
    1,
    'perGapAllOrNothing',
    true,
    true,
    true,
    ['listenTapWhatYouHear'],
    'S038',
  ),
  listenRepeat: spec(
    'listenRepeat',
    'speaking',
    MACHINE_ASR,
    0,
    'tokenF1',
    false,
    false,
    true,
    [],
    'S038',
  ),
  listenAndRespond: spec(
    'listenAndRespond',
    'discourse',
    MACHINE_CHECK,
    0,
    'lengthAndKeywords',
    false,
    false,
    true,
    [],
    'S040',
  ),
  gapFillSelect: spec(
    'gapFillSelect',
    'recognition',
    MACHINE_CHECK,
    1,
    'exactId',
    true,
    true,
    false,
    ['gapFillTyped', 'meaningSelect'],
    'S039',
  ),
  gapFillTyped: spec(
    'gapFillTyped',
    'production',
    MACHINE_CHECK,
    1,
    'perGapAllOrNothing',
    true,
    true,
    false,
    ['gapFillSelect', 'typedTranslate'],
    'S039',
  ),
  completeWord: spec(
    'completeWord',
    'production',
    MACHINE_CHECK,
    1,
    'perGapAllOrNothing',
    true,
    true,
    false,
    ['gapFillSelect'],
    'S039',
  ),
  typeWordEnding: spec(
    'typeWordEnding',
    'production',
    MACHINE_CHECK,
    1,
    'perGapAllOrNothing',
    true,
    true,
    false,
    ['gapFillSelect'],
    'S039',
  ),
  readAndRespond: spec(
    'readAndRespond',
    'discourse',
    MACHINE_CHECK,
    0,
    'lengthAndKeywords',
    false,
    false,
    false,
    [],
    'S040',
  ),
  speakSentence: spec(
    'speakSentence',
    'speaking',
    MACHINE_ASR,
    0,
    'tokenF1',
    false,
    false,
    false,
    [],
    'S041',
  ),
  pronunciationSelect: spec(
    'pronunciationSelect',
    'speaking',
    MACHINE_CHECK,
    0,
    'exactId',
    false,
    false,
    true,
    [],
    'S041',
  ),
  characterSelect: spec(
    'characterSelect',
    'character',
    MACHINE_CHECK,
    0,
    'exactId',
    true,
    true,
    false,
    // EC-MIS-12: forward select recycles into typed production and back into itself.
    ['gapFillTyped', 'characterSelect'],
    'S042',
  ),
  characterTrace: spec(
    'characterTrace',
    'character',
    MACHINE_PER_STROKE,
    0,
    'strokeSequence',
    false,
    false,
    false,
    // INV-MIS-08: a rejected trace writes a weak-item row and reaches the hub as a
    // RECOGNITION item; it never queues a mistake, so it has no recycle of its own.
    [],
    'S042',
  ),
  characterBuild: spec(
    'characterBuild',
    'character',
    MACHINE_CHECK,
    0,
    'orderedComposition',
    true,
    true,
    false,
    ['characterSelect'],
    'S042',
  ),
  learnCharacters: spec(
    'learnCharacters',
    'character',
    MACHINE_CHECK,
    0,
    'presentationOnly',
    false,
    false,
    false,
    [],
    'S042',
  ),
};

export function exerciseSpec(type: ExerciseType): ExerciseTypeSpec {
  const found = EXERCISE_REGISTRY[type];
  if (found === undefined) {
    // Reachable only from untyped data (a pack row, a resumed queue). INV-PACK-19's
    // falsifier is exactly this: a type string reaching generation undeclared.
    throw new Error(`exercise registry: no declaration for type ${String(type)}`);
  }
  return found;
}

/** Trace is never a recycle target (INV-MIS-07). Asserted, not just intended. */
export const NEVER_A_RECYCLE_TARGET: readonly ExerciseType[] = ['characterTrace'];

/* ========================================================= 4. the node-type registry */

export const NODE_TYPES = [
  'lesson',
  'practice',
  'speaking',
  'alphabet',
  'characters',
  'review',
  'jumpHere',
  'trophy',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/**
 * What each path node type may put in a queue. INV-PACK-19 is the statement that the
 * union of these values is a subset of the registry's keys — tested, because the two
 * lists are edited by different people at different times.
 */
export const NODE_TYPE_EMITS: Record<NodeType, readonly ExerciseType[]> = {
  lesson: [
    'pictureSelect',
    'matchPairs',
    'meaningSelect',
    'wordBankTranslate',
    'typedTranslate',
    'completeChat',
    'listenTapWhatYouHear',
    'listenTypeWhatYouHear',
    'gapFillSelect',
    'gapFillTyped',
    'completeWord',
    'typeWordEnding',
    'readAndRespond',
  ],
  practice: [
    'meaningSelect',
    'matchPairs',
    'wordBankTranslate',
    'typedTranslate',
    'gapFillTyped',
    'listenTypeWhatYouHear',
  ],
  speaking: ['speakSentence', 'pronunciationSelect', 'listenRepeat'],
  alphabet: ['characterSelect', 'characterTrace', 'learnCharacters'],
  characters: ['characterSelect', 'characterTrace', 'characterBuild', 'learnCharacters'],
  review: [
    'meaningSelect',
    'wordBankTranslate',
    'typedTranslate',
    'gapFillTyped',
    'listenMissingWord',
    'listenAndRespond',
  ],
  jumpHere: [
    'meaningSelect',
    'wordBankTranslate',
    'typedTranslate',
    'gapFillSelect',
    'gapFillTyped',
  ],
  trophy: ['meaningSelect', 'wordBankTranslate', 'typedTranslate'],
};

/** Every type any node can emit, deduplicated. */
export function emittableExerciseTypes(): readonly ExerciseType[] {
  const out = new Set<ExerciseType>();
  for (const types of Object.values(NODE_TYPE_EMITS)) for (const t of types) out.add(t);
  return [...out];
}

/** Sanity used by the registry test: every declared machine names declared shell states. */
export function undeclaredShellStatesInRegistry(): string[] {
  const bad: string[] = [];
  for (const type of EXERCISE_TYPES) {
    for (const state of EXERCISE_REGISTRY[type].machine.states) {
      if (!isDeclaredShellState(state)) bad.push(`${type}: ${state}`);
    }
  }
  return bad;
}
