import { readFileSync, writeFileSync } from 'node:fs';
import {
  expect,
  it,
} from '/Users/mannbellani/freelingo-wt/p3-app/node_modules/vitest/dist/index.js';
import { generateSession } from '/Users/mannbellani/freelingo-wt/p3-app/packages/core/src/session/generate.ts';
import { DEFAULT_FLAVOUR_MATRIX } from '/Users/mannbellani/freelingo-wt/p3-app/packages/core/src/session/flavours.ts';
import { exerciseSpec } from '/Users/mannbellani/freelingo-wt/p3-app/packages/core/src/session/registry.ts';
const root =
  '/Users/mannbellani/freelingo-wt/p6-media/content/es/grading/first-unit-20260913-revision-3/bundle';
it('independent exact six-item population meets the real lesson floor without due or audio padding', () => {
  const first = JSON.parse(readFileSync(root + '/first-session.json', 'utf8'));
  const rows = readFileSync(root + '/candidates.jsonl', 'utf8')
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x));
  const candidates = first.exerciseIds.map((id: string) => {
    const d = rows.find((x) => x.draft.record.exercise_id === id).draft,
      spec = exerciseSpec(d.presentation.type);
    return {
      id: 'exercise:' + id,
      itemId: d.presentation.itemId,
      type: d.presentation.type,
      family: spec.family,
      conceptId: d.schedulerObjective.itemRef,
      nodeRef: first.nodeId,
      requiresAudio: spec.requiresAudio,
    };
  });
  const input = {
    sessionId: 'independent-preview',
    courseId: 'en-es',
    nodeRef: first.nodeId,
    flavour: 'lesson',
    candidates,
    seed: 20260913,
    audio: { canProduce: () => false },
    pack: {
      resolves: (id: string) => candidates.some((x: { itemId: string }) => x.itemId === id),
      nodeRefOf: () => first.nodeId,
      assetPresent: () => true,
    },
    modality: { gatedFamilies: () => [] },
    scheduler: {
      commit() {
        throw Error('A preview cannot write');
      },
      duePool: () => [],
      isSeen: () => false,
      openMistakes: () => [],
    },
  } as const;
  const generated = generateSession(input);
  expect(DEFAULT_FLAVOUR_MATRIX.lesson.minLength).toBe(6);
  expect(candidates).toHaveLength(6);
  expect(new Set(candidates.map((c: { itemId: string }) => c.itemId)).size).toBe(6);
  expect(generated).toMatchObject({
    offered: true,
    reason: 'ok',
    droppedForGate: [],
    droppedForAudio: [],
    degraded: [],
  });
  expect(generated.queue.map((q) => q.id)).toEqual(
    first.exerciseIds.map((id: string) => 'exercise:' + id),
  );
  for (let omitted = 0; omitted < 6; omitted++) {
    const shortened = candidates.filter((_: unknown, index: number) => index !== omitted);
    expect(generateSession({ ...input, candidates: shortened })).toMatchObject({
      offered: false,
      reason: 'nothingDue',
      queue: [],
    });
  }

  writeFileSync(
    '/private/tmp/p3-spanish-revision3-review/generation.json',
    JSON.stringify(
      {
        minimum: DEFAULT_FLAVOUR_MATRIX.lesson.minLength,
        authoredCount: candidates.length,
        generated,
      },
      null,
      2,
    ),
  );
});
