// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { migrate, type Db } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { freshSession, DEFAULT_FLAVOUR_MATRIX, type SessionState } from '@freelingo/core/session';
import { ES_PACK, ES_UNIT } from '../../../../packages/core/src/grading/packs/es';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import { SqliteSessionStore } from './SqliteSessionStore';
import { SqliteLearningContextStore } from './SqliteLearningContextStore';
import { SqliteSchedulerStore } from './SqliteSchedulerStore';
import { SqliteWordStore } from './SqliteWordStore';
import { fixtureLexemes, observeFixtureLexemes } from './learningCompletion.fixtures';
import { emptySchedulerState, registerRows, introduce, asItemId } from '@freelingo/core/scheduler';
import { SqliteLearningRuntime } from './SqliteLearningRuntime';
const opened: Db[] = [];
afterEach(() => {
  for (const db of opened) db.close();
  opened.length = 0;
});
const at = Date.parse('2026-09-13T12:00:00Z');
const zone = { tzId: 'UTC', utcOffsetMinutes: 0, tzSource: 'iana' } as const;
function setup() {
  const db = createNodeDb();
  opened.push(db);
  migrate(db);
  new SqliteWordStore(db).initializeFreshHistory(at, { databaseWasCreated: true });
  db.run("INSERT INTO course_progress(course_id,added_at) VALUES('en-es','2026-09-13')");
  db.run("INSERT INTO course_selection(course_id,is_active,is_selected) VALUES('en-es',1,1)");
  db.run(
    'UPDATE course_progress SET pack_content_hash=?,score_unlocked=0,score_ceiling_beat_shown=0',
    ['a'.repeat(64)],
  );
  db.run("INSERT INTO course_path_state VALUES('en-es',100,0,0)");
  db.run('UPDATE account SET selection_seed=1');
  const item: VerifiedRuntimeItem = fixtureLexemes({
    schemaVersion: 1,
    exerciseId: 'exercise-1',
    itemId: 'semantic-1',
    unitId: 'u1',
    lessonIndex: 1,
    profileId: 'es',
    responseLanguage: 'es',
    proof: {
      sourceId: 'source',
      sourceSha256: 'a',
      approvalId: 'review',
      approvalSha256: 'b',
      draftSha256: 'c',
    },
    gradable: {
      itemId: 'semantic-1',
      family: 'typed-translate',
      accepted: [{ surface: 'el gato', surfaceId: 'sf:gato', rank: 1 }],
    },
    presentation: {
      itemId: 'semantic-1',
      type: 'typedTranslate',
      instruction: 'Translate',
      prompt: 'the cat',
      promptLanguage: 'en',
      language: 'es',
      acceptedAnswers: ['el gato', 'el felino'],
    },
    schedulerSurfaces: [
      {
        itemId: 'semantic-1',
        surfaceId: 'sf:gato',
        surface: 'el gato',
        language: 'es',
        kind: 'lexeme',
        itemRef: 'gato',
        canonical: true,
      },
    ],
    lexicalBindings: [],
    introductions: [
      { surfaceId: 'sf:en-cat', surface: 'the cat', language: 'en', when: 'prompt' },
      { surfaceId: 'sf:gato', surface: 'el gato', language: 'es', when: 'wrong-feedback' },
    ],
    explanation: 'cat',
    grading: { pack: ES_PACK, unit: ES_UNIT, profileId: 'es', responseLanguage: 'es' },
  });
  let pack = {
    courseId: 'en-es',
    contentHash: 'a'.repeat(64),
    pack: {
      meta: { lang: 'es', courseId: 'en-es' },
      path: () => ({
        manifest: {
          packId: 'test-es',
          languageName: 'Spanish',
          declaredNodeTypes: ['lesson'],
          legendaryDenominator: ['lesson'],
          scoreCeiling: 29,
          cefrChecked: true,
          sectionTitles: ['Section one'],
        },
        sections: [
          {
            sectionIndex: 1,
            title: 'Section one',
            band: 'early A1',
            units: [
              {
                unitId: 'u1',
                unitIndex: 1,
                title: 'First unit',
                colourIndex: 0,
                nodes: [
                  {
                    nodeId: 'node-1',
                    type: 'lesson',
                    sessions: [{ lessonIndex: 1, exerciseIds: ['exercise-1'] }],
                    introducesScriptUnits: [],
                    requiresScriptUnits: [],
                  },
                ],
              },
            ],
          },
        ],
        forNode: () => ({
          node: {
            nodeId: 'node-1',
            type: 'lesson',
            sessions: [{ lessonIndex: 1, exerciseIds: ['exercise-1'] }],
            introducesScriptUnits: [],
            requiresScriptUnits: [],
          },
          unitIndex: 0,
          sectionIndex: 0,
          unitId: 'u1',
        }),
      }),
    },
    runtimeItem: (id: string) => {
      if (id !== item.exerciseId) throw new Error('no exact variant');
      return item;
    },
  } as unknown as VerifiedInstalledPack;
  const queued = {
    id: 'slot-1',
    itemId: item.itemId,
    type: item.presentation.type,
    family: 'production',
    conceptId: 'gato',
    nodeRef: 'node-1',
    requiresAudio: false,
  } as const;
  const initial: SessionState = {
    ...freshSession({
      sessionId: 'session-1',
      courseId: 'en-es',
      nodeRef: 'node-1',
      queue: [queued],
    }),
    shellState: 'challenge.idle',
  };
  const sessions = new SqliteSessionStore(db);
  sessions.activate(initial);
  new SqliteLearningContextStore(db).create(
    {
      courseId: 'en-es',
      sessionKind: 'graded',
      nodeRef: 'node-1',
      start: {
        sessionId: 'session-1',
        startedAtUtcMs: at,
        startedAtMonotonicMs: 100,
        startZone: zone,
      },
      economyFlavour: 'lesson',
      practiceItemRatio: 1,
      longFormEntry: null,
      boostAtStart: null,
      packContentHash: pack.contentHash,
      origin: { kind: 'path' },
      targetNodeId: 'node-1',
    },
    [
      {
        slotId: 'slot-1',
        exerciseId: 'exercise-1',
        itemId: item.itemId,
        surface: 'el gato',
        role: 'production',
        rubyShown: false,
      },
    ],
  );
  const ports = {
    packs: { get: () => pack },
    clock: () => ({ utcMs: at, monotonicMs: 100, zone }),
    modalityClock: () => null,
    newSessionId: () => 'next',
    canPlayAudio: () => false,
    canRecognizeSpeech: () => false,
    hasTargetScriptInput: () => true,
    reduceMotion: () => false,
  };
  const runtime = new SqliteLearningRuntime(db, ports);
  const request = {
    sessionId: 'session-1',
    slotId: 'slot-1',
    exerciseId: 'exercise-1',
    itemId: 'semantic-1',
    when: 'wrong-feedback',
  } as const;
  return {
    db,
    item,
    initial,
    sessions,
    ports,
    runtime,
    request,
    setPack: (p: VerifiedInstalledPack) => {
      pack = p;
    },
    getPack: () => pack,
  };
}

