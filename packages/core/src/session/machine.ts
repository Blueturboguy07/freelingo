/**
 * The session shell state machine — S029.
 *
 * Owns INV-SESS-04, 14, 19, 20, 22, 24, 25 and drives every other module.
 *
 * `step()` is TOTAL: `(state, event) → { state, writes, exit }`, and the state it returns
 * always carries a DECLARED shell state (INV-SESS-22). That is asserted by a property
 * that drives uniformly random event sequences — including events that make no sense in
 * the current state — because "every transition lands in a declared state" is only worth
 * anything if the illegal transitions are the ones being generated.
 */
import type { SessionFlavourConfig } from './flavours.js';
import type {
  Allowance,
  Answer,
  ExerciseType,
  ExitRoute,
  InputMode,
  MistakeRow,
  ProgressWrite,
  QueuedItem,
  ShellState,
  Verdict,
  WeakItemRow,
} from './types.js';
import { EMPTY_IN_FLIGHT, allowanceRemaining, spendAllowance } from './types.js';
import type { SessionState } from './resume.js';
import { checkpoint } from './resume.js';
import { exerciseSpec } from './registry.js';
import { comboAfter } from './combo.js';
import { advanceProgress, consumeFinalSegment } from './progress.js';
import type { RecyclePhase } from './mistakes.js';
import {
  afterMistakeReplay,
  hasPendingMistake,
  queueMistake,
  recycleTarget,
  serveNextMistake,
  weakItemFor,
} from './mistakes.js';
import { emitInterstitials } from './interstitials.js';
import type { GradingPort, MonotonicClock } from './ports.js';
import { quitCommit, quitDecision } from './quit.js';

/* ============================================================== 1. runtime state */

/**
 * Everything the machine needs beyond the persisted row.
 * `currentReplay` IS persisted (it is part of the row): a kill during a mistake replay
 * must restore that replay, not the main-queue item at `index`.
 */
export interface RuntimeState extends SessionState {
  readonly currentReplay: { readonly item: QueuedItem; readonly phase: RecyclePhase } | null;
  /** The learner tapped `Use keyboard` / `Use word bank` in this session (EC-SES-25). */
  readonly inputModeExplicit: boolean;
  /** Durable rows accrued this session, committed on quit or completion. */
  readonly mistakeRows: readonly MistakeRow[];
  readonly weakItemRows: readonly WeakItemRow[];
  /** The pack declares a non-Latin script: hard mode never changes the input default. */
  readonly packNonLatinScript: boolean;
  /** Did the whole session end? `null` while it is live. */
  readonly exited: 'quit' | 'complete' | null;
}

export interface StepDeps {
  readonly config: SessionFlavourConfig;
  readonly grading: GradingPort;
  readonly clock: MonotonicClock;
  /** Which exercise types can be served right now (modality, suspension, pack). */
  readonly isTypeEligible: (type: ExerciseType) => boolean;
  /** The step-up heuristic. Called once per graded answer. */
  readonly stepUpTripped: (state: RuntimeState) => boolean;
}

/* ==================================================================== 2. events */

export type SessionEvent =
  | { readonly type: 'showTips' }
  | { readonly type: 'tipsContinue' }
  | { readonly type: 'rendered' }
  | {
      readonly type: 'input';
      readonly text: string;
      readonly caret: number;
      readonly partialState: Readonly<Record<string, unknown>>;
      readonly gradeable: boolean;
    }
  | { readonly type: 'audioInterrupted' }
  | { readonly type: 'audioCompleted' }
  | { readonly type: 'setInputMode'; readonly mode: InputMode }
  | { readonly type: 'check' }
  | { readonly type: 'graded' }
  | { readonly type: 'skip' }
  | { readonly type: 'strokeRejections'; readonly count: number }
  | { readonly type: 'continue' }
  | { readonly type: 'exit'; readonly route: ExitRoute }
  | { readonly type: 'keepLearning' }
  | { readonly type: 'endSession'; readonly route: ExitRoute };

export interface StepResult {
  readonly state: RuntimeState;
  readonly writes: readonly ProgressWrite[];
  /** Non-null when the player must pop back to the path. */
  readonly exit: { readonly route: ExitRoute; readonly reason: 'quit' | 'immediate' } | null;
}

/* ==================================================================== 3. helpers */

function currentItem(state: RuntimeState): QueuedItem | null {
  if (state.currentReplay !== null) return state.currentReplay.item;
  return state.core.queue[state.core.index] ?? null;
}

function mainDrained(state: RuntimeState): boolean {
  return state.core.index >= state.core.queue.length;
}

function bannerFor(verdict: Verdict): ShellState {
  switch (verdict.kind) {
    case 'wrong':
      return 'banner.wrong';
    case 'softCorrect':
      return 'banner.softCorrect';
    default:
      return 'banner.correct';
  }
}

