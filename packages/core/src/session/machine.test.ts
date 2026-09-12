import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { MISTAKE_REVIEW_KEY, effectiveInputMode, step } from './machine.js';
import type { RuntimeState, SessionEvent, StepDeps } from './machine.js';
import { DEFAULT_FLAVOUR_MATRIX, MID_LESSON_RECYCLE_GAP } from './flavours.js';
import { ScriptedGrading, TestMonotonicClock } from './test-doubles.js';
import { freshSession, item, items } from './session-fixture.js';
import {
  DECLARED_SHELL_STATES,
  EXIT_ROUTES,
  S029_SHELL_STATES,
  SHELL_STATES,
  isDeclaredShellState,
} from './types.js';
import type { ShellState } from './types.js';
import type { VerdictKind } from './types.js';
import { hasPendingMistake } from './mistakes.js';
import type { GradingPort } from './ports.js';
import type { ProgressWrite } from './types.js';
import { deserialiseSession, keyOf, serialiseSession } from './resume.js';
import {
  MISTAKE_REVIEW_COPY_MANY,
  MISTAKE_REVIEW_COPY_ONE,
  PRODUCER_ORDER,
} from './interstitials.js';
import type { InterstitialProducer } from './interstitials.js';

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

/**
 * The only states the queue cursor may advance OUT OF: a challenge on screen (a modality
 * skip) or the banner that follows one (CONTINUE). Any other state advancing the index is
 * a bug, whatever shell state it lands in.
 */
const ADVANCING_STATES: readonly ShellState[] = [
  'challenge.idle',
  'challenge.armed',
  'banner.correct',
  'banner.softCorrect',
  'banner.wrong',
];

/**
 * A grader that fails each named item on its FIRST encounter only.
 *
 * Id-keyed scripts cannot express this: the replay carries the SAME `itemId` as the miss
 * (INV-MIS-07), so `ScriptedGrading({'item-1': 'wrong'})` fails the replays too and the
 * mistake burns its whole re-queue budget. That is four serves, not the two the invariant
 * is about.
 */
function wrongOnce(ids: readonly string[]): GradingPort {
  const pending = new Set(ids);
  return {
    grade: ({ item: served }) => ({
      kind: pending.delete(served.itemId) ? 'wrong' : 'correct',
    }),
  };
}

