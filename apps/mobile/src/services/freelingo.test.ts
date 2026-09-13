// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { migrate } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { toLocalDay } from '@freelingo/core/day';
import { openPack, type PackReader } from '@freelingo/core/packs';
import type { HubInput } from '@freelingo/core/hub';
import type { LearningRuntime, LearningRuntimePorts } from '../db/learningRuntimePorts';
import type { OpenedProgressDb } from '../db/ExpoDb';
import type { FactoryBindings, FactoryResources } from './factoryPorts';
import { SqliteAppState } from './SqliteAppState';
import { createFreelingoServices } from './freelingo';
const now = Date.parse('2026-09-13T10:00:00Z');
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { promise, resolve };
}
function fixture(active = false) {
  const db = createNodeDb();
  migrate(db);
  const closeDb = vi.spyOn(db, 'close');
  closers.push(() => {
    if (!closeDb.mock.calls.length) db.close();
  });
  const app = new SqliteAppState(db);
  if (active) {
    app.initialize(17);
    app.selectCourse('en-es', new Date(now).toISOString());
    db.run("UPDATE course_progress SET pack_state='installed',pack_content_hash=?", [
      'a'.repeat(64),
    ]);
    app.completeOnboarding('en-es', 'a'.repeat(64), new Date(now).toISOString());
  }
  const source = new DatabaseSync(
    new URL('../../../../tools/coursekit/tests/fixtures/path/loader-pack.sqlite', import.meta.url),
    { readOnly: true },
  );
  closers.push(() => source.close());
  const reader: PackReader = {
    all: <T>(sql: string, p: readonly unknown[] = []) =>
      source.prepare(sql).all(...(p as never[])) as T[],
    get: <T>(sql: string, p: readonly unknown[] = []) =>
      source.prepare(sql).get(...(p as never[])) as T | undefined,
  };
  const pack = openPack(reader, { packRoot: '/test-only-pack' });
  const verified = {
    courseId: 'en-es',
    contentHash: 'a'.repeat(64),
    pack,
    manifest: {
      packId: pack.meta.packId,
      courseId: 'en-es',
      version: pack.meta.version,
      major: 1,
      payloadSha256: 'a'.repeat(64),
      payloadBytes: 1,
      audioBytes: 0,
      itemIds: [],
    },
    runtimeItem: () => {
      throw Error('Not a grading fixture');
    },
    audioUri: () => null,
  };
  const events: string[] = [];
  const hub: HubInput = {
    courseId: 'en-es',
    courseLabel: 'Spanish',
    localDay: toLocalDay('2026-09-13'),
    nowUtc: new Date(now).toISOString(),
    seed: 'test',
    items: [],
    mistakes: [],
    sharedReview: { localDay: toLocalDay('2026-09-13'), itemIds: [], spentIds: [] },
    completedUnitIndices: [],
    currentUnitIndex: 0,
    unitLastOfferedDays: {},
    pathOffer: null,
    lastPathCompletedDay: toLocalDay('2026-09-13'),
    preferences: {
      listening: true,
      speaking: true,
      listeningUntilUtc: null,
      speakingUntilUtc: null,
    },
    audioAvailable: false,
    microphoneAvailable: false,
    packReady: true,
    daily: null,
    activeBoost: null,
    ladders: {},
    otherCourseMistakes: [],
  };
  const engine = {
    start: vi.fn(async () => {
      events.push('start');
    }),
    resolveOffer: vi.fn(async () => {}),
    dispatch: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    recordExposure: vi.fn(async () => {}),
    readSession: () => null,
    readCeremony: () => null,
    readOffer: () => null,
    readScheduler: () => {
      throw Error('Unused in factory');
    },
    readDay: () => {
      throw Error('Unused in factory');
    },
    readHub: vi.fn(() => hub),
    saveHubDaily: vi.fn(async () => {}),
    advanceCeremony: vi.fn(async () => {}),
    foreground: vi.fn(async () => {
      events.push('learning foreground');
    }),
    background: vi.fn(async () => {
      events.push('learning background');
    }),
  } satisfies LearningRuntime;
  const constructed = vi.fn();
  class BoundaryRuntime implements LearningRuntime {
    constructor(actualDb: typeof db, ports: LearningRuntimePorts) {
      constructed(actualDb, ports);
    }
    start = engine.start;
    resolveOffer = engine.resolveOffer;
    dispatch = engine.dispatch;
    complete = engine.complete;
    recordExposure = engine.recordExposure;
    readSession = engine.readSession;
    readCeremony = engine.readCeremony;
    readOffer = engine.readOffer;
    readScheduler = engine.readScheduler;
    readDay = engine.readDay;
    readHub = engine.readHub;
    saveHubDaily = engine.saveHubDaily;
    advanceCeremony = engine.advanceCeremony;
    foreground = engine.foreground;
    background = engine.background;
  }
  const resources: FactoryResources = {
    packs: {
      get: () => verified,
      state: () => 'installed',
      refresh: vi.fn(async () => {
        events.push('refresh');
      }),
      close: vi.fn(() => {
        events.push('repository close');
      }),
    },
    media: {
      capabilities: {
        canPlay: false,
        canRecognize: false,
        recognizerLocale: null,
        microphonePermission: 'undetermined',
        screenReaderActive: false,
        announcementInFlight: false,
      },
      play: () => {
        throw Error('No fixture playback');
      },
      recognize: () => {
        throw Error('No fixture microphone');
      },
      remediate: vi.fn(),
      announce: vi.fn(),
    },
    learning: {
      clock: () => ({
        utcMs: now,
        monotonicMs: 100,
        zone: { tzId: 'UTC', utcOffsetMinutes: 0, tzSource: 'fixed_offset' },
      }),
      modalityClock: () => null,
      newSessionId: () => 'test-session',
      canPlayAudio: () => false,
      canRecognizeSpeech: () => false,
      hasTargetScriptInput: () => true,
      reduceMotion: () => false,
      screenReaderActive: () => false,
    },
    catalogue: {
      read: () => [
        {
          id: 'en-es',
          languageName: 'Spanish',
          language: 'es',
          packState: 'installed',
          sizeMb: 1,
          itemCount: 4,
          alignment: 'cefr',
          levelLabel: 'A1',
          machineAuthoredPercent: null,
          wrongItemPercent: null,
          nativeReview: 'unreviewed',
          beta: true,
          download: { kind: 'idle' },
          validatorSummary: 'Test-only catalogue',
        },
      ],
      download: vi.fn(async () => {}),
      pauseDownload: vi.fn(async () => {}),
      playSample: vi.fn(async () => {}),
    },
    restore: {
      read: () => ({ kind: 'offered' }),
      pick: vi.fn(async () => {}),
      confirm: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    },
    notifications: {
      read: () => ({
        platform: 'ios',
        permission: 'undetermined',
        requestedPermission: false,
        undeterminedForegrounds: 0,
        practiceEnabled: true,
        streakEnabled: true,
        hour: 19,
        minute: 0,
        channels: { daily: 'unknown', streak: 'unknown' },
        capabilities: { exactAlarmCapable: false, fireTimeRecheckCapable: false },
      }),
      save: vi.fn(async () => {}),
      requestPermission: vi.fn(async () => {}),
      openSettings: vi.fn(async () => {}),
      openExactAlarmSettings: vi.fn(async () => {}),
    },
    actions: {
      reportItem: vi.fn(async () => {}),
      snoozeItem: vi.fn(async () => {}),
      readSurface: vi.fn(async () => ({ title: 'Bound source', paragraphs: [], rows: [] })),
      applyCourseAction: vi.fn(async () => {}),
      launchLegendary: vi.fn(async () => {}),
      shareCard: vi.fn(async () => {}),
      playWord: vi.fn(async () => {}),
    },
    readUi: () => ({ theme: 'dark', boldText: true, highContrast: true }),
    audioBytesPresent: () => 0,
    prepareForeground: vi.fn(async () => {
      events.push('prepare');
    }),
    publishAndRearm: vi.fn(async () => {
      events.push('publish');
    }),
    background: vi.fn(async () => {
      events.push('native background');
    }),
    subscribe: vi.fn(() => vi.fn()),
    close: vi.fn(async () => {
      events.push('native close');
    }),
  };
  // Only the native handle is a boundary double. Every persistence assertion uses real SQLite.
  const opened: OpenedProgressDb = {
    db,
    handle: {} as OpenedProgressDb['handle'],
    dbPath: '/test-only.db',
    journalMode: 'wal',
    userVersion: 9,
    backup: { taken: null, deleted: [] },
  };
  const bindings: FactoryBindings = {
    appVersion: 'test-version',
    newSelectionSeed: () => 19,
    LearningRuntime: BoundaryRuntime,
    openPersistence: vi.fn(async () => ({
      opened,
      status: {
        platform: 'ios',
        dbPath: opened.dbPath,
        dbPathPersistent: true,
        journalMode: 'wal',
        userVersion: 9,
        packsDir: '/test-only-pack',
        packsExcluded: true,
        packsExcludedError: null,
        preMigrationBackup: null,
        preMigrationBackupsDeleted: [],
      },
    })),
    createResources: vi.fn(async (actual) => {
      expect(actual).toBe(opened);
      return resources;
    }),
  };
  return {
    db,
    closeDb,
    app,
    resources,
    bindings,
    events,
    engine,
    constructed,
    opened,
    services: createFreelingoServices(bindings),
  };
}
it('[INV-PER-06] opens and retains one real database and orders prepare, verification, day processing, publication', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.services.open(), f.services.open()]);
  expect(first).toBe(second);
  expect(first.opened).toBe(f.opened);
  expect(f.bindings.openPersistence).toHaveBeenCalledOnce();
  expect(f.constructed.mock.calls[0]![0]).toBe(f.db);
  expect(f.events).toEqual(['prepare', 'refresh', 'learning foreground', 'publish']);
  expect((await first.readSnapshot()).onboarding?.screen).toBe('courses');
  expect(f.db.all('SELECT * FROM course_progress')).toEqual([]);
  await first.close();
});
it('[INV-PACK-03][INV-PATH-01] active snapshot projects actual signed path and stored settings without fixture grading or rewards', async () => {
  const f = fixture(true),
    runtime = await f.services.open();
  const snapshot = await runtime.readSnapshot();
  expect(snapshot.path.model?.sections[0]?.units[0]?.nodes[0]?.id).toBe('u001:learn');
  expect(snapshot.path.status).toBe('ready');
  expect(snapshot.settings?.goalTier).toBe('regular');
  expect(snapshot.ui).toMatchObject({ theme: 'dark', boldText: true });
  await runtime.loop.setAppearance('light');
  expect((await runtime.readSnapshot()).ui.theme).toBe('light');
  expect(f.db.get('SELECT lifetime_xp FROM account')?.lifetime_xp).toBe(0);
  await runtime.close();
});
it('[INV-PACK-04] missing installed pack is visible and refuses start before the learning runtime', async () => {
  const f = fixture(true);
  f.resources.packs.get = () => null;
  const runtime = await f.services.open();
  expect((await runtime.readSnapshot()).path.status).toBe('pack-missing');
  await expect(
    runtime.launchLesson({
      kind: 'path',
      request: { nodeId: 'u001:learn', unitIndex: 0, flavour: 'lesson' },
    }),
  ).rejects.toThrow(/verified/i);
  expect(f.engine.start).not.toHaveBeenCalled();
  await runtime.close();
});
it('[INV-PATH-06] unknown legacy path history has its own visible state, never a download claim', async () => {
  const f = fixture();
  f.app.initialize(17);
  f.db.run(
    "INSERT INTO course_progress(course_id,added_at,pack_content_hash,pack_state) VALUES('en-es','2026-09-13',?,'installed')",
    ['a'.repeat(64)],
  );
  f.app.selectCourse('en-es', new Date(now).toISOString());
  f.app.completeOnboarding('en-es', 'a'.repeat(64), new Date(now).toISOString());
  const runtime = await f.services.open();
  expect((await runtime.readSnapshot()).path.status).toBe('history-unavailable');
  expect(f.db.all('SELECT * FROM course_path_state')).toEqual([]);
  await runtime.close();
});
it('[INV-SESS-01] repeated user events remain ordered; reads wait for the pending durable write', async () => {
  const f = fixture(true),
    runtime = await f.services.open(),
    gate = deferred();
  f.engine.dispatch.mockImplementationOnce(async () => gate.promise);
  const event = {
    type: 'input',
    text: 'hola',
    caret: 4,
    partialState: {},
    gradeable: true,
  } as const;
  const one = runtime.dispatchLesson(event),
    two = runtime.dispatchLesson(event);
  let readDone = false;
  const read = runtime.readSnapshot().then(() => (readDone = true));
  await Promise.resolve();
  await Promise.resolve();
  expect(f.engine.dispatch).toHaveBeenCalledOnce();
  expect(readDone).toBe(false);
  gate.resolve();
  await Promise.all([one, two, read]);
  expect(f.engine.dispatch).toHaveBeenCalledTimes(2);
  expect(f.resources.packs.refresh).toHaveBeenCalledOnce();
  await runtime.close();
});
it('[INV-MOD-01] serialized OFF then ON uses the actual preference writer and preserves ON', async () => {
  const f = fixture(true),
    runtime = await f.services.open();
  await Promise.all([
    runtime.loop.setPreference('en-es', { key: 'listening', value: false, clearSuspension: null }),
    runtime.loop.setPreference('en-es', {
      key: 'listening',
      value: true,
      clearSuspension: 'listening',
    }),
  ]);
  expect((await runtime.readSnapshot()).settings?.preferences.listening).toBe(true);
  await runtime.close();
});
it('[INV-SESS-27] refresh precedes launch and foreground; background checkpoints before native cleanup', async () => {
  const f = fixture(true),
    runtime = await f.services.open();
  f.events.length = 0;
  await runtime.launchLesson({
    kind: 'path',
    request: { nodeId: 'u001:learn', unitIndex: 0, flavour: 'lesson' },
  });
  expect(f.events).toEqual(['refresh', 'start']);
  f.events.length = 0;
  await runtime.foreground();
  expect(f.events).toEqual(['prepare', 'refresh', 'learning foreground', 'publish']);
  f.events.length = 0;
  await runtime.background();
  expect(f.events).toEqual(['learning background', 'native background']);
  await runtime.close();
});
it('[INV-CER-01] completion delegates to the durable owner and publishes only after it resolves', async () => {
  const f = fixture(true),
    runtime = await f.services.open(),
    gate = deferred();
  f.engine.complete.mockImplementationOnce(async () => gate.promise);
  f.events.length = 0;
  const completed = runtime.completeLesson();
  await Promise.resolve();
  expect(f.events).toEqual([]);
  gate.resolve();
  await completed;
  expect(f.engine.complete).toHaveBeenCalledOnce();
  expect(f.events).toEqual(['publish']);
  expect(f.db.get('SELECT lifetime_xp FROM account')?.lifetime_xp).toBe(0);
  await runtime.close();
});
it('failed native preparation releases resources, repository, and SQLite without returning a partial runtime', async () => {
  const f = fixture();
  vi.mocked(f.resources.prepareForeground).mockRejectedValueOnce(Error('native prepare failed'));
  await expect(f.services.open()).rejects.toThrow('native prepare failed');
  expect(f.resources.close).toHaveBeenCalledOnce();
  expect(f.resources.packs.close).toHaveBeenCalledOnce();
  expect(f.closeDb).toHaveBeenCalledOnce();
});
it('failed resource creation still closes the opened SQLite database', async () => {
  const f = fixture();
  vi.mocked(f.bindings.createResources).mockRejectedValueOnce(Error('resources failed'));
  await expect(f.services.open()).rejects.toThrow('resources failed');
  expect(f.closeDb).toHaveBeenCalledOnce();
});
it('[INV-SESS-27] close is idempotent and drains already queued work even when native release fails', async () => {
  const f = fixture(true),
    runtime = await f.services.open(),
    gate = deferred();
  f.engine.dispatch.mockImplementationOnce(async () => gate.promise);
  vi.mocked(f.resources.close).mockRejectedValueOnce(Error('release failed'));
  const event = { type: 'input', text: 'a', caret: 1, partialState: {}, gradeable: true } as const;
  const write = runtime.dispatchLesson(event),
    close = runtime.close();
  await expect(runtime.dispatchLesson(event)).rejects.toThrow(/closed/i);
  expect(f.closeDb).not.toHaveBeenCalled();
  gate.resolve();
  await write;
  await expect(close).rejects.toThrow(/release failed/i);
  await expect(runtime.close()).rejects.toThrow(/release failed/i);
  expect(f.resources.close).toHaveBeenCalledOnce();
  expect(f.resources.packs.close).toHaveBeenCalledOnce();
  expect(f.closeDb).toHaveBeenCalledOnce();
});

