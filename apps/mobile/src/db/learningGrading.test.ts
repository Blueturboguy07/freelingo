// @vitest-environment node
import { expect, it } from 'vitest';
import {
  freshSession,
  step,
  DEFAULT_FLAVOUR_MATRIX,
  type Answer,
  type GradeRequest,
  type SessionState,
  type StepDeps,
} from '@freelingo/core/session';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import { ES_PACK, ES_UNIT } from '../../../../packages/core/src/grading/packs/es';
import { JA_PACK, JA_UNIT } from '../../../../packages/core/src/grading/packs/ja';
import { DE_PACK, DE_UNIT } from '../../../../packages/core/src/grading/packs/de';
import { gradeRuntimeItem, schedulerGradeFor, targetsForRuntimeAnswer } from './learningGrading';
function runtime(patch: Partial<VerifiedRuntimeItem> = {}): VerifiedRuntimeItem {
  return {
    schemaVersion: 1,
    exerciseId: 'exercise-1',
    itemId: 'item-1',
    unitId: 'unit-1',
    lessonIndex: 1,
    profileId: 'es',
    responseLanguage: 'es',
    proof: {
      sourceId: 'source-1',
      sourceSha256: 'hash',
      approvalId: 'approval-1',
      approvalSha256: 'hash',
      draftSha256: 'hash',
    },
    gradable: {
      itemId: 'item-1',
      family: 'typed-translate',
      accepted: [{ surface: 'el gato', surfaceId: 'gato', rank: 1 }],
      targetLexemeId: 'gato',
      targetLexemeSurface: 'gato',
    },
    presentation: {
      itemId: 'item-1',
      type: 'typedTranslate',
      instruction: 'Translate',
      prompt: 'the cat',
      language: 'es',
      acceptedAnswers: ['el gato'],
    },
    schedulerSurfaces: [
      { itemId: 'item-1', surfaceId: 'gato', surface: 'el gato', language: 'es', canonical: true },
    ],
    introductions: [],
    explanation: 'A cat.',
    grading: { profileId: 'es', responseLanguage: 'es', pack: ES_PACK, unit: ES_UNIT },
    ...patch,
  };
}
function input(
  r: VerifiedRuntimeItem,
  text: string,
  partial: Record<string, unknown> = {},
): GradeRequest {
  return {
    item: {
      id: 'slot-1',
      itemId: r.itemId,
      type: r.presentation.type,
      family: 'production',
      conceptId: 'gato',
      nodeRef: 'node-1',
      requiresAudio: false,
    },
    raw: text,
    partialState: partial,
    hardMode: false,
  };
}
const learner = { introducedSurfaceIds: new Set<string>(['gato']) };
const base: Answer = {
  exerciseIndex: 0,
  slotId: 'slot-1',
  itemId: 'item-1',
  type: 'typedTranslate',
  verdict: 'correct',
  softCorrected: false,
  wrong: false,
  costPaid: 0,
  skipped: false,
  scorable: true,
  queue: 'main',
  note: null,
};
it.each(['correct', 'softCorrect', 'accepted'] as const)(
  '[INV-SCH-03] maps actual graded %s to Good independently of accuracy participation',
  (verdict) => {
    expect(schedulerGradeFor({ ...base, verdict, scorable: false })).toBe(3);
  },
);
it('[INV-SCH-03] records a lapse, excludes skipped/no-verdict and preserves signed replay indices', () => {
  expect(schedulerGradeFor({ ...base, exerciseIndex: -2, verdict: 'wrong', wrong: true })).toBe(1);
  expect(schedulerGradeFor({ ...base, skipped: true })).toBeNull();
  expect(schedulerGradeFor({ ...base, verdict: 'noVerdict' })).toBeNull();
});
it('[INV-GRD-03] calls the actual three-tier checker and preserves its full verdict', () => {
  const r = runtime();
  expect(gradeRuntimeItem(r, input(r, 'el gato'), learner).session.kind).toBe('correct');
  const soft = gradeRuntimeItem(r, input(r, 'el ga to'), learner);
  expect(soft.feedback.softCorrected).toBe(true);
  expect(soft.session).toEqual({ kind: 'softCorrect', note: soft.feedback.note });
  expect(gradeRuntimeItem(r, input(r, 'el perro'), learner).session.kind).toBe('wrong');
});
it('[INV-GRD-13] uses each exact response profile and never an ambient language fixture', () => {
  const r = runtime({
    gradable: {
      itemId: 'item-1',
      family: 'typed-translate',
      accepted: [{ surface: 'heißt', surfaceId: 's', rank: 1 }],
    },
  });
  const de = { ...r, grading: { ...r.grading, pack: DE_PACK, unit: DE_UNIT } };
  expect(gradeRuntimeItem(de, input(de, 'heisst'), learner).session.kind).toBe('correct');
  expect(gradeRuntimeItem(r, input(r, 'heisst'), learner).session.kind).toBe('wrong');
});
it('[INV-GRD-23] grades bank IDs with the real pack delimiter rather than rendered text', () => {
  const r = runtime({
    gradable: {
      itemId: 'item-1',
      family: 'word-bank',
      accepted: [{ surface: 'ねこです', surfaceId: 's', rank: 1 }],
      tiles: [
        { tileId: 'a', text: 'ねこ' },
        { tileId: 'b', text: 'です' },
      ],
    },
    presentation: { ...runtime().presentation, type: 'wordBankTranslate' },
    grading: { profileId: 'ja', responseLanguage: 'ja', pack: JA_PACK, unit: JA_UNIT },
  });
  expect(
    gradeRuntimeItem(r, input(r, 'ねこ です', { selectedTileIds: ['a', 'b'] }), learner).session
      .kind,
  ).toBe('correct');
  expect(
    gradeRuntimeItem(r, input(r, 'ねこです', { selectedTileIds: ['b', 'a'] }), learner).session
      .kind,
  ).toBe('wrong');
  for (const ids of [
    ['a', 'unknown'],
    ['a', 'a', 'b'],
  ])
    expect(() =>
      gradeRuntimeItem(r, input(r, 'ねこです', { selectedTileIds: ids }), learner),
    ).toThrow(/tile/i);
});
it('[INV-GRD-03] selection must resolve the actual signed option ID, ignoring forged raw answer text', () => {
  const r = runtime({
    gradable: { ...runtime().gradable, family: 'select' },
    presentation: {
      ...runtime().presentation,
      type: 'meaningSelect',
      options: [
        { id: 'a', text: 'el gato' },
        { id: 'b', text: 'el perro' },
      ],
    },
  });
  expect(
    gradeRuntimeItem(r, input(r, 'el gato', { selectedOptionId: 'b' }), learner).session.kind,
  ).toBe('wrong');
  expect(() =>
    gradeRuntimeItem(r, input(r, 'el gato', { selectedOptionId: 'invented' }), learner),
  ).toThrow(/option/i);
});
it('[INV-GRD-05] fixed gaps grade their actual spans and reject omitted multi-gap input', () => {
  const r = runtime({
    gradable: {
      itemId: 'item-1',
      family: 'gap-fill',
      accepted: [],
      gaps: [{ gapId: 'g1', accepted: [{ surface: 'gato', surfaceId: 's', rank: 1 }] }],
    },
    presentation: { ...runtime().presentation, type: 'gapFillTyped' },
  });
  expect(gradeRuntimeItem(r, input(r, 'gato'), learner).session.kind).toBe('correct');
  expect(gradeRuntimeItem(r, input(r, 'el gato'), learner).session.kind).toBe('wrong');
  const multi = {
    ...r,
    gradable: {
      ...r.gradable,
      gaps: [
        ...r.gradable.gaps!,
        { gapId: 'g2', accepted: [{ surface: 'perro', surfaceId: 'p', rank: 1 }] },
      ],
    },
  };
  expect(() => gradeRuntimeItem(multi, input(multi, 'gato'), learner)).toThrow(/gap/i);
  expect(
    gradeRuntimeItem(multi, input(multi, '', { gapAnswers: { g1: 'gato', g2: 'perro' } }), learner)
      .session.kind,
  ).toBe('correct');
});
it('[INV-GRD-08] open response uses keyword/length guard and re-prompts prompt copying without an answer', () => {
  const r = runtime({
    gradable: {
      itemId: 'item-1',
      family: 'read-and-respond',
      accepted: [],
      prompt: 'El gato come',
      requiredLexemeIds: ['gato'],
    },
    presentation: { ...runtime().presentation, type: 'readAndRespond' },
    grading: {
      ...runtime().grading,
      unit: { ...ES_UNIT, openResponseMinimumLength: 3, taughtInflections: { gato: ['gato'] } },
    },
  });
  expect(gradeRuntimeItem(r, input(r, 'El gato come'), learner).session.kind).toBe('noVerdict');
  expect(gradeRuntimeItem(r, input(r, 'Mi gato juega feliz'), learner).session.kind).toBe(
    'accepted',
  );
});
it('[INV-PACK-41] refuses changed semantic/type bindings and unavailable speech proof instead of typed fallback', () => {
  const r = runtime();
  expect(() =>
    gradeRuntimeItem(
      r,
      { ...input(r, 'el gato'), item: { ...input(r, '').item, itemId: 'other' } },
      learner,
    ),
  ).toThrow(/binding/i);
  const speech = runtime({
    gradable: { ...r.gradable, family: 'speaking' },
    presentation: { ...r.presentation, type: 'speakSentence' },
  });
  expect(() => gradeRuntimeItem(speech, input(speech, 'el gato'), learner)).toThrow(/speech/i);
});
it('[INV-GRD-05] a typed gap never ignores malformed explicit answer state', () => {
  const r = runtime({
    gradable: {
      itemId: 'item-1',
      family: 'gap-fill',
      accepted: [],
      gaps: [{ gapId: 'g1', accepted: [{ surface: 'gato', surfaceId: 's', rank: 1 }] }],
    },
    presentation: { ...runtime().presentation, type: 'gapFillTyped' },
  });
  for (const gapAnswers of [
    null,
    [],
    ['gato'],
    { other: 'gato' },
    { g1: 1 },
    { g1: 'gato', extra: 'gato' },
  ])
    expect(() => gradeRuntimeItem(r, input(r, 'gato', { gapAnswers }), learner)).toThrow(/gap/i);
  expect(
    gradeRuntimeItem(r, input(r, 'wrong raw', { gapAnswers: { g1: 'gato' } }), learner).session
      .kind,
  ).toBe('correct');
});