/**
 * INV-SESS-20. The learner's explicit session preference WINS over hard mode's typed
 * default; a hard item never overwrites or clears the stored `inputMode`; and on a
 * non-Latin pack hard mode never changes the input default at all.
 */
export function effectiveInputMode(state: RuntimeState, hard: boolean): InputMode {
  if (state.inputModeExplicit) return state.core.inputMode;
  if (hard && !state.packNonLatinScript) return 'keyboard';
  return state.core.inputMode;
}

function withCore(state: RuntimeState, core: Partial<RuntimeState['core']>): RuntimeState {
  return { ...state, core: { ...state.core, ...core } };
}

/* ===================================================================== 4. step */

export function step(state: RuntimeState, event: SessionEvent, deps: StepDeps): StepResult {
  const none: StepResult = { state, writes: [], exit: null };
  if (state.exited !== null) return none;

  switch (event.type) {
    case 'showTips':
      return { state: { ...state, shellState: 'tips' }, writes: [], exit: null };

    case 'tipsContinue':
      // INV-SESS-22: leaving `tips` writes zero rows of any kind.
      return { state: { ...state, shellState: 'loading' }, writes: [], exit: null };

    case 'rendered': {
      if (state.shellState !== 'loading') return none;
      if (mainDrained(state) && !hasPendingMistake(state.mistakes)) {
        return complete(state);
      }
      return { state: mark(state, 'challenge.idle', deps), writes: [], exit: null };
    }

    case 'input': {
      if (state.shellState !== 'challenge.idle' && state.shellState !== 'challenge.armed') {
        return none;
      }
      const inFlight = {
        ...state.inFlight,
        text: event.text,
        caret: event.caret,
        partialState: event.partialState,
      };
      const item = currentItem(state);
      // INV-SESS-24: CHECK stays disabled until the clip completes again.
      const audioOk =
        item === null || !exerciseSpec(item.type).requiresAudio || inFlight.audioHeardToEnd;
      const next: ShellState = event.gradeable && audioOk ? 'challenge.armed' : 'challenge.idle';
      return { state: mark({ ...state, inFlight }, next, deps), writes: [], exit: null };
    }

    case 'audioCompleted': {
      const inFlight = { ...state.inFlight, audioHeardToEnd: true };
      return { state: { ...state, inFlight }, writes: [], exit: null };
    }

    case 'audioInterrupted': {
      // INV-SESS-24: reset the has-been-heard flag, and preserve the typed buffer and
      // caret BYTE-IDENTICALLY. Only the flag moves.
      if (state.shellState !== 'challenge.idle' && state.shellState !== 'challenge.armed') {
        return none;
      }
      const inFlight = { ...state.inFlight, audioHeardToEnd: false };
      return {
        state: mark({ ...state, inFlight }, 'challenge.idle', deps),
        writes: [],
        exit: null,
      };
    }

    case 'setInputMode':
      // INV-SESS-20: this is the ONLY writer of `core.inputMode`.
      return {
        state: withCore({ ...state, inputModeExplicit: true }, { inputMode: event.mode }),
        writes: [],
        exit: null,
      };

    case 'check': {
      if (state.shellState !== 'challenge.armed') return none;
      return { state: mark(state, 'grading', deps), writes: [], exit: null };
    }

    case 'graded':
      return grade(state, deps);

    case 'strokeRejections': {
      // INV-MIS-08: a weak-item row, never a mistake row.
      const item = currentItem(state);
      if (item === null) return none;
      const row = weakItemFor(item, state.courseId, event.count);
      if (row === null) return none;
      return {
        state: { ...state, weakItemRows: [...state.weakItemRows, row] },
        writes: [],
        exit: null,
      };
    }

    case 'skip':
      return skip(state, deps);

    case 'continue': {
      if (state.shellState === 'interstitial') {
        const [, ...rest] = state.pendingInterstitialKeys;
        if (rest.length > 0) {
          return {
            state: { ...state, pendingInterstitialKeys: rest, shellState: 'interstitial' },
            writes: [],
            exit: null,
          };
        }
        // NOT `route` again: `route` already advanced the index when it queued these
        // screens. Dismissing the last one resumes where that left off.
        return continueAfterInterstitials({ ...state, pendingInterstitialKeys: [] }, deps);
      }
      if (state.shellState === 'mistakeReview') return serveReplay(state, deps);
      if (
        state.shellState === 'banner.correct' ||
        state.shellState === 'banner.softCorrect' ||
        state.shellState === 'banner.wrong'
      ) {
        return route(state, deps);
      }
      return none;
    }

    case 'exit': {
      // INV-SESS-14 / INV-SESS-25: EVERY route lands here. No route has its own path.
      const decision = quitDecision(state);
      if (decision.kind === 'exitImmediately') {
        // INV-SESS-12: zero rows of any kind.
        return {
          state: { ...state, exited: 'quit' },
          writes: decision.writes,
          exit: { route: event.route, reason: 'immediate' },
        };
      }
      return { state: mark(state, 'quitDialog', deps), writes: [], exit: null };
    }

    case 'keepLearning': {
      if (state.shellState !== 'quitDialog') return none;
      // Armed-ness is recomputed from the restored input, so KEEP LEARNING never needs a
      // remembered sub-state that a kill could lose.
      return { state: mark(state, 'challenge.idle', deps), writes: [], exit: null };
    }

    case 'endSession': {
      const commit = quitCommit({
        state,
        config: deps.config,
        route: event.route,
        mistakeRows: state.mistakeRows,
        weakItemRows: state.weakItemRows,
      });
      return {
        state: { ...state, exited: 'quit' },
        writes: commit.writes,
        exit: { route: event.route, reason: 'quit' },
      };
    }
  }
}