it('[INV-SESS-27][INV-AUD-07] failed background checkpoint still stops native media and preserves the original failure', async () => {
  const f = fixture(true),
    runtime = await f.services.open();
  f.engine.background.mockRejectedValueOnce(Error('SQLite checkpoint failed'));
  await expect(runtime.background()).rejects.toThrow('SQLite checkpoint failed');
  expect(f.resources.background).toHaveBeenCalledOnce();
  await runtime.close();
});
it('[INV-SESS-27][INV-AUD-07] simultaneous checkpoint and native shutdown failures both remain inspectable', async () => {
  const f = fixture(true),
    runtime = await f.services.open();
  f.engine.background.mockRejectedValueOnce(Error('SQLite checkpoint failed'));
  vi.mocked(f.resources.background).mockRejectedValueOnce(Error('Native shutdown failed'));
  await expect(runtime.background()).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: 'SQLite checkpoint failed' }),
      expect.objectContaining({ message: 'Native shutdown failed' }),
    ],
  });
  await runtime.close();
});
it('[INV-PACK-04] explicit repair of a verified partial pack queues audio download and refreshes observed state afterwards', async () => {
  const f = fixture(true),
    runtime = await f.services.open();
  f.resources.packs.state = () => 'partial';
  vi.mocked(f.resources.catalogue.download).mockImplementation(async () => {
    f.events.push('download queued');
  });
  f.events.length = 0;
  await runtime.repairPack();
  expect(f.resources.catalogue.download).toHaveBeenCalledWith('en-es');
  expect(f.events).toEqual(['refresh', 'download queued', 'refresh']);
  expect((await runtime.readSnapshot()).path.status).toBe('ready');
  await runtime.close();
});

