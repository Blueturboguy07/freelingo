import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  expect,
  it,
} from '/Users/mannbellani/freelingo-wt/p3-app/node_modules/vitest/dist/index.js';
import { generateSession } from '/Users/mannbellani/freelingo-wt/p3-app/packages/core/src/session/generate.ts';
import { DEFAULT_FLAVOUR_MATRIX } from '/Users/mannbellani/freelingo-wt/p3-app/packages/core/src/session/flavours.ts';
import { exerciseSpec } from '/Users/mannbellani/freelingo-wt/p3-app/packages/core/src/session/registry.ts';
import {
  asItemId,
  roleOfExerciseType,
} from '/Users/mannbellani/freelingo-wt/p3-app/packages/core/src/scheduler/types.ts';
import {
  EMPTY_INTRODUCTION_LEDGER,
  introductionRecordFor,
  planIntroductions,
  productionAllowedAt,
  recordIntroduction,
} from '/Users/mannbellani/freelingo-wt/p3-app/packages/core/src/scheduler/introduction.ts';
import { DEFAULT_SCHEDULER_ECONOMY } from '/Users/mannbellani/freelingo-wt/p3-app/packages/core/src/scheduler/config.ts';
import { localDayOf } from '/Users/mannbellani/freelingo-wt/p3-app/packages/core/src/day/civil.ts';

const root = fileURLToPath(new URL('../bundle/', import.meta.url));
const first = JSON.parse(readFileSync(root + 'first-session.json', 'utf8'));
const rows = readFileSync(root + 'candidates.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const selected = first.exerciseIds.map((id: string) =>
  rows.find((row) => row.draft.record.exercise_id === id),
);
function generate(population = selected) {
  const candidates = population.map((row) => {
    const d = row.draft,
      spec = exerciseSpec(d.presentation.type);
    return {
      id: 'exercise:' + d.record.exercise_id,
      itemId: d.presentation.itemId,
      type: d.presentation.type,
      family: spec.family,
      conceptId: d.schedulerObjective.itemRef,
      nodeRef: first.nodeId,
      requiresAudio: spec.requiresAudio,
    };
  });
  return generateSession({
    sessionId: 'revision3-exact-author-population',
    courseId: 'en-es',
    nodeRef: first.nodeId,
    flavour: 'lesson',
    candidates,
    seed: 20260913,
    audio: { canProduce: () => false },
    pack: {
      resolves: (id) => candidates.some((row) => row.itemId === id),
      nodeRefOf: (id) => (candidates.some((row) => row.itemId === id) ? first.nodeId : null),
      assetPresent: (id) => {
        const row = population.find((row) => row.draft.presentation.itemId === id);
        return !!row && !(row.draft.presentation.options ?? []).some((option) => option.imageUri);
      },
    },
    modality: { gatedFamilies: () => [] },
    scheduler: {
      commit() {
        throw new Error('Read-only generation must never commit');
      },
      duePool: () => [],
      isSeen: () => false,
      openMistakes: () => [],
    },
  });
}

it('[INV-SESS-26] exact six authored recognition variants meet the unchanged real lesson floor', () => {
  expect(DEFAULT_FLAVOUR_MATRIX.lesson.minLength).toBe(6);
  expect(selected).toHaveLength(6);
  expect(new Set(selected.map((row) => row.draft.presentation.itemId)).size).toBe(6);
  expect(selected.map((row) => row.draft.presentation.type)).toEqual(
    Array(6).fill('meaningSelect'),
  );
  const result = generate();
  expect(result.offered).toBe(true);
  expect(result.queue.map((row) => row.itemId)).toEqual(
    selected.map((row) => row.draft.presentation.itemId),
  );
  expect(result).toMatchObject({ droppedForGate: [], droppedForAudio: [], degraded: [] });
  writeFileSync(
    fileURLToPath(new URL('./generation.json', import.meta.url)),
    JSON.stringify(
      {
        candidatesSha256: createHash('sha256')
          .update(readFileSync(root + 'candidates.jsonl'))
          .digest('hex'),
        minimum: DEFAULT_FLAVOUR_MATRIX.lesson.minLength,
        source:
          'actual generateSession with exact authored resolver population; not an installed-pack approval',
        result,
      },
      null,
      2,
    ) + '\n',
  );
});

it('[INV-SESS-26] removing any authored candidate still blocks a five-item draw without due padding', () => {
  for (let i = 0; i < selected.length; i++) {
    expect(generate(selected.filter((_, index) => index !== i))).toMatchObject({
      offered: false,
      reason: 'nothingDue',
      queue: [],
    });
  }
});

it('[INV-SCH-10][INV-SCH-11] six real scheduler items fit the fresh budget while production stays delayed', () => {
  const at = new Date('2026-09-13T17:00:00Z'),
    day = localDayOf(at, 'America/Chicago');
  const ids = selected.map((row) => asItemId(row.draft.schedulerSurfaces[0].itemId));
  expect(DEFAULT_SCHEDULER_ECONOMY.maxNewItemsPerLocalDay).toBe(40);
  expect(DEFAULT_SCHEDULER_ECONOMY.minHoursBetweenIntroductionAndProduction).toBe(4);
  expect(planIntroductions(EMPTY_INTRODUCTION_LEDGER, day, ids)).toEqual(ids);
  expect(new Set(selected.map((row) => row.draft.lexicalBindings[0].wordItemId)).size).toBe(5);
  let ledger = EMPTY_INTRODUCTION_LEDGER;
  for (const row of selected) {
    const id = asItemId(row.draft.schedulerSurfaces[0].itemId);
    expect(roleOfExerciseType(row.draft.presentation.type)).toBe('recognition');
    expect(productionAllowedAt(ledger, id, at)).toBe(false);
    ledger = recordIntroduction(
      ledger,
      introductionRecordFor(id, row.draft.presentation.prompt, at, 'America/Chicago'),
    );
    expect(productionAllowedAt(ledger, id, new Date(at.getTime() + 4 * 3_600_000 - 1))).toBe(false);
    expect(productionAllowedAt(ledger, id, new Date(at.getTime() + 4 * 3_600_000))).toBe(true);
  }
  expect(ledger.firstExposuresByDay.get(day)?.size).toBe(6);
});
