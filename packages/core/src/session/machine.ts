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
 *
 * Totality is not enough on its own, and a refuter proved it: `skip` and
 * `strokeRejections` used to carry no shell-state guard, so a `skip` fired at a banner
 * appended a SECOND answer for an index that already had one — two attempt rows on the
 * key INV-SCH-03 writes. EVERY event now guards, and the INV-SESS-22 property asserts the
 * attempt ledger stays injective on `exerciseIndex` and that the index only ever advances
 * out of a state that was showing a challenge or its banner.
 */
import type { SessionFlavourConfig } from './flavours.js';
import type {
  Allowance,
  Answer,
  ExerciseType,
  ExitRoute,
  InputMode,
  ProgressWrite,
  QueuedItem,
  QueuedMistake,
  ShellState,
  Verdict,
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
  midLessonRecycleDue,
  queueMistake,
  recycleTarget,
  serveMistake,
  weakItemFor,
} from './mistakes.js';
import { emitInterstitials } from './interstitials.js';
import type { GradingPort, MonotonicClock } from './ports.js';
import { completionCommit, quitCommit, quitDecision } from './quit.js';

/* ============================================================== 1. runtime state */

/**
 * The runtime state IS the persisted row.
 *
 * There is deliberately no second type. An earlier shape kept `currentReplay`,
 * `mistakeRows`, `weakItemRows`, `inputModeExplicit` and `packNonLatinScript` on a
 * runtime-only object while the DECLARED row carried none of them; the tests serialised
 * the runtime object and so never noticed that a real writer would drop the in-flight
 * replay and every durable mistake. `resume.ts` now owns one interface, one declared
 * field list and a compile-time proof the list covers it.
 */
export type RuntimeState = SessionState;

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

/** The interstitial key S049's screen is queued under. */
export const MISTAKE_REVIEW_KEY = 'mistakeReview';

/**
 * The shell state a queued interstitial key renders as.
 *
 * S029 declares BOTH `interstitial` and `mistakeReview`, so the mistake-review screen is
 * not a second `interstitial`: it is the declared state, carrying S049's plural-aware
 * copy key on `state.mistakeReviewCopyKey`. One queue, two renderings — which is what
 * INV-COM-08 ("all producers emit into ONE queue") asks for, and why `route()` no longer
 * filters the producer out.
 */
function shellForKey(key: string): ShellState {
  return key === MISTAKE_REVIEW_KEY ? 'mistakeReview' : 'interstitial';
}

/** The states in which a challenge (or a replay) is on screen awaiting an answer. */
function isChallengeState(shell: ShellState): boolean {
  return shell === 'challenge.idle' || shell === 'challenge.armed';
}

function isBannerState(shell: ShellState): boolean {
  return (
    shell === 'banner.correct' || shell === 'banner.softCorrect' || shell === 'banner.wrong'
  );
}

function currentItem(state: RuntimeState): QueuedItem | null {
  if (state.currentReplay !== null) return state.currentReplay.item;
  return state.core.queue[state.core.index] ?? null;
}

function mainDrained(state: RuntimeState): boolean {
  return state.core.index >= state.core.queue.length;
}

/** Answers served from the MAIN queue. The mid-lesson recycle gap counts these. */
function mainAnswerCount(state: RuntimeState): number {
  return state.core.answers.filter((a) => a.queue === 'main').length;
}