it('[INV-SESS-01][INV-SESS-15] actual ordered input/check persists one real grade and its exact target receipt', async () => {
  const { db, runtime, ports } = setup();
  const input = runtime.dispatch({
    type: 'input',
    text: 'el gato',
    caret: 7,
    partialState: {},
    gradeable: true,
  });
  const check = runtime.dispatch({ type: 'check' });
  await Promise.all([input, check]);
  const saved = new SqliteLearningRuntime(db, ports).readSession()!.state;
  expect(saved.shellState).toBe('banner.correct');
  expect(saved.core.answers).toHaveLength(1);
  expect(saved.core.answers[0]?.verdict).toBe('correct');
  expect(db.all('SELECT exercise_id,exercise_index FROM course_session_answer_receipt')).toEqual([
    { exercise_id: 'exercise-1', exercise_index: 0 },
  ]);
  expect(
    db.all('SELECT target_item_id,target_surface_id,grade FROM course_session_answer_target'),
  ).toEqual([{ target_item_id: 'semantic-1', target_surface_id: 'sf:gato', grade: 3 }]);
  expect(db.all('SELECT * FROM committed_session')).toEqual([]);
  await runtime.dispatch({ type: 'graded' });
  await runtime.dispatch({ type: 'check' });
  expect(new SqliteLearningRuntime(db, ports).readSession()!.state.core.answers).toEqual(
    saved.core.answers,
  );
});
it('[INV-PER-03][INV-SESS-01] a failed target insertion rolls back the grade and can replay the same input', async () => {
  const { db, runtime, ports } = setup();
  await runtime.dispatch({
    type: 'input',
    text: 'el gato',
    caret: 7,
    partialState: {},
    gradeable: true,
  });
  db.run(
    "CREATE TRIGGER kill_target BEFORE INSERT ON course_session_answer_target BEGIN SELECT RAISE(ABORT,'kill target'); END",
  );
  await expect(runtime.dispatch({ type: 'check' })).rejects.toThrow('kill target');
  const restored = new SqliteLearningRuntime(db, ports).readSession()!.state;
  expect(restored.shellState).toBe('challenge.armed');
  expect(restored.core.answers).toEqual([]);
  expect(db.all('SELECT * FROM course_session_answer_receipt')).toEqual([]);
  db.run('DROP TRIGGER kill_target');
  await runtime.dispatch({ type: 'check' });
  expect(runtime.readSession()!.state.core.answers).toHaveLength(1);
});
it('[INV-SESS-04][INV-GRD-27] actual wrong feedback survives reload without recording a hidden exposure', async () => {
  const { db, runtime, ports } = setup();
  await runtime.dispatch({
    type: 'input',
    text: 'el perro',
    caret: 8,
    partialState: {},
    gradeable: true,
  });
  await runtime.dispatch({ type: 'check' });
  expect(new SqliteLearningRuntime(db, ports).readSession()!.state.shellState).toBe('banner.wrong');
  expect(db.get('SELECT grade FROM course_session_answer_target')?.grade).toBe(1);
  expect(db.all('SELECT * FROM course_surface_exposure')).toEqual([]);
});
it('[INV-ECO-20] observed active time excludes background and modal spans across ordered checkpoints', async () => {
  const { db, ports } = setup();
  let monotonic = 100;
  const runtime = new SqliteLearningRuntime(db, {
    ...ports,
    clock: () => ({ utcMs: at + monotonic - 100, monotonicMs: monotonic, zone }),
  });
  await runtime.foreground();
  monotonic = 1100;
  await runtime.dispatch({
    type: 'input',
    text: 'el gato',
    caret: 7,
    partialState: {},
    gradeable: true,
  });
  monotonic = 2100;
  await runtime.background();
  monotonic = 102100;
  await runtime.foreground();
  monotonic = 103100;
  await runtime.dispatch({ type: 'check' });
  monotonic = 104100;
  await runtime.dispatch({ type: 'exit', route: 'closeButton' });
  monotonic = 154100;
  await runtime.dispatch({ type: 'keepLearning' });
  expect(db.get('SELECT active_ms FROM course_session_context')?.active_ms).toBe(4000);
});
it('[INV-SESS-21] current pack/source corruption aborts dispatch before any checkpoint or receipt', async () => {
  const { db, runtime, getPack, setPack, item } = setup();
  setPack({ ...getPack(), runtimeItem: () => ({ ...item, lessonIndex: 99 }) });
  await expect(
    runtime.dispatch({ type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true }),
  ).rejects.toThrow(/node/);
  expect(db.all('SELECT * FROM course_session_answer_receipt')).toEqual([]);
});