/** Drive one answer through the shell and dismiss whatever screens follow it. */
function answerOnce(state: RuntimeState, d: StepDeps): RuntimeState {
  let next = step(
    state,
    { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
    d,
  ).state;
  next = step(next, { type: 'check' }, d).state;
  next = step(next, { type: 'graded' }, d).state;
  next = step(next, { type: 'continue' }, d).state;
  for (let i = 0; i < 6; i += 1) {
    if (next.shellState !== 'interstitial' && next.shellState !== 'mistakeReview') break;
    next = step(next, { type: 'continue' }, d).state;
  }
  return next;
}

/** Every event shape the player can produce, including nonsensical ones for this state. */
const eventArb: fc.Arbitrary<SessionEvent> = fc.oneof(
  fc.constant<SessionEvent>({ type: 'showTips' }),
  fc.constant<SessionEvent>({ type: 'tipsContinue' }),
  fc.constant<SessionEvent>({ type: 'rendered' }),
  fc
    .record({ text: fc.string({ maxLength: 8 }), gradeable: fc.boolean() })
    .map(({ text, gradeable }): SessionEvent => ({
      type: 'input',
      text,
      caret: text.length,
      partialState: { n: text.length },
      gradeable,
    })),
  fc.constant<SessionEvent>({ type: 'audioInterrupted' }),
  fc.constant<SessionEvent>({ type: 'audioCompleted' }),
  fc.constantFrom<SessionEvent>(
    { type: 'setInputMode', mode: 'keyboard' },
    { type: 'setInputMode', mode: 'bank' },
  ),
  fc.constant<SessionEvent>({ type: 'check' }),
  fc.constant<SessionEvent>({ type: 'graded' }),
  fc.constant<SessionEvent>({ type: 'skip' }),
  fc
    .integer({ min: 0, max: 12 })
    .map((count): SessionEvent => ({ type: 'strokeRejections', count })),
  fc.constant<SessionEvent>({ type: 'continue' }),
  fc.constantFrom(...EXIT_ROUTES).map((route): SessionEvent => ({ type: 'exit', route })),
  fc.constant<SessionEvent>({ type: 'keepLearning' }),
  fc.constantFrom(...EXIT_ROUTES).map((route): SessionEvent => ({ type: 'endSession', route })),
);

describe('the session shell state machine (S029)', () => {
  it('[INV-SESS-22] every transition lands in a DECLARED shell state, for any event sequence', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 24 }),
        fc.constantFrom<VerdictKind>('correct', 'softCorrect', 'wrong'),
        (events, fallback) => {
          const d = deps({ grading: new ScriptedGrading({}, fallback) });
          let state: RuntimeState = freshSession({ queue: items(6) });
          for (const event of events) {
            const result = step(state, event, d);
            expect(
              isDeclaredShellState(result.state.shellState),
              `undeclared shell state ${result.state.shellState} after ${event.type}`,
            ).toBe(true);
            expect(DECLARED_SHELL_STATES.has(result.state.shellState)).toBe(true);

            // A DECLARED state is not enough, and a refuter proved it: `skip` carried no
            // shell-state guard, so `graded → skip` appended a SECOND answer at an index
            // that already had one — two attempt rows on `(session_id, exercise_index)`,
            // the key INV-SCH-03 writes. The ledger must stay INJECTIVE on that index…
            const indices = result.state.core.answers.map((a) => a.exerciseIndex);
            expect(
              new Set(indices).size,
              `duplicate exerciseIndex after ${event.type} from ${state.shellState}: ${indices.join()}`,
            ).toBe(indices.length);

            // …and the queue cursor may only move out of a state that was actually
            // showing a challenge or its banner. Nothing else may advance it.
            if (result.state.core.index > state.core.index) {
              expect(
                ADVANCING_STATES,
                `index advanced from ${state.shellState} on ${event.type}`,
              ).toContain(state.shellState);
            }
            // The cursor never rewinds, either.
            expect(result.state.core.index).toBeGreaterThanOrEqual(state.core.index);

            state = result.state;
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
    // …and the declared set is the S029 table's twelve plus the `tips` state EC-SES-27
    // adds, which is the arithmetic behind the 13 (see the comment on SHELL_STATES).
    expect([...SHELL_STATES]).toContain('banner.softCorrect');
    expect([...SHELL_STATES]).toContain('tips');
    expect(S029_SHELL_STATES).toHaveLength(12);
    expect([...SHELL_STATES].filter((s) => !S029_SHELL_STATES.includes(s))).toEqual(['tips']);
    expect(SHELL_STATES).toHaveLength(S029_SHELL_STATES.length + 1);
    expect(SHELL_STATES).toHaveLength(13);
  });

  it('[INV-SESS-22] an illegal `skip` at a banner writes no second answer for an index that already has one', () => {
    // The exact sequence the refuter's probe used: rendered → input → check → graded
    // leaves `banner.correct` with one answer at index 0. A `skip` there used to append a
    // second answer at index 0 and then advance the cursor.
    const d = deps();
    let state: RuntimeState = freshSession({ queue: items(6) });
    state = step(state, { type: 'rendered' }, d).state;
    state = step(
      state,
      { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
      d,
    ).state;
    state = step(state, { type: 'check' }, d).state;
    state = step(state, { type: 'graded' }, d).state;
    expect(state.shellState).toBe('banner.correct');
    expect(state.core.answers.map((a) => a.exerciseIndex)).toEqual([0]);

    const illegal = step(state, { type: 'skip' }, d);
    expect(illegal.state.core.answers.map((a) => a.exerciseIndex)).toEqual([0]);
    expect(illegal.state.core.index).toBe(0);
    expect(illegal.state).toBe(state);

    // `strokeRejections` is guarded the same way: no weak-item row from a banner.
    const strokes = step(state, { type: 'strokeRejections', count: 11 }, d);
    expect(strokes.state.weakItemRows).toEqual([]);
    expect(strokes.state).toBe(state);

    // …and the legal skip, from a challenge, still works.
    const legal = step(
      step(freshSession({ queue: items(6) }), { type: 'rendered' }, d).state,
      { type: 'skip' },
      d,
    );
    expect(legal.state.core.answers).toHaveLength(1);
    expect(legal.state.core.answers[0]!.skipped).toBe(true);
  });

  it('[INV-SESS-22] leaving the tips state writes zero rows of any kind', () => {
    const d = deps();
    const tips = step(freshSession(), { type: 'showTips' }, d);
    expect(tips.state.shellState).toBe('tips');
    expect(tips.writes).toEqual([]);
    const left = step(tips.state, { type: 'tipsContinue' }, d);
    expect(left.state.shellState).toBe('loading');
    expect(left.writes).toEqual([]);
  });

  it('[INV-SESS-04] banner.* is a persisted shell state: a kill between the verdict and CONTINUE restores the banner with CONTINUE armed', () => {
    fc.assert(
      fc.property(fc.constantFrom<VerdictKind>('correct', 'softCorrect', 'wrong'), (verdict) => {
        const d = deps({ grading: new ScriptedGrading({}, verdict) });
        let state = freshSession({ queue: items(6) });
        state = step(state, { type: 'rendered' }, d).state;
        state = step(
          state,
          { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
          d,
        ).state;
        state = step(state, { type: 'check' }, d).state;
        const graded = step(state, { type: 'graded' }, d);
        const expected =
          verdict === 'wrong'
            ? 'banner.wrong'
            : verdict === 'softCorrect'
              ? 'banner.softCorrect'
              : 'banner.correct';
        expect(graded.state.shellState).toBe(expected);
        // The reward ledger is unchanged: the banner writes nothing.
        expect(graded.writes).toEqual([]);
        // Restore: CONTINUE is armed and re-presents the banner, not the item.
        const restored = JSON.parse(JSON.stringify(graded.state)) as RuntimeState;
        expect(restored.shellState).toBe(expected);
        const continued = step(restored, { type: 'continue' }, d);
        expect(continued.state.core.index).toBe(1);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SESS-24] after an audio interruption CHECK stays disabled until the clip completes again, with the buffer byte-identical', () => {
    const d = deps();
    const listening = items(4, { type: 'listenTypeWhatYouHear' });
    let state = freshSession({ queue: listening });
    state = step(state, { type: 'rendered' }, d).state;
    // Not heard yet: a gradeable input cannot arm CHECK.
    state = step(
      state,
      { type: 'input', text: 'el gato', caret: 7, partialState: {}, gradeable: true },
      d,
    ).state;
    expect(state.shellState).toBe('challenge.idle');
    // Heard to the end: armed.
    state = step(state, { type: 'audioCompleted' }, d).state;
    state = step(
      state,
      { type: 'input', text: 'el gato', caret: 7, partialState: {}, gradeable: true },
      d,
    ).state;
    expect(state.shellState).toBe('challenge.armed');

    // A call interrupts. CHECK is disabled again; the typed buffer and caret are identical.
    const interrupted = step(state, { type: 'audioInterrupted' }, d).state;
    expect(interrupted.shellState).toBe('challenge.idle');
    expect(interrupted.inFlight.text).toBe('el gato');
    expect(interrupted.inFlight.caret).toBe(7);
    expect(interrupted.inFlight.audioHeardToEnd).toBe(false);
    // CHECK is unreachable until the clip plays to completion again.
    expect(step(interrupted, { type: 'check' }, d).state.shellState).toBe('challenge.idle');
    const rearmed = step(
      step(interrupted, { type: 'audioCompleted' }, d).state,
      { type: 'input', text: 'el gato', caret: 7, partialState: {}, gradeable: true },
      d,
    ).state;
    expect(rearmed.shellState).toBe('challenge.armed');
  });

  it('[INV-SESS-19] a step-up sets hardMode for this session only, and complete clears it', () => {
    const d = deps({ stepUpTripped: () => true });
    let state = freshSession({ queue: items(6) });
    state = step(state, { type: 'rendered' }, d).state;
    state = step(
      state,
      { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
      d,
    ).state;
    state = step(state, { type: 'check' }, d).state;
    state = step(state, { type: 'graded' }, d).state;
    state = step(state, { type: 'continue' }, d).state;
    expect(state.shellState).toBe('interstitial');
    expect(state.core.hardMode).toBe(true);
    expect(state.stepUpFired).toBe(true);

    // Drive to completion: hardMode is cleared on entry to `complete`.
    const d2 = deps({ stepUpTripped: () => false });
    for (let guard = 0; guard < 60 && state.shellState !== 'complete'; guard += 1) {
      state = step(state, { type: 'continue' }, d2).state;
      state = step(
        state,
        { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
        d2,
      ).state;
      state = step(state, { type: 'check' }, d2).state;
      state = step(state, { type: 'graded' }, d2).state;
    }
    expect(state.shellState).toBe('complete');
    expect(state.core.hardMode).toBe(false);
  });

  it('[INV-SESS-20] a hard item never mutates the persisted inputMode, and an explicit preference wins over the typed default', () => {
    const d = deps();
    const base = freshSession({ queue: items(6) });
    expect(base.core.inputMode).toBe('bank');
    // Hard mode biases the presentation to typed…
    expect(effectiveInputMode({ ...base, core: { ...base.core, hardMode: true } }, true)).toBe(
      'keyboard',
    );
    // …but the STORED mode is untouched, so the next non-hard item reopens in it.
    const hard = { ...base, core: { ...base.core, hardMode: true } };
    expect(hard.core.inputMode).toBe('bank');
    expect(effectiveInputMode(hard, false)).toBe('bank');

    // An explicit session preference wins over hard mode's default.
    const explicit = step(base, { type: 'setInputMode', mode: 'bank' }, d).state;
    expect(explicit.inputModeExplicit).toBe(true);
    expect(
      effectiveInputMode({ ...explicit, core: { ...explicit.core, hardMode: true } }, true),
    ).toBe('bank');

    // On a non-Latin pack hard mode never changes the input default at all.
    const ja = freshSession({ queue: items(6), packNonLatinScript: true });
    expect(effectiveInputMode(ja, true)).toBe(ja.core.inputMode);
  });

  it('[INV-SESS-19] falsifier: a step-up in one session cannot change the typo verdict in the next', () => {
    // hardMode is in `core` — the session row — and `freshSession` is the only producer of
    // a start state. There is no account-level carrier for it to leak through.
    const started = freshSession({ flavour: 'nodePractice' });
    expect(started.core.hardMode).toBe(false);
    expect(Object.keys(started)).not.toContain('accountHardMode');
  });

  it('[INV-MIS-01] a lesson with mistakes cannot reach complete until the replays are drained', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<VerdictKind>('correct', 'wrong'), { minLength: 4, maxLength: 8 }),
        (verdicts) => {
          const grading = new ScriptedGrading();
          const queue = items(verdicts.length);
          verdicts.forEach((v, i) => grading.set(`item-${i + 1}`, v));
          const d = deps({ grading });
          let state: RuntimeState = freshSession({ queue });
          state = step(state, { type: 'rendered' }, d).state;
          for (let guard = 0; guard < 200 && state.shellState !== 'complete'; guard += 1) {
            state = step(
              state,
              { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
              d,
            ).state;
            state = step(state, { type: 'check' }, d).state;
            state = step(state, { type: 'graded' }, d).state;
            state = step(state, { type: 'continue' }, d).state;
          }
          expect(state.shellState).toBe('complete');
          // Never complete with a pending mistake.
          expect(hasPendingMistake(state.mistakes)).toBe(false);
          // The reserved final segment was consumed exactly once.
          expect(state.progress.finalSegmentConsumed).toBe(true);
          expect(state.progress.numerator).toBe(state.progress.denominator);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });


  it('[INV-MIS-01] the FIRST recycle is served MID-LESSON: a replay is answered strictly before the last main-queue item', () => {
    // The refuted claim. An 8-item lesson missing item-1 used to produce the serve trace
    // MAIN(1..8) then REPLAY,REPLAY,REPLAY,REPLAY — every replay after the whole main
    // queue, with the first still labelled `midLesson`. `phase` named a FORMAT; it now
    // names a POSITION, and this is the assertion that says so.
    const d = deps({ grading: wrongOnce(['item-1']) });
    const queue = items(8);
    let state: RuntimeState = freshSession({ queue });
    state = step(state, { type: 'rendered' }, d).state;

    const trace: string[] = [];
    for (let guard = 0; guard < 200 && state.shellState !== 'complete'; guard += 1) {
      if (state.shellState === 'challenge.idle' || state.shellState === 'challenge.armed') {
        const replay = state.currentReplay;
        const onScreen = replay !== null ? replay.item : state.core.queue[state.core.index]!;
        trace.push(`${replay !== null ? 'REPLAY' : 'MAIN'}(${onScreen.itemId})`);
      }
      state = answerOnce(state, d);
    }
    expect(state.shellState).toBe('complete');

    const answers = state.core.answers;
    const firstReplay = answers.findIndex((a) => a.queue === 'mistakes');
    const lastMain = answers.map((a) => a.queue).lastIndexOf('main');
    expect(firstReplay).toBeGreaterThanOrEqual(0);
    // THE LINE. A replay answer sits at a position strictly before the last main item.
    expect(firstReplay).toBeLessThan(lastMain);
    expect(trace.indexOf('REPLAY(item-1)')).toBeLessThan(trace.lastIndexOf('MAIN(item-8)'));

    // Exactly twice, mid-lesson in a different format, end in the original.
    const replays = answers.filter((a) => a.queue === 'mistakes');
    expect(replays).toHaveLength(2);
    expect(replays[0]!.type).not.toBe('meaningSelect');
    expect(replays[1]!.type).toBe('meaningSelect');
    expect(hasPendingMistake(state.mistakes)).toBe(false);
  });

  it('[INV-MIS-01] for any miss position in any lesson length, every mistake is recycled exactly twice and the first recycle is mid-lesson whenever a slot exists', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 14 }),
        fc.integer({ min: 1, max: 13 }),
        (length, rawMiss) => {
          // Any miss position in the queue, INCLUDING the last item (no mid-lesson slot).
          const missAt = ((rawMiss - 1) % length) + 1;
          const d = deps({ grading: wrongOnce([`item-${missAt}`]) });
          let state: RuntimeState = freshSession({ queue: items(length) });
          state = step(state, { type: 'rendered' }, d).state;
          for (let guard = 0; guard < 400 && state.shellState !== 'complete'; guard += 1) {
            state = answerOnce(state, d);
          }
          expect(state.shellState).toBe('complete');
          const answers = state.core.answers;
          // Exactly two recycles, ALWAYS — whether or not a mid-lesson slot existed.
          expect(answers.filter((a) => a.queue === 'mistakes')).toHaveLength(2);

          const firstReplay = answers.findIndex((a) => a.queue === 'mistakes');
          const lastMain = answers.map((a) => a.queue).lastIndexOf('main');
          // A mid-lesson slot exists iff the miss is at least `gap` main answers from the
          // end of the queue. When it does, the first recycle MUST be served there; when
          // it does not, S049's "best-effort" applies and both go at the end. Stating the
          // condition rather than picking generators that avoid it is the point: the
          // boundary case is the one the previous cut hid behind.
          const hasMidSlot = missAt + MID_LESSON_RECYCLE_GAP < length;
          if (hasMidSlot) {
            expect(firstReplay).toBeLessThan(lastMain);
          } else {
            expect(firstReplay).toBeGreaterThan(lastMain);
            // …and then both are in the ORIGINAL format, never mislabelled mid-lesson.
            for (const replay of answers.filter((a) => a.queue === 'mistakes')) {
              expect(replay.type).toBe('meaningSelect');
            }
          }
          expect(hasPendingMistake(state.mistakes)).toBe(false);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-MIS-01] a miss with no mid-lesson slot left is still recycled exactly twice, at the end, in the original format', () => {
    // S049 calls the different-format mid-lesson replay "best-effort". Missing the LAST
    // main item leaves no mid-lesson slot; the COUNT is still two, and honesty about that
    // is why `phase` is computed from position rather than from `recyclesServed`.
    const d = deps({ grading: wrongOnce(['item-8']) });
    let state: RuntimeState = freshSession({ queue: items(8) });
    state = step(state, { type: 'rendered' }, d).state;
    for (let guard = 0; guard < 200 && state.shellState !== 'complete'; guard += 1) {
      state = answerOnce(state, d);
    }
    const replays = state.core.answers.filter((a) => a.queue === 'mistakes');
    expect(replays).toHaveLength(2);
    // Both at the end, so both in the ORIGINAL format — not mislabelled `midLesson`.
    for (const replay of replays) expect(replay.type).toBe('meaningSelect');
  });

  it('[INV-SESS-23] completing a lesson commits attempts, a session row, a day reward and DELETES the session_state row, so RESUME is never offered on a finished lesson', () => {
    // `complete()` used to return `writes: []`: a lesson played to the end wrote nothing
    // and left its row parked, so the next launch offered RESUME on a finished lesson.
    const d = deps();
    const start = freshSession({ queue: items(6) });
    let state: RuntimeState = step(start, { type: 'rendered' }, d).state;
    let writes: readonly ProgressWrite[] = [];
    for (let guard = 0; guard < 200 && state.shellState !== 'complete'; guard += 1) {
      state = step(
        state,
        { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
        d,
      ).state;
      state = step(state, { type: 'check' }, d).state;
      state = step(state, { type: 'graded' }, d).state;
      const continued = step(state, { type: 'continue' }, d);
      state = continued.state;
      if (continued.writes.length > 0) writes = continued.writes;
    }
    expect(state.shellState).toBe('complete');

    const kinds = writes.map((w) => w.kind);
    expect(kinds).toContain('attempt');
    expect(kinds).toContain('session');
    expect(kinds).toContain('dayReward');
    expect(kinds).toContain('sessionStateDelete');
    // The delete names THIS session's key, so the parked row provably goes.
    const deletes = writes.filter((w) => w.kind === 'sessionStateDelete');
    expect(deletes).toHaveLength(1);
    expect((deletes[0] as { key: string }).key).toBe(keyOf(state));
    // Six items answered, six attempt rows, one session row, one day reward.
    expect(writes.filter((w) => w.kind === 'attempt')).toHaveLength(6);
    expect(writes.filter((w) => w.kind === 'session')).toHaveLength(1);
    expect(writes.filter((w) => w.kind === 'dayReward')).toHaveLength(1);
  });

  it('[INV-SESS-23] a session of nothing but skips reaches complete, writes its attempts, and writes NO session row and NO day-keyed reward', () => {
    // The falsifier: ten `Can't speak now` taps in Perfect Pronunciation extending the
    // streak. Driven through `step`, not through `completionCommit` directly, because the
    // whole point is that the runtime is what calls it.
    const d = deps();
    let state: RuntimeState = freshSession({
      queue: items(6, { type: 'speakSentence' }),
    });
    state = step(state, { type: 'rendered' }, d).state;
    let writes: readonly ProgressWrite[] = [];
    for (let guard = 0; guard < 60 && state.shellState !== 'complete'; guard += 1) {
      const skipped = step(state, { type: 'skip' }, d);
      state = skipped.state;
      if (skipped.writes.length > 0) writes = skipped.writes;
    }
    expect(state.shellState).toBe('complete');
    expect(writes.filter((w) => w.kind === 'attempt')).toHaveLength(6);
    expect(writes.filter((w) => w.kind === 'session')).toHaveLength(0);
    expect(writes.filter((w) => w.kind === 'dayReward')).toHaveLength(0);
    // The row still goes: a finished session never offers RESUME.
    expect(writes.filter((w) => w.kind === 'sessionStateDelete')).toHaveLength(1);
  });

  it('[INV-COM-08] driven through step(), the boundary that trips all three producers renders combo → step-up → mistake-review, one screen at a time', () => {
    // Proved END-TO-END, not inside `interstitials.ts`. The machine used to FILTER the
    // mistake-review producer out of the queue, so this order was never realised through
    // `step()` and S049's plural-aware copy never reached any state the UI could read.
    //
    // The construction is exact. Five items, item-1 missed on its first encounter:
    //   main1 wrong (combo 0) · main2 (1) · main3 (2) · REPLAY item-1 mid-lesson (3) ·
    //   main4 (4) · main5 (5) — and that last answer DRAINS the queue at combo 5 with the
    //   mistake's second recycle still owed. Milestone, step-up and review, one boundary.
    const d = deps({
      grading: wrongOnce(['item-1']),
      stepUpTripped: (state) => state.core.combo === 5,
    });
    let state: RuntimeState = freshSession({ queue: items(5) });
    state = step(state, { type: 'rendered' }, d).state;

    const boundaries: {
      queue: readonly string[];
      shells: string[];
      reviewCopyKey: string | null;
    }[] = [];
    for (let guard = 0; guard < 200 && state.shellState !== 'complete'; guard += 1) {
      state = step(
        state,
        { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
        d,
      ).state;
      state = step(state, { type: 'check' }, d).state;
      state = step(state, { type: 'graded' }, d).state;
      state = step(state, { type: 'continue' }, d).state;
      if (state.shellState !== 'interstitial' && state.shellState !== 'mistakeReview') continue;

      // One boundary's worth of screens, drained a screen at a time.
      const queued = state.pendingInterstitialKeys;
      const shells: string[] = [];
      let reviewCopyKey: string | null = null;
      for (let i = 0; i < 6; i += 1) {
        if (state.shellState !== 'interstitial' && state.shellState !== 'mistakeReview') break;
        // EC-COM-11's failure is two mascot slide-ins in one frame: exactly one screen is
        // on show at any moment, and it is the head of the queue.
        expect(state.pendingInterstitialKeys.length).toBeGreaterThan(0);
        shells.push(state.shellState);
        if (state.shellState === 'mistakeReview') {
          reviewCopyKey = state.mistakeReviewCopyKey;
        }
        state = step(state, { type: 'continue' }, d).state;
      }
      boundaries.push({ queue: queued, shells, reviewCopyKey });
    }
    expect(state.shellState).toBe('complete');

    const producerOf = (key: string): InterstitialProducer =>
      key.startsWith('combo.') ? 'combo' : key.startsWith('stepup:') ? 'stepUp' : 'mistakeReview';

    // EVERY boundary's queue is a duplicate-free subsequence of the canonical order…
    for (const boundary of boundaries) {
      const ranks = boundary.queue.map((k) => PRODUCER_ORDER[producerOf(k)]);
      expect(new Set(ranks).size).toBe(ranks.length);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    }

    // …and the constructed boundary carries all three, in that order, in ONE queue.
    const all = boundaries.find((b) => b.queue.length === 3);
    expect(all, 'no boundary emitted all three producers').toBeDefined();
    expect(all!.queue.map(producerOf)).toEqual(['combo', 'stepUp', 'mistakeReview']);
    expect(all!.queue[0]).toBe('combo.5_in_a_row');
    expect(all!.queue[1]).toBe('stepup:production');
    // The mistake-review screen renders as the DECLARED shell state S029 lists, carrying
    // S049's plural-aware copy key — which is the state the UI reads the copy slot from.
    expect(all!.shells).toEqual(['interstitial', 'interstitial', 'mistakeReview']);
    expect(all!.queue[2]).toBe(MISTAKE_REVIEW_KEY);
    expect([MISTAKE_REVIEW_COPY_ONE, MISTAKE_REVIEW_COPY_MANY]).toContain(all!.reviewCopyKey);
    // One mistake owed, so the SINGULAR copy: `Let's review the exercise you missed!`
    expect(all!.reviewCopyKey).toBe(MISTAKE_REVIEW_COPY_ONE);
  });

  it('[INV-COM-09] a soft-correct crossing a milestone renders the tier-2 note as the banner headline AND still emits exactly one milestone interstitial', () => {
    const note = 'Pay attention to the accents.';
    const grading = new ScriptedGrading();
    grading.setVerdict('item-10', { kind: 'softCorrect', note });
    const d = deps({ grading });
    let state: RuntimeState = freshSession({ queue: items(14) });
    state = step(state, { type: 'rendered' }, d).state;

    let crossing: RuntimeState | null = null;
    const keysAtCrossing: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      state = step(
        state,
        { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
        d,
      ).state;
      state = step(state, { type: 'check' }, d).state;
      state = step(state, { type: 'graded' }, d).state;
      if (i === 9) crossing = state;
      state = step(state, { type: 'continue' }, d).state;
      if (state.shellState === 'interstitial') {
        if (i === 9) keysAtCrossing.push(...state.pendingInterstitialKeys);
        state = step(state, { type: 'continue' }, d).state;
      }
    }

    // The banner: green, soft-correct, and the NOTE is the headline.
    expect(crossing!.shellState).toBe('banner.softCorrect');
    expect(crossing!.lastVerdict).toEqual({ kind: 'softCorrect', note });
    expect(crossing!.core.answers.at(-1)!.note).toBe(note);
    // It survives a kill between the verdict and CONTINUE (INV-SESS-04), which is what
    // makes "restores the banner" mean "restores the banner WITH its headline".
    expect(deserialiseSession(serialiseSession(crossing!)).lastVerdict?.note).toBe(note);

    // The milestone is not lost: exactly one, and it is the 10-in-a-row copy.
    expect(keysAtCrossing.filter((k) => k.startsWith('combo.'))).toEqual(['combo.10_in_a_row']);
    // A soft-correct never breaks the combo.
    expect(crossing!.core.combo).toBe(10);
  });

  it('[INV-COM-06] the denominator never moves however the session plays out', () => {
    const grading = new ScriptedGrading({ 'item-2': 'wrong', 'item-5': 'wrong' });
    const d = deps({ grading });
    let state: RuntimeState = freshSession({ queue: items(8) });
    const denominator = state.progress.denominator;
    state = step(state, { type: 'rendered' }, d).state;
    for (let guard = 0; guard < 200 && state.shellState !== 'complete'; guard += 1) {
      state = step(
        state,
        { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
        d,
      ).state;
      state = step(state, { type: 'check' }, d).state;
      state = step(state, { type: 'graded' }, d).state;
      state = step(state, { type: 'continue' }, d).state;
      expect(state.progress.denominator).toBe(denominator);
    }
    expect(denominator).toBe(8);
    expect(state.core.answers.length).toBeGreaterThan(8); // the replays ran
  });

  it('[INV-MIS-07] a replay preserves the missed item id for FSRS', () => {
    // Wrong once in the main queue, correct on both replays. The grader has to be
    // call-counting rather than id-keyed precisely BECAUSE the replay carries the same
    // item id — which is the invariant.
    let seen = 0;
    const grading: GradingPort = {
      grade: ({ item: served }) => {
        if (served.itemId !== 'item-1') return { kind: 'correct' };
        seen += 1;
        return { kind: seen === 1 ? 'wrong' : 'correct' };
      },
    };
    const d = deps({ grading });
    let state: RuntimeState = freshSession({ queue: items(6) });
    state = step(state, { type: 'rendered' }, d).state;
    for (let guard = 0; guard < 200 && state.shellState !== 'complete'; guard += 1) {
      state = step(
        state,
        { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
        d,
      ).state;
      state = step(state, { type: 'check' }, d).state;
      state = step(state, { type: 'graded' }, d).state;
      state = step(state, { type: 'continue' }, d).state;
    }
    const replays = state.core.answers.filter((a) => a.queue === 'mistakes');
    expect(replays.length).toBe(2);
    for (const replay of replays) expect(replay.itemId).toBe('item-1');
    // Mid-lesson in a DIFFERENT format, end-of-lesson in the ORIGINAL.
    expect(replays[0]!.type).not.toBe('meaningSelect');
    expect(replays[1]!.type).toBe('meaningSelect');
  });

  it('[INV-PACK-05] a degraded item is served like any other and never aborts the session', () => {
    const queue = [
      item(1),
      { ...item(2), degraded: 'noImage' as const },
      item(3),
      item(4),
      item(5),
      item(6),
    ];
    const d = deps();
    let state: RuntimeState = freshSession({ queue });
    state = step(state, { type: 'rendered' }, d).state;
    for (let guard = 0; guard < 100 && state.shellState !== 'complete'; guard += 1) {
      state = step(
        state,
        { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
        d,
      ).state;
      state = step(state, { type: 'check' }, d).state;
      state = step(state, { type: 'graded' }, d).state;
      state = step(state, { type: 'continue' }, d).state;
    }
    expect(state.shellState).toBe('complete');
    expect(state.core.answers).toHaveLength(6);
  });
});
