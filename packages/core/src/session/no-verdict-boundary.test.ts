import { expect, it } from 'vitest';
import { gradeOpenResponse, gradeTypedAnswer, NO_SURFACES_INTRODUCED } from '../grading/index.js';
import { ES_PACK, ES_UNIT } from '../grading/packs/es.js';
import { JA_PACK, JA_UNIT } from '../grading/packs/ja.js';
import type { Verdict as GradingVerdict } from '../grading/types.js';
import { DEFAULT_FLAVOUR_MATRIX } from './flavours.js';
import { step, type StepDeps } from './machine.js';
import { freshSession, item } from './session-fixture.js';
import type { SessionState } from './resume.js';
function deps(grade: (raw: string) => GradingVerdict): StepDeps {
  return {
    config: DEFAULT_FLAVOUR_MATRIX.lesson,
    clock: { nowMs: () => 2000 },
    isTypeEligible: () => true,
    stepUpTripped: () => false,
    grading: {
      grade: (request) => {
        const v = grade(request.raw);
        return {
          kind: v.writesAttemptRow ? 'accepted' : 'noVerdict',
          ...((v.note ?? v.notArmedReason) === null ? {} : { note: (v.note ?? v.notArmedReason)! }),
        };
      },
    },
  };
}
function state(type: 'readAndRespond' | 'typedTranslate', text: string): SessionState {
  const s = freshSession({ queue: [item(1, { type })] });
  return {
    ...s,
    shellState: 'challenge.armed',
    core: { ...s.core, combo: 5 },
    inFlight: { text, caret: 2, partialState: { draft: ['a', 'b'] }, audioHeardToEnd: true },
  };
}
const open = (reply: string) =>
  gradeOpenResponse({
    pack: ES_PACK,
    unit: { ...ES_UNIT, openResponseMinimumLength: 3, taughtInflections: { gato: ['gato'] } },
    item: {
      itemId: 'item-1',
      family: 'read-and-respond',
      accepted: [],
      prompt: 'El gato come',
      requiredLexemeIds: ['gato'],
    },
    reply,
    path: 'keyword-length',
  });
it.each(['El gato come', 'gato'])(
  '[INV-GRD-10] actual ungraded open response %s remains in place without any answer, cost, combo or progress mutation',
  (text) => {
    const before = state('readAndRespond', text),
      d = deps(open);
    const checking = step(before, { type: 'check' }, d).state;
    const result = step(checking, { type: 'graded' }, d);
    expect(result.state.shellState).toBe('challenge.idle');
    expect(result.state.core).toEqual(before.core);
    expect(result.state.inFlight).toEqual(before.inFlight);
    expect(result.state.progress).toEqual(before.progress);
    expect(result.state.mistakes).toEqual(before.mistakes);
    expect(result.writes).toEqual([]);
    expect(result.state.lastVerdict).toEqual({
      kind: 'noVerdict',
      note: open(text).notArmedReason,
    });
  },
);
it('[INV-GRD-14] zero target-script typed input keeps the exact draft and produces no attempt', () => {
  const before = state('typedTranslate', '123'),
    d = deps((answer) =>
      gradeTypedAnswer({
        pack: JA_PACK,
        unit: JA_UNIT,
        item: {
          itemId: 'item-1',
          family: 'typed-translate',
          accepted: [{ surface: 'ねこ', surfaceId: 'kana', rank: 1 }],
        },
        learner: NO_SURFACES_INTRODUCED,
        answer,
      }),
    );
  const result = step(step(before, { type: 'check' }, d).state, { type: 'graded' }, d);
  expect(result.state.shellState).toBe('challenge.idle');
  expect(result.state.core.answers).toEqual([]);
  expect(result.state.inFlight).toEqual(before.inFlight);
  expect(result.writes).toEqual([]);
});
it('[INV-GRD-08] correcting an ungraded draft can complete exactly once through the real checker', () => {
  const d = deps(open),
    before = state('readAndRespond', 'El gato come');
  const retry = step(step(before, { type: 'check' }, d).state, { type: 'graded' }, d).state;
  const entered = step(
    retry,
    { type: 'input', text: 'Mi gato juega feliz', caret: 19, partialState: {}, gradeable: true },
    d,
  ).state;
  const graded = step(step(entered, { type: 'check' }, d).state, { type: 'graded' }, d).state;
  expect(graded.core.answers).toHaveLength(1);
  expect(graded.core.answers[0]?.verdict).toBe('accepted');
  expect(graded.shellState).toBe('banner.correct');
  expect(step(graded, { type: 'graded' }, d).state.core.answers).toHaveLength(1);
});
