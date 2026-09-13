// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { migrate, type Db } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { freshSession, type SessionState } from '@freelingo/core/session';
import { ES_PACK, ES_UNIT } from '../../../../packages/core/src/grading/packs/es';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import { SqliteSessionStore } from './SqliteSessionStore';
import { SqliteLearningContextStore } from './SqliteLearningContextStore';
import { prepareLearningLaunch } from './learningLaunch';
import { SqliteLearningRuntime } from './SqliteLearningRuntime';
import { SqliteSchedulerStore } from './SqliteSchedulerStore';
import { emptySchedulerState, registerRows, introduce, asItemId } from '@freelingo/core/scheduler';
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
  db.run("INSERT INTO course_progress(course_id,added_at) VALUES('en-es','2026-09-13')");
  db.run("INSERT INTO course_selection(course_id,is_active,is_selected) VALUES('en-es',1,1)");
  const item: VerifiedRuntimeItem = {
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
  };
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
    return {
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
    };
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
it('[INV-SESS-01][INV-SESS-05][INV-SESS-21] launch freezes actual eligible authored variants and reloads their exact queue', async () => {
  const f = launchSetup();
  await f.runtime.start('en-es', f.request);
  const state = f.runtime.readSession()!.state;
  expect(state.sessionId).toBe('next');
  expect(state.core.queue.map((q) => q.itemId)).toEqual(f.population.map((p) => p.itemId));
  expect(state.core.queue).toHaveLength(6);
  expect(Object.keys(state.core.optionSeeds)).toHaveLength(6);
  expect(state.shellState).toBe('loading');
  expect(new SqliteLearningRuntime(f.db, f.ports).readSession()).toEqual(f.runtime.readSession());
  expect(
    f.db
      .all('SELECT exercise_id FROM course_session_slot ORDER BY exercise_id')
      .map((r) => r.exercise_id),
  ).toEqual(f.population.map((p) => p.exerciseId));
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
});
it('[INV-SCH-10][INV-SCH-11] unintroduced production cannot be generated by registering declared rows', async () => {
  const f = launchSetup(false);
  await expect(f.runtime.start('en-es', f.request)).rejects.toThrow(/eligible|available|due/i);
  expect(f.db.all('SELECT * FROM course_session_state')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_item_surface')).toEqual([]);
});
it('[INV-PATH-01][INV-SESS-21] stale node placement and undeclared source variants fail before saving a session', async () => {
  const f = launchSetup();
  await expect(
    f.runtime.start('en-es', { kind: 'path', request: { ...f.request.request, unitIndex: 1 } }),
  ).rejects.toThrow();
  f.setPack({ ...f.pack, runtimeItem: (id) => ({ ...f.pack.runtimeItem(id), unitId: 'future' }) });
  await expect(f.runtime.start('en-es', f.request)).rejects.toThrow();
  expect(f.db.all('SELECT * FROM course_session_context')).toEqual([]);
});
it('[INV-PER-03] launch reservation and initial checkpoint roll back as one transaction', async () => {
  const f = launchSetup();
  f.db.run(
    "CREATE TRIGGER kill_start BEFORE INSERT ON course_session_state BEGIN SELECT RAISE(ABORT,'kill start');END",
  );
  await expect(f.runtime.start('en-es', f.request)).rejects.toThrow('kill start');
  expect(f.db.all('SELECT * FROM course_session_context')).toEqual([]);
  f.db.run('DROP TRIGGER kill_start');
  await f.runtime.start('en-es', f.request);
  expect(f.runtime.readSession()?.state.sessionId).toBe('next');
});
it('[INV-SESS-10] an old saved lesson offers a durable-state choice instead of overwriting its queue', async () => {
  const f = launchSetup();
  await f.runtime.start('en-es', f.request);
  const prior = f.runtime.readSession()!.state;
  const later = new SqliteLearningRuntime(f.db, {
    ...f.ports,
    clock: () => ({ utcMs: at + 90000000, monotonicMs: 90000100, zone }),
  });
  await later.start('en-es', f.request);
  expect(later.readOffer()?.kind).toBe('resume');
  expect(later.readSession()!.state).toEqual(prior);
  await later.resolveOffer('resume');
  expect(later.readOffer()).toBeNull();
  expect(later.readSession()!.state.core).toEqual(prior.core);
});
it('[INV-PATH-06] launch cannot manufacture missing legacy path history', async () => {
  const f = launchSetup(true, false);
  await expect(f.runtime.start('en-es', f.request)).rejects.toThrow(/history/);
  expect(f.db.all('SELECT * FROM course_path_state')).toEqual([]);
});

it.each(['typedTranslate', 'meaningSelect'] as const)(
  '[INV-SCH-07] existing introductions do not bypass a report hold during %s launch',
  async (type) => {
    const f = launchSetup();
    f.setPack({
      ...f.pack,
      runtimeItem: (id) => {
        const value = f.pack.runtimeItem(id);
        return {
          ...value,
          gradable: {
            ...value.gradable,
            family: type === 'meaningSelect' ? 'select' : 'typed-translate',
          },
          presentation: { ...value.presentation, type },
        };
      },
    });
    const store = new SqliteSchedulerStore(f.db);
    const state = store.load('en-es', 'UTC');
    store.save('en-es', {
      ...state,
      holds: f.population.map((p) => ({
        scope: { kind: 'item' as const, itemId: asItemId(p.itemId) },
        reason: 'report' as const,
        from: new Date(at - 1000),
        until: null,
      })),
    });
    await expect(f.runtime.start('en-es', f.request)).rejects.toThrow(/eligible|available/);
    expect(f.db.all('SELECT * FROM course_session_context')).toEqual([]);
  },
);
it('[INV-SCH-11] a future observation receipt cannot introduce a source at launch', async () => {
  const f = launchSetup();
  f.db.run('INSERT INTO course_surface_exposure VALUES(?,?,?,?,?,?,?,?,?,?)', [
    'en-es',
    'sf:0',
    'el gato',
    'es',
    'session-proof',
    'slot-proof',
    'e0',
    f.pack.contentHash,
    'wrong-feedback',
    at + 1,
  ]);
  await expect(f.runtime.start('en-es', f.request)).rejects.toThrow(/observation|Observed/);
  expect(f.db.all('SELECT * FROM course_session_context')).toEqual([]);
});
it('[INV-SESS-21] resuming exact saved slots never decodes unrelated future variants', async () => {
  const f = launchSetup();
  await f.runtime.start('en-es', f.request);
  const unknown = {
    nodeId: 'future-node',
    type: 'lesson',
    sessions: [{ lessonIndex: 2, exerciseIds: ['future-missing-metadata'] }],
    introducesScriptUnits: [],
    requiresScriptUnits: [],
  };
  const old = f.pack.pack.path();
  f.setPack({
    ...f.pack,
    pack: {
      ...f.pack.pack,
      path: () => ({
        ...old,
        sections: old.sections.map((s) => ({
          ...s,
          units: s.units.map((u) => ({ ...u, nodes: [...u.nodes, unknown] })),
        })),
      }),
    },
  } as unknown as VerifiedInstalledPack);
  const later = new SqliteLearningRuntime(f.db, {
    ...f.ports,
    clock: () => ({ utcMs: at + 90000000, monotonicMs: 90000100, zone }),
  });
  await later.start('en-es', f.request);
  await later.resolveOffer('resume');
  expect(later.readSession()!.state.sessionId).toBe('next');
});

function paddedSetup() {
  const f = launchSetup();
  const old = f.pack.pack.path(),
    first = old.sections[0]!.units[0]!.nodes[0]!;
  const target = f.population.slice(0, 2).map((p, i) => ({
    ...p,
    itemId: 'target-' + i,
    exerciseId: 'target-e' + i,
    lessonIndex: 2,
    gradable: { ...p.gradable, itemId: 'target-' + i },
    presentation: { ...p.presentation, itemId: 'target-' + i },
    schedulerSurfaces: p.schedulerSurfaces.map((t) => ({
      ...t,
      itemId: 'target-' + i,
      surfaceId: 'target-sf' + i,
    })),
  }));
  const future = f.population.map((p, i) => ({
    ...p,
    itemId: 'future-' + i,
    exerciseId: 'future-e' + i,
    lessonIndex: 3,
    gradable: { ...p.gradable, itemId: 'future-' + i },
    presentation: { ...p.presentation, itemId: 'future-' + i },
    schedulerSurfaces: p.schedulerSurfaces.map((t) => ({
      ...t,
      itemId: 'future-' + i,
      surfaceId: 'future-sf' + i,
    })),
  }));
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
it('[INV-SESS-04][INV-SESS-21][INV-SCH-09] real earlier-node due padding survives kill/resume without spending either shared pool surface', async () => {
  const f = paddedSetup();
  await f.runtime.start('en-es', f.request);
  const state = f.runtime.readSession()!.state;
  expect(state.nodeRef).toBe('node-2');
  expect(state.core.queue.some((q) => f.population.some((p) => p.itemId === q.itemId))).toBe(true);
  expect(state.core.queue.some((q) => f.future.some((p) => p.itemId === q.itemId))).toBe(false);
  const pools = f.db.all('SELECT item_id,spent_by FROM course_review_pool_item');
  expect(pools.map((r) => r.item_id)).toEqual(
    expect.arrayContaining(f.target.map((p) => p.itemId)),
  );
  expect(pools.every((r) => r.spent_by === null)).toBe(true);
  const earlierIndex = state.core.queue.findIndex((q) =>
    f.population.some((p) => p.itemId === q.itemId),
  );
  f.sessions.put({
    ...state,
    core: { ...state.core, index: earlierIndex },
    shellState: 'challenge.idle',
  });
  const restarted = new SqliteLearningRuntime(f.db, f.ports);
  expect(restarted.readSession()!.state.core.queue).toEqual(state.core.queue);
  await restarted.start('en-es', f.request);
  expect(restarted.readOffer()).toBeNull();
  expect(restarted.readSession()!.exerciseId).toBe(
    new SqliteLearningContextStore(f.db)
      .load('en-es', 'next')!
      .slots.find((s) => s.slotId === state.core.queue[earlierIndex]!.id)!.exerciseId,
  );
});
it('[INV-SESS-21][INV-SCH-11] later unlocks and introductions cannot retroactively bless a corrupted saved padding slot', async () => {
  const f = paddedSetup();
  await f.runtime.start('en-es', f.request);
  const state = f.runtime.readSession()!.state,
    contexts = new SqliteLearningContextStore(f.db),
    context = contexts.load('en-es', 'next')!;
  const index = state.core.queue.findIndex((q) => f.population.some((p) => p.itemId === q.itemId)),
    old = state.core.queue[index]!,
    future = f.future[0]!;
  // Recreate a saved imported context claiming an earlier launch. No production source
  // mutator permits this replacement; the read boundary must still detect it.
  f.sessions.delete('en-es', 'graded', 'node-2');
  f.db.run('DELETE FROM course_session_context');
  const queue = state.core.queue.map((q, i) => (i === index ? { ...q, itemId: future.itemId } : q));
  contexts.create(
    context.launch,
    context.slots.map((b) =>
      b.slotId === old.id ? { ...b, itemId: future.itemId, exerciseId: future.exerciseId } : b,
    ),
  );
  f.sessions.activate({ ...state, core: { ...state.core, queue, index } });
  f.db.run(
    "INSERT INTO course_node(course_id,node_id,section_id,unit_id,node_type,node_index,levels_total,levels_completed,completed_at) VALUES('en-es','node-2','1','u1','lesson',1,1,1,?)",
    [new Date(at + 1000).toISOString()],
  );
  // Even a corrupted frozen membership row cannot manufacture historical unlock proof.
  f.db.run(
    'INSERT INTO course_review_pool_item(course_id,local_day,item_id,position) VALUES(?,?,?,?)',
    [
      'en-es',
      '2026-09-13',
      future.itemId,
      f.db.all('SELECT * FROM course_review_pool_item').length,
    ],
  );
  const later = new SqliteLearningRuntime(f.db, {
    ...f.ports,
    clock: () => ({ utcMs: at + 2000, monotonicMs: 2100, zone }),
  });
  expect(() => later.readSession()).toThrow(/eligible when/);
});

function boostSetup() {
  const f = launchSetup();
  f.db.run('INSERT INTO account_boost VALUES(?,?,?,?,?,?,?,?,?,?)', [
    'boost-1',
    'xpBoost',
    2,
    15,
    900,
    new Date(at).toISOString(),
    new Date(at).toISOString(),
    100,
    new Date(at).toISOString(),
    new Date(at + 900000).toISOString(),
  ]);
  const read = (wall: number, monotonic: number) =>
    f.db.withExclusiveTransaction(
      () =>
        prepareLearningLaunch(
          { ...f.db, withExclusiveTransaction: (fn) => fn() },
          f.ports,
          { utcMs: wall, monotonicMs: monotonic, zone },
          'en-es',
          f.request,
        ).launch.boostAtStart,
    );
  return { ...f, read };
}
it('[INV-ECO-02] restoring wall time cannot revive a grant expired by an observed rewind', () => {
  const f = boostSetup();
  expect(f.read(at + 360000, 360100)?.multiplier).toBe(2);
  expect(f.read(at - 1440000, 420100)).toBeNull();
  expect(f.read(at + 420000, 480100)).toBeNull();
});
it('[INV-ECO-02] a reset monotonic reading cannot revive an expired grant or enlarge its shortened expiry', () => {
  const expired = boostSetup();
  expect(expired.read(at + 360000, 3600100)).toBeNull();
  expect(expired.read(at + 420000, 100)).toBeNull();
  const shortened = boostSetup();
  const first = shortened.read(at + 360000, 720100)!;
  expect(first.expiresAtUtc).toBe(new Date(at + 540000).toISOString());
  expect(shortened.read(at + 420000, 100)?.expiresAtUtc).toBe(first.expiresAtUtc);
});
it('[INV-ECO-02] missing persisted boost expiry is explicit unknown provenance', () => {
  const f = boostSetup();
  f.db.run('UPDATE account_boost SET expires_at=NULL');
  expect(() => f.read(at + 1000, 1100)).toThrow(/provenance/);
});

it('[INV-PACK-02] quarantined aggregate rows stay retained and cannot enter a new queue', async () => {
  const f = launchSetup();
  f.db.run('UPDATE course_item SET quarantined=1');
  await expect(f.runtime.start('en-es', f.request)).rejects.toThrow(/eligible|available/);
  expect(f.db.all('SELECT quarantined FROM course_item').every((r) => r.quarantined === 1)).toBe(
    true,
  );
});

it('[INV-SESS-05][INV-CRS-01] resuming a collision restores the saved course without rewriting the onboarding selection', async () => {
  const f = launchSetup();
  await f.runtime.start('en-es', f.request);
  f.db.run("INSERT INTO course_progress(course_id,added_at) VALUES('en-fr','2026-09-13')");
  f.db.withExclusiveTransaction(() => {
    f.db.run('UPDATE course_selection SET is_active=0,is_selected=0');
    f.db.run("INSERT INTO course_selection(course_id,is_active,is_selected) VALUES('en-fr',1,1)");
  });
  await f.runtime.start('en-fr', f.request);
  expect(f.runtime.readOffer()?.kind).toBe('collision');
  await f.runtime.resolveOffer('resume');
  expect(f.runtime.readSession()?.state.courseId).toBe('en-es');
  expect(f.db.get('SELECT course_id FROM course_selection WHERE is_active=1')?.course_id).toBe(
    'en-es',
  );
  expect(f.db.get('SELECT course_id FROM course_selection WHERE is_selected=1')?.course_id).toBe(
    'en-fr',
  );
});

it('[INV-A11Y-06][INV-HUB-09] screen-reader mode excludes all tracing at the real launch boundary', async () => {
  const f = launchSetup();
  const original = f.pack.runtimeItem;
  f.setPack({
    ...f.pack,
    runtimeItem: (id) => {
      const source = original(id);
      return {
        ...source,
        gradable: { ...source.gradable, family: 'character-trace' },
        presentation: { ...source.presentation, type: 'characterTrace' },
      };
    },
  });
  const enabled = new SqliteLearningRuntime(f.db, { ...f.ports, screenReaderActive: () => true });
  await expect(enabled.start('en-es', f.request)).rejects.toThrow(/eligible|available|due/i);
  expect(f.db.all('SELECT * FROM course_session_context')).toEqual([]);
  const disabled = new SqliteLearningRuntime(f.db, { ...f.ports, screenReaderActive: () => false });
  await disabled.start('en-es', f.request);
  expect(disabled.readSession()!.state.core.queue.every((q) => q.type === 'characterTrace')).toBe(
    true,
  );
});
it('[INV-A11Y-06][INV-SESS-21] screen-reader launch retains real declared non-tracing alternatives', async () => {
  const f = launchSetup(),
    original = f.pack.runtimeItem;
  const ids = f.population.map((p) => p.exerciseId + '-trace');
  f.path.forNode('node-1').node.sessions[0]!.exerciseIds.push(...ids);
  f.setPack({
    ...f.pack,
    runtimeItem: (id) => {
      if (!id.endsWith('-trace')) return original(id);
      const source = original(id.slice(0, -6));
      return {
        ...source,
        exerciseId: id,
        gradable: { ...source.gradable, family: 'character-trace' },
        presentation: { ...source.presentation, type: 'characterTrace' },
      };
    },
  });
  const runtime = new SqliteLearningRuntime(f.db, { ...f.ports, screenReaderActive: () => true });
  await runtime.start('en-es', f.request);
  expect(runtime.readSession()!.state.core.queue).toHaveLength(6);
  expect(runtime.readSession()!.state.core.queue.every((q) => q.type === 'typedTranslate')).toBe(
    true,
  );
  expect(f.db.all('SELECT exercise_id FROM course_session_slot').map((r) => r.exercise_id)).toEqual(
    f.population.map((p) => p.exerciseId),
  );
});
