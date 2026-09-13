// @vitest-environment node
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  freshSession,
  step,
  DEFAULT_FLAVOUR_MATRIX,
  type GradeRequest,
  type StepDeps,
  type SessionState,
} from '@freelingo/core/session';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import { ES_PACK, ES_UNIT } from '../../../../packages/core/src/grading/packs/es';
import { gradeRuntimeItem, targetsForRuntimeAnswer, schedulerGradeFor } from './learningGrading';
const surface = 'Quiero agua.';
const surfaceId =
  'sf_' +
  createHash('sha256')
    .update(JSON.stringify(['es', surface]))
    .digest('hex')
    .slice(0, 32);
function source(): VerifiedRuntimeItem {
  return {
    schemaVersion: 1,
    exerciseId: 'spoken-exercise',
    itemId: 'spoken-aggregate',
    unitId: 'u1',
    lessonIndex: 1,
    profileId: 'es',
    responseLanguage: 'es',
    proof: {
      sourceId: 'spoken-source',
      sourceSha256: '1'.repeat(64),
      approvalId: 'review',
      approvalSha256: '2'.repeat(64),
      draftSha256: '3'.repeat(64),
    },
    gradable: {
      itemId: 'spoken-aggregate',
      family: 'speaking',
      accepted: [{ surface, surfaceId, rank: 1 }],
    },
    presentation: {
      itemId: 'spoken-aggregate',
      type: 'speakSentence',
      instruction: 'Say it',
      prompt: surface,
      promptLanguage: 'es',
      language: 'es',
      acceptedAnswers: [surface],
    },
    schedulerSurfaces: [
      {
        itemId: 'spoken-aggregate',
        surfaceId,
        surface,
        language: 'es',
        canonical: true,
        kind: 'lexeme',
        itemRef: 'agua',
      },
    ],
    lexicalBindings: [],
    introductions: [],
    explanation: 'An original reviewed request for water.',
    grading: { pack: ES_PACK, unit: ES_UNIT, profileId: 'es', responseLanguage: 'es' },
    speech: {
      schemaVersion: 1,
      language: 'es',
      ledgerUnit: 'lemma',
      policy: {
        algorithm: 'stored-unit-f1-v1',
        threshold: 0.7,
        fallback: 'normalized-levenshtein-v1',
        fallbackThreshold: 0.7,
        ignoredPunctuation: ['.', '?', '!'],
        fillers: ['eh'],
      },
      references: [
        {
          surfaceId,
          text: surface,
          tokens: [
            { unit: 'querer', surface: 'Quiero', start: 0, end: 6 },
            { unit: 'agua', surface: 'agua', start: 7, end: 11 },
          ],
          sourceId: 'spoken-source',
          sourceSha256: '1'.repeat(64),
          analysisSha256: '2'.repeat(64),
          adapterFingerprint: 'independent-test-token-spans',
        },
      ],
    },
  };
}
const learner = { introducedSurfaceIds: new Set<string>([surfaceId]) };
const item = {
  id: 'spoken-slot',
  itemId: 'spoken-aggregate',
  type: 'speakSentence',
  family: 'speaking',
  conceptId: 'agua',
  nodeRef: 'node-1',
  requiresAudio: false,
} as const;
function input(raw: string, partialState: Record<string, unknown> = {}): GradeRequest {
  return { item, raw, partialState, hardMode: false };
}
it('[INV-MOD-13] forwards only actual recognizer segments to the stored-token speech grader', () => {
  const result = gradeRuntimeItem(
    source(),
    input('agua Quiero.', {
      segments: [
        { segment: 'agua', startTimeMillis: 0, endTimeMillis: 100, confidence: -1 },
        { segment: 'Quiero.', startTimeMillis: 100, endTimeMillis: 200, confidence: 0.5 },
      ],
    }),
    learner,
  );
  expect(result.session.kind).toBe('correct');
  expect(result.speech).toMatchObject({
    method: 'token-f1',
    score: 1,
    matchedSurfaceId: surfaceId,
    heartCost: 0,
  });
  expect(result.feedback).toBeNull();
  expect(result.responseSurfaceId).toBe(surfaceId);
});
it('[INV-MOD-13] absent segments use the declared character fallback without manufacturing tokens', () => {
  expect(gradeRuntimeItem(source(), input(surface), learner).speech).toMatchObject({
    method: 'character-fallback',
    accepted: true,
  });
  expect(gradeRuntimeItem(source(), input('un perro azul'), learner).session.kind).toBe('wrong');
  expect(gradeRuntimeItem(source(), input(''), learner)).toMatchObject({
    session: { kind: 'noVerdict' },
    speech: { outcome: 'no-audio' },
    responseSurfaceId: null,
  });
});
it.each([
  null,
  {},
  [null],
  new Array(1),
  [{ segment: 'agua', startTimeMillis: 0, endTimeMillis: 10 }],
])(
  '[INV-PER-03] malformed present speech segments remain a recoverable source error (%s)',
  (segments) => {
    expect(() => gradeRuntimeItem(source(), input(surface, { segments }), learner)).toThrow(
      /segments/,
    );
  },
);
it('[INV-MOD-13] missing or invalid reviewed speech evidence cannot fall back to accepted text', () => {
  const { speech: _speech, ...missing } = source();
  expect(() => gradeRuntimeItem(missing, input(surface), learner)).toThrow(/speech/);
  const value = source();
  expect(() =>
    gradeRuntimeItem(
      {
        ...value,
        speech: {
          ...value.speech!,
          references: [{ ...value.speech!.references[0]!, sourceSha256: 'bad' }],
        },
      },
      input(surface),
      learner,
    ),
  ).toThrow(/speech evidence/);
});
it('[INV-MOD-13] actual engine retries a rejected capture and grades a later accepted capture once', () => {
  const runtime = source();
  const deps: StepDeps = {
    config: DEFAULT_FLAVOUR_MATRIX.lesson,
    clock: { nowMs: () => 100 },
    grading: { grade: (request) => gradeRuntimeItem(runtime, request, learner).session },
    isTypeEligible: () => true,
    stepUpTripped: () => false,
  };
  let state: SessionState = {
    ...freshSession({
      sessionId: 'speech-session',
      courseId: 'en-es',
      nodeRef: 'node-1',
      queue: [item],
    }),
    shellState: 'challenge.idle' as const,
  };
  const submit = (id: string, transcript: string) => {
    state = step(
      state,
      {
        type: 'speechResult',
        eventId: id,
        slotId: item.id,
        itemId: item.itemId,
        transcript,
        amplitude: 0.5,
      },
      deps,
    ).state;
    state = step(state, { type: 'check' }, deps).state;
    state = step(state, { type: 'graded' }, deps).state;
  };
  submit('capture-1', 'un perro azul');
  expect(state.core.answers).toEqual([]);
  expect(state.modality.observations.at(-1)?.reviewKind).toBe('pronunciation_failure');
  submit('capture-2', surface);
  expect(state.core.answers).toHaveLength(1);
  const answer = state.core.answers[0]!;
  expect(answer.scorable).toBe(false);
  expect(schedulerGradeFor(answer)).toBe(3);
  expect(
    targetsForRuntimeAnswer(runtime, answer, {
      targetLanguage: 'es',
      rubyShown: false,
      responseSurfaceId: surfaceId,
      partialState: {},
    }),
  ).toEqual([
    { itemId: runtime.itemId, surfaceId, surface, role: 'production', rubyShown: false, grade: 3 },
  ]);
});