it('[INV-MIS-01][INV-MIS-07][INV-SESS-01] actual end replay binds its new slot and survives a graded kill/resume', async () => {
  const f = setup();
  f.db.run('INSERT INTO course_item(course_id,item_id,countable) VALUES(?,?,0)', [
    'en-es',
    f.item.itemId,
  ]);
  let scheduler = registerRows(emptySchedulerState('UTC'), [
    { itemId: asItemId(f.item.itemId), surface: 'el gato', kind: 'lexeme' },
  ]);
  scheduler = introduce(scheduler, asItemId(f.item.itemId), 'el gato', new Date(at - 86400000));
  new SqliteSchedulerStore(f.db).save('en-es', scheduler);
  await f.runtime.dispatch({
    type: 'input',
    text: 'el perro',
    caret: 8,
    partialState: {},
    gradeable: true,
  });
  await f.runtime.dispatch({ type: 'check' });
  await f.runtime.dispatch({ type: 'continue' });
  expect(f.runtime.readSession()?.state.shellState).toBe('mistakeReview');
  expect(f.runtime.readSession()?.challenge).toBeNull();
  const restarted = new SqliteLearningRuntime(f.db, f.ports);
  await restarted.dispatch({ type: 'continue' });
  const replay = restarted.readSession()!.state.currentReplay!.item;
  expect(replay.id).toBe('slot-1#replay0');
  expect(
    f.db.get('SELECT exercise_id FROM course_session_slot WHERE slot_id=?', [replay.id])
      ?.exercise_id,
  ).toBe(f.item.exerciseId);
  await restarted.dispatch({
    type: 'input',
    text: 'el gato',
    caret: 7,
    partialState: {},
    gradeable: true,
  });
  await restarted.dispatch({ type: 'check' });
  const saved = new SqliteLearningRuntime(f.db, f.ports).readSession()!.state;
  expect(saved.core.answers).toHaveLength(2);
  expect(saved.core.answers[1]).toMatchObject({
    queue: 'mistakes',
    exerciseIndex: -2,
    slotId: replay.id,
  });
  expect(
    f.db
      .all('SELECT exercise_index FROM course_session_answer_receipt ORDER BY exercise_index')
      .map((r) => r.exercise_index),
  ).toEqual([-2, 0]);
});

