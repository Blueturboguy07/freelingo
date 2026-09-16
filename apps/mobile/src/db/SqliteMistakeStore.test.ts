// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { migrate, type Db } from '@freelingo/schema';
import { toLocalDay } from '@freelingo/core/day';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import {
  freshSession,
  step,
  DEFAULT_FLAVOUR_MATRIX,
  type SessionState,
  type StepDeps,
} from '@freelingo/core/session';
import {
  applyEncounter,
  asItemId,
  asSessionId,
  emptySchedulerState,
  registerRows,
  introduce,
  rowAt,
} from '@freelingo/core/scheduler';
import { ES_PACK, ES_UNIT } from '../../../../packages/core/src/grading/packs/es';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import type { LearningSchedulerTransition } from './learningTransitions';
import { SqliteSchedulerStore } from './SqliteSchedulerStore';
import { SqliteMistakeStore } from './SqliteMistakeStore';
import { readPracticeMistakeOrigins } from './learningHubSources';
import type { LearningLaunch } from './SqliteLearningContextStore';
const opened: Db[] = [];
afterEach(() => {
  opened.forEach((d) => d.close());
  opened.length = 0;
});
const at = Date.parse('2026-09-13T12:00:00Z');
function setup() {
  const db = createNodeDb();
  opened.push(db);
  migrate(db);
  db.run("INSERT INTO course_progress(course_id,added_at) VALUES('en-es','2026-09-13')");
  db.run("INSERT INTO course_item(course_id,item_id,countable) VALUES('en-es','item',0)");
  const item: VerifiedRuntimeItem = {
    schemaVersion: 1,
    exerciseId: 'exercise',
    itemId: 'item',
    unitId: 'u1',
    lessonIndex: 1,
    profileId: 'es',
    responseLanguage: 'es',
    proof: {
      sourceId: 's',
      sourceSha256: 'a',
      approvalId: 'r',
      approvalSha256: 'b',
      draftSha256: 'c',
    },
    gradable: {
      itemId: 'item',
      family: 'typed-translate',
      accepted: [{ surfaceId: 'sf:cat', surface: 'gato', rank: 1 }],
    },
    presentation: {
      itemId: 'item',
      type: 'typedTranslate',
      prompt: 'cat',
      promptLanguage: 'en',
      language: 'es',
      instruction: 'Translate',
      acceptedAnswers: ['gato'],
    },
    schedulerSurfaces: [
      {
        itemId: 'item',
        surfaceId: 'sf:cat',
        surface: 'gato',
        language: 'es',
        kind: 'lexeme',
        itemRef: 'concept',
        canonical: true,
      },
    ],
    lexicalBindings: [],
    introductions: [],
    explanation: 'cat',
    grading: { pack: ES_PACK, unit: ES_UNIT, profileId: 'es', responseLanguage: 'es' },
  };
  let scheduler = registerRows(emptySchedulerState('UTC'), [
    { itemId: asItemId('item'), surface: 'gato', kind: 'lexeme' },
  ]);
  scheduler = introduce(scheduler, asItemId('item'), 'gato', new Date(at - 86400000));
  new SqliteSchedulerStore(db).save('en-es', scheduler);
  let now = at;
  const deps = (wrong: boolean, accepted = false): StepDeps => ({
    config: DEFAULT_FLAVOUR_MATRIX.lesson,
    clock: { nowMs: () => 100 },
    isTypeEligible: () => false,
    stepUpTripped: () => false,
    grading: { grade: () => ({ kind: accepted ? 'accepted' : wrong ? 'wrong' : 'correct' }) },
  });
  const start = (sessionId: string): SessionState => ({
    ...freshSession({
      sessionId,
      courseId: 'en-es',
      nodeRef: 'node',
      queue: [
        {
          id: 'slot',
          itemId: 'item',
          type: 'typedTranslate',
          family: 'production',
          conceptId: 'concept',
          nodeRef: 'node',
          requiresAudio: false,
        },
      ],
    }),
    shellState: 'challenge.idle',
  });
  const grade = (state: SessionState, wrong: boolean, accepted = false) => {
    const inputState: SessionState = accepted
      ? {
          ...state,
          core: {
            ...state.core,
            queue: state.core.queue.map((slot) => ({
              ...slot,
              type: 'readAndRespond',
              family: 'discourse',
            })),
          },
        }
      : state;
    let s = step(
      inputState,
      {
        type: 'input',
        text: wrong ? 'perro' : 'gato',
        caret: 4,
        partialState: {},
        gradeable: true,
      },
      deps(wrong, accepted),
    ).state;
    s = step(s, { type: 'check' }, deps(wrong, accepted)).state;
    return step(s, { type: 'graded' }, deps(wrong, accepted)).state;
  };
  const persist = (state: SessionState) => {
    const answer = state.core.answers.at(-1)!;
    const served: VerifiedRuntimeItem =
      answer.type === 'readAndRespond'
        ? {
            ...item,
            exerciseId: 'exercise-open',
            gradable: { ...item.gradable, family: 'read-and-respond' },
            presentation: { ...item.presentation, type: 'readAndRespond' },
          }
        : item;
    const target = {
        itemId: 'item',
        surfaceId: 'sf:cat',
        surface: 'gato',
        role: 'production' as const,
        rubyShown: false,
        grade: answer.wrong ? (1 as const) : (3 as const),
      },
      receipt = {
        slotId: answer.slotId,
        exerciseId: served.exerciseId,
        itemId: 'item',
        surface: 'gato',
        role: 'production' as const,
        rubyShown: false,
        exerciseIndex: answer.exerciseIndex,
        answeredAtUtcMs: now,
        answeredLocalDay: toLocalDay(new Date(now).toISOString().slice(0, 10)),
        activeMs: 100,
      };
    const beforeState = new SqliteSchedulerStore(db).load('en-es', 'UTC'),
      before = rowAt(beforeState, asItemId('item'), 'gato')!;
    const result = applyEncounter(beforeState, {
      sessionId: asSessionId(state.sessionId),
      exerciseIndex: answer.exerciseIndex,
      itemId: asItemId('item'),
      surface: 'gato',
      targetSurfaceId: 'sf:cat',
      role: 'production',
      grade: target.grade,
      at: new Date(now),
      rubyShown: false,
    });
    new SqliteSchedulerStore(db).save('en-es', result.state, [
      {
        sessionId: state.sessionId,
        exerciseId: served.exerciseId,
        packContentHash: 'a'.repeat(64),
        answer,
        surface: 'gato',
        role: 'production',
        rubyShown: false,
        answeredAtUtc: new Date(now).toISOString(),
        activeMs: 100,
        targets: [target],
      },
    ]);
    const transition: LearningSchedulerTransition = {
      courseId: 'en-es',
      sessionId: state.sessionId,
      answerOrdinal: state.core.answers.length - 1,
      targetPosition: 0,
      answer,
      receipt,
      target,
      runtimeItem: served,
      packContentHash: 'a'.repeat(64),
      before,
      after: rowAt(result.state, asItemId('item'), 'gato')!,
      review: result.review,
      wroteAttempt: result.wroteAttempt,
    };
    now += 86400000;
    const launch: LearningLaunch = {
      courseId: state.courseId,
      sessionKind: state.sessionKind,
      nodeRef: state.nodeRef,
      start: {
        sessionId: state.sessionId,
        startedAtUtcMs: at,
        startedAtMonotonicMs: 0,
        startZone: { tzId: 'UTC', utcOffsetMinutes: 0, tzSource: 'iana' },
      },
      economyFlavour: state.flavour,
      practiceItemRatio: 1,
      longFormEntry: null,
      boostAtStart: null,
      packContentHash: 'a'.repeat(64),
      origin: { kind: 'path' },
      targetNodeId: state.nodeRef,
    };
    return { state, transitions: [transition], launch };
  };
  return { db, start, grade, persist, store: new SqliteMistakeStore(db), deps };
}
it('[INV-MIS-04] actual miss and in-session replay survive reload without earning retirement', () => {
  const f = setup();
  let s = f.grade(f.start('one'), true);
  const first = f.persist(s);
  f.store.apply(first);
  expect(f.store.load('en-es')[0]?.row).toMatchObject({
    createdInSessionId: 'one',
    reviewStreak: 0,
  });
  s = step(s, { type: 'continue' }, f.deps(false)).state;
  s = step(s, { type: 'continue' }, f.deps(false)).state;
  s = f.grade(s, false);
  expect(s.core.answers.at(-1)?.queue).toBe('mistakes');
  f.store.apply(f.persist(s));
  const saved = new SqliteMistakeStore(f.db).load('en-es')[0]!;
  expect(saved.row.reviewStreak).toBe(0);
  expect(saved.retiredAtUtcMs).toBeNull();
});
it('[INV-MIS-04] two later actual correct encounters retire and any intervening wrong resets the core streak', () => {
  const f = setup();
  f.store.apply(f.persist(f.grade(f.start('one'), true)));
  f.store.apply(f.persist(f.grade(f.start('two'), false)));
  expect(f.store.load('en-es')[0]?.row.reviewStreak).toBe(1);
  f.store.apply(f.persist(f.grade(f.start('three'), true)));
  expect(f.store.load('en-es')[0]?.row.reviewStreak).toBe(0);
  f.store.apply(f.persist(f.grade(f.start('four'), false)));
  f.store.apply(f.persist(f.grade(f.start('five'), false)));
  const saved = f.store.load('en-es')[0]!;
  expect(saved.row.reviewStreak).toBe(2);
  expect(saved.retiredAtUtcMs).not.toBeNull();
  expect(saved.misses).toBe(2);
});
it('[INV-MIS-04][INV-PER-03] exact encounter replay is idempotent and mismatched targets preserve receipts', () => {
  const f = setup(),
    input = f.persist(f.grade(f.start('one'), true));
  f.store.apply(input);
  const before = f.db.all('SELECT * FROM course_mistake_encounter');
  f.store.apply(input);
  expect(f.db.all('SELECT * FROM course_mistake_encounter')).toEqual(before);
  expect(() =>
    f.store.apply({
      ...input,
      transitions: [
        { ...input.transitions[0]!, target: { ...input.transitions[0]!.target, grade: 3 } },
      ],
    }),
  ).toThrow();
  expect(f.db.all('SELECT * FROM course_mistake_encounter')).toEqual(before);
});
it('[INV-MIS-04][INV-PER-03] malformed cache or unproved live legacy backlog is recoverable and retained', () => {
  const f = setup();
  f.store.apply(f.persist(f.grade(f.start('one'), true)));
  f.db.run('UPDATE course_mistake_state SET review_streak=1');
  expect(() => f.store.load('en-es')).toThrow(/cache|history/);
  expect(f.db.get('SELECT review_streak FROM course_mistake_state')?.review_streak).toBe(1);
  const legacy = setup();
  legacy.db.run(
    "INSERT INTO course_mistake(course_id,session_id,exercise_index,item_id,created_at) VALUES('en-es','old',0,'item','2020-01-01')",
  );
  expect(() => legacy.store.load('en-es')).toThrow(/legacy|history/);
  expect(legacy.db.all('SELECT * FROM course_mistake')).toHaveLength(1);
});
it('[INV-MIS-04][INV-PER-03] cache write failure rolls back the corresponding immutable encounter', () => {
  const f = setup(),
    input = f.persist(f.grade(f.start('one'), true));
  f.db.run(
    "CREATE TRIGGER kill_mistake BEFORE INSERT ON course_mistake_state BEGIN SELECT RAISE(ABORT,'kill mistake'); END",
  );
  expect(() => f.store.apply(input)).toThrow();
  expect(f.db.all('SELECT * FROM course_mistake_encounter')).toEqual([]);
  f.db.run('DROP TRIGGER kill_mistake');
  f.store.apply(input);
  expect(f.store.load('en-es')).toHaveLength(1);
});

