// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import type { Db } from '@freelingo/schema';
import { buildHub, type HubKind } from '@freelingo/core/hub';
import { hubFixture } from './learningHub.fixtures';
import { SqliteLearningRuntime } from './SqliteLearningRuntime';
import type { LearningRuntimeConstructor } from './learningRuntimePorts';
const Runtime: LearningRuntimeConstructor = SqliteLearningRuntime;
import { SqliteLearningContextStore } from './SqliteLearningContextStore';
import { SqlitePoolStore } from './SqlitePoolStore';
import { toLocalDay } from '@freelingo/core/day';
import { SqliteWordStore } from './SqliteWordStore';
import { registerSources } from './learningSources';
import { fixtureLexemes, observeFixtureLexemes } from './learningCompletion.fixtures';
const opened: Db[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));
function setup() {
  const f = hubFixture(false, true);
  opened.push(f.db);
  f.db.run('UPDATE course_progress SET score_unlocked=0,score_ceiling_beat_shown=0');
  const words = new SqliteWordStore(f.db);
  f.teach();
  words.recordIntroduction({
    courseId: 'en-es',
    packContentHash: f.pack.contentHash,
    item: f.item,
    surfaceId: 'spanish-cat',
  });
  let next = 0;
  const ports = { ...f.ports, newSessionId: () => 'hub-session-' + ++next };
  const runtime = new Runtime(f.db, ports);
  const offer = (kind: HubKind = 'today') =>
    buildHub(f.model.read('en-es')).modes.find((m) => m.kind === kind)!.offer!;
  return { ...f, ports, runtime, offer };
}
it('[INV-HUB-03][INV-SCH-05][INV-SESS-21] one actual taught target launches its one physical Hub question and reserves its pool atomically', async () => {
  const f = setup(),
    offered = f.offer();
  expect(offered.itemIds).toEqual(['aggregate-cat']);
  await f.runtime.start('en-es', { kind: 'hub', offer: offered });
  const saved = f.runtime.readSession()!;
  expect(saved.state.flavour).toBe('nodePractice');
  expect(saved.state.core.queue).toHaveLength(1);
  expect(saved.state.core.queue[0]!.itemId).toBe('aggregate-cat');
  const context = new SqliteLearningContextStore(f.db).load('en-es', saved.state.sessionId)!;
  expect(context.launch).toMatchObject({
    economyFlavour: 'hubTargetPractice',
    targetNodeId: null,
    practiceItemRatio: 0.1,
    origin: { kind: 'hub', offerId: offered.id },
  });
  expect(context.slots[0]!.exerciseId).toBe(f.item.exerciseId);
  expect(
    new SqlitePoolStore(f.db)
      .load('en-es', toLocalDay('2026-09-13'))!
      .pool.spentBy.get('aggregate-cat' as never),
  ).toBe('todaysReview');
  expect(f.db.all('SELECT * FROM course_node')).toEqual([]);
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
  expect(new SqliteLearningRuntime(f.db, f.ports).readSession()).toEqual(saved);
});
it('[INV-HUB-09][INV-CER-01] current unavailable or forged offers fail without allocating pool, session or source writes', async () => {
  const f = setup(),
    offered = f.offer();
  for (const altered of [
    { ...offered, flavour: 'hubWords' as const },
    { ...offered, itemIds: ['other'] },
    { ...offered, practiceItemRatio: 1 },
    { ...offered, nodeId: 'n1' },
  ]) {
    const before = f.db.get('SELECT total_changes() AS n');
    await expect(f.runtime.start('en-es', { kind: 'hub', offer: altered })).rejects.toThrow();
    expect(f.db.get('SELECT total_changes() AS n')).toEqual(before);
  }
  f.db.run("UPDATE course_item SET quarantined=1 WHERE item_id='aggregate-cat'");
  await expect(f.runtime.start('en-es', { kind: 'hub', offer: offered })).rejects.toThrow();
  expect(f.db.all('SELECT * FROM course_review_pool_day')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_session_state')).toEqual([]);
});
it('[INV-CER-01][INV-SCH-05] a failed final session insert rolls back the real Today reservation and pool header', async () => {
  const f = setup(),
    offered = f.offer();
  f.db.run(
    "CREATE TRIGGER fail_hub BEFORE INSERT ON course_session_state BEGIN SELECT RAISE(ABORT,'session write interrupted'); END",
  );
  await expect(f.runtime.start('en-es', { kind: 'hub', offer: offered })).rejects.toThrow(
    'session write interrupted',
  );
  expect(f.db.all('SELECT * FROM course_review_pool_day')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_session_context')).toEqual([]);
  f.db.run('DROP TRIGGER fail_hub');
  await f.runtime.start('en-es', { kind: 'hub', offer: offered });
  expect(f.runtime.readSession()?.state.core.queue).toHaveLength(1);
});
it('[INV-HUB-05][INV-SESS-02] reopening the same saved Hub offer resumes its frozen source even after its Today item is spent', async () => {
  const f = setup(),
    offer = f.offer();
  await f.runtime.start('en-es', { kind: 'hub', offer });
  const before = f.runtime.readSession();
  await f.runtime.start('en-es', { kind: 'hub', offer });
  expect(f.runtime.readOffer()).toBeNull();
  expect(f.runtime.readSession()).toEqual(before);
});
it('[INV-HUB-05] runtime exposes the actual read/save backend without awarding or introducing anything', async () => {
  const f = setup();
  expect(f.runtime.readHub('en-es')).toEqual(f.model.read('en-es'));
  const daily = buildHub(f.runtime.readHub('en-es')).daily;
  await f.runtime.saveHubDaily(daily);
  expect(f.runtime.readHub('en-es').daily).toEqual(daily);
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
});

it('[INV-SESS-04][INV-HUB-05][INV-HUB-06] real Hub dispatch grades, kill-restores its banner, then commits one source-backed review without path progress', async () => {
  const f = setup();
  await f.runtime.start('en-es', { kind: 'hub', offer: f.offer() });
  await f.runtime.dispatch({ type: 'rendered' });
  await f.runtime.dispatch({
    type: 'input',
    text: 'cat',
    caret: 3,
    partialState: {},
    gradeable: true,
  });
  await f.runtime.dispatch({ type: 'check' });
  expect(f.runtime.readSession()?.state.shellState).toBe('banner.correct');
  const resumed = new SqliteLearningRuntime(f.db, f.ports);
  expect(resumed.readSession()).toEqual(f.runtime.readSession());
  for (let n = 0; n < 10 && resumed.readSession(); n++)
    await resumed.dispatch({ type: 'continue' });
  expect(resumed.readSession()).toBeNull();
  expect(f.db.get('SELECT flavour,xp_awarded,graded_attempts FROM committed_session')).toEqual({
    flavour: 'hubTargetPractice',
    xp_awarded: 0,
    graded_attempts: 1,
  });
  expect(f.db.all('SELECT * FROM course_attempt')).toHaveLength(1);
  expect(f.db.all('SELECT * FROM course_attempt_target')).toHaveLength(1);
  expect(f.db.all('SELECT * FROM course_node')).toEqual([]);
  await resumed.complete();
  expect(f.db.all('SELECT * FROM committed_session')).toHaveLength(1);
  expect(resumed.readHub('en-es').daily?.completedIds).toContain('2026-09-13/en-es/today/');
});
it('[INV-HUB-03][INV-SCH-11] five taught MATCH children remain one whole question; opening Hub registers only its missing aggregate parent', async () => {
  const f = hubFixture(true, true);
  opened.push(f.db);
  const pairs = ['gato', 'perro', 'ave', 'pez', 'oso'].map((left, i) => ({
    leftItemId: 'lex:' + i,
    leftId: 'l' + i,
    rightId: 'r' + i,
    left,
    right: ['cat', 'dog', 'bird', 'fish', 'bear'][i]!,
  }));
  const item = fixtureLexemes({
    ...f.item,
    gradable: { itemId: f.item.itemId, family: 'match', accepted: [] },
    presentation: {
      ...f.item.presentation,
      type: 'matchPairs',
      prompt: 'Match the pairs',
      promptLanguage: 'en',
      language: 'es',
      pairs,
      acceptedAnswers: [],
    },
    schedulerSurfaces: pairs.map((p) => ({
      itemId: p.leftItemId,
      surfaceId: 'match:' + p.leftId,
      surface: p.left,
      language: 'es',
      kind: 'lexeme',
      itemRef: p.leftItemId,
      canonical: true,
    })),
    introductions: [],
  });
  const pack = { ...f.pack, runtimeItem: () => item };
  f.setPack(pack);
  observeFixtureLexemes(f.db, item, f.ports.clock().utcMs - 86400000);
  f.store.save(
    'en-es',
    registerSources(f.db, 'en-es', f.store.load('en-es', 'UTC'), [{ item }], f.ports.clock()),
  );
  f.db.run('DELETE FROM course_item WHERE item_id=?', [item.itemId]);
  const ports = { ...f.ports, newSessionId: () => 'hub-match' },
    runtime = new SqliteLearningRuntime(f.db, ports);
  const input = runtime.readHub('en-es'),
    offer = buildHub(input).modes.find((m) => m.kind === 'words')!.offer!;
  expect(input.items).toHaveLength(5);
  expect(offer.itemIds).toEqual([item.itemId]);
  expect(
    f.store.load('en-es', 'UTC').introductions.firstIntroducedAt.has(item.itemId as never),
  ).toBe(false);
  await runtime.saveHubDaily(buildHub(input).daily);
  await runtime.start('en-es', { kind: 'hub', offer });
  const session = runtime.readSession()!;
  expect(session.state.core.queue).toHaveLength(1);
  expect(session.challenge!.pairs).toHaveLength(5);
  expect(
    new SqliteLearningContextStore(f.db).load('en-es', 'hub-match')!.launch.practiceItemRatio,
  ).toBe(0.1);
  expect(
    f.store.load('en-es', 'UTC').introductions.firstIntroducedAt.has(item.itemId as never),
  ).toBe(false);
  expect(
    f.db.all('SELECT spent_by FROM course_review_pool_item').every((r) => r.spent_by === null),
  ).toBe(true);
});

it('[INV-HUB-08][INV-HUB-05] saving the current Rewind recommendation does not consume it before Start', async () => {
  const f = setup(),
    second = {
      nodeId: 'n2',
      type: 'chest',
      sessions: [],
      introducesScriptUnits: [],
      requiresScriptUnits: [],
    };
  const path = {
    ...f.path,
    manifest: { ...f.path.manifest, supportedNodeTypes: ['lesson', 'chest'] },
    sections: [
      {
        ...f.path.sections[0]!,
        units: [
          ...f.path.sections[0]!.units,
          { unitId: 'u2', unitIndex: 2, title: 'Next unit', colourIndex: 1, nodes: [second] },
        ],
      },
    ],
    forNode: (id: string) =>
      id === 'n2'
        ? { node: second, unitId: 'u2', unitIndex: 1, sectionIndex: 0 }
        : f.path.forNode(id),
  };
  f.setPack({ ...f.pack, pack: { ...f.pack.pack, path: () => path } } as unknown as typeof f.pack);
  f.db.run(
    "INSERT INTO course_node(course_id,node_id,section_id,unit_id,node_type,node_index,levels_total,levels_completed,completed_at) VALUES('en-es','n1','1','u1','lesson',0,1,1,'2026-09-12T12:00:00Z')",
  );
  const input = f.runtime.readHub('en-es'),
    model = buildHub(input),
    offer = model.modes.find((m) => m.kind === 'rewind')!.offer!;
  expect(offer?.unitIndex).toBe(0);
  expect(model.daily.choiceIds).toContain(offer.id);
  await f.runtime.saveHubDaily(model.daily);
  expect(
    buildHub(f.runtime.readHub('en-es')).modes.find((m) => m.kind === 'rewind')!.offer,
  ).toEqual(offer);
  await f.runtime.start('en-es', { kind: 'hub', offer });
  expect(f.runtime.readSession()?.state.core.queue).toHaveLength(1);
});

it('[INV-SESS-21][INV-HUB-09] a saved Hub source rejects a changed exact variant rather than silently substituting a currently available answer', async () => {
  const f = setup();
  await f.runtime.start('en-es', { kind: 'hub', offer: f.offer() });
  f.setPack({
    ...f.pack,
    runtimeItem: () => ({
      ...f.item,
      presentation: { ...f.item.presentation, type: 'meaningSelect' },
    }),
  });
  expect(() => new SqliteLearningRuntime(f.db, f.ports).readSession()).toThrow(/saved variant/);
  expect(f.db.all('SELECT * FROM course_session_state')).toHaveLength(1);
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
});
