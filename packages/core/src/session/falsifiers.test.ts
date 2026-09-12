/**
 * The committed falsifier inputs.
 *
 * Plan §P1 gate: "committed falsifier inputs per invariant". Every id this lane owns has a
 * file under `__falsifiers__/` carrying the CONCRETE input that breaks the invariant when
 * the implementation is wrong, plus the outcome the spec demands. `pnpm test:falsify`
 * (`vitest -t falsifier`) replays all of them.
 *
 * A falsifier file is not a second copy of a unit test: the property tests generate, these
 * replay the one shape the corpus actually recorded, so a regression names the edge case
 * it broke rather than a shrunk counterexample nobody recognises.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { generateSession, revalidateQueue } from './generate.js';
import { DEFAULT_FLAVOUR_MATRIX } from './flavours.js';
import {
  FixedAudio,
  FixedModality,
  FixedPack,
  RecordingScheduler,
  ScriptedGrading,
  TestMonotonicClock,
} from './test-doubles.js';
import { COURSE_A, freshSession, item, items } from './session-fixture.js';
import { barIsGold, comboAfter, comboLabelVisible } from './combo.js';
import { STEP_UP_COPY, emitInterstitials, isCanonicalInterstitialOrder } from './interstitials.js';
import { advanceProgress, consumeFinalSegment, initialProgress } from './progress.js';
import {
  afterMistakeReplay,
  applyEncounter,
  hasPendingMistake,
  pendingServes,
  queueMistake,
  recycleTarget,
  refilterAgainstLiveRows,
  serveNextMistake,
  weakItemFor,
} from './mistakes.js';
import {
  RESUME_FIELDS,
  canonicalJson,
  keyOf,
  checkpoint,
  coldStartRoute,
  deserialiseSession,
  monotonicAgeMs,
  resumeOffered,
  seedsOnResume,
  serialiseSession,
} from './resume.js';
import {
  InMemorySessionStore,
  applyStartOverExclusion,
  planStartOver,
  requestStart,
} from './store.js';
import { completionCommit, quitCommit, quitDecision } from './quit.js';
import { effectiveInputMode, step } from './machine.js';
import type { RuntimeState, StepDeps } from './machine.js';
import type { GradingPort } from './ports.js';
import { runForegroundBoot } from './boot.js';
import type { BootPort } from './ports.js';
import { EXERCISE_REGISTRY, NEVER_A_RECYCLE_TARGET, emittableExerciseTypes } from './registry.js';
import { DECLARED_SHELL_STATES } from './types.js';
import type {
  Answer,
  ExerciseType,
  ExitRoute,
  ItemFamily,
  MistakeRow,
  QueuedItem,
  QueuedMistake,
  SessionFlavour,
  SessionKind,
  VerdictKind,
} from './types.js';
import { MAX_SERVES_PER_MISTAKE } from './mistakes.js';

const DIR = fileURLToPath(new URL('./__falsifiers__/', import.meta.url));

interface Falsifier {
  readonly id: string;
  readonly case: string;
  readonly kind: string;
  readonly input: Record<string, unknown>;
  readonly expect: Record<string, unknown>;
}

/** Every id this task must turn green; the guard below fails if one has no file. */
const OWNED_IDS: readonly string[] = [
  ...Array.from({ length: 27 }, (_, i) => `INV-SESS-${String(i + 1).padStart(2, '0')}`),
  ...[1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12].map((n) => `INV-COM-${String(n).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, i) => `INV-MIS-${String(i + 1).padStart(2, '0')}`),
  'INV-AUD-01',
  'INV-PACK-05',
  'INV-PACK-19',
];

function deps(over: Partial<StepDeps> = {}): StepDeps {
  return {
    config: DEFAULT_FLAVOUR_MATRIX.lesson,
    grading: new ScriptedGrading(),
    clock: new TestMonotonicClock(),
    isTypeEligible: () => true,
    stepUpTripped: () => false,
    ...over,
  };
}

function answer(
  i: number,
  verdict: VerdictKind,
  type: ExerciseType = 'meaningSelect',
  skipped = false,
): Answer {
  return {
    exerciseIndex: i,
    slotId: `slot-${i + 1}`,
    itemId: `item-${i + 1}`,
    type,
    verdict,
    softCorrected: verdict === 'softCorrect',
    wrong: verdict === 'wrong',
    costPaid: verdict === 'wrong' ? 1 : 0,
    skipped,
    scorable: !skipped,
    queue: 'main',
    note: null,
  };
}

const VERDICT: Record<string, VerdictKind> = { c: 'correct', w: 'wrong', s: 'softCorrect' };

function mistakeOf(id: string): QueuedMistake {
  return {
    itemId: id,
    slotId: `slot-${id}`,
    originalType: 'meaningSelect',
    servesRemaining: MAX_SERVES_PER_MISTAKE,
    recyclesServed: 0,
    queuedAtMainAnswers: 0,
  };
}

/** Drive a whole session to `complete` with a scripted grader. */
/** Is a challenge on screen, i.e. can the answer script proceed? */
function isAnswerable(state: RuntimeState): boolean {
  return (
    state.shellState === 'challenge.idle' ||
    state.shellState === 'challenge.armed' ||
    state.shellState === 'complete'
  );
}

function runToComplete(start: RuntimeState, d: StepDeps): RuntimeState {
  let state = step(start, { type: 'rendered' }, d).state;
  for (let guard = 0; guard < 400 && state.shellState !== 'complete'; guard += 1) {
    state = step(
      state,
      { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
      d,
    ).state;
    state = step(state, { type: 'check' }, d).state;
    state = step(state, { type: 'graded' }, d).state;
    state = step(state, { type: 'continue' }, d).state;
  }
  return state;
}

/* ======================================================== the handler table */

type Handler = (input: Record<string, unknown>) => Record<string, unknown>;

const HANDLERS: Record<string, Handler> = {
  generate(input: Record<string, unknown>) {
    const count = input.candidateCount as number;
    const distinct = input.distinctItems as number;
    const audioEvery = (input.audioEvery as number | undefined) ?? 0;
    const candidates: QueuedItem[] = Array.from({ length: count }, (_, i) => ({
      ...item((i % distinct) + 1, {
        type:
          audioEvery > 0 && (i + 1) % audioEvery === 0 ? 'listenTapWhatYouHear' : 'meaningSelect',
        conceptId: `concept-${(i % distinct) + 1}`,
      }),
      id: `slot-${i + 1}`,
    }));
    const audioMissing = input.audioMissingAll
      ? candidates.filter((c) => c.requiresAudio).map((c) => c.itemId)
      : [];
    const result = generateSession({
      sessionId: 'session-1',
      courseId: COURSE_A,
      nodeRef: 'node-1',
      flavour: input.flavour as SessionFlavour,
      candidates,
      audio: new FixedAudio(audioMissing),
      pack: new FixedPack({ missingAssets: (input.missingAssets as string[] | undefined) ?? [] }),
      modality: new FixedModality(
        ((input.gated as ItemFamily[] | undefined) ?? []) as ItemFamily[],
      ),
      scheduler: new RecordingScheduler(),
      seed: 11,
    });
    let adjacent = 0;
    for (let i = 1; i < result.queue.length; i += 1) {
      if (result.queue[i]!.itemId === result.queue[i - 1]!.itemId) adjacent += 1;
    }
    const gated = new Set(((input.gated as ItemFamily[] | undefined) ?? []) as ItemFamily[]);
    const out: Record<string, unknown> = {
      offered: result.offered,
      adjacentRepeats: adjacent,
      // Nothing may enter the queue that was neither a candidate nor in the due pool.
      paddedFromElsewhere: result.queue.filter((q) => !candidates.some((c) => c.id === q.id))
        .length,
    };
    if ('audioMissingAll' in input) {
      out.unplayableQueued = result.queue.filter(
        (q) => q.requiresAudio && audioMissing.includes(q.itemId),
      ).length;
    }
    if ('missingAssets' in input) out.aborted = !result.offered;
    if ('gated' in input) out.gatedQueued = result.queue.filter((q) => gated.has(q.family)).length;
    return out;
  },

  revalidate(input: Record<string, unknown>) {
    const result = revalidateQueue(items(input.queue as number), input.index as number, {
      gatedFamilies: (input.gated as ItemFamily[]) ?? [],
      pack: new FixedPack({ unresolved: (input.unresolved as string[]) ?? [] }),
      audio: new FixedAudio(),
      substitutes: [],
    });
    return {
      resumable: result.resumable,
      removed: [...result.removed],
      length: result.queue.length,
    };
  },

  combo(input: Record<string, unknown>) {
    const verdicts = (input.verdicts as string[]) ?? [];
    let combo = 0;
    for (const v of verdicts) {
      if (v === 'skip') {
        combo = comboAfter(combo, answer(0, 'noVerdict', 'speakSentence', true));
      } else if (v === 'match5') {
        // Five pairs cleared in one exercise: ONE increment, not five.
        combo = comboAfter(combo, answer(0, 'correct', 'matchPairs'));
      } else {
        combo = comboAfter(combo, answer(0, VERDICT[v]!));
      }
    }
    if (input.thenReplay !== undefined) {
      combo = comboAfter(combo, {
        ...answer(0, VERDICT[input.thenReplay as string]!),
        queue: 'mistakes',
        note: null,
      });
    }
    return { combo, gold: barIsGold(combo), label: comboLabelVisible(combo) };
  },

  interstitials(input: Record<string, unknown>) {
    const run = input.correctRun as number;
    const stepUpAt = input.stepUpAt as number | undefined;
    let combo = 0;
    let used: string[] = [];
    const copies: string[] = [];
    let stepUps = 0;
    let stepUpFired = false;
    for (let i = 0; i < run; i += 1) {
      combo = comboAfter(combo, answer(i, 'correct'));
      const screens = emitInterstitials({
        config: DEFAULT_FLAVOUR_MATRIX.lesson,
        combo,
        motivationalMessages: input.motivationalMessages as boolean,
        usedInterstitialKeys: used,
        stepUpTripped: stepUpAt !== undefined && combo === stepUpAt,
        stepUpAlreadyFired: stepUpFired,
        mistakesPending: 0,
        mistakeReviewDue: false,
      });
      for (const screen of screens) {
        used = [...used, screen.key];
        if (screen.producer === 'combo') copies.push(screen.copyKey);
        if (screen.producer === 'stepUp') {
          stepUps += 1;
          stepUpFired = true;
        }
      }
    }
    const out: Record<string, unknown> = {
      copies: copies.length,
      distinct: new Set(copies).size,
      nonComboCopies: copies.filter((c) => !c.startsWith('combo.')).length,
    };
    if (stepUpAt !== undefined) out.stepUps = stepUps;
    return out;
  },

  interstitialOrder(input: Record<string, unknown>) {
    const screens = emitInterstitials({
      config: DEFAULT_FLAVOUR_MATRIX.lesson,
      combo: input.combo as number,
      motivationalMessages: true,
      usedInterstitialKeys: [],
      stepUpTripped: (input.stepUpTripped as boolean) ?? false,
      stepUpAlreadyFired: (input.stepUpAlreadyFired as boolean) ?? false,
      mistakesPending: (input.mistakesPending as number) ?? 0,
      mistakeReviewDue: (input.mistakeReviewDue as boolean) ?? false,
    });
    return {
      producers: screens.map((s) => s.producer),
      canonicalOrder: isCanonicalInterstitialOrder(screens),
      copyKeys: screens.map((s) => s.copyKey),
    };
  },

  /**
   * INV-COM-12. The old shape of this falsifier asserted `stepUp === null ||
   * 'production'` over the ten shipped rows, which cannot fail while no row declares
   * `audio` — a refuter called it vacuous and was right. This drives BOTH kinds through
   * `emitInterstitials` with a synthetic config, so "the less-sound copy never appears
   * outside an audio flavour" is a statement about the CODE (the copy key is read from
   * `config.stepUp`), not about which rows happen to ship today.
   */
  stepUpCopy(input: Record<string, unknown>) {
    const base = {
      combo: input.combo as number,
      motivationalMessages: true,
      usedInterstitialKeys: [] as string[],
      stepUpTripped: input.stepUpTripped as boolean,
      mistakesPending: 0,
      mistakeReviewDue: false,
    };
    const alreadyFired = emitInterstitials({
      ...base,
      config: DEFAULT_FLAVOUR_MATRIX.lesson,
      stepUpAlreadyFired: input.stepUpAlreadyFired as boolean,
    });
    const firstTrip = emitInterstitials({
      ...base,
      config: DEFAULT_FLAVOUR_MATRIX.lesson,
      stepUpAlreadyFired: false,
    });
    const copyKeyPerStepUpKind: Record<string, string> = {};
    let audioCopyFromANonAudioConfig = 0;
    for (const kind of ['production', 'audio'] as const) {
      const screens = emitInterstitials({
        ...base,
        config: { ...DEFAULT_FLAVOUR_MATRIX.lesson, stepUp: kind },
        stepUpAlreadyFired: false,
      });
      const card = screens.find((s) => s.producer === 'stepUp')!;
      copyKeyPerStepUpKind[kind] = card.copyKey;
      if (kind !== 'audio' && card.copyKey === STEP_UP_COPY.audio) {
        audioCopyFromANonAudioConfig += 1;
      }
    }
    return {
      producersWhenAlreadyFired: alreadyFired.map((s) => s.producer),
      stepUpsWhenAlreadyFired: alreadyFired.filter((s) => s.producer === 'stepUp').length,
      stepUpsOnFirstTrip: firstTrip.filter((s) => s.producer === 'stepUp').length,
      copyKeyPerStepUpKind,
      // Recorded, not asserted-away: the audio-only hub flavours are P4, so no shipped
      // row declares `audio` yet. The two lines above are what keep the id honest.
      shippedFlavoursDeclaringAudio: Object.values(DEFAULT_FLAVOUR_MATRIX).filter(
        (c) => c.stepUp === 'audio',
      ).length,
      audioCopyFromANonAudioConfig,
    };
  },

  progress(input: Record<string, unknown>) {
    const length = input.length as number;
    let state = initialProgress(length);
    for (let i = 0; i < (input.correctBefore as number); i += 1) {
      state = advanceProgress(state, answer(i, 'correct'), input.wrong as number);
    }
    for (let i = 0; i < (input.wrong as number); i += 1) {
      state = advanceProgress(state, answer(i, 'wrong'), input.wrong as number);
    }
    const beforeComplete = state.numerator;
    for (let i = 0; i < (input.replays as number); i += 1) {
      state = advanceProgress(state, { ...answer(i, 'correct'), queue: 'mistakes' }, 1);
    }
    const once = consumeFinalSegment(state);
    const twice = consumeFinalSegment(once);
    return {
      denominator: state.denominator,
      numeratorBeforeComplete: beforeComplete,
      numeratorAtComplete: once.numerator,
      finalSegmentConsumedTwice: twice.numerator !== once.numerator,
    };
  },

  refilter(input: Record<string, unknown>) {
    const queued = (input.queued as string[]).map(mistakeOf);
    const live: MistakeRow[] = (input.live as string[]).map((id) => ({
      itemId: id,
      courseId: COURSE_A,
      conceptId: 'c',
      createdInSessionId: 'S1',
      reviewStreak: 0,
    }));
    const remaining = refilterAgainstLiveRows(queued, live);
    return { remaining: remaining.map((m) => m.itemId), pending: hasPendingMistake(remaining) };
  },

  mistakeDrain(input: Record<string, unknown>) {
    const verdicts = input.verdicts as boolean[];
    let queue: readonly QueuedMistake[] = Array.from({ length: input.count as number }, (_, i) =>
      mistakeOf(`m${i}`),
    );
    let serves = 0;
    let measure = pendingServes(queue);
    let decreasing = true;
    while (hasPendingMistake(queue)) {
      const served = serveNextMistake(queue)!;
      queue = afterMistakeReplay(served.served, served.rest, verdicts[serves % verdicts.length]!);
      serves += 1;
      const next = pendingServes(queue);
      if (next >= measure) decreasing = false;
      measure = next;
    }
    // NOTE: this handler is the TERMINATION measure only (INV-MIS-02). It deliberately
    // reports no `phases`: a phase is a POSITION in the session, and this harness has no
    // session — naming one here is how the previous cut came to record
    // `["midLesson","midLesson","end","end"]` for four serves that all ran after the main
    // queue had drained. INV-MIS-01's falsifier is `serveTrace`, driven through `step()`.
    return {
      serves,
      pendingAtEnd: hasPendingMistake(queue),
      measureStrictlyDecreasing: decreasing,
    };
  },

  queueMistake(input: Record<string, unknown>) {
    const repeat = (input.repeat as number | undefined) ?? 1;
    const queued = (input.flavours as SessionFlavour[]).map((flavour) => {
      let queue: readonly QueuedMistake[] = [];
      for (let i = 0; i < repeat; i += 1) {
        queue = queueMistake({
          config: DEFAULT_FLAVOUR_MATRIX[flavour],
          item: item(1, { type: input.type as ExerciseType }),
          queue,
          mainAnswersAtMiss: i + 1,
        });
      }
      return queue.length;
    });
    return { queued };
  },

  retire(input: Record<string, unknown>) {
    let row: MistakeRow = {
      itemId: 'a',
      courseId: COURSE_A,
      conceptId: 'c',
      createdInSessionId: 'S1',
      reviewStreak: 0,
    };
    let retired = false;
    for (const [sessionId, correct] of input.encounters as [string, boolean][]) {
      const result = applyEncounter({ row, sessionId, correct });
      row = result.row;
      retired = retired || result.retired;
    }
    return { retired, reviewStreak: row.reviewStreak };
  },

  recycle(input: Record<string, unknown>) {
    const eligible = new Set(input.eligible as string[]);
    const m = { ...mistakeOf('a'), originalType: input.original as ExerciseType };
    const mid = recycleTarget(m, 'midLesson', (t) => eligible.has(t));
    const end = recycleTarget(m, 'end', (t) => eligible.has(t));
    return { midType: mid.type, midDegraded: mid.degraded, endType: end.type };
  },

  weakItem(input: Record<string, unknown>) {
    const trace = item(1, { type: input.type as ExerciseType });
    const weak = weakItemFor(trace, COURSE_A, input.rejections as number);
    const queued = queueMistake({
      config: DEFAULT_FLAVOUR_MATRIX.lesson,
      item: trace,
      queue: [],
      mainAnswersAtMiss: 1,
    });
    return { weakItem: weak !== null, mistakeQueued: queued.length };
  },

  killAndRestore(input: Record<string, unknown>) {
    const d = deps();
    let state: RuntimeState = freshSession({ queue: items(input.queueLength as number) });
    const script = [
      { type: 'rendered' as const },
      {
        type: 'input' as const,
        text: 'una manzana',
        caret: 11,
        partialState: { tiles: [3, 1] },
        gradeable: true,
      },
      { type: 'check' as const },
      { type: 'graded' as const },
      { type: 'continue' as const },
    ];
    let ok = true;
    for (let i = 0; i < (input.maxSteps as number); i += 1) {
      state = step(state, script[i % script.length]!, d).state;
      const bytes = serialiseSession(state);
      if (serialiseSession(deserialiseSession(bytes)) !== bytes) ok = false;
      if (canonicalJson(deserialiseSession(bytes).core) !== canonicalJson(state.core)) ok = false;
    }
    return { byteIdenticalAtEveryKillPoint: ok };
  },

  resumeFields(_input: Record<string, unknown>) {
    return { fields: [...RESUME_FIELDS] };
  },

  resumeAge(input: Record<string, unknown>) {
    const at = input.checkpointMs as number;
    const state = checkpoint(freshSession(), at);
    const probes = input.probes as number[];
    const out: Record<string, unknown> = {
      offered: probes.map((delta) => resumeOffered(state, at + delta)),
    };
    if (probes.some((p) => p < 0)) {
      out.clampedToZero = probes
        .filter((p) => p < 0)
        .every((p) => monotonicAgeMs(state, at + p) === 0);
    }
    return out;
  },

  seeds(input: Record<string, unknown>) {
    const session = freshSession({ queue: items(input.queueLength as number) });
    const index = input.index as number;
    const core = { ...session.core, index };
    const seeds = seedsOnResume(core, () => 999_999);
    let verbatim = 0;
    let fresh = 0;
    core.queue.forEach((q, position) => {
      if (seeds[q.id] === core.optionSeeds[q.id] && position < index) verbatim += 1;
      if (seeds[q.id] === 999_999 && position >= index) fresh += 1;
    });
    return { replayedVerbatim: verbatim, reRandomised: fresh };
  },

  coldStart(input: Record<string, unknown>) {
    const session = freshSession({
      courseId: input.sessionCourse as string,
      nodeRef: input.nodeRef as string,
    });
    return { ...coldStartRoute(input.persistedActiveCourse as string, session) };
  },

  inFlight(input: Record<string, unknown>) {
    const d = deps({ grading: new ScriptedGrading({}, 'wrong') });
    let state = freshSession({ flavour: 'jumpHere', queue: items(8) });
    state = step(state, { type: 'rendered' }, d).state;
    state = step(
      state,
      {
        type: 'input',
        text: input.text as string,
        caret: input.caret as number,
        partialState: input.partialState as Record<string, unknown>,
        gradeable: true,
      },
      d,
    ).state;
    const restored = deserialiseSession(serialiseSession(state)) as RuntimeState;
    const graded = step(step(restored, { type: 'check' }, d).state, { type: 'graded' }, d).state;
    const replayed = step(graded, { type: 'graded' }, d).state;
    return {
      restoredText: restored.inFlight.text,
      restoredCaret: restored.inFlight.caret,
      heartsChargedTwice: canonicalJson(replayed.core.hearts) !== canonicalJson(graded.core.hearts),
      answers: replayed.core.answers.length,
    };
  },

  audioInterrupt(input: Record<string, unknown>) {
    const d = deps();
    let state = freshSession({ queue: items(4, { type: 'listenTypeWhatYouHear' }) });
    state = step(state, { type: 'rendered' }, d).state;
    state = step(state, { type: 'audioCompleted' }, d).state;
    state = step(
      state,
      {
        type: 'input',
        text: input.text as string,
        caret: input.caret as number,
        partialState: {},
        gradeable: true,
      },
      d,
    ).state;
    const armedBefore = state.shellState === 'challenge.armed';
    const interrupted = step(state, { type: 'audioInterrupted' }, d).state;
    const afterCheck = step(interrupted, { type: 'check' }, d).state;
    return {
      armedBeforeInterrupt: armedBefore,
      stateAfterInterrupt: interrupted.shellState,
      textPreserved:
        interrupted.inFlight.text === input.text && interrupted.inFlight.caret === input.caret,
      checkReachable: afterCheck.shellState === 'grading',
    };
  },

  hardMode(_input: Record<string, unknown>) {
    const d = deps({ stepUpTripped: () => true });
    const start = freshSession({ queue: items(6) });
    let state = step(start, { type: 'rendered' }, d).state;
    state = step(
      state,
      { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
      d,
    ).state;
    state = step(state, { type: 'check' }, d).state;
    state = step(state, { type: 'graded' }, d).state;
    state = step(state, { type: 'continue' }, d).state;
    const afterStepUp = state.core.hardMode;
    const complete = runToComplete(state, deps());
    return {
      hardModeAtStart: start.core.hardMode,
      hardModeAfterStepUp: afterStepUp,
      hardModeAtComplete: complete.core.hardMode,
    };
  },

  inputMode(input: Record<string, unknown>) {
    const d = deps();
    const base = freshSession({ queue: items(6), packNonLatinScript: input.nonLatin as boolean });
    const explicit = step(
      base,
      { type: 'setInputMode', mode: input.explicit as 'bank' | 'keyboard' },
      d,
    ).state;
    const hard = { ...explicit, core: { ...explicit.core, hardMode: input.hard as boolean } };
    return {
      effective: effectiveInputMode(hard, input.hard as boolean),
      storedUnchanged: hard.core.inputMode === (input.explicit as string),
    };
  },

  /**
   * INV-SESS-09 / INV-SESS-17: opening a session while another GRADED one is in flight.
   * Every deep link goes through `requestStart`; a collision opens the guard sheet and
   * creates nothing. Parked rows for other surfaces (story, radio) never collide.
   */
  store(input: Record<string, unknown>) {
    const store = new InMemorySessionStore();
    let guardSheets = 0;
    let activationRefusals = 0;
    for (const [courseId, kind, nodeRef] of input.rows as [string, SessionKind, string][]) {
      const state = freshSession({ courseId, sessionKind: kind, nodeRef });
      if (requestStart(store, { courseId, kind, nodeRef }).kind === 'guardSheet') {
        guardSheets += 1;
        // The guard sheet is the only legal response: nothing is stored, nothing evicted.
        try {
          store.activate(state);
        } catch {
          activationRefusals += 1;
        }
        continue;
      }
      store.put(state);
      if (kind === 'graded') store.activate(state);
    }
    return {
      rows: store.all().length,
      guardSheets,
      activeGradedKeys: store.activeGraded() === null ? 0 : 1,
      activationRefusals,
    };
  },

  /**
   * INV-SESS-07 with its own falsifier's case, at last.
   *
   * EC-SES-07 "two courses each hold a suspended session" and EC-SES-10 "the other
   * course's session is PARKED, not discarded" are both about LESSONS, so the rows here
   * are `graded`. The previous committed input used `story` rows — a scenario its own
   * `case` string deliberately avoided, because with graded rows the store threw.
   */
  parkedCourses(input: Record<string, unknown>) {
    const store = new InMemorySessionStore();
    const rows = input.rows as [string, SessionKind, string][];
    const keysEverStored = new Set<string>();
    for (const [courseId, kind, nodeRef] of rows) {
      const state = freshSession({ courseId, sessionKind: kind, nodeRef });
      store.put(state);
      keysEverStored.add(keyOf(state));
    }
    // The course switch: park the live one, activate the other. Neither row moves.
    const [switchCourse, switchKind, switchNode] = input.thenActivate as [
      string,
      SessionKind,
      string,
    ];
    store.park();
    store.activate(store.get(switchCourse, switchKind, switchNode)!);
    const present = new Set(store.all().map(keyOf));
    return {
      rows: store.all().length,
      gradedRows: store.all().filter((r) => r.sessionKind === 'graded').length,
      rowsForCourseA: store.forCourse(rows[0]![0]).length,
      rowsForCourseB: store.forCourse(rows[1]![0]).length,
      deletedRows: [...keysEverStored].filter((k) => !present.has(k)).length,
      activeGradedAfterSwitch: decodeURIComponent(keyOf(store.activeGraded()!)),
      courseAStillParked: store.get(rows[0]![0], rows[0]![1], rows[0]![2]) !== null,
    };
  },

  startOver(input: Record<string, unknown>) {
    const session = freshSession({ queue: items(input.queueLength as number) });
    const index = input.index as number;
    const parked = {
      ...session,
      core: {
        ...session.core,
        index,
        answers: Array.from({ length: index }, (_, i) => answer(i, 'correct')),
      },
      mistakes: (input.mistakes as string[]).map(mistakeOf),
    };
    const due = new Set(input.due as string[]);
    const plan = planStartOver(parked, (id) => due.has(id));
    const regenerated = applyStartOverExclusion(items(input.queueLength as number), plan).map(
      (q) => q.itemId,
    );
    return {
      excluded: [...plan.excludedItemIds].sort(),
      dueExceptions: [...plan.dueExceptions],
      handedOver: [...plan.handedOverMistakes],
      // No attempt row is created by a regeneration: the committed ones stand, and the
      // plan carries no attempts field at all.
      newAttemptRows: regenerated.length - new Set(regenerated).size,
    };
  },

  quit(input: Record<string, unknown>) {
    const d = deps();
    const n = input.answers as number;
    const session = freshSession({ queue: items(12) });
    const state: RuntimeState = {
      ...session,
      shellState: 'challenge.idle',
      core: {
        ...session.core,
        index: n,
        answers: Array.from({ length: n }, (_, i) => answer(i, 'correct')),
      },
    };
    const decision = quitDecision(state);
    const opened = step(state, { type: 'exit', route: input.route as ExitRoute }, d);
    const out: Record<string, unknown> = { decision: decision.kind, writes: opened.writes.length };
    if (decision.kind === 'showQuitSheet') {
      const ended = step(opened.state, { type: 'endSession', route: input.route as ExitRoute }, d);
      out.attemptsOnEnd = ended.writes.filter((w) => w.kind === 'attempt').length;
      const commit = quitCommit({
        state,
        config: DEFAULT_FLAVOUR_MATRIX.lesson,
        route: input.route as ExitRoute,
        mistakeRows: [],
        weakItemRows: [],
      });
      out.xp = commit.xpAwarded;
    }
    return out;
  },

  quitCommit(input: Record<string, unknown>) {
    const verdicts = (input.verdicts as string[]).map((v) => VERDICT[v]!);
    const session = freshSession({ queue: items(12) });
    const answers = verdicts.map((v, i) => answer(i, v));
    const rows: MistakeRow[] = answers
      .filter((a) => a.wrong)
      .map((a) => ({
        itemId: a.itemId,
        courseId: COURSE_A,
        conceptId: 'c',
        createdInSessionId: 'session-1',
        reviewStreak: 0,
      }));
    const commit = quitCommit({
      state: { ...session, core: { ...session.core, index: answers.length, answers } },
      config: DEFAULT_FLAVOUR_MATRIX.lesson,
      route: input.route as ExitRoute,
      mistakeRows: rows,
      weakItemRows: [],
    });
    return {
      attempts: commit.writes.filter((w) => w.kind === 'attempt').length,
      mistakes: commit.writes.filter((w) => w.kind === 'mistake').length,
      xp: commit.xpAwarded,
      advancesNodeRing: commit.advancesNodeRing,
    };
  },

  completion(input: Record<string, unknown>) {
    const session = freshSession({ queue: items(12) });
    const skips = Array.from({ length: input.skips as number }, (_, i) =>
      answer(i, 'noVerdict', 'speakSentence', true),
    );
    const commit = completionCommit({
      state: { ...session, core: { ...session.core, index: skips.length, answers: skips } },
      config: DEFAULT_FLAVOUR_MATRIX.lesson,
      mistakeRows: [],
      weakItemRows: [],
    });
    return {
      sessionRows: commit.writes.filter((w) => w.kind === 'session').length,
      dayRewards: commit.writes.filter((w) => w.kind === 'dayReward').length,
      attempts: commit.writes.filter((w) => w.kind === 'attempt').length,
      xp: commit.xpAwarded,
    };
  },

  quitFromTips(_input: Record<string, unknown>) {
    const d = deps();
    const tips: RuntimeState = { ...freshSession(), shellState: 'tips' };
    const decision = quitDecision(tips);
    const result = step(tips, { type: 'exit', route: 'closeButton' }, d);
    return {
      decision: decision.kind,
      writes: result.writes.length,
      undeclaredStates: DECLARED_SHELL_STATES.has(result.state.shellState) ? 0 : 1,
    };
  },

  bannerKill(input: Record<string, unknown>) {
    const d = deps({ grading: new ScriptedGrading({}, input.verdict as VerdictKind) });
    let state = freshSession({ queue: items(6) });
    state = step(state, { type: 'rendered' }, d).state;
    state = step(
      state,
      { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
      d,
    ).state;
    state = step(state, { type: 'check' }, d).state;
    const graded = step(state, { type: 'graded' }, d);
    const restored = deserialiseSession(serialiseSession(graded.state)) as RuntimeState;
    const continued = step(restored, { type: 'continue' }, d);
    return {
      restoredState: restored.shellState,
      writesAtBanner: graded.writes.length,
      indexAfterContinue: continued.state.core.index,
    };
  },

  boot(_input: Record<string, unknown>) {
    const log: string[] = [];
    let streak = 'pre-rollover';
    const snapshots: string[] = [];
    const nudges: string[] = [];
    const port: BootPort = {
      rolloverTo: async () => {
        await Promise.resolve();
        streak = 'post-rollover';
        log.push('rollover');
      },
      recomputeFsrs: async () => {
        await Promise.resolve();
        log.push('fsrsRecompute');
      },
      publishSnapshotAndReload: async () => {
        await Promise.resolve();
        snapshots.push(streak);
        log.push('snapshotAndReload');
      },
      rearmNotifications: async () => {
        await Promise.resolve();
        nudges.push(streak);
        log.push('notificationRearm');
      },
    };
    return { port, log, snapshots, nudges } as unknown as Record<string, unknown>;
  },

  /**
   * INV-MIS-01, driven through `step()` — the falsifier a refuter's probe wrote.
   *
   * It records the ORDER items were served in, not just how many times each was
   * recycled, because the bug it exists to catch was invisible to a count: every replay
   * used to be served after the whole main queue had drained while the code still
   * labelled the first one `midLesson`. `firstReplayAnswerPosition <
   * lastMainAnswerPosition` is the line that fails if that regresses.
   */
  serveTrace(input: Record<string, unknown>) {
    const wrongAt = new Set((input.wrongAt as number[]).map((n) => `item-${n}`));
    const grading: GradingPort = {
      // Wrong on the FIRST encounter only: the replays are answered correctly, so each
      // mistake takes exactly its two scheduled recycles.
      grade: ({ item: served }) => ({
        kind: wrongAt.has(served.itemId) && wrongAt.delete(served.itemId) ? 'wrong' : 'correct',
      }),
    };
    const d = deps({ grading });
    const queue = items(input.queueLength as number);
    let state: RuntimeState = freshSession({ queue });

    const trace: string[] = [];
    const phases: string[] = [];
    const replayTypes: Record<string, string[]> = {};
    let served = state.currentReplay;
    state = step(state, { type: 'rendered' }, d).state;
    for (let guard = 0; guard < 400 && state.shellState !== 'complete'; guard += 1) {
      // What is on screen right now?
      served = state.currentReplay;
      const onScreen = served !== null ? served.item : (state.core.queue[state.core.index] ?? null);
      if (onScreen !== null && state.shellState === 'challenge.idle') {
        trace.push(`${served !== null ? 'REPLAY' : 'MAIN'}(${onScreen.itemId})`);
        if (served !== null) {
          phases.push(served.phase);
          (replayTypes[onScreen.itemId] ??= []).push(onScreen.type);
        }
      }
      state = step(
        state,
        { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
        d,
      ).state;
      state = step(state, { type: 'check' }, d).state;
      state = step(state, { type: 'graded' }, d).state;
      state = step(state, { type: 'continue' }, d).state;
      // Dismiss any interstitial / mistake-review screen standing in the way.
      for (let i = 0; i < 4 && !isAnswerable(state); i += 1) {
        state = step(state, { type: 'continue' }, d).state;
      }
    }

    const answers = state.core.answers;
    const firstReplay = answers.findIndex((a) => a.queue === 'mistakes');
    let lastMain = -1;
    answers.forEach((a, i) => {
      if (a.queue === 'main') lastMain = i;
    });
    const missed = (input.wrongAt as number[]).map((n) => `item-${n}`);
    const originalType = (id: string) => queue.find((q) => q.itemId === id)!.type;
    return {
      serveTrace: trace,
      recyclesPerMistake: missed.map(
        (id) => answers.filter((a) => a.queue === 'mistakes' && a.itemId === id).length,
      ),
      phases,
      firstReplayAnswerPosition: firstReplay,
      lastMainAnswerPosition: lastMain,
      // S049: mid-lesson in a DIFFERENT format (best-effort), end in the ORIGINAL.
      midLessonFormatDiffers: missed.every((id) => replayTypes[id]![0] !== originalType(id)),
      endFormatIsOriginal: missed.every((id) => replayTypes[id]![1] === originalType(id)),
      pendingAtComplete: hasPendingMistake(state.mistakes),
      reachedComplete: state.shellState === 'complete',
    };
  },

  /**
   * INV-COM-09 / EC-COM-12: "the tier-2 note WINS THE BANNER HEADLINE — it is corrective
   * information — and the milestone is not lost: it fires as the separate interstitial
   * after CONTINUE."
   *
   * Both halves. The previous committed input asserted only `{combo, gold, label}`, so
   * the headline half was never checked and `grade()` was quietly discarding
   * `verdict.note`.
   */
  softCorrectMilestone(input: Record<string, unknown>) {
    const note = input.note as string;
    const n = input.correctBefore as number;
    const grading = new ScriptedGrading();
    grading.setVerdict(`item-${n + 1}`, { kind: 'softCorrect', note });
    const d = deps({ grading });
    let state: RuntimeState = freshSession({ queue: items(n + 4) });
    state = step(state, { type: 'rendered' }, d).state;

    let bannerShell = '';
    let headline: string | null = null;
    let headlineAfterKill: string | null = null;
    const milestoneKeys: string[] = [];
    const allMilestoneKeys: string[] = [];
    for (let i = 0; i < n + 1; i += 1) {
      state = step(
        state,
        { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
        d,
      ).state;
      state = step(state, { type: 'check' }, d).state;
      state = step(state, { type: 'graded' }, d).state;
      if (i === n) {
        bannerShell = state.shellState;
        headline = state.lastVerdict?.note ?? null;
        // …and it is on the ROW, so a kill between the verdict and CONTINUE restores the
        // banner WITH its headline (INV-SESS-04).
        headlineAfterKill = deserialiseSession(serialiseSession(state)).lastVerdict?.note ?? null;
      }
      state = step(state, { type: 'continue' }, d).state;
      if (state.shellState === 'interstitial') {
        // Only the screens emitted at the CROSSING count for this invariant: "…and still
        // emits EXACTLY ONE milestone interstitial". Combo 5 fires earlier in the run and
        // is not what is being counted.
        if (i === n) milestoneKeys.push(...state.pendingInterstitialKeys);
        allMilestoneKeys.push(...state.pendingInterstitialKeys);
        state = step(state, { type: 'continue' }, d).state;
      }
    }
    return {
      combo: state.core.combo,
      gold: barIsGold(state.core.combo),
      label: comboLabelVisible(state.core.combo),
      shellStateAtBanner: bannerShell,
      bannerHeadline: headline,
      headlineSurvivesKill: headlineAfterKill,
      milestoneInterstitials: milestoneKeys.filter((k) => k.startsWith('combo.')).length,
      milestoneCopyKey: milestoneKeys.find((k) => k.startsWith('combo.')) ?? null,
      // The whole run, so "the milestone is not lost" is a count, not an absence: 5 and
      // 10 both fired, with distinct copy (INV-COM-03).
      milestonesInWholeRun: allMilestoneKeys.filter((k) => k.startsWith('combo.')).length,
      distinctCopyInWholeRun: new Set(allMilestoneKeys.filter((k) => k.startsWith('combo.'))).size,
      // A soft-correct never breaks the combo.
      comboBroken: state.core.combo !== (input.correctBefore as number) + 1,
    };
  },

  registry(_input: Record<string, unknown>) {
    const undeclared = emittableExerciseTypes().filter((t) => EXERCISE_REGISTRY[t] === undefined);
    const traces = Object.values(EXERCISE_REGISTRY).flatMap((s) =>
      s.recycleTargets.filter((t) => NEVER_A_RECYCLE_TARGET.includes(t)),
    );
    return { undeclared: undeclared.length, tracesAsRecycleTarget: traces.length };
  },
};

/* ================================================================= the suite */

const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const cases: Falsifier[] = files.map(
  (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Falsifier,
);

describe('committed falsifier inputs', () => {
  it('falsifier coverage: every invariant this lane owns has a committed falsifier input', () => {
    const present = new Set(cases.map((c) => c.id));
    const missing = OWNED_IDS.filter((id) => !present.has(id));
    expect(missing).toEqual([]);
    expect(cases).toHaveLength(OWNED_IDS.length);
  });

  for (const falsifier of cases) {
    if (falsifier.kind === 'boot') continue;
    it(`falsifier [${falsifier.id}] ${falsifier.case}`, () => {
      const handler = HANDLERS[falsifier.kind];
      expect(handler, `no handler for kind ${falsifier.kind}`).toBeDefined();
      const actual = handler!(falsifier.input);
      expect(actual).toEqual(falsifier.expect);
    });
  }

  const bootCase = cases.find((c) => c.kind === 'boot')!;
  it(`falsifier [${bootCase.id}] ${bootCase.case}`, async () => {
    const harness = HANDLERS.boot!({}) as unknown as {
      port: BootPort;
      log: string[];
      snapshots: string[];
      nudges: string[];
    };
    await runForegroundBoot(harness.port);
    expect({
      order: harness.log,
      snapshots: harness.snapshots,
      nudges: harness.nudges,
    }).toEqual(bootCase.expect);
  });
});