/* ================================================================ 5. sub-steps */

/** Checkpoint at the boundary and stamp the new shell state (INV-SESS-01/04). */
function mark(state: RuntimeState, shellState: ShellState, deps: StepDeps): RuntimeState {
  return { ...checkpoint(state, deps.clock.nowMs()), shellState } as RuntimeState;
}

function grade(state: RuntimeState, deps: StepDeps): StepResult {
  if (state.shellState !== 'grading') return { state, writes: [], exit: null };
  const item = currentItem(state);
  if (item === null) return { state, writes: [], exit: null };

  const exerciseIndex =
    state.currentReplay !== null ? -1 - state.core.answers.length : state.core.index;
  // INV-SESS-15: a heart already paid is never charged twice. An answer already recorded
  // for this index makes the whole grade a no-op.
  if (state.core.answers.some((a) => a.exerciseIndex === exerciseIndex)) {
    return { state, writes: [], exit: null };
  }

  const verdict = deps.grading.grade({
    item,
    raw: state.inFlight.text,
    partialState: state.inFlight.partialState,
    hardMode: state.core.hardMode,
  });

  const spec = exerciseSpec(item.type);
  const wrong = verdict.kind === 'wrong';
  const cost =
    wrong && spec.punitive ? (spec.heartCost === 'perWrongPair' ? 1 : spec.heartCost) : 0;
  const hearts: Allowance = spendAllowance(state.core.hearts, cost);

  const answer: Answer = {
    exerciseIndex,
    slotId: item.id,
    itemId: item.itemId,
    type: item.type,
    verdict: verdict.kind,
    softCorrected: verdict.kind === 'softCorrect',
    wrong,
    costPaid: cost,
    skipped: false,
    scorable: spec.scorable,
    queue: state.currentReplay !== null ? 'mistakes' : 'main',
  };

  // INV-COM-01: exactly one increment per EXERCISE.
  const combo = comboAfter(state.core.combo, answer);

  let mistakes = state.mistakes;
  let mistakeRows = state.mistakeRows;
  if (state.currentReplay !== null) {
    // The served replay is the head of the queue (serveReplay put it there). A correct
    // answer advances it toward retirement; a wrong one re-queues it while budget remains.
    const [servedHead, ...rest] = state.mistakes;
    if (servedHead !== undefined) {
      mistakes = afterMistakeReplay(servedHead, rest, !wrong);
    }
  } else if (wrong) {
    // INV-GRD-04: a soft-correct never creates a mistake row — `wrong` is the only gate.
    mistakes = queueMistake({ config: deps.config, item, queue: state.mistakes });
    if (mistakes !== state.mistakes) {
      mistakeRows = [
        ...mistakeRows,
        {
          itemId: item.itemId,
          courseId: state.courseId,
          conceptId: item.conceptId,
          createdInSessionId: state.sessionId,
          reviewStreak: 0,
        },
      ];
    }
  }

  const outstanding = mistakes.filter((m) => m.servesRemaining > 0).length;
  const progress = advanceProgress(state.progress, answer, outstanding);

  const next: RuntimeState = {
    ...withCore(state, {
      answers: [...state.core.answers, answer],
      hearts,
      combo,
    }),
    mistakes,
    mistakeRows,
    progress,
  };

  const shell = allowanceRemaining(hearts) <= 0 && wrong ? 'outOfHearts' : bannerFor(verdict);
  return { state: mark(next, shell, deps), writes: [], exit: null };
}

