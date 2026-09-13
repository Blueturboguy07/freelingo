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
import { SqliteLearningRuntime } from './SqliteLearningRuntime';
import { SqliteSchedulerStore } from './SqliteSchedulerStore';
import { SqliteWordStore } from './SqliteWordStore';
import { fixtureLexemes, observeFixtureLexemes } from './learningCompletion.fixtures';
import { emptySchedulerState, registerRows, introduce, asItemId } from '@freelingo/core/scheduler';
import type { LearningRuntime } from './learningRuntimePorts';
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
      meta: { lang: 'es' },
      path: () => ({
        forNode: () => ({
          node: { nodeId: 'node-1', sessions: [{ lessonIndex: 1, exerciseIds: ['exercise-1'] }] },
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
    conceptId: 'cat',
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
    screenReaderActive: () => false,
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

function launchSetup(known = true, history = true) {
  const f = setup();
  f.db.run('UPDATE account SET selection_seed=7');
  f.sessions.delete('en-es', 'graded', 'node-1');
  f.db.run('DELETE FROM course_session_context');
  const population = Array.from({ length: 6 }, (_, i) => {
    const id = 'semantic-' + i,
      sf = 'sf:' + i;
    return fixtureLexemes({
      ...f.item,
      itemId: id,
      exerciseId: 'e' + i,
      gradable: {
        ...f.item.gradable,
        itemId: id,
        accepted: [{ surface: 'el gato', surfaceId: sf, rank: 1 }],
      },
      presentation: { ...f.item.presentation, itemId: id },
      schedulerSurfaces: [
        {
          itemId: id,
          surfaceId: sf,
          surface: 'el gato',
          language: 'es',
          canonical: true,
          kind: 'lexeme' as const,
          itemRef: 'gato',
        },
      ],
      introductions: [],
    });
  });
  const node = {
    nodeId: 'node-1',
    type: 'lesson',
    sessions: [{ lessonIndex: 1, exerciseIds: population.map((p) => p.exerciseId) }],
    introducesScriptUnits: [],
    requiresScriptUnits: [],
  };
  const path = {
    manifest: {
      courseId: 'en-es',
      supportedCefrBands: ['early A1'],
      scoreCeiling: 29,
      legendaryDenominator: ['lesson', 'practice', 'unitReview'],
      supportedNodeTypes: ['lesson'],
      supportsLetters: false,
      hasDailyRefresh: true,
    },
    sections: [
      {
        sectionIndex: 1,
        title: 'Section one',
        band: 'early A1',
        units: [{ unitId: 'u1', unitIndex: 1, title: 'First unit', colourIndex: 0, nodes: [node] }],
      },
    ],
    forNode: (id: string) => {
      if (id !== 'node-1') throw Error('unknown node');
      return { node, unitId: 'u1', unitIndex: 0, sectionIndex: 0 };
    },
  };
  const pack = {
    ...f.getPack(),
    pack: { ...f.getPack().pack, meta: { lang: 'es', courseId: 'en-es' }, path: () => path },
    runtimeItem: (id: string) => {
      const item = population.find((p) => p.exerciseId === id);
      if (!item) throw Error('unknown source');
      return item;
    },
  } as unknown as VerifiedInstalledPack;
  f.setPack(pack);
  f.db.run(
    'UPDATE course_progress SET pack_content_hash=?,score_unlocked=0,score_ceiling_beat_shown=0',
    [pack.contentHash],
  );
  if (history) f.db.run("INSERT INTO course_path_state VALUES('en-es',100,0,0)");
  if (known) {
    for (const p of population)
      f.db.run('INSERT INTO course_item(course_id,item_id,countable) VALUES(?,?,0)', [
        'en-es',
        p.itemId,
      ]);
    let scheduler = registerRows(
      emptySchedulerState('UTC'),
      population.map((p) => ({ itemId: asItemId(p.itemId), surface: 'el gato', kind: 'lexeme' })),
    );
    for (const p of population)
      scheduler = introduce(scheduler, asItemId(p.itemId), 'el gato', new Date(at - 86400000));
    new SqliteSchedulerStore(f.db).save('en-es', scheduler);
    for (const p of population) observeFixtureLexemes(f.db, p, at - 86400000);
  }
  return {
    ...f,
    population,
    pack,
    path,
    request: {
      kind: 'path',
      request: { nodeId: 'node-1', unitIndex: 0, flavour: 'lesson' },
    } as const,
  };
}

function completionSetup() {
  const f = launchSetup();
  Object.assign(f.path.manifest, {
    packId: 'test-es',
    languageName: 'Spanish',
    declaredNodeTypes: ['lesson'],
    cefrChecked: true,
    sectionTitles: ['Section one'],
  });
  f.db.run('UPDATE account SET daily_goal_xp=10');
  let now = at;
  const ports = { ...f.ports, clock: () => ({ utcMs: now, monotonicMs: 100 + now - at, zone }) };
  const runtime = new SqliteLearningRuntime(f.db, ports) as unknown as LearningRuntime;
  return {
    ...f,
    runtime,
    ports,
    setNow: (n: number) => {
      now = n;
    },
  };
}
async function finish(f: Pick<ReturnType<typeof completionSetup>, 'db' | 'runtime'>) {
  for (let n = 0; n < 100; n++) {
    const state = new SqliteSessionStore(f.db).activeGraded();
    if (!state) return;
    if (state.exited !== null) {
      await f.runtime.complete();
      return;
    }
    const event =
      state.shellState === 'loading'
        ? { type: 'rendered' as const }
        : state.shellState === 'challenge.idle'
          ? { type: 'input' as const, text: 'el gato', caret: 7, partialState: {}, gradeable: true }
          : state.shellState === 'challenge.armed'
            ? { type: 'check' as const }
            : { type: 'continue' as const };
    await f.runtime.dispatch(event);
  }
  throw Error('Actual session did not finish');
}
function durable(db: Db) {
  return [
    'course_attempt',
    'course_attempt_target',
    'course_node',
    'committed_session',
    'account_day',
    'course_mistake_encounter',
    'course_ceremony',
  ].map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY rowid`)]);
}
it('[INV-PER-04][INV-SCH-03][INV-CER-01] actual input/check/continue commits attempts, target cards, path, day and ceremony once across reload', async () => {
  const f = completionSetup();
  await f.runtime.start('en-es', f.request);
  await finish(f);
  expect(f.db.all('SELECT * FROM committed_session')).toHaveLength(1);
  expect(f.db.all('SELECT * FROM course_attempt')).toHaveLength(6);
  expect(f.db.all('SELECT * FROM course_attempt_target')).toHaveLength(6);
  expect(f.db.get('SELECT levels_completed,levels_total FROM course_node')).toEqual({
    levels_completed: 1,
    levels_total: 1,
  });
  expect(Number(f.db.get('SELECT xp FROM course_progress')?.xp)).toBeGreaterThan(0);
  expect(f.db.get('SELECT earned_xp FROM account_day')?.earned_xp).toBe(
    f.db.get('SELECT xp FROM course_progress')?.xp,
  );
  expect(f.db.all('SELECT * FROM course_session_context')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_session_state')).toEqual([]);
  const restored = new SqliteLearningRuntime(f.db, f.ports) as unknown as LearningRuntime;
  expect(restored.readCeremony()?.status).toBe('committed');
  const before = durable(f.db);
  await Promise.all([restored.complete(), restored.complete()]);
  expect(durable(f.db)).toEqual(before);
});
it.each(['course_node', 'committed_session', 'course_ceremony'])(
  '[INV-PER-04][INV-ECO-05] failure writing %s rolls back scheduler/path/rewards while retaining frozen intent for retry',
  async (table) => {
    const f = completionSetup();
    await f.runtime.start('en-es', f.request);
    const before = f.db.all('SELECT * FROM course_item_surface ORDER BY item_id,surface');
    f.db.run(
      `CREATE TRIGGER kill_completion BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'kill completion');END`,
    );
    await expect(finish(f)).rejects.toThrow('kill completion');
    expect(f.db.all('SELECT * FROM course_attempt')).toEqual([]);
    expect(f.db.all('SELECT * FROM course_node')).toEqual([]);
    expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
    expect(f.db.all('SELECT * FROM course_ceremony')).toEqual([]);
    expect(f.db.all('SELECT * FROM course_item_surface ORDER BY item_id,surface')).toEqual(before);
    const intent = f.db.get(
      'SELECT completed_at_utc_ms FROM course_session_context',
    )?.completed_at_utc_ms;
    expect(intent).toBe(at);
    expect(new SqliteSessionStore(f.db).activeGraded()?.exited).toBe('complete');
    f.db.run('DROP TRIGGER kill_completion');
    f.setNow(at + 86400000);
    const restored = new SqliteLearningRuntime(f.db, f.ports) as unknown as LearningRuntime;
    await restored.complete();
    expect(f.db.all('SELECT * FROM committed_session')).toHaveLength(1);
    expect(f.db.get('SELECT reward_local_day FROM committed_session')?.reward_local_day).toBe(
      '2026-09-13',
    );
  },
);
it('[INV-PER-04][INV-MIS-04] an actual quit saves the graded mistake but earns no path progress or XP', async () => {
  const f = completionSetup();
  await f.runtime.start('en-es', f.request);
  await f.runtime.dispatch({ type: 'rendered' });
  await f.runtime.dispatch({
    type: 'input',
    text: 'el perro',
    caret: 8,
    partialState: {},
    gradeable: true,
  });
  await f.runtime.dispatch({ type: 'check' });
  await f.runtime.dispatch({ type: 'exit', route: 'closeButton' });
  await f.runtime.dispatch({ type: 'endSession', route: 'closeButton' });
  await f.runtime.complete();
  expect(f.db.get('SELECT outcome,xp_awarded FROM committed_session')).toEqual({
    outcome: 'quit',
    xp_awarded: 0,
  });
  expect(f.db.all('SELECT * FROM course_node')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_attempt')).toHaveLength(1);
  expect(f.db.get('SELECT review_streak FROM course_mistake_state')?.review_streak).toBe(0);
});
it('[INV-PER-04][INV-SCH-03] an actual skipped answer is audited without a synthetic scheduler target', async () => {
  const f = completionSetup();
  await f.runtime.start('en-es', f.request);
  await f.runtime.dispatch({ type: 'rendered' });
  await f.runtime.dispatch({ type: 'skip' });
  await f.runtime.dispatch({ type: 'exit', route: 'closeButton' });
  await f.runtime.dispatch({ type: 'endSession', route: 'closeButton' });
  await f.runtime.complete();
  expect(f.db.all('SELECT skipped,scheduler_grade FROM course_attempt')).toEqual([
    { skipped: 1, scheduler_grade: null },
  ]);
  expect(f.db.all('SELECT * FROM course_attempt_target')).toEqual([]);
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_session_state')).toEqual([]);
  expect(f.runtime.readCeremony()).toBeNull();
});
it('[INV-SESS-21][INV-PER-04] changed saved pack source prevents terminal writes and preserves original staging', async () => {
  const f = completionSetup();
  await f.runtime.start('en-es', f.request);
  f.db.run(
    "CREATE TRIGGER kill_completion BEFORE INSERT ON committed_session BEGIN SELECT RAISE(ABORT,'kill completion');END",
  );
  await expect(finish(f)).rejects.toThrow();
  f.db.run('DROP TRIGGER kill_completion');
  f.setPack({ ...f.pack, contentHash: 'b'.repeat(64) });
  await expect(f.runtime.complete()).rejects.toThrow(/pack|source/i);
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_session_context')).toHaveLength(1);
});

it('[INV-SESS-12][INV-SESS-23] leaving the untouched first exercise clears staging without any attempt or committed session', async () => {
  const f = completionSetup();
  await f.runtime.start('en-es', f.request);
  await f.runtime.dispatch({ type: 'rendered' });
  await f.runtime.dispatch({ type: 'exit', route: 'closeButton' });
  expect(f.db.all('SELECT * FROM course_attempt')).toEqual([]);
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_session_state')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_session_context')).toEqual([]);
  expect(f.runtime.readCeremony()).toBeNull();
});
it('[INV-SCH-03][INV-SESS-23] a prior audit-only session identity cannot be regenerated', async () => {
  const f = completionSetup();
  await f.runtime.start('en-es', f.request);
  await f.runtime.dispatch({ type: 'rendered' });
  await f.runtime.dispatch({ type: 'skip' });
  await f.runtime.dispatch({ type: 'exit', route: 'closeButton' });
  await f.runtime.dispatch({ type: 'endSession', route: 'closeButton' });
  await f.runtime.complete();
  await expect(f.runtime.start('en-es', f.request)).rejects.toThrow(/identity/i);
});

it('[INV-MIS-04][INV-SESS-01][INV-SCH-03] actual negative-index recycles commit in answer order and never retire the creating-session mistake', async () => {
  const f = completionSetup();
  await f.runtime.start('en-es', f.request);
  await f.runtime.dispatch({ type: 'rendered' });
  await f.runtime.dispatch({
    type: 'input',
    text: 'el perro',
    caret: 8,
    partialState: {},
    gradeable: true,
  });
  await f.runtime.dispatch({ type: 'check' });
  await finish(f);
  const attempts = f.db.all(
    'SELECT exercise_index,queue FROM course_attempt ORDER BY attempt_sequence',
  );
  expect(attempts.filter((a) => Number(a.exercise_index) < 0)).toHaveLength(2);
  expect(attempts).toHaveLength(8);
  expect(f.db.get('SELECT review_streak FROM course_mistake_state')?.review_streak).toBe(0);
});
it('[INV-PER-04] foreground after a killed terminal commit retries the original intent before showing the ceremony', async () => {
  const f = completionSetup();
  await f.runtime.start('en-es', f.request);
  f.db.run(
    "CREATE TRIGGER kill_completion BEFORE INSERT ON course_ceremony BEGIN SELECT RAISE(ABORT,'kill completion');END",
  );
  await expect(finish(f)).rejects.toThrow('kill completion');
  f.db.run('DROP TRIGGER kill_completion');
  f.setNow(at + 86400000);
  const restored = new SqliteLearningRuntime(f.db, f.ports) as unknown as LearningRuntime;
  await restored.foreground();
  expect(restored.readCeremony()?.status).toBe('committed');
  expect(f.db.get('SELECT reward_local_day FROM committed_session')?.reward_local_day).toBe(
    '2026-09-13',
  );
});
it('[INV-PATH-01][INV-PER-04] later destination progress cannot turn the saved earlier lesson into a second completion', async () => {
  const f = completionSetup();
  await f.runtime.start('en-es', f.request);
  f.db.run(
    "INSERT INTO course_node VALUES('en-es','node-1','u1','1','lesson',0,1,1,'2026-09-13T11:00:00Z',NULL)",
  );
  await expect(finish(f)).rejects.toThrow(/already completed/);
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_attempt')).toEqual([]);
});
it('[INV-SESS-11][INV-SESS-23] a fully skipped actual queue writes audit attempts without a session reward or path progress', async () => {
  const f = completionSetup();
  await f.runtime.start('en-es', f.request);
  for (let n = 0; n < 100; n++) {
    const state = new SqliteSessionStore(f.db).activeGraded();
    if (!state) break;
    await f.runtime.dispatch(
      state.shellState === 'loading'
        ? { type: 'rendered' }
        : ['challenge.idle', 'challenge.armed'].includes(state.shellState)
          ? { type: 'skip' }
          : { type: 'continue' },
    );
  }
  expect(f.db.all('SELECT * FROM course_attempt')).toHaveLength(6);
  expect(f.db.all('SELECT * FROM course_attempt_target')).toEqual([]);
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_node')).toEqual([]);
});
function paddedSetup() {
  const f = completionSetup();
  const old = f.pack.pack.path(),
    first = old.sections[0]!.units[0]!.nodes[0]!;
  const target = f.population.slice(0, 2).map((p, i) =>
    fixtureLexemes({
      ...p,
      itemId: 'target-' + i,
      exerciseId: 'target-e' + i,
      lessonIndex: 2,
      gradable: {
        ...p.gradable,
        itemId: 'target-' + i,
        accepted: [{ surface: 'el gato', surfaceId: 'target-sf' + i, rank: 1 }],
      },
      presentation: { ...p.presentation, itemId: 'target-' + i },
      schedulerSurfaces: p.schedulerSurfaces.map((t) => ({
        ...t,
        itemId: 'target-' + i,
        surfaceId: 'target-sf' + i,
      })),
    }),
  );
  const future = f.population.map((p, i) =>
    fixtureLexemes({
      ...p,
      itemId: 'future-' + i,
      exerciseId: 'future-e' + i,
      lessonIndex: 3,
      gradable: {
        ...p.gradable,
        itemId: 'future-' + i,
        accepted: [{ surface: 'el gato', surfaceId: 'future-sf' + i, rank: 1 }],
      },
      presentation: { ...p.presentation, itemId: 'future-' + i },
      schedulerSurfaces: p.schedulerSurfaces.map((t) => ({
        ...t,
        itemId: 'future-' + i,
        surfaceId: 'future-sf' + i,
      })),
    }),
  );
  const nodes = [
    first,
    {
      ...first,
      nodeId: 'node-2',
      sessions: [{ lessonIndex: 2, exerciseIds: target.map((p) => p.exerciseId) }],
    },
    {
      ...first,
      nodeId: 'node-3',
      sessions: [{ lessonIndex: 3, exerciseIds: future.map((p) => p.exerciseId) }],
    },
  ];
  const path = {
    ...old,
    sections: old.sections.map((section) => ({
      ...section,
      units: section.units.map((u) => ({ ...u, nodes })),
    })),
    forNode: (id: string) => {
      const node = nodes.find((n) => n.nodeId === id);
      if (!node) throw Error('node missing');
      return { node, unitId: 'u1', unitIndex: 0, sectionIndex: 0 };
    },
  };
  const all = [...f.population, ...target, ...future];
  const pack = {
    ...f.pack,
    pack: { ...f.pack.pack, path: () => path },
    runtimeItem: (id: string) => {
      const item = all.find((p) => p.exerciseId === id);
      if (!item) throw Error('source missing');
      return item;
    },
  } as unknown as VerifiedInstalledPack;
  f.setPack(pack);
  f.db.run(
    "INSERT INTO course_node(course_id,node_id,section_id,unit_id,node_type,node_index,levels_total,levels_completed,completed_at) VALUES('en-es','node-1','1','u1','lesson',0,1,1,?)",
    [new Date(at - 3600000).toISOString()],
  );
  const store = new SqliteSchedulerStore(f.db);
  let scheduler = store.load('en-es', 'UTC');
  for (const item of [...target, ...future]) {
    f.db.run('INSERT INTO course_item(course_id,item_id,countable) VALUES(?,?,0)', [
      'en-es',
      item.itemId,
    ]);
    scheduler = registerRows(scheduler, [
      { itemId: asItemId(item.itemId), surface: 'el gato', kind: 'lexeme' },
    ]);
    scheduler = introduce(scheduler, asItemId(item.itemId), 'el gato', new Date(at - 86400000));
  }
  store.save('en-es', scheduler);
  for (const p of [...target, ...future]) observeFixtureLexemes(f.db, p, at - 86400000);
  return {
    ...f,
    pack,
    target,
    future,
    request: {
      kind: 'path',
      request: { nodeId: 'node-2', unitIndex: 0, flavour: 'lesson' },
    } as const,
  };
}
it('[INV-PATH-01][INV-SCH-09] actual earlier-node padding reviews original sources while completion advances only the destination', async () => {
  const f = paddedSetup();
  await f.runtime.start('en-es', f.request);
  await finish(f);
  expect(f.db.all('SELECT node_id,levels_completed FROM course_node ORDER BY node_index')).toEqual([
    { node_id: 'node-1', levels_completed: 1 },
    { node_id: 'node-2', levels_completed: 1 },
  ]);
  expect(
    f.db
      .all('SELECT item_id FROM course_attempt')
      .some((a) => f.population.some((p) => p.itemId === a.item_id)),
  ).toBe(true);
  expect(
    f.db.all('SELECT spent_by FROM course_review_pool_item').every((r) => r.spent_by === null),
  ).toBe(true);
});

function matchCompletionSetup(limited = false) {
  const f = completionSetup();
  const pairs = ['gato', 'perro', 'ave', 'pez', 'oso'].map((left, i) => ({
    leftItemId: 'lex:' + i,
    leftId: 'l' + i,
    rightId: 'r' + i,
    left,
    right: ['cat', 'dog', 'bird', 'fish', 'bear'][i]!,
  }));
  const item = fixtureLexemes({
    ...f.population[0]!,
    gradable: { itemId: 'semantic-0', family: 'match', accepted: [] },
    presentation: {
      ...f.population[0]!.presentation,
      type: 'matchPairs',
      prompt: 'Match the pairs',
      pairs,
      acceptedAnswers: [],
    },
    schedulerSurfaces: pairs.map((p) => ({
      itemId: p.leftItemId,
      surfaceId: 'match-sf:' + p.leftId,
      surface: p.left,
      language: 'es',
      kind: 'lexeme',
      itemRef: p.leftItemId,
      canonical: true,
    })),
    introductions: [],
  });
  const pack = {
    ...f.pack,
    runtimeItem: (id: string) => (id === item.exerciseId ? item : f.pack.runtimeItem(id)),
  };
  f.setPack(pack);
  observeFixtureLexemes(f.db, item, at - 86400000);
  const store = new SqliteSchedulerStore(f.db);
  let scheduler = registerRows(
    store.load('en-es', 'UTC'),
    item.schedulerSurfaces.map((s) => ({
      itemId: asItemId(s.itemId),
      surface: s.surface,
      kind: s.kind,
    })),
  );
  for (const s of item.schedulerSurfaces)
    scheduler = introduce(scheduler, asItemId(s.itemId), s.surface, new Date(at - 86400000));
  store.save('en-es', scheduler);
  const queued = {
    id: 'match-slot',
    itemId: item.itemId,
    type: 'matchPairs' as const,
    family: 'recognition' as const,
    conceptId: item.itemId,
    nodeRef: 'node-1',
    requiresAudio: false,
  };
  const initial = freshSession({
    sessionId: 'session-match',
    courseId: 'en-es',
    nodeRef: 'node-1',
    queue: [queued],
  });
  const allowance = DEFAULT_FLAVOUR_MATRIX.legendary.mistakeAllowance!;
  f.sessions.activate({
    ...initial,
    shellState: 'challenge.idle',
    ...(limited
      ? {
          flavour: 'legendary' as const,
          core: {
            ...initial.core,
            hearts: { kind: 'pips' as const, total: allowance, remaining: allowance },
          },
        }
      : {}),
  });
  new SqliteLearningContextStore(f.db).create(
    {
      courseId: 'en-es',
      sessionKind: 'graded',
      nodeRef: 'node-1',
      start: {
        sessionId: 'session-match',
        startedAtUtcMs: at,
        startedAtMonotonicMs: 100,
        startZone: zone,
      },
      economyFlavour: limited ? 'legendary' : 'lesson',
      practiceItemRatio: 1,
      longFormEntry: null,
      boostAtStart: null,
      packContentHash: pack.contentHash,
      origin: { kind: 'path' },
      targetNodeId: 'node-1',
    },
    [
      {
        slotId: queued.id,
        exerciseId: item.exerciseId,
        itemId: item.itemId,
        surface: item.presentation.prompt,
        role: 'recognition',
        rubyShown: false,
      },
    ],
  );
  return { ...f, item, pairs, allowance };
}
async function matchTaps(
  f: ReturnType<typeof matchCompletionSetup>,
  wrong = false,
  limited = false,
) {
  if (wrong)
    for (let i = 0; i < (limited ? f.allowance : 1); i++)
      await f.runtime.dispatch({
        type: 'matchPair',
        attemptId: 'wrong-' + i,
        leftId: 'l0',
        rightId: 'r1',
      });
  if (!limited)
    for (const p of f.pairs)
      await f.runtime.dispatch({
        type: 'matchPair',
        attemptId: 'correct-' + p.leftId,
        leftId: p.leftId,
        rightId: p.rightId,
      });
  expect(f.sessions.activeGraded()!.core.answers).toHaveLength(1);
}
async function quitMatch(f: ReturnType<typeof matchCompletionSetup>) {
  await f.runtime.dispatch({ type: 'exit', route: 'closeButton' });
  await f.runtime.dispatch({ type: 'endSession', route: 'closeButton' });
}
it.each([false, true])(
  '[INV-SESS-13][INV-SCH-03] actual completed MATCH wrong=%s commits one parent and all five observed target grades',
  async (wrong) => {
    const f = matchCompletionSetup();
    await matchTaps(f, wrong);
    await quitMatch(f);
    expect(f.db.all('SELECT verdict,cost_paid FROM course_attempt')).toEqual([
      { verdict: wrong ? 'wrong' : 'correct', cost_paid: wrong ? 1 : 0 },
    ]);
    expect(
      f.db.all('SELECT target_item_id,grade FROM course_attempt_target ORDER BY position'),
    ).toEqual(
      f.pairs.map((p, i) => ({ target_item_id: p.leftItemId, grade: wrong && i === 0 ? 1 : 3 })),
    );
    expect(f.db.all('SELECT * FROM account_word_review')).toHaveLength(5);
  },
);
it('[INV-SESS-13][INV-SCH-03] actual exhausted MATCH commits only its touched left item and one parent', async () => {
  const f = matchCompletionSetup(true);
  await matchTaps(f, true, true);
  await quitMatch(f);
  expect(f.db.all('SELECT verdict,cost_paid FROM course_attempt')).toEqual([
    { verdict: 'wrong', cost_paid: f.allowance },
  ]);
  expect(f.db.all('SELECT target_item_id,grade FROM course_attempt_target')).toEqual([
    { target_item_id: 'lex:0', grade: 1 },
  ]);
  expect(f.db.get('SELECT outcome FROM committed_session')?.outcome).toBe('failed');
});
it.each(['accepted-omission', 'wrong-all-good', 'unfinished-subset'] as const)(
  '[INV-SESS-13][INV-PER-04] corrupted MATCH %s fails before committing attempts or rewards',
  async (mode) => {
    const f = matchCompletionSetup();
    await matchTaps(f, mode !== 'accepted-omission');
    // Simulate external damaged storage, beyond the append-only writer's protection.
    if (mode === 'wrong-all-good') {
      f.db.run('DROP TRIGGER course_session_answer_target_append_only_update');
      f.db.run('UPDATE course_session_answer_target SET grade=3');
    } else {
      f.db.run('DROP TRIGGER course_session_answer_target_append_only_delete');
      f.db.run('DELETE FROM course_session_answer_target WHERE position>=?', [
        mode === 'accepted-omission' ? 4 : 1,
      ]);
    }
    await expect(quitMatch(f)).rejects.toThrow(/MATCH/i);
    expect(f.db.all('SELECT * FROM course_attempt')).toEqual([]);
    expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
    expect(f.db.all('SELECT * FROM course_session_context')).toHaveLength(1);
  },
);

function restartSetup() {
  const f = completionSetup();
  let sequence = 0;
  const ports = { ...f.ports, newSessionId: () => `restart-${++sequence}` };
  return {
    ...f,
    ports,
    runtime: new SqliteLearningRuntime(f.db, ports) as unknown as LearningRuntime,
  };
}
async function answerOne(f: ReturnType<typeof restartSetup>, wrong = false) {
  await f.runtime.dispatch({ type: 'rendered' });
  await f.runtime.dispatch({
    type: 'input',
    text: wrong ? 'el perro' : 'el gato',
    caret: 7,
    partialState: {},
    gradeable: true,
  });
  await f.runtime.dispatch({ type: 'check' });
}
async function offerRestart(f: ReturnType<typeof restartSetup>) {
  await f.runtime.background();
  f.setNow(at + 2 * 86400000);
  await f.runtime.foreground();
  await f.runtime.start('en-es', f.request);
  expect(f.runtime.readOffer()?.kind).toBe('resume');
}
it('[INV-SESS-03][INV-PER-04] actual start-over commits the abandoned answer once and regenerates only genuinely due abandoned items', async () => {
  const f = restartSetup();
  await f.runtime.start('en-es', f.request);
  await answerOne(f);
  const old = f.runtime.readSession()!.state;
  await offerRestart(f);
  await f.runtime.resolveOffer('start-over');
  const next = f.runtime.readSession()!.state;
  expect(next.sessionId).not.toBe(old.sessionId);
  expect(next.core.answers).toEqual([]);
  expect(f.db.all('SELECT session_id,verdict FROM course_attempt')).toEqual([
    { session_id: old.sessionId, verdict: 'correct' },
  ]);
  expect(f.db.get('SELECT outcome,xp_awarded FROM committed_session')).toEqual({
    outcome: 'quit',
    xp_awarded: 0,
  });
  expect(next.core.queue.length).toBeGreaterThan(0);
  const rows = new SqliteSchedulerStore(f.db).load('en-es', 'UTC');
  for (const q of next.core.queue) {
    if (old.core.queue.some((o) => o.itemId === q.itemId))
      expect(
        [...rows.rows.values()]
          .filter((r) => r.itemId === q.itemId)
          .every((r) => r.card.due.getTime() <= at + 2 * 86400000),
      ).toBe(true);
  }
  expect(f.db.all('SELECT * FROM course_session_context')).toHaveLength(1);
  expect(f.runtime.readOffer()).toBeNull();
});
it('[INV-SESS-03][INV-PER-04] untouched non-due abandoned slots cannot be regenerated and failure retains the original checkpoint', async () => {
  const f = restartSetup();
  f.db.run('UPDATE course_item_surface SET due_utc_ms=?', [at + 30 * 86400000]);
  await f.runtime.start('en-es', f.request);
  const before = f.runtime.readSession()!.state;
  await offerRestart(f);
  await expect(f.runtime.resolveOffer('start-over')).rejects.toThrow(/eligible|available/i);
  expect(f.runtime.readSession()!.state).toEqual(before);
  expect(f.db.all('SELECT * FROM course_attempt')).toEqual([]);
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
});
it('[INV-SESS-03][INV-PER-04] failed regeneration rolls back old attempts, WordStore reviews and staging deletion before exact retry', async () => {
  const f = restartSetup();
  await f.runtime.start('en-es', f.request);
  await answerOne(f, true);
  await offerRestart(f);
  const state = f.runtime.readSession()!.state;
  const before = f.db.all('SELECT * FROM course_item_surface ORDER BY item_id');
  f.db.run(
    `CREATE TRIGGER reject_regeneration BEFORE INSERT ON course_session_context WHEN NEW.session_id<>'${state.sessionId}' BEGIN SELECT RAISE(ABORT,'regeneration failed');END`,
  );
  await expect(f.runtime.resolveOffer('start-over')).rejects.toThrow('regeneration failed');
  expect(f.runtime.readSession()!.state).toEqual(state);
  expect(f.db.all('SELECT * FROM course_attempt')).toEqual([]);
  expect(f.db.all('SELECT * FROM account_word_review')).toEqual([]);
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_item_surface ORDER BY item_id')).toEqual(before);
  f.db.run('DROP TRIGGER reject_regeneration');
  await f.runtime.resolveOffer('start-over');
  expect(f.db.all('SELECT * FROM course_attempt')).toHaveLength(1);
  expect(f.db.all('SELECT * FROM account_word_review')).toHaveLength(1);
  expect(f.db.get('SELECT item_id FROM course_mistake_state')?.item_id).toBe(
    state.core.answers[0]!.itemId,
  );
});
it('[INV-SESS-21][INV-PER-04] start-over with unavailable original source retains graded history for recovery', async () => {
  const f = restartSetup();
  await f.runtime.start('en-es', f.request);
  await answerOne(f);
  const state = f.runtime.readSession()!.state;
  f.setPack({ ...f.pack, contentHash: 'b'.repeat(64) });
  await f.runtime.start('en-es', f.request);
  await expect(f.runtime.resolveOffer('start-over')).rejects.toThrow(
    /original|source|recover|pack/i,
  );
  expect(f.sessions.activeGraded()).toEqual(state);
  expect(f.db.all('SELECT * FROM course_session_answer_receipt')).toHaveLength(1);
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
});
it('[INV-SESS-03] regeneration refuses a reused identity even for an untouched abandoned session', async () => {
  const f = completionSetup();
  await f.runtime.start('en-es', f.request);
  await offerRestart(f as ReturnType<typeof restartSetup>);
  const state = f.runtime.readSession()!.state;
  await expect(f.runtime.resolveOffer('start-over')).rejects.toThrow(/identity/i);
  expect(f.runtime.readSession()!.state).toEqual(state);
});
it('[INV-SESS-09][INV-PER-04] actual cross-course End and start new preserves old attempts and restores the destination selection', async () => {
  const f = restartSetup();
  await f.runtime.start('en-es', f.request);
  await answerOne(f);
  const old = f.runtime.readSession()!.state;
  const other = 'en-es-second';
  f.db.run(
    'INSERT INTO course_progress(course_id,added_at,pack_content_hash,score_unlocked,score_ceiling_beat_shown) VALUES(?,?,?,?,?)',
    [other, '2026-09-13', f.pack.contentHash, 0, 0],
  );
  f.db.run('UPDATE course_selection SET is_active=0');
  f.db.run('INSERT INTO course_selection(course_id,is_active,is_selected) VALUES(?,1,0)', [other]);
  f.db.run('INSERT INTO course_path_state VALUES(?,100,0,0)', [other]);
  f.db.run(
    'INSERT INTO course_item(course_id,item_id,countable,quarantined) SELECT ?,item_id,countable,quarantined FROM course_item WHERE course_id=?',
    [other, 'en-es'],
  );
  new SqliteSchedulerStore(f.db).save(other, new SqliteSchedulerStore(f.db).load('en-es', 'UTC'));
  const path = f.pack.pack.path();
  const second = {
    ...f.pack,
    courseId: other,
    pack: {
      ...f.pack.pack,
      meta: { ...f.pack.pack.meta, courseId: other },
      path: () => ({ ...path, manifest: { ...path.manifest, courseId: other } }),
    },
  } as unknown as VerifiedInstalledPack;
  let id = 0;
  const runtime = new SqliteLearningRuntime(f.db, {
    ...f.ports,
    packs: { get: (course) => (course === other ? second : f.pack) },
    newSessionId: () => `second-${++id}`,
  }) as unknown as LearningRuntime;
  await runtime.start(other, f.request);
  expect(runtime.readOffer()?.kind).toBe('collision');
  await runtime.resolveOffer('end-and-start-new');
  expect(runtime.readSession()!.state.courseId).toBe(other);
  expect(f.db.get('SELECT course_id FROM course_selection WHERE is_active=1')?.course_id).toBe(
    other,
  );
  expect(f.db.get('SELECT course_id FROM course_selection WHERE is_selected=1')?.course_id).toBe(
    'en-es',
  );
  expect(f.db.all('SELECT course_id,session_id FROM course_attempt')).toEqual([
    { course_id: 'en-es', session_id: old.sessionId },
  ]);
  expect(f.db.all('SELECT * FROM course_session_context')).toHaveLength(1);
});
it('[INV-SESS-12][INV-SESS-21] untouched stale-source start-over regenerates current verified sources without inventing past attempts', async () => {
  const f = restartSetup();
  await f.runtime.start('en-es', f.request);
  const old = f.runtime.readSession()!.state;
  const extra = f.population.map((p, i) =>
    fixtureLexemes({
      ...p,
      itemId: `updated-${i}`,
      exerciseId: `updated-ex-${i}`,
      gradable: {
        ...p.gradable,
        itemId: `updated-${i}`,
        accepted: [{ surface: 'el gato', surfaceId: `updated-sf-${i}`, rank: 1 }],
      },
      presentation: { ...p.presentation, itemId: `updated-${i}` },
      schedulerSurfaces: p.schedulerSurfaces.map((s) => ({
        ...s,
        itemId: `updated-${i}`,
        surfaceId: `updated-sf-${i}`,
      })),
    }),
  );
  let scheduler = new SqliteSchedulerStore(f.db).load('en-es', 'UTC');
  for (const p of extra) {
    observeFixtureLexemes(f.db, p, at - 86400000);
    scheduler = registerRows(
      scheduler,
      p.schedulerSurfaces.map((s) => ({
        itemId: asItemId(s.itemId),
        surface: s.surface,
        kind: s.kind,
      })),
    );
    for (const s of p.schedulerSurfaces)
      scheduler = introduce(scheduler, asItemId(s.itemId), s.surface, new Date(at - 86400000));
  }
  new SqliteSchedulerStore(f.db).save('en-es', scheduler);
  const oldPath = f.pack.pack.path(),
    node = {
      ...oldPath.forNode('node-1').node,
      sessions: [{ lessonIndex: 1, exerciseIds: extra.map((p) => p.exerciseId) }],
    };
  const path = {
    ...oldPath,
    sections: oldPath.sections.map((section) => ({
      ...section,
      units: section.units.map((unit) => ({ ...unit, nodes: [node] })),
    })),
    forNode: () => ({ node, unitId: 'u1', unitIndex: 0, sectionIndex: 0 }),
  };
  f.setPack({
    ...f.pack,
    contentHash: 'b'.repeat(64),
    pack: { ...f.pack.pack, path: () => path },
    runtimeItem: (id: string) => {
      const item = extra.find((p) => p.exerciseId === id);
      if (!item) throw Error('old source unavailable');
      return item;
    },
  } as unknown as VerifiedInstalledPack);
  f.db.run('UPDATE course_progress SET pack_content_hash=?', ['b'.repeat(64)]);
  await f.runtime.start('en-es', f.request);
  expect(f.runtime.readOffer()?.kind).toBe('resume');
  await f.runtime.resolveOffer('start-over');
  const current = f.runtime.readSession()!.state;
  expect(current.sessionId).not.toBe(old.sessionId);
  expect(current.core.queue.every((q) => extra.some((p) => p.itemId === q.itemId))).toBe(true);
  expect(f.db.all('SELECT * FROM course_attempt')).toEqual([]);
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_session_context')).toHaveLength(1);
});
