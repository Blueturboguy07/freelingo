/**
 * Strict persisted-session boundary (INV-SESS-01/06/15).
 *
 * This validates the declared row, not a new version of the lesson machine. Callers
 * still bind the row to its SQL key and enforce the active-session lease. Only an
 * absent legacy modality field is initialized; malformed present fields are never
 * repaired or deleted, and a rejected row remains available for recovery.
 */
import {
  EXERCISE_TYPES,
  INPUT_MODES,
  ITEM_FAMILIES,
  SESSION_FLAVOURS,
  SESSION_KINDS,
  SHELL_STATES,
  VERDICT_KINDS,
  type Allowance,
  type Answer,
  type InFlightInput,
  type LastVerdict,
  type MistakeRow,
  type ProgressState,
  type QueuedItem,
  type QueuedMistake,
  type ReplayInFlight,
  type ResumeCore,
  type SessionState,
  type WeakItemRow,
} from '@freelingo/core/session';

import { emptySessionModality, isSessionModalityState } from '@freelingo/core/modality';

type Validator<T> = (value: unknown) => value is T;
type Fields<T> = { readonly [K in keyof T]-?: Validator<T[K]> };

const string: Validator<string> = (value) => typeof value === 'string';
const boolean: Validator<boolean> = (value) => typeof value === 'boolean';
const finite: Validator<number> = (value): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const integer: Validator<number> = (value): value is number =>
  finite(value) && Number.isSafeInteger(value);
const counter: Validator<number> = (value): value is number => integer(value) && value >= 0;

function member<const T extends readonly string[]>(values: T): Validator<T[number]> {
  return (value): value is T[number] => string(value) && values.includes(value);
}
function nullable<T>(validate: Validator<T>): Validator<T | null> {
  return (value): value is T | null => value === null || validate(value);
}
function arrayOf<T>(validate: Validator<T>): Validator<readonly T[]> {
  return (value): value is readonly T[] => Array.isArray(value) && value.every(validate);
}
function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function recordOf<T>(validate: Validator<T>): Validator<Readonly<Record<string, T>>> {
  return (value): value is Readonly<Record<string, T>> =>
    record(value) && Object.values(value).every(validate);
}

/** Exhaustive mapped keys make adding a declared field a compile-time boundary change. */
function shape<T>(fields: Fields<T>, optional: readonly (keyof T)[] = []): Validator<T> {
  const validators = fields as Readonly<Record<string, Validator<unknown>>>;
  const optionalKeys = new Set<string>(optional.map(String));
  return (value): value is T =>
    record(value) &&
    Object.keys(value).every((key) => Object.hasOwn(validators, key)) &&
    Object.entries(validators).every(([key, validate]) =>
      Object.hasOwn(value, key) ? validate(value[key]) : optionalKeys.has(key),
    );
}

const queuedItem = shape<QueuedItem>(
  {
    id: string,
    itemId: string,
    type: member(EXERCISE_TYPES),
    family: member(ITEM_FAMILIES),
    conceptId: string,
    nodeRef: string,
    requiresAudio: boolean,
    degraded: member(['noAudio', 'noImage']),
  },
  ['degraded'],
);
const answerFields = shape<Answer>({
  exerciseIndex: integer,
  slotId: string,
  itemId: string,
  type: member(EXERCISE_TYPES),
  verdict: member(VERDICT_KINDS),
  softCorrected: boolean,
  wrong: boolean,
  costPaid: counter,
  skipped: boolean,
  scorable: boolean,
  queue: member(['main', 'mistakes']),
  note: nullable(string),
});
/** machine.exerciseIndexFor reserves negative ledger indices for mistake replays. */
const answer: Validator<Answer> = (value): value is Answer =>
  answerFields(value) &&
  (value.queue === 'main' ? value.exerciseIndex >= 0 : value.exerciseIndex < 0);
const infiniteAllowance = shape<Extract<Allowance, { kind: 'infinite' }>>({
  kind: member(['infinite']),
});
const pipsAllowance = shape<Extract<Allowance, { kind: 'pips' }>>({
  kind: member(['pips']),
  total: counter,
  remaining: counter,
});
const allowance: Validator<Allowance> = (value): value is Allowance =>
  infiniteAllowance(value) || (pipsAllowance(value) && value.remaining <= value.total);
