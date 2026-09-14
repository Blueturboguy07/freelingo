// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import type { Db } from '@freelingo/schema';
import { buildHub } from '@freelingo/core/hub';
import { freshSession, type SessionState } from '@freelingo/core/session';
import { hubFixture } from './learningHub.fixtures';
import { SqliteLearningRuntime } from './SqliteLearningRuntime';
import { SqliteSessionStore } from './SqliteSessionStore';
import { SqliteLearningContextStore } from './SqliteLearningContextStore';
const opened: Db[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));
async function setup(mode: 'today' | 'target' = 'today') {
  const f = hubFixture(false, true);
  opened.push(f.db);
  f.db.run('UPDATE course_progress SET score_unlocked=0,score_ceiling_beat_shown=0');
  f.teach();
  const ordinaryPorts = { ...f.ports, newSessionId: () => 'saved-hub' };
  const owner = new SqliteLearningRuntime(f.db, ordinaryPorts);
  const offer = buildHub(f.model.read('en-es')).modes.find((m) => m.kind === mode)!.offer!;
  await owner.start('en-es', { kind: 'hub', offer });
  const state = owner.readSession()!.state;
  const context = new SqliteLearningContextStore(f.db).load('en-es', state.sessionId)!;
  let clockAllowed = false;
  const clock = vi.fn(() => {
    if (!clockAllowed) throw Error('resume inspection must not read the clock');
    return ordinaryPorts.clock();
  });
  const ports = {
    ...ordinaryPorts,
    clock,
    newSessionId: vi.fn((): string => {
      throw Error('no allocation');
    }),
  };
  const runtime = new SqliteLearningRuntime(f.db, ports);
  const expected = { sessionId: state.sessionId, packContentHash: f.pack.contentHash };
  const snapshot = () => ({
    changes: f.db.get('SELECT total_changes() AS n'),
    sessions: f.db.all('SELECT * FROM course_session_state ORDER BY course_id,node_ref'),
    contexts: f.db.all('SELECT * FROM course_session_context ORDER BY course_id,session_id'),
    selection: f.db.all('SELECT * FROM course_selection ORDER BY course_id'),
    archive: f.db.all('SELECT * FROM committed_session'),
  });
  function parkAndAddPath(courseId = 'en-es') {
    const sessions = new SqliteSessionStore(f.db);
    sessions.park();
    const path: SessionState = freshSession({
      sessionId: 'saved-path-' + courseId,
      courseId,
      nodeRef: 'n1',
      queue: state.core.queue.map((q) => ({ ...q, nodeRef: 'n1' })),
    });
    new SqliteLearningContextStore(f.db).create(
      {
        ...context.launch,
        courseId,
        nodeRef: 'n1',
        economyFlavour: 'lesson',
        origin: { kind: 'path' },
        targetNodeId: 'n1',
        start: { ...context.launch.start, sessionId: path.sessionId },
      },
      context.slots,
    );
    sessions.activate(path);
    return path;
  }
  return {
    ...f,
    owner,
    runtime,
    ordinaryPorts,
    ports,
    clock,
    expected,
    state,
    context,
    snapshot,
    parkAndAddPath,
    allowClock: () => {
      clockAllowed = true;
    },
  };
}
it('[INV-WID-09][INV-SESS-21] inspection and explicit S051 preparation preserve every saved byte, lease and clock for a sub-24-hour active lesson', async () => {
  const f = await setup(),
    before = f.snapshot();
  expect(f.runtime.readResumableCourse('en-es')).toEqual({
    status: 'ready',
    candidate: {
      courseId: 'en-es',
      nodeRef: f.state.nodeRef,
      ...f.expected,
    },
  });
  await f.runtime.prepareResumeOffer('en-es', f.expected);
  expect(f.runtime.readOffer()).toEqual({
    kind: 'resume',
    sessionId: f.state.sessionId,
    lessonLabel: f.state.nodeRef,
  });
  await f.runtime.prepareResumeOffer('en-es', f.expected);
  expect(f.snapshot()).toEqual(before);
  expect(f.clock).not.toHaveBeenCalled();
  expect(f.ports.newSessionId).not.toHaveBeenCalled();
  f.allowClock();
  await f.runtime.resolveOffer('resume');
  expect(f.runtime.readSession()!.state.sessionId).toBe(f.state.sessionId);
  expect(f.runtime.readOffer()).toBeNull();
});
it('[INV-WID-09][INV-SESS-17][INV-CRS-01] a sole parked course candidate is read without switching; only explicit resume restores its course', async () => {
  const f = await setup();
  new SqliteSessionStore(f.db).park();
  f.db.run("INSERT INTO course_progress(course_id,added_at) VALUES('en-fr','2026-09-13')");
  f.db.run('UPDATE course_selection SET is_active=0,is_selected=0');
  f.db.run("INSERT INTO course_selection(course_id,is_active,is_selected) VALUES('en-fr',1,1)");
  const before = f.snapshot();
  expect(f.runtime.readResumableCourse('en-es').status).toBe('ready');
  await f.runtime.prepareResumeOffer('en-es', f.expected);
  expect(f.snapshot()).toEqual(before);
  f.allowClock();
  await f.runtime.resolveOffer('resume');
  expect(f.db.get('SELECT course_id FROM course_selection WHERE is_active=1')!.course_id).toBe(
    'en-es',
  );
  expect(f.db.get('SELECT course_id FROM course_selection WHERE is_selected=1')!.course_id).toBe(
    'en-fr',
  );
});
it('[INV-WID-09][INV-SESS-17] an active same-course candidate wins; multiple parked candidates never use key or wall-clock ordering', async () => {
  const f = await setup(),
    path = f.parkAndAddPath();
  expect(f.runtime.readResumableCourse('en-es')).toMatchObject({
    status: 'ready',
    candidate: { sessionId: path.sessionId },
  });
  new SqliteSessionStore(f.db).park();
  const before = f.snapshot();
  expect(f.runtime.readResumableCourse('en-es')).toEqual({
    status: 'unavailable',
    reason: 'multiple-parked-sessions',
  });
  await expect(f.runtime.prepareResumeOffer('en-es', f.expected)).rejects.toThrow(/unavailable/);
  expect(f.runtime.readOffer()).toBeNull();
  expect(f.snapshot()).toEqual(before);
});
it('[INV-WID-09][INV-SESS-09] a different course active lease is explicit and cannot be parked by a widget read or preparation', async () => {
  const f = await setup();
  f.db.run("INSERT INTO course_progress(course_id,added_at) VALUES('en-fr','2026-09-13')");
  f.db.run("INSERT INTO course_selection(course_id,is_active,is_selected) VALUES('en-fr',0,0)");
  f.parkAndAddPath('en-fr');
  const before = f.snapshot();
  expect(f.runtime.readResumableCourse('en-es')).toEqual({
    status: 'unavailable',
    reason: 'another-course-active',
  });
  await expect(f.runtime.prepareResumeOffer('en-es', f.expected)).rejects.toThrow(/unavailable/);
  expect(f.snapshot()).toEqual(before);
});
it('[INV-WID-09][INV-SESS-21] stale session and pack identities cannot replace the inspected candidate', async () => {
  const f = await setup(),
    before = f.snapshot();
  for (const expected of [
    { ...f.expected, sessionId: 'different' },
    { ...f.expected, packContentHash: 'b'.repeat(64) },
  ])
    await expect(f.runtime.prepareResumeOffer('en-es', expected)).rejects.toThrow(/changed/);
  expect(f.runtime.readOffer()).toBeNull();
  expect(f.snapshot()).toEqual(before);
});
it('[INV-WID-09][INV-SESS-09] preparation cannot replace an existing collision decision', async () => {
  const f = await setup();
  f.allowClock();
  await f.runtime.start('en-es', {
    kind: 'path',
    request: { nodeId: 'n1', unitIndex: 0, flavour: 'lesson' },
  });
  const offer = f.runtime.readOffer(),
    before = f.snapshot();
  expect(offer!.kind).toBe('collision');
  await expect(f.runtime.prepareResumeOffer('en-es', f.expected)).rejects.toThrow(/offer/);
  expect(f.runtime.readOffer()).toEqual(offer);
  expect(f.snapshot()).toEqual(before);
});
it('[INV-WID-09][INV-SESS-21] missing or changed source is an inert unavailable result and never deletes saved progress', async () => {
  const f = await setup(),
    before = f.snapshot();
  const missing = new SqliteLearningRuntime(f.db, { ...f.ports, packs: { get: () => null } });
  expect(missing.readResumableCourse('en-es')).toEqual({
    status: 'unavailable',
    reason: 'saved-source-unavailable',
  });
  f.setPack({
    ...f.pack,
    runtimeItem: () => ({
      ...f.item,
      presentation: { ...f.item.presentation, type: 'meaningSelect' },
    }),
  });
  expect(f.runtime.readResumableCourse('en-es')).toEqual({
    status: 'unavailable',
    reason: 'saved-source-unavailable',
  });
  await expect(f.runtime.prepareResumeOffer('en-es', f.expected)).rejects.toThrow(/unavailable/);
  expect(f.snapshot()).toEqual(before);
});
it('[INV-WID-09][INV-SESS-15] corrupt checkpoints remain recoverable bytes with no thrown widget read or side effects', async () => {
  const f = await setup();
  f.db.run("UPDATE course_session_state SET runtime_json='{}'");
  const before = f.snapshot();
  expect(f.runtime.readResumableCourse('en-es')).toEqual({
    status: 'unavailable',
    reason: 'saved-state-unavailable',
  });
  await expect(f.runtime.prepareResumeOffer('en-es', f.expected)).rejects.toThrow(/unavailable/);
  expect(f.snapshot()).toEqual(before);
});
it('[INV-WID-09][INV-CER-01] frozen completion and terminal state are never offered as a live lesson', async () => {
  const f = await setup();
  new SqliteLearningContextStore(f.db).freezeCompletion('en-es', f.state.sessionId, {
    completedAtUtcMs: f.context.launch.start.startedAtUtcMs,
    completedAtMonotonicMs: 60000,
    completionZone: f.context.launch.start.startZone,
    outcome: 'quit',
    intendedAtUtc: new Date(f.context.launch.start.startedAtUtcMs).toISOString(),
  });
  const before = f.snapshot();
  expect(f.runtime.readResumableCourse('en-es')).toEqual({
    status: 'unavailable',
    reason: 'pending-completion',
  });
  await expect(f.runtime.prepareResumeOffer('en-es', f.expected)).rejects.toThrow(/unavailable/);
  expect(f.snapshot()).toEqual(before);
});
it('[INV-WID-09][INV-CER-01] an actual pending reward ceremony takes precedence over preparing another lesson offer', async () => {
  const f = await setup();
  await f.owner.dispatch({ type: 'rendered' });
  await f.owner.recordExposure({
    sessionId: f.state.sessionId,
    slotId: f.state.core.queue[0]!.id,
    itemId: f.item.itemId,
    exerciseId: f.item.exerciseId,
    when: 'prompt',
  });
  await f.owner.dispatch({
    type: 'input',
    text: 'cat',
    caret: 3,
    partialState: {},
    gradeable: true,
  });
  await f.owner.dispatch({ type: 'check' });
  for (let i = 0; i < 10 && f.owner.readSession(); i++)
    await f.owner.dispatch({ type: 'continue' });
  expect(f.owner.readCeremony()?.status).toBe('committed');
  const before = f.snapshot();
  expect(f.runtime.readResumableCourse('en-es')).toEqual({
    status: 'unavailable',
    reason: 'pending-ceremony',
  });
  await expect(f.runtime.prepareResumeOffer('en-es', f.expected)).rejects.toThrow(/unavailable/);
  expect(f.snapshot()).toEqual(before);
});
it('[INV-WID-09] a removed or empty course is reported without creating a candidate', async () => {
  const f = await setup();
  new SqliteSessionStore(f.db).delete('en-es', 'graded', f.state.nodeRef);
  const before = f.snapshot();
  expect(f.runtime.readResumableCourse('en-es')).toEqual({ status: 'none' });
  expect(f.runtime.readResumableCourse('not-installed')).toEqual({ status: 'none' });
  expect(f.snapshot()).toEqual(before);
});