it('[INV-ECO-20][INV-PER-03] a failed background checkpoint cannot accrue the later background gap', async () => {
  const f = setup();
  let now = 100;
  const runtime = new SqliteLearningRuntime(f.db, {
    ...f.ports,
    clock: () => ({ utcMs: at + now - 100, monotonicMs: now, zone }),
  });
  await runtime.foreground();
  now = 1100;
  f.db.run(
    "CREATE TRIGGER kill_background BEFORE UPDATE OF active_ms ON course_session_context BEGIN SELECT RAISE(ABORT,'kill background'); END",
  );
  await expect(runtime.background()).rejects.toThrow('kill background');
  f.db.run('DROP TRIGGER kill_background');
  now = 101100;
  await runtime.dispatch({
    type: 'input',
    text: 'el gato',
    caret: 7,
    partialState: {},
    gradeable: true,
  });
  expect(f.db.get('SELECT active_ms FROM course_session_context')?.active_ms).toBe(0);
  now = 102100;
  await runtime.foreground();
  now = 103100;
  await runtime.dispatch({ type: 'check' });
  expect(f.db.get('SELECT active_ms FROM course_session_context')?.active_ms).toBe(1000);
});

function finiteSetup() {
  const f = setup();
  const contexts = new SqliteLearningContextStore(f.db),
    context = contexts.load('en-es', 'session-1')!;
  f.sessions.delete('en-es', 'graded', 'node-1');
  f.db.run('DELETE FROM course_session_context');
  contexts.create({ ...context.launch, economyFlavour: 'legendary' }, context.slots);
  const allowance = DEFAULT_FLAVOUR_MATRIX.legendary.mistakeAllowance!;
  f.sessions.activate({
    ...f.initial,
    flavour: 'legendary',
    core: { ...f.initial.core, hearts: { kind: 'pips', total: allowance, remaining: allowance } },
  });
  f.db.run('INSERT INTO course_item(course_id,item_id,countable) VALUES(?,?,0)', [
    'en-es',
    f.item.itemId,
  ]);
  let scheduler = registerRows(emptySchedulerState('UTC'), [
    { itemId: asItemId(f.item.itemId), surface: 'el gato', kind: 'lexeme' },
  ]);
  scheduler = introduce(scheduler, asItemId(f.item.itemId), 'el gato', new Date(at - 86400000));
  new SqliteSchedulerStore(f.db).save('en-es', scheduler);
  observeFixtureLexemes(f.db, f.item, at - 86400000);
  return { ...f, contexts };
}
it('[INV-ECO-16][INV-PER-03] allowance exhaustion freezes failed time through replay, kill and later End session', async () => {
  const f = finiteSetup();
  let now = 100;
  const ports = { ...f.ports, clock: () => ({ utcMs: at + now - 100, monotonicMs: now, zone }) };
  let runtime = new SqliteLearningRuntime(f.db, ports);
  for (let i = 0; i < 20 && runtime.readSession()?.state.shellState !== 'outOfHearts'; i++) {
    now += 1000;
    const shell = runtime.readSession()!.state.shellState;
    if (shell === 'challenge.idle' || shell === 'challenge.armed') {
      await runtime.dispatch({
        type: 'input',
        text: 'el perro',
        caret: 8,
        partialState: {},
        gradeable: true,
      });
      await runtime.dispatch({ type: 'check' });
    } else await runtime.dispatch({ type: 'continue' });
  }
  const failed = runtime.readSession()!.state;
  expect(failed.shellState).toBe('outOfHearts');
  expect(failed.exited).toBeNull();
  expect(failed.core.answers.at(-1)!.exerciseIndex).toBeLessThan(0);
  const frozen = f.contexts.load('en-es', 'session-1')!.completion;
  expect(frozen).toMatchObject({
    outcome: 'failed',
    completedAtUtcMs: at + now - 100,
    completedAtMonotonicMs: now,
  });
  now += 3600000;
  runtime = new SqliteLearningRuntime(f.db, ports);
  await runtime.dispatch({ type: 'endSession', route: 'closeButton' });
  expect(f.contexts.load('en-es', 'session-1')).toBeNull();
  expect(f.sessions.get('en-es', 'graded', 'node-1')).toBeNull();
  expect(f.db.get('SELECT outcome,completed_at_utc_ms FROM committed_session')).toEqual({
    outcome: 'failed',
    completed_at_utc_ms: frozen!.completedAtUtcMs,
  });
});
it('[INV-ECO-16] ordinary quit never manufactures an allowance-failure award intent', async () => {
  const f = finiteSetup();
  await f.runtime.dispatch({
    type: 'input',
    text: 'el gato',
    caret: 7,
    partialState: {},
    gradeable: true,
  });
  await f.runtime.dispatch({ type: 'check' });
  await f.runtime.dispatch({ type: 'exit', route: 'closeButton' });
  await f.runtime.dispatch({ type: 'endSession', route: 'closeButton' });
  expect(f.db.get('SELECT outcome FROM committed_session')?.outcome).toBe('quit');
});
it('[INV-ECO-16][INV-PER-03] corrupt exhausted allowance without real grade receipts cannot become a failed intent', async () => {
  const f = finiteSetup(),
    state = f.sessions.get('en-es', 'graded', 'node-1')!;
  f.sessions.put({
    ...state,
    shellState: 'outOfHearts',
    core: { ...state.core, hearts: { kind: 'pips', total: 3, remaining: 0 } },
  });
  await expect(f.runtime.dispatch({ type: 'endSession', route: 'closeButton' })).rejects.toThrow(
    /failure|allowance|receipt/,
  );
  expect(f.contexts.load('en-es', 'session-1')!.completion).toBeNull();
});