it('[INV-ECO-01][INV-ECO-21] Settings saves the goal in the retained database before publication', async () => {
  const f = fixture(true),
    runtime = await f.services.open();
  const observed: unknown[] = [];
  vi.mocked(f.resources.publishAndRearm).mockImplementation(async () => {
    observed.push(f.db.get('SELECT daily_goal_xp FROM account WHERE id=1')?.daily_goal_xp);
  });
  await runtime.loop.setGoal('intense');
  expect(f.db.get('SELECT daily_goal_tier,daily_goal_xp FROM account WHERE id=1')).toMatchObject({
    daily_goal_tier: 'intense',
    daily_goal_xp: 50,
  });
  expect((await runtime.readSnapshot()).settings?.goalTier).toBe('intense');
  expect(observed).toEqual([50]);
  expect(f.engine.complete).not.toHaveBeenCalled();
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
  await runtime.close();
});
it('S004/S006 onboarding persists its selected goal without creating quests or rewards', async () => {
  const f = fixture(),
    runtime = await f.services.open();
  await runtime.handleOnboarding({ type: 'selectCourse', courseId: 'en-es' });
  await runtime.handleOnboarding({ type: 'continue' });
  await runtime.handleOnboarding({ type: 'choosePlacement', choice: 'scratch' });
  await runtime.handleOnboarding({ type: 'continue' });
  vi.mocked(f.resources.publishAndRearm).mockClear();
  await runtime.handleOnboarding({ type: 'chooseGoal', goal: 'casual' });
  expect(f.db.get('SELECT daily_goal_tier,daily_goal_xp FROM account WHERE id=1')).toMatchObject({
    daily_goal_tier: 'casual',
    daily_goal_xp: 10,
  });
  expect((await runtime.readSnapshot()).onboarding).toMatchObject({
    screen: 'goal',
    selected: 'casual',
  });
  expect(f.resources.publishAndRearm).toHaveBeenCalledOnce();
  expect(f.db.all('SELECT * FROM account_quest')).toEqual([]);
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
  await runtime.close();
});
it('[INV-ECO-21] a rejected durable goal write cannot publish a new preference', async () => {
  const f = fixture(true),
    runtime = await f.services.open();
  f.db.run(
    "CREATE TRIGGER reject_goal BEFORE UPDATE OF daily_goal_xp ON account BEGIN SELECT RAISE(ABORT,'goal write rejected'); END",
  );
  vi.mocked(f.resources.publishAndRearm).mockClear();
  await expect(runtime.loop.setGoal('intense')).rejects.toThrow('goal write rejected');
  expect((await runtime.readSnapshot()).settings?.goalTier).toBe('regular');
  expect(f.resources.publishAndRearm).not.toHaveBeenCalled();
  await runtime.close();
});
it('[INV-ECO-21] publication failure preserves a committed goal and retry publishes without replaying its write', async () => {
  const f = fixture(true),
    runtime = await f.services.open();
  vi.mocked(f.resources.publishAndRearm).mockRejectedValueOnce(Error('publication failed'));
  await expect(runtime.loop.setGoal('serious')).rejects.toThrow('publication failed');
  expect((await runtime.readSnapshot()).settings?.goalTier).toBe('serious');
  f.db.run(
    "CREATE TRIGGER reject_repeated_goal BEFORE UPDATE OF daily_goal_xp ON account BEGIN SELECT RAISE(ABORT,'duplicate write'); END",
  );
  vi.mocked(f.resources.publishAndRearm).mockClear();
  await runtime.loop.setGoal('serious');
  expect(f.resources.publishAndRearm).toHaveBeenCalledOnce();
  expect(f.db.all('SELECT * FROM committed_session')).toEqual([]);
  await runtime.close();
});