it('[INV-WID-09][INV-SESS-03] an inspected START OVER is deferred until the explicit choice and then uses the actual due exception and fresh source plan', async () => {
  const f = await setup('target');
  const before = f.snapshot();
  await f.runtime.prepareResumeOffer('en-es', f.expected);
  expect(f.snapshot()).toEqual(before);
  f.allowClock();
  f.ports.newSessionId.mockImplementation(() => 'regenerated');
  await f.runtime.resolveOffer('start-over');
  expect(f.runtime.readSession()!.state.sessionId).toBe('regenerated');
  expect(f.runtime.readSession()!.state.core.queue[0]!.itemId).toBe(f.item.itemId);
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
  expect(f.db.get('SELECT session_id FROM course_session_context')!.session_id).toBe('regenerated');
});
it('[INV-WID-09][INV-SESS-21] a structurally valid empty queue cannot manufacture a source-backed resume candidate', async () => {
  const f = await setup();
  new SqliteSessionStore(f.db).put({ ...f.state, core: { ...f.state.core, queue: [], index: 0 } });
  const before = f.snapshot();
  expect(f.runtime.readResumableCourse('en-es')).toEqual({
    status: 'unavailable',
    reason: 'saved-state-unavailable',
  });
  expect(f.snapshot()).toEqual(before);
});
it('[INV-WID-09][INV-CER-01] a terminal checkpoint without completion metadata remains unavailable and preserved', async () => {
  const f = await setup();
  new SqliteSessionStore(f.db).put({ ...f.state, exited: 'quit' });
  const before = f.snapshot();
  expect(f.runtime.readResumableCourse('en-es')).toEqual({
    status: 'unavailable',
    reason: 'pending-completion',
  });
  expect(f.snapshot()).toEqual(before);
});
it('[INV-WID-09][INV-SESS-21] source revalidation at the explicit decision cannot resume a replaced pack after the offer was prepared', async () => {
  const f = await setup();
  await f.runtime.prepareResumeOffer('en-es', f.expected);
  f.setPack({ ...f.pack, contentHash: 'b'.repeat(64) });
  const before = f.snapshot(),
    offer = f.runtime.readOffer();
  f.allowClock();
  await expect(f.runtime.resolveOffer('resume')).rejects.toThrow(/unavailable|changed/);
  expect(f.runtime.readOffer()).toEqual(offer);
  expect(f.snapshot()).toEqual(before);
});