const coreFields = shape<ResumeCore>({
  queue: arrayOf(queuedItem),
  index: counter,
  answers: arrayOf(answer),
  hearts: allowance,
  combo: counter,
  usedInterstitialKeys: arrayOf(string),
  inputMode: member(INPUT_MODES),
  hardMode: boolean,
  optionSeeds: recordOf(counter),
});
const resumeCore: Validator<ResumeCore> = (value): value is ResumeCore =>
  coreFields(value) && value.index <= value.queue.length;
const input = shape<InFlightInput>({
  text: string,
  caret: counter,
  partialState: record,
  audioHeardToEnd: boolean,
});
const mistake = shape<QueuedMistake>({
  itemId: string,
  slotId: string,
  originalType: member(EXERCISE_TYPES),
  servesRemaining: counter,
  recyclesServed: counter,
  queuedAtMainAnswers: counter,
});
const progressFields = shape<ProgressState>({
  denominator: counter,
  numerator: counter,
  finalSegmentConsumed: boolean,
});
const progress: Validator<ProgressState> = (value): value is ProgressState =>
  progressFields(value) && value.numerator <= value.denominator;
const lastVerdict = shape<LastVerdict>({ kind: member(VERDICT_KINDS), note: nullable(string) });
const replay = shape<ReplayInFlight>({ item: queuedItem, phase: member(['midLesson', 'end']) });
const mistakeRow = shape<MistakeRow>({
  itemId: string,
  courseId: string,
  conceptId: string,
  createdInSessionId: string,
  reviewStreak: counter,
});
const weakItemRow = shape<WeakItemRow>({ itemId: string, courseId: string, rejections: counter });
const session = shape<SessionState>({
  sessionId: string,
  courseId: string,
  sessionKind: member(SESSION_KINDS),
  nodeRef: string,
  flavour: member(SESSION_FLAVOURS),
  core: resumeCore,
  shellState: member(SHELL_STATES),
  inFlight: input,
  modality: isSessionModalityState,
  mistakes: arrayOf(mistake),
  progress,
  checkpointMonotonicMs: finite,
  startedMonotonicMs: finite,
  pendingInterstitialKeys: arrayOf(string),
  stepUpFired: boolean,
  motivationalMessages: boolean,
  mistakeReviewCopyKey: nullable(string),
  endReviewIntroShown: boolean,
  lastVerdict: nullable(lastVerdict),
  currentReplay: nullable(replay),
  inputModeExplicit: boolean,
  mistakeRows: arrayOf(mistakeRow),
  weakItemRows: arrayOf(weakItemRow),
  packNonLatinScript: boolean,
  exited: nullable(member(['quit', 'complete'])),
});

/**
 * partialState stays opaque, but its values must actually survive JSON persistence.
 * An ancestor set rejects cycles while permitting repeated, acyclic object references.
 * Data descriptors avoid invoking getters supplied to the public unknown-value guard.
 */
function jsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || string(value) || boolean(value) || finite(value)) return true;
  if (!Array.isArray(value) && !record(value)) return false;
  if (ancestors.has(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return false;
  if (Array.isArray(value)) {
    if (keys.length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return false;
    }
  }
  ancestors.add(value);
  const valid = keys.every((key) => {
    if (Array.isArray(value) && key === 'length') return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      descriptor.enumerable === true &&
      Object.hasOwn(descriptor, 'value') &&
      jsonValue(descriptor.value, ancestors)
    );
  });
  ancestors.delete(value);
  return valid;
}

export class SessionCodecError extends Error {
  constructor() {
    super('Invalid persisted session state');
    this.name = 'SessionCodecError';
  }
}

/** Full structural check with no filesystem, SQLite or native-platform dependency. */
export function isSessionState(value: unknown): value is SessionState {
  try {
    return jsonValue(value) && session(value);
  } catch {
    // Cyclic/deep/hostile runtime input must fail just like malformed parsed JSON.
    return false;
  }
}

/** An absent pre-modality field has no observations. Present invalid state stays invalid.
 * This migration changes only the parsed return value, never stored bytes or another field. */
export function parseSessionState(raw: string): SessionState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SessionCodecError();
  }
  if (record(value) && !Object.hasOwn(value, 'modality'))
    value = { ...value, modality: emptySessionModality() };
  if (!isSessionState(value)) throw new SessionCodecError();
  return value;
}