it('[INV-SCH-11] actual accepted Spanish alternate schedules its own signed target surface', () => {
  const r = runtime({
    gradable: {
      ...runtime().gradable,
      accepted: [
        { surface: 'el gato', surfaceId: 'gato', rank: 1 },
        { surface: 'el felino', surfaceId: 'felino', rank: 2 },
      ],
    },
    schedulerSurfaces: [
      { itemId: 'item-1', surfaceId: 'gato', surface: 'el gato', language: 'es', canonical: true },
      {
        itemId: 'item-1',
        surfaceId: 'felino',
        surface: 'el felino',
        language: 'es',
        canonical: false,
      },
    ],
  });
  const grade = gradeRuntimeItem(r, input(r, 'el felino'), learner);
  expect(
    targetsForRuntimeAnswer(r, base, {
      targetLanguage: 'es',
      rubyShown: false,
      responseSurfaceId: grade.responseSurfaceId,
      partialState: {},
    }),
  ).toEqual([
    {
      itemId: 'item-1',
      surfaceId: 'felino',
      surface: 'el felino',
      role: 'production',
      rubyShown: false,
      grade: 3,
    },
  ]);
  expect(() =>
    targetsForRuntimeAnswer({ ...r, schedulerSurfaces: r.schedulerSurfaces.slice(0, 1) }, base, {
      targetLanguage: 'es',
      rubyShown: false,
      responseSurfaceId: grade.responseSurfaceId,
      partialState: {},
    }),
  ).toThrow(/surface/);
});
it('[INV-SCH-11] reverse English responses and real wrong answers retain the declared Spanish canonical source', () => {
  const r = runtime({ responseLanguage: 'en' });
  const options = {
    targetLanguage: 'es',
    rubyShown: false,
    responseSurfaceId: 'english-answer',
    partialState: {},
  };
  expect(targetsForRuntimeAnswer(r, base, options)[0]?.surfaceId).toBe('gato');
  expect(
    targetsForRuntimeAnswer(
      runtime(),
      { ...base, verdict: 'wrong', wrong: true },
      { ...options, responseSurfaceId: null },
    )[0],
  ).toMatchObject({ surfaceId: 'gato', grade: 1 });
  expect(() =>
    targetsForRuntimeAnswer(runtime(), base, { ...options, responseSurfaceId: null }),
  ).toThrow(/matched/);
  expect(targetsForRuntimeAnswer(runtime(), { ...base, skipped: true }, options)).toEqual([]);
});
it('[INV-GRD-20][INV-SCH-11] one actual gap keeps its per-gap approved matched surface in the runtime receipt', () => {
  const accepted = [
    { surface: 'gato', surfaceId: 'cat', rank: 1 },
    { surface: 'felino', surfaceId: 'feline', rank: 2 },
  ];
  const r = runtime({
    gradable: {
      itemId: 'item-1',
      family: 'gap-fill',
      accepted,
      gaps: [{ gapId: 'real-gap', accepted }],
    },
    presentation: {
      ...runtime().presentation,
      type: 'gapFillTyped',
      prompt: 'el ____',
      acceptedAnswers: ['gato', 'felino'],
    },
    schedulerSurfaces: accepted.map((f, i) => ({
      itemId: 'item-1',
      surfaceId: f.surfaceId,
      surface: f.surface,
      language: 'es',
      canonical: i === 0,
    })),
  });
  const grade = gradeRuntimeItem(r, input(r, 'felino'), learner);
  expect(grade.feedback.matchedSurfaceId).toBeNull();
  expect(grade.responseSurfaceId).toBe('feline');
  expect(
    targetsForRuntimeAnswer(
      r,
      { ...base, type: 'gapFillTyped' },
      {
        targetLanguage: 'es',
        rubyShown: false,
        responseSurfaceId: grade.responseSurfaceId,
        partialState: {},
      },
    )[0]?.surface,
  ).toBe('felino');
});
it('[INV-SESS-13][INV-SCH-11] actual grid taps schedule each touched semantic target while accuracy keeps one Answer', () => {
  for (const limited of [false, true]) {
    const pairs = ['gato', 'perro', 'ave', 'pez', 'oso'].map((left, i) => ({
      leftItemId: 'lex:' + i,
      leftId: 'l' + i,
      rightId: 'r' + i,
      left,
      right: 'meaning' + i,
    }));
    const r = runtime({
      gradable: { itemId: 'item-1', family: 'match', accepted: [] },
      presentation: { ...runtime().presentation, type: 'matchPairs', pairs },
      schedulerSurfaces: pairs.map((p) => ({
        itemId: p.leftItemId,
        surfaceId: 'sf:' + p.leftId,
        surface: p.left,
        language: 'es',
        canonical: true,
      })),
    });
    const queue = [{ ...input(r, '').item, family: 'recognition' as const }];
    let state = {
      ...freshSession({ queue }),
      shellState: 'challenge.idle' as const,
    } as SessionState;
    if (limited)
      state = {
        ...state,
        core: { ...state.core, hearts: { kind: 'pips', total: 1, remaining: 1 } },
      };
    const deps: StepDeps = {
      config: DEFAULT_FLAVOUR_MATRIX.lesson,
      clock: { nowMs: () => 0 },
      isTypeEligible: () => true,
      stepUpTripped: () => false,
      matchPairs: () => pairs,
      grading: {
        grade: () => {
          throw Error('grid must grade actual pairs');
        },
      },
    };
    state = step(
      state,
      { type: 'matchPair', attemptId: 'wrong', leftId: 'l0', rightId: 'r1' },
      deps,
    ).state;
    if (!limited)
      for (const p of pairs)
        state = step(
          state,
          {
            type: 'matchPair',
            attemptId: 'correct' + p.leftId,
            leftId: p.leftId,
            rightId: p.rightId,
          },
          deps,
        ).state;
    expect(state.core.answers).toHaveLength(1);
    const targets = targetsForRuntimeAnswer(r, state.core.answers[0]!, {
      targetLanguage: 'es',
      rubyShown: false,
      responseSurfaceId: null,
      partialState: state.inFlight.partialState,
    });
    expect(targets.map((t) => [t.itemId, t.grade])).toEqual(
      limited ? [['lex:0', 1]] : pairs.map((p, i) => [p.leftItemId, i === 0 ? 1 : 3]),
    );
  }
});
