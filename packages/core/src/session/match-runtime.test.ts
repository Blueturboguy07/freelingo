import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { freshSession, item } from './session-fixture.js';
import { DEFAULT_FLAVOUR_MATRIX } from './flavours.js';
import { step } from './machine.js';
import type { StepDeps, SessionEvent } from './machine.js';
import type { SessionState } from './resume.js';
const pairs = Array.from({ length: 5 }, (_, n) => ({
  leftId: `l${n}`,
  rightId: `r${n}`,
  leftItemId: `lexeme${n}`,
}));
const deps: StepDeps = {
  config: DEFAULT_FLAVOUR_MATRIX.legendary,
  clock: { nowMs: () => 1 },
  grading: { grade: () => ({ kind: 'correct' }) },
  isTypeEligible: () => true,
  stepUpTripped: () => false,
  matchPairs: () => pairs,
};
function start(): SessionState {
  const state = freshSession({ flavour: 'legendary', queue: [item(1, { type: 'matchPairs' })] });
  return {
    ...state,
    shellState: 'challenge.idle',
    core: { ...state.core, hearts: { kind: 'pips', total: 20, remaining: 20 }, combo: 4 },
  };
}
const tap = (attemptId: string, leftId: string, rightId: string): SessionEvent => ({
  type: 'matchPair',
  attemptId,
  leftId,
  rightId,
});
describe('immediate match-pair accounting', () => {
  it('[INV-GRD-07] first wrong LEFT semantic item owns the only mistake and both replays are recognition', () => {
    const lessonDeps = { ...deps, config: DEFAULT_FLAVOUR_MATRIX.lesson };
    let state = step(start(), tap('first-wrong', 'l3', 'r1'), lessonDeps).state;
    expect(state.inFlight.partialState['matchRuntime']).toMatchObject({
      firstWrongItemId: 'lexeme3',
    });
    state = step(state, tap('second-wrong', 'l1', 'r2'), lessonDeps).state;
    for (let n = 0; n < 5; n++)
      state = step(state, tap(`correct-${n}`, `l${n}`, `r${n}`), lessonDeps).state;
    expect(state.mistakeRows).toHaveLength(1);
    expect(state.mistakeRows[0]?.itemId).toBe('lexeme3');
    expect(state.mistakeRows[0]?.conceptId).toBe('lexeme3');
    expect(state.mistakes[0]?.itemId).toBe('lexeme3');
    expect(state.core.answers).toHaveLength(1);
    expect(state.core.answers[0]?.itemId).toBe(start().core.queue[0]?.itemId);
    const replayTypes: string[] = [];
    for (let n = 0; n < 20 && state.shellState !== 'complete'; n++) {
      if (
        state.shellState.startsWith('banner.') ||
        state.shellState === 'mistakeReview' ||
        state.shellState === 'interstitial'
      )
        state = step(state, { type: 'continue' }, lessonDeps).state;
      else if (state.shellState === 'challenge.idle') {
        replayTypes.push(state.currentReplay?.item.type ?? 'missing');
        expect(state.currentReplay?.item.itemId).toBe('lexeme3');
        state = step(
          state,
          { type: 'input', text: 'correct', caret: 7, partialState: {}, gradeable: true },
          lessonDeps,
        ).state;
      } else if (state.shellState === 'challenge.armed')
        state = step(state, { type: 'check' }, lessonDeps).state;
      else if (state.shellState === 'grading')
        state = step(state, { type: 'graded' }, lessonDeps).state;
    }
    expect(replayTypes).toEqual(['meaningSelect', 'meaningSelect']);
    expect(state.core.hearts).toMatchObject({ remaining: 18 });
  });

  it('[INV-SESS-15] [INV-GRD-07] charges each wrong pair immediately, persists the taps, and never charges it again', () => {
    let state = start();
    const wrong = tap('first', 'l0', 'r1');
    state = step(state, wrong, deps).state;
    expect(state.core.hearts).toEqual({ kind: 'pips', total: 20, remaining: 19 });
    expect(state.core.combo).toBe(0);
    const snapshot = JSON.parse(JSON.stringify(state)) as SessionState;
    expect(step(snapshot, wrong, deps).state).toEqual(snapshot);
    state = step(snapshot, tap('second', 'l0', 'r2'), deps).state;
    expect(state.core.hearts).toEqual({ kind: 'pips', total: 20, remaining: 18 });
    for (let n = 0; n < 5; n++)
      state = step(state, tap(`correct-${n}`, `l${n}`, `r${n}`), deps).state;
    expect(state.core.answers).toHaveLength(1);
    expect(state.core.answers[0]?.costPaid).toBe(2);
    expect(state.core.answers[0]?.wrong).toBe(true);
    expect(state.mistakeRows).toHaveLength(1);
    expect(state.core.hearts).toEqual({ kind: 'pips', total: 20, remaining: 18 });
    expect(step(state, { type: 'graded' }, deps).state).toEqual(state);
  });
  it('[INV-COM-01] completes all five pairs with one combo increment and no CHECK', () => {
    let state = start();
    for (let n = 0; n < 5; n++) {
      state = step(state, tap(`correct-${n}`, `l${n}`, `r${n}`), deps).state;
      if (n < 4) expect(state.core.combo).toBe(4);
    }
    expect(state.core.answers).toHaveLength(1);
    expect(state.core.combo).toBe(5);
    expect(state.core.answers[0]?.costPaid).toBe(0);
    expect(state.shellState).toBe('banner.correct');
  });
  it('[INV-SESS-15] opaque input cannot forge prepaid cost or overwrite validated pair state', () => {
    const wrong = step(start(), tap('first', 'l0', 'r1'), deps).state;
    const result = step(
      wrong,
      {
        type: 'input',
        text: '',
        caret: 0,
        gradeable: false,
        partialState: { matchRuntime: { paid: 999, taps: [], matched: [] } },
      },
      deps,
    ).state;
    expect(result.inFlight.partialState['matchRuntime']).toEqual(
      wrong.inFlight.partialState['matchRuntime'],
    );
  });
  it('[INV-SESS-22] rejects missing evidence, unknown IDs and a duplicate already matched pair without side effects', () => {
    const initial = start();
    expect(step(initial, tap('bad', 'unknown', 'r1'), deps).state).toEqual(initial);
    const { matchPairs: _, ...noPairs } = deps;
    expect(step(initial, tap('bad', 'l0', 'r1'), noPairs).state).toEqual(initial);
    const matched = step(initial, tap('ok', 'l0', 'r0'), deps).state;
    expect(step(matched, tap('repeat', 'l0', 'r0'), deps).state).toEqual(matched);
  });
  it('[INV-SESS-15] fuzzes repeated pair deliveries without duplicate immediate payment', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), (deliveries) => {
        let state = start();
        const seen = new Set<string>();
        for (const [index, repeat] of deliveries.entries()) {
          const id = repeat ? 'repeat' : `tap-${index}`;
          seen.add(id);
          state = step(state, tap(id, 'l0', 'r1'), deps).state;
        }
        expect(state.core.hearts).toEqual({ kind: 'pips', total: 20, remaining: 20 - seen.size });
        expect(state.core.answers).toHaveLength(0);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
