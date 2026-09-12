import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { effectiveInputMode, step } from './machine.js';
import type { RuntimeState, SessionEvent, StepDeps } from './machine.js';
import { DEFAULT_FLAVOUR_MATRIX } from './flavours.js';
import { ScriptedGrading, TestMonotonicClock } from './test-doubles.js';
import { freshSession, item, items } from './session-fixture.js';
import { DECLARED_SHELL_STATES, EXIT_ROUTES, SHELL_STATES, isDeclaredShellState } from './types.js';
import type { VerdictKind } from './types.js';
import { hasPendingMistake } from './mistakes.js';
import type { GradingPort } from './ports.js';

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
            state = result.state;
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
    // …and the declared set is the one S029 lists, plus the `tips` state EC-SES-27 adds.
    expect([...SHELL_STATES]).toContain('banner.softCorrect');
    expect([...SHELL_STATES]).toContain('tips');
    expect(SHELL_STATES).toHaveLength(13);
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
