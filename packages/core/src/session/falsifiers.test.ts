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
import { emitInterstitials } from './interstitials.js';
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
  };
}

/** Drive a whole session to `complete` with a scripted grader. */
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
        mainQueueDrained: false,
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
      mainQueueDrained: (input.mainQueueDrained as boolean) ?? false,
    });
    return { producers: screens.map((s) => s.producer) };
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
    const phases: string[] = [];
    let serves = 0;
    let measure = pendingServes(queue);
    let decreasing = true;
    while (hasPendingMistake(queue)) {
      const served = serveNextMistake(queue)!;
      phases.push(served.served.recyclesServed === 0 ? 'midLesson' : 'end');
      queue = afterMistakeReplay(served.served, served.rest, verdicts[serves % verdicts.length]!);
      serves += 1;
      const next = pendingServes(queue);
      if (next >= measure) decreasing = false;
      measure = next;
    }
    const out: Record<string, unknown> = {
      serves,
      pendingAtEnd: hasPendingMistake(queue),
      measureStrictlyDecreasing: decreasing,
    };
    if (verdicts.every(Boolean)) out.phases = phases;
    return out;
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

  store(input: Record<string, unknown>) {
    const store = new InMemorySessionStore();
    let refusals = 0;
    for (const [courseId, kind, nodeRef] of input.rows as [string, SessionKind, string][]) {
      try {
        store.put(freshSession({ courseId, sessionKind: kind, nodeRef }));
      } catch {
        refusals += 1;
        // The guard sheet is the only legal response to a collision.
        expect(requestStart(store, { courseId, kind, nodeRef }).kind).toBe('guardSheet');
      }
    }
    return { rows: store.all().length, refusals };
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