it('[INV-MIS-04] a retired mistake begins a new proven lifecycle only after another actual miss', () => {
  const f = setup();
  for (const [id, wrong] of [
    ['one', true],
    ['two', false],
    ['three', false],
  ] as const)
    f.store.apply(f.persist(f.grade(f.start(id), wrong)));
  expect(f.store.load('en-es')[0]?.row.reviewStreak).toBe(2);
  f.store.apply(f.persist(f.grade(f.start('four'), true)));
  const saved = f.store.load('en-es')[0]!;
  expect(saved.row).toMatchObject({ createdInSessionId: 'four', reviewStreak: 0 });
  expect(saved.retiredAtUtcMs).toBeNull();
  expect(saved.misses).toBe(1);
  expect(f.db.all('SELECT * FROM course_mistake_encounter')).toHaveLength(4);
});
it('[INV-MIS-05] a real correct encounter without an existing mistake invents no backlog entry', () => {
  const f = setup();
  f.store.apply(f.persist(f.grade(f.start('correct-only'), false)));
  expect(f.store.load('en-es')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_mistake_encounter')).toEqual([]);
});

it('[INV-MIS-04][INV-GRD-08] actual non-binary accepted grades advance an existing mistake under the same core rule', () => {
  const f = setup();
  f.store.apply(f.persist(f.grade(f.start('one'), true)));
  const accepted = f.grade(f.start('two'), false, true);
  expect(accepted.core.answers.at(-1)).toMatchObject({
    type: 'readAndRespond',
    verdict: 'accepted',
    scorable: false,
    costPaid: 0,
  });
  f.store.apply(f.persist(accepted));
  expect(f.store.load('en-es')[0]?.row.reviewStreak).toBe(1);
});

it('[INV-HUB-09][INV-MIS-07] Hub alternative forms use the actual latest miss, not a later accepted review', () => {
  const f = setup();
  f.store.apply(f.persist(f.grade(f.start('hub-origin'), true)));
  expect(readPracticeMistakeOrigins(f.db, 'en-es').get('item')).toBe('typedTranslate');
  f.store.apply(f.persist(f.grade(f.start('hub-review-one'), false, true)));
  const before = f.db.get('SELECT total_changes() AS n');
  expect(readPracticeMistakeOrigins(f.db, 'en-es').get('item')).toBe('typedTranslate');
  expect(f.db.get('SELECT total_changes() AS n')).toEqual(before);
  f.store.apply(f.persist(f.grade(f.start('hub-review-two'), false, true)));
  expect(readPracticeMistakeOrigins(f.db, 'en-es').size).toBe(0);
});
it('[INV-HUB-09][INV-MIS-07] corrupted normalized mistake history cannot advertise an alternative source', () => {
  const f = setup();
  f.store.apply(f.persist(f.grade(f.start('hub-origin'), true)));
  f.db.run("UPDATE course_mistake_state SET misses=99 WHERE course_id='en-es'");
  expect(() => readPracticeMistakeOrigins(f.db, 'en-es')).toThrow(/cache differs/);
});

it('[INV-MIS-01][INV-ECO-09] mode boundary rejects an engine and economy mismatch before writing a mistake', () => {
  const f = setup();
  const graded = f.grade(f.start('hub-words'), true),
    input = f.persist(graded);
  const launch: LearningLaunch = {
    ...input.launch,
    economyFlavour: 'hubWords',
    origin: { kind: 'hub', offerId: 'words', localDay: toLocalDay('2026-09-13') },
    targetNodeId: null,
  };
  expect(() => f.store.apply({ ...input, launch })).toThrow(/engine.*economy/);
  expect(f.db.all('SELECT * FROM course_mistake_encounter')).toEqual([]);
});

it('[INV-HUB-09][INV-MIS-07] later retirement and a new lifecycle cannot rewrite the exact mistake form available at launch', () => {
  const f = setup();
  f.store.apply(f.persist(f.grade(f.start('historical-origin'), true)));
  f.store.apply(f.persist(f.grade(f.start('historical-review1'), false, true)));
  f.store.apply(f.persist(f.grade(f.start('historical-review2'), false, true)));
  expect(readPracticeMistakeOrigins(f.db, 'en-es').size).toBe(0);
  const before = f.db.get('SELECT total_changes() AS n');
  expect(readPracticeMistakeOrigins(f.db, 'en-es', at).get('item')).toBe('typedTranslate');
  expect(readPracticeMistakeOrigins(f.db, 'en-es', at - 1).size).toBe(0);
  expect(readPracticeMistakeOrigins(f.db, 'en-es', at + 2 * 86400000).size).toBe(0);
  expect(f.db.get('SELECT total_changes() AS n')).toEqual(before);
  f.store.apply(f.persist(f.grade(f.start('new-origin'), true)));
  expect(readPracticeMistakeOrigins(f.db, 'en-es').get('item')).toBe('typedTranslate');
  expect(readPracticeMistakeOrigins(f.db, 'en-es', at + 2 * 86400000).size).toBe(0);
});