it('[INV-ECO-16][INV-PER-03] frozen failed intent rejects a new grade after the actual Keep learning cursor', async () => {
  const f = finiteSetup();
  for (let i = 0; i < 20 && f.runtime.readSession()?.state.shellState !== 'outOfHearts'; i++) {
    const shell = f.runtime.readSession()!.state.shellState;
    if (shell === 'challenge.idle' || shell === 'challenge.armed') {
      await f.runtime.dispatch({
        type: 'input',
        text: 'el perro',
        caret: 8,
        partialState: {},
        gradeable: true,
      });
      await f.runtime.dispatch({ type: 'check' });
    } else await f.runtime.dispatch({ type: 'continue' });
  }
  const frozen = f.contexts.load('en-es', 'session-1')!.completion,
    answers = f.runtime.readSession()!.state.core.answers;
  await f.runtime.dispatch({ type: 'exit', route: 'closeButton' });
  expect(f.runtime.readSession()!.state.shellState).toBe('quitDialog');
  await f.runtime.dispatch({ type: 'keepLearning' });
  expect(f.runtime.readSession()!.state.shellState).toBe('challenge.idle');
  await f.runtime.dispatch({
    type: 'input',
    text: 'el gato',
    caret: 7,
    partialState: {},
    gradeable: true,
  });
  await expect(f.runtime.dispatch({ type: 'check' })).rejects.toThrow(
    /frozen failure|terminal grade|completion is frozen/,
  );
  expect(f.runtime.readSession()!.state.core.answers).toEqual(answers);
  expect(f.contexts.load('en-es', 'session-1')!.completion).toEqual(frozen);
  expect(f.db.all('SELECT * FROM course_session_answer_receipt')).toHaveLength(answers.length);
});