function pendingCount(queue: readonly QueuedMistake[]): number {
  return queue.filter((m) => m.servesRemaining > 0).length;
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

/**
 * Is a replay owed RIGHT NOW, and in which phase?
 *
 * `midLesson` while main-queue items remain and a miss has aged `midLessonRecycleGap`
 * further main answers; `end` once the main queue is drained and anything is still
 * pending. The phase names a POSITION, and the format follows from it (`recycleTarget`):
 * a different format mid-lesson, the original at the end (S049).
 */
function replayDue(state: RuntimeState, deps: StepDeps): RecyclePhase | null {
  if (mainDrained(state)) return hasPendingMistake(state.mistakes) ? 'end' : null;
  const due = midLessonRecycleDue(
    state.mistakes,
    mainAnswerCount(state),
    deps.config.midLessonRecycleGap,
  );
  return due === null ? null : 'midLesson';
}

/* ===================================================================== 4. step */

export function step(state: RuntimeState, event: SessionEvent, deps: StepDeps): StepResult {
  const none: StepResult = { state, writes: [], exit: null };
  if (state.exited !== null) return none;

  switch (event.type) {
    case 'showTips':
      if (state.shellState !== 'loading' && !isChallengeState(state.shellState)) return none;
      return { state: { ...state, shellState: 'tips' }, writes: [], exit: null };

    case 'tipsContinue':
      // INV-SESS-22: leaving `tips` writes zero rows of any kind.
      if (state.shellState !== 'tips') return none;
      return { state: { ...state, shellState: 'loading' }, writes: [], exit: null };

    case 'rendered': {
      if (state.shellState !== 'loading') return none;
      if (replayDue(state, deps) !== null) return serveReplay(state, deps);
      if (mainDrained(state)) return complete(state, deps);
      return { state: mark(state, 'challenge.idle', deps), writes: [], exit: null };
    }

    case 'input': {
      if (!isChallengeState(state.shellState)) return none;
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
      if (!isChallengeState(state.shellState)) return none;
      const inFlight = { ...state.inFlight, audioHeardToEnd: true };
      return { state: { ...state, inFlight }, writes: [], exit: null };
    }

    case 'audioInterrupted': {
      // INV-SESS-24: reset the has-been-heard flag, and preserve the typed buffer and
      // caret BYTE-IDENTICALLY. Only the flag moves.
      if (!isChallengeState(state.shellState)) return none;
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
      // INV-MIS-08: a weak-item row, never a mistake row. Guarded like everything else:
      // strokes only arrive while a challenge is on screen.
      if (!isChallengeState(state.shellState)) return none;
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

    case 'skip': {
      // The guard a refuter proved missing: `graded → skip` used to append a second
      // answer at an index that already had one.
      if (!isChallengeState(state.shellState)) return none;
      return skip(state, deps);
    }

    case 'continue': {
      if (state.shellState === 'mistakeReview') {
        // S049's screen was the head of the queue; dismissing it serves the replay.
        return serveReplay(
          { ...state, pendingInterstitialKeys: [], mistakeReviewCopyKey: null },
          deps,
        );
      }
      if (state.shellState === 'interstitial') {
        const [, ...rest] = state.pendingInterstitialKeys;
        const head = rest[0];
        if (head !== undefined) {
          return {
            state: mark({ ...state, pendingInterstitialKeys: rest }, shellForKey(head), deps),
            writes: [],
            exit: null,
          };
        }
        // NOT `route` again: `route` already advanced the index when it queued these
        // screens. Dismissing the last one resumes where that left off.
        return continueAfterInterstitials({ ...state, pendingInterstitialKeys: [] }, deps);
      }
      if (isBannerState(state.shellState)) return route(state, deps);
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
  return { ...checkpoint(state, deps.clock.nowMs()), shellState };
}

/** The attempt-ledger key. Replays get a negative index so `main` indices stay injective. */
function exerciseIndexFor(state: RuntimeState): number {
  return state.currentReplay !== null ? -1 - state.core.answers.length : state.core.index;
}

function grade(state: RuntimeState, deps: StepDeps): StepResult {
  if (state.shellState !== 'grading') return { state, writes: [], exit: null };
  const item = currentItem(state);
  if (item === null) return { state, writes: [], exit: null };

  const exerciseIndex = exerciseIndexFor(state);
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

  // INV-COM-09 / EC-COM-12: the tier-2 note is CORRECTIVE information and wins the banner
  // headline, so it rides the answer AND the row. Dropping it here — which is what the
  // previous cut did — restores `banner.softCorrect` with an empty headline.
  const note = verdict.note ?? null;

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
    note,
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
    mistakes = queueMistake({
      config: deps.config,
      item,
      queue: state.mistakes,
      mainAnswersAtMiss: mainAnswerCount(state) + 1,
    });
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

  const progress = advanceProgress(state.progress, answer, pendingCount(mistakes));

  const next: RuntimeState = {
    ...withCore(state, {
      answers: [...state.core.answers, answer],
      hearts,
      combo,
    }),
    mistakes,
    mistakeRows,
    progress,
    lastVerdict: { kind: verdict.kind, note },
  };

  const shell = allowanceRemaining(hearts) <= 0 && wrong ? 'outOfHearts' : bannerFor(verdict);
  return { state: mark(next, shell, deps), writes: [], exit: null };
}

function skip(state: RuntimeState, deps: StepDeps): StepResult {
  const item = currentItem(state);
  if (item === null) return { state, writes: [], exit: null };
  const exerciseIndex = exerciseIndexFor(state);
  if (state.core.answers.some((a) => a.exerciseIndex === exerciseIndex)) {
    return { state, writes: [], exit: null };
  }
  const answer: Answer = {
    exerciseIndex,
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
    note: null,
  };
  // A skipped REPLAY is not evidence of retention: the mistake is re-queued while budget
  // remains, exactly as a wrong replay would be. The serve was already spent, so the
  // termination measure still decreases (INV-MIS-02).
  let mistakes = state.mistakes;
  if (state.currentReplay !== null) {
    const [servedHead, ...rest] = state.mistakes;
    if (servedHead !== undefined) mistakes = afterMistakeReplay(servedHead, rest, false);
  }
  // INV-COM-10: no mistake row, no combo break, no progress segment.
  const next: RuntimeState = {
    ...withCore(state, { answers: [...state.core.answers, answer] }),
    mistakes,
  };
  return route(next, deps);
}

/** Where the session goes after a banner or a skip. */
function route(state: RuntimeState, deps: StepDeps): StepResult {
  // Commit the answer's position first: either the replay just answered is released, or
  // the main index advances past the item just answered.
  const advanced: RuntimeState =
    state.currentReplay === null ? advanceIndex(state) : { ...state, currentReplay: null };

  const outstanding = pendingCount(advanced.mistakes);
  const due = replayDue(advanced, deps);
  // The end-of-queue block announces itself ONCE. A mid-lesson replay is a single item
  // coming back on its own, and S049's singular copy is written for exactly that, so it
  // announces itself each time.
  const announce = due !== null && (due === 'midLesson' || !advanced.endReviewIntroShown);

  const screens = emitInterstitials({
    config: deps.config,
    combo: advanced.core.combo,
    motivationalMessages: advanced.motivationalMessages,
    usedInterstitialKeys: advanced.core.usedInterstitialKeys,
    stepUpTripped: deps.stepUpTripped(state),
    stepUpAlreadyFired: advanced.stepUpFired,
    mistakesPending: due === 'midLesson' ? 1 : outstanding,
    mistakeReviewDue: announce,
  });

  if (screens.length === 0) return continueAfterInterstitials(advanced, deps);

  const stepUp = screens.some((s) => s.producer === 'stepUp');
  const review = screens.find((s) => s.producer === 'mistakeReview') ?? null;
  // `usedInterstitialKeys` is the nine-field record of COPY ALREADY SHOWN from a finite
  // pool. The mistake-review screen is not drawn from one — it fires once per review
  // block by design — so it is tracked by the queue, not by that list.
  const usedKeys = screens.filter((s) => s.producer !== 'mistakeReview').map((s) => s.key);
  const keys = screens.map((s) => s.key);
  const next: RuntimeState = {
    ...withCore(advanced, {
      usedInterstitialKeys: [...advanced.core.usedInterstitialKeys, ...usedKeys],
      // The step-up card announces a rule change to the NEXT exercise (EC-COM-10).
      hardMode: stepUp ? true : advanced.core.hardMode,
    }),
    stepUpFired: advanced.stepUpFired || stepUp,
    pendingInterstitialKeys: keys,
    mistakeReviewCopyKey: review === null ? null : review.copyKey,
    endReviewIntroShown: advanced.endReviewIntroShown || (review !== null && due === 'end'),
  };
  return { state: mark(next, shellForKey(keys[0]!), deps), writes: [], exit: null };
}

function advanceIndex(state: RuntimeState): RuntimeState {
  return withCore(state, { index: state.core.index + 1 });
}

function continueAfterInterstitials(state: RuntimeState, deps: StepDeps): StepResult {
  if (replayDue(state, deps) !== null) return serveReplay(state, deps);
  if (!mainDrained(state)) {
    return { state: mark(freshChallenge(state), 'challenge.idle', deps), writes: [], exit: null };
  }
  return complete(state, deps);
}

function freshChallenge(state: RuntimeState): RuntimeState {
  return { ...state, inFlight: EMPTY_IN_FLIGHT };
}

/**
 * Serve the next replay. The recycle ladder is TOTAL and always yields an item
 * (INV-MIS-06), and the PHASE is the position: mid-lesson while main items remain, end
 * once they do not.
 */
function serveReplay(state: RuntimeState, deps: StepDeps): StepResult {
  const phase: RecyclePhase = mainDrained(state) ? 'end' : 'midLesson';
  const gap = deps.config.midLessonRecycleGap;
  const answers = mainAnswerCount(state);
  const pick =
    phase === 'midLesson'
      ? (m: QueuedMistake) => m.recyclesServed === 0 && answers - m.queuedAtMainAnswers >= gap
      : () => true;
  const served = serveMistake(state.mistakes, pick);
  if (served === null) {
    if (mainDrained(state)) return complete(state, deps);
    return { state: mark(freshChallenge(state), 'challenge.idle', deps), writes: [], exit: null };
  }
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
    mistakeReviewCopyKey: null,
  };
  return { state: mark(next, 'challenge.idle', deps), writes: [], exit: null };
}

/**
 * The end of the session — and the ONLY place the completion writes are produced.
 *
 * A refuter caught this returning `writes: []`: a lesson played to `complete` wrote no
 * attempt, no session row, no day reward, and never deleted its `session_state` row, so
 * the next launch offered RESUME on a finished lesson. `completionCommit` is now wired,
 * and `machine.test.ts` drives `step` all the way to `complete` and asserts the
 * `sessionStateDelete` for `keyOf(state)` is among the writes.
 *
 * INV-SESS-18: the reserved final segment is consumed EXACTLY ONCE.
 * INV-SESS-19: `hardMode` is cleared on entry to `complete`; it is session-scoped and a
 * leaked flag would silently change grading for the rest of the day.
 * INV-SESS-23: `completionCommit` itself gates the session row and the day-keyed reward
 * on the graded-attempt count, so a zero-graded session still writes neither.
 */
function complete(state: RuntimeState, deps: StepDeps): StepResult {
  const next: RuntimeState = {
    ...withCore(state, { hardMode: false }),
    progress: consumeFinalSegment(state.progress),
    shellState: 'complete',
    currentReplay: null,
    pendingInterstitialKeys: [],
    mistakeReviewCopyKey: null,
    exited: 'complete',
  };
  const commit = completionCommit({
    state: next,
    config: deps.config,
    mistakeRows: next.mistakeRows,
    weakItemRows: next.weakItemRows,
  });
  return { state: next, writes: commit.writes, exit: null };
}
