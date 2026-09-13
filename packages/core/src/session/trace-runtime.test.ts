import { describe, expect, it } from 'vitest';
import { freshSession, item } from './session-fixture.js';
import { DEFAULT_FLAVOUR_MATRIX } from './flavours.js';
import { step } from './machine.js';
import type { StepDeps } from './machine.js';
import type { SessionState } from './resume.js';
import type { TraceDefinition } from '../grading/trace.js';
const first = [
    { x: 10, y: 20 },
    { x: 90, y: 20 },
  ],
  second = [
    { x: 50, y: 10 },
    { x: 50, y: 90 },
  ];
const definition: TraceDefinition = {
  version: 1,
  source: 'test:source',
  viewBox: { width: 100, height: 100 },
  strokes: [{ points: first }, { points: second }],
};
const deps: StepDeps = {
  config: DEFAULT_FLAVOUR_MATRIX.lesson,
  clock: { nowMs: () => 1 },
  grading: { grade: () => ({ kind: 'wrong' }) },
  isTypeEligible: () => true,
  stepUpTripped: () => false,
  traceDefinition: () => definition,
};
function start(): SessionState {
  const state = freshSession({ queue: [item(1, { type: 'characterTrace' })] });
  return {
    ...state,
    shellState: 'challenge.idle',
    core: { ...state.core, combo: 4, hearts: { kind: 'pips', total: 3, remaining: 3 } },
  };
}
describe('stroke events through the real session', () => {
  it('[INV-SESS-15] [INV-COM-01] a rejected stroke retries in place; accepted strokes survive resume and finish once', () => {
    let state = step(
      start(),
      { type: 'traceStroke', attemptId: 'bad', points: second },
      deps,
    ).state;
    expect(state.inFlight.partialState['traceRuntime']).toMatchObject({
      accepted: 0,
      rejections: 1,
    });
    expect(state.core.hearts).toMatchObject({ remaining: 3 });
    expect(state.core.combo).toBe(4);
    expect(state.core.answers).toHaveLength(0);
    state = step(state, { type: 'traceStroke', attemptId: 'first', points: first }, deps).state;
    state = JSON.parse(JSON.stringify(state)) as SessionState;
    expect(
      step(state, { type: 'traceStroke', attemptId: 'first', points: first }, deps).state,
    ).toEqual(state);
    state = step(state, { type: 'traceStroke', attemptId: 'second', points: second }, deps).state;
    expect(state.shellState).toBe('banner.correct');
    expect(state.core.combo).toBe(5);
    expect(state.core.answers).toHaveLength(1);
    expect(state.core.answers[0]).toMatchObject({ wrong: false, scorable: false, costPaid: 0 });
    expect(state.mistakeRows).toHaveLength(0);
    expect(step(state, { type: 'graded' }, deps).state).toEqual(state);
  });
  it('[INV-MIS-08] eleven rejected strokes produce one weak recognition row and no accuracy miss', () => {
    let state = start();
    for (let n = 0; n < 11; n++)
      state = step(
        state,
        { type: 'traceStroke', attemptId: `wrong${n}`, points: second },
        deps,
      ).state;
    expect(state.weakItemRows).toHaveLength(1);
    expect(state.mistakeRows).toHaveLength(0);
    expect(state.core.answers).toHaveLength(0);
  });
  it('[INV-SESS-15] CHECK and ordinary input cannot forge a completed trace', () => {
    let state = step(
      start(),
      {
        type: 'input',
        text: 'done',
        caret: 4,
        partialState: { traceRuntime: { attempts: [], complete: true, accepted: 2 } },
        gradeable: true,
      },
      deps,
    ).state;
    expect(state.inFlight.partialState['traceRuntime']).toBeUndefined();
    state = step(state, { type: 'check' }, deps).state;
    expect(state.core.answers).toHaveLength(0);
    expect(state.shellState).not.toBe('grading');
  });
});