function skip(state: RuntimeState, deps: StepDeps): StepResult {
  const item = currentItem(state);
  if (item === null) return { state, writes: [], exit: null };
  const spec = exerciseSpec(item.type);
  const answer: Answer = {
    exerciseIndex: state.core.index,
    slotId: item.id,
    itemId: item.itemId,
    type: item.type,
    verdict: 'noVerdict',
    softCorrected: false,
    wrong: false,
    costPaid: 0,
    skipped: true,
    // INV-GRD-06: a skipped speaking/listening item is out of the denominator.
    scorable: false,
    queue: state.currentReplay !== null ? 'mistakes' : 'main',
  };
  void spec;
  // INV-COM-10: no mistake row, no combo break, no progress segment.
  const next = withCore(state, { answers: [...state.core.answers, answer] });
  return route(next, deps);
}

/** Where the session goes after a banner or an interstitial is dismissed. */
function route(state: RuntimeState, deps: StepDeps): StepResult {
  const outstanding = state.mistakes.filter((m) => m.servesRemaining > 0).length;
  const drained =
    state.currentReplay === null ? mainDrained(advanceIndex(state)) : mainDrained(state);

  const screens = emitInterstitials({
    config: deps.config,
    combo: state.core.combo,
    motivationalMessages: state.motivationalMessages,
    usedInterstitialKeys: state.core.usedInterstitialKeys,
    stepUpTripped: deps.stepUpTripped(state),
    stepUpAlreadyFired: state.stepUpFired,
    mistakesPending: outstanding,
    mainQueueDrained: drained,
  }).filter((s) => s.producer !== 'mistakeReview');

  const advanced =
    state.currentReplay === null ? advanceIndex(state) : { ...state, currentReplay: null };

  if (screens.length > 0) {
    const keys = screens.map((s) => s.key);
    const stepUp = screens.some((s) => s.producer === 'stepUp');
    const next: RuntimeState = {
      ...withCore(advanced, {
        usedInterstitialKeys: [...advanced.core.usedInterstitialKeys, ...keys],
        // The step-up card announces a rule change to the NEXT exercise (EC-COM-10).
        hardMode: stepUp ? true : advanced.core.hardMode,
      }),
      stepUpFired: advanced.stepUpFired || stepUp,
      pendingInterstitialKeys: keys,
    };
    return { state: mark(next, 'interstitial', deps), writes: [], exit: null };
  }

  return continueAfterInterstitials(advanced, deps);
}

function advanceIndex(state: RuntimeState): RuntimeState {
  return withCore(state, { index: state.core.index + 1 });
}

function continueAfterInterstitials(state: RuntimeState, deps: StepDeps): StepResult {
  if (!mainDrained(state)) {
    return { state: mark(freshChallenge(state), 'challenge.idle', deps), writes: [], exit: null };
  }
  if (hasPendingMistake(state.mistakes)) {
    return { state: mark(state, 'mistakeReview', deps), writes: [], exit: null };
  }
  return complete(state);
}

function freshChallenge(state: RuntimeState): RuntimeState {
  return { ...state, inFlight: EMPTY_IN_FLIGHT };
}

/** Serve the next replay: the recycle ladder is TOTAL and always yields an item. */
function serveReplay(state: RuntimeState, deps: StepDeps): StepResult {
  const served = serveNextMistake(state.mistakes);
  if (served === null) return complete(state);
  const phase: RecyclePhase = served.served.recyclesServed === 0 ? 'midLesson' : 'end';
  const target = recycleTarget(served.served, phase, deps.isTypeEligible);
  const original = state.core.queue.find((q) => q.itemId === served.served.itemId);
  const item: QueuedItem = {
    id: `${served.served.slotId}#replay${served.served.recyclesServed}`,
    // INV-MIS-07: the recycle PRESERVES the missed item's id for FSRS.
    itemId: served.served.itemId,
    type: target.type,
    family: original?.family ?? 'recognition',
    conceptId: original?.conceptId ?? served.served.itemId,
    nodeRef: state.nodeRef,
    requiresAudio: false,
  };
  const next: RuntimeState = {
    ...freshChallenge(state),
    mistakes: [served.served, ...served.rest],
    currentReplay: { item, phase },
  };
  return { state: mark(next, 'challenge.idle', deps), writes: [], exit: null };
}

function complete(state: RuntimeState): StepResult {
  // INV-SESS-18: the reserved final segment is consumed EXACTLY ONCE.
  // INV-SESS-19: `hardMode` is cleared on entry to `complete`; it is session-scoped and a
  // leaked flag would silently change grading for the rest of the day.
  const next: RuntimeState = {
    ...withCore(state, { hardMode: false }),
    progress: consumeFinalSegment(state.progress),
    shellState: 'complete',
    currentReplay: null,
  };
  return { state: next, writes: [], exit: null };
}
