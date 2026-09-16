// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, type Db } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import {
  freshSession,
  step,
  DEFAULT_FLAVOUR_MATRIX,
  type SessionState,
  type StepDeps,
} from '@freelingo/core/session';
import { ES_PACK, ES_UNIT } from '../../../../packages/core/src/grading/packs/es';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import { SqliteSessionStore } from './SqliteSessionStore';
import { SqliteWordStore } from './SqliteWordStore';
import { SqliteSchedulerStore } from './SqliteSchedulerStore';
import { contentHashItemId } from '../../../../packages/core/src/packs/items';
import { SqliteLearningContextStore } from './SqliteLearningContextStore';
import { SqliteLearningRuntime } from './SqliteLearningRuntime';
import { roleOfExerciseType } from '@freelingo/core/scheduler';
import { gradeRuntimeItem } from './learningGrading';
const opened: Db[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of opened) db.close();
  opened.length = 0;
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
const at = Date.parse('2026-09-13T12:00:00Z');
const zone = { tzId: 'UTC', utcOffsetMinutes: 0, tzSource: 'iana' } as const;
function wrongBanner(state: SessionState, item: VerifiedRuntimeItem): SessionState {
  const deps: StepDeps = {
    config: DEFAULT_FLAVOUR_MATRIX.lesson,
    clock: { nowMs: () => 100 },
    isTypeEligible: () => true,
    stepUpTripped: () => false,
    grading: {
      grade: (request) =>
        gradeRuntimeItem(item, request, { introducedSurfaceIds: new Set() }).session,
    },
  };
  let next = step(
    state,
    { type: 'input', text: 'el perro', caret: 8, partialState: {}, gradeable: true },
    deps,
  ).state;
  next = step(next, { type: 'check' }, deps).state;
  return step(next, { type: 'graded' }, deps).state;
}
function setup(
  transform: (item: VerifiedRuntimeItem) => VerifiedRuntimeItem = (item) => item,
  location?: string,
) {
  const db = createNodeDb(location ? { location } : {});
  if (location) db.run('PRAGMA journal_mode=WAL');
  opened.push(db);
  migrate(db);
  new SqliteWordStore(db).initializeFreshHistory(at - 1000, { databaseWasCreated: true });
  db.run(
    "INSERT INTO course_progress(course_id,added_at,pack_content_hash) VALUES('en-es','2026-09-13',?)",
    ['a'.repeat(64)],
  );
  db.run("INSERT INTO course_selection(course_id,is_active,is_selected) VALUES('en-es',1,1)");
  const item: VerifiedRuntimeItem = transform({
    schemaVersion: 1,
    exerciseId: 'exercise-1',
    itemId: 'semantic-1',
    unitId: 'u1',
    lessonIndex: 1,
    profileId: 'es',
    responseLanguage: 'es',
    proof: {
      sourceId: 'source',
      sourceSha256: 'a'.repeat(64),
      approvalId: 'review',
      approvalSha256: 'b'.repeat(64),
      draftSha256: 'c'.repeat(64),
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
        itemRef: 'lx:gato:NOUN',
        canonical: true,
      },
    ],
    lexicalBindings: [
      {
        schedulerItemId: 'semantic-1',
        surfaceId: 'sf:gato',
        surface: 'el gato',
        language: 'es',
        lexemeId: 'lx:gato:NOUN',
        lemma: 'gato',
        pos: 'NOUN',
        wordItemId: contentHashItemId({
          prompt: 'a domestic feline',
          preferredSurface: 'gato',
          register: 'neutral',
          lexemes: ['gato'],
          grammarConcepts: [],
          graphemes: [],
        }),
        semantic: {
          prompt: 'a domestic feline',
          preferredSurface: 'gato',
          register: 'neutral',
          lexemes: ['gato'],
          grammarConcepts: [],
          graphemes: [],
        },
        countable: true,
        classification: 'word',
        proof: {
          sourceId: 'source',
          sourceSha256: 'a'.repeat(64),
          declarationSha256: 'd'.repeat(64),
          bindingSha256: 'e'.repeat(64),
        },
      },
    ],
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
        role: roleOfExerciseType(item.presentation.type),
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
it('[INV-GRD-27][INV-SESS-01] loading the exact saved variant introduces no hidden accepted alternate', () => {
  const { runtime, db } = setup();
  expect(runtime.readSession()?.exerciseId).toBe('exercise-1');
  expect(runtime.readSession()?.challenge?.acceptedAnswers).toEqual(['el gato', 'el felino']);
  expect(db.all('SELECT * FROM course_surface_exposure')).toEqual([]);
});
it('[INV-GRD-27] only a current wrong banner records its actual visible target-language surface once', async () => {
  const { db, item, runtime, request, initial, sessions, ports } = setup();
  await runtime.recordExposure(request);
  expect(db.all('SELECT * FROM course_surface_exposure')).toEqual([]);
  sessions.put(wrongBanner(initial, item));
  await runtime.recordExposure(request);
  expect(
    db.all(
      'SELECT surface_id,surface,language,exercise_id,display_role FROM course_surface_exposure',
    ),
  ).toEqual([
    {
      surface_id: 'sf:gato',
      surface: 'el gato',
      language: 'es',
      exercise_id: 'exercise-1',
      display_role: 'wrong-feedback',
    },
  ]);
  const first = db.all('SELECT * FROM course_surface_exposure');
  await new SqliteLearningRuntime(db, ports).recordExposure(request);
  expect(db.all('SELECT * FROM course_surface_exposure')).toEqual(first);
  expect(db.all('SELECT * FROM course_attempt')).toEqual([]);
  expect(
    [...new SqliteSchedulerStore(db).load('en-es', 'UTC').rows.values()].map((r) =>
      r.introducedAt?.getTime(),
    ),
  ).toEqual([at]);
});
it('[INV-GRD-27] actual Spanish reverse prompt can be introduced but English prompts and wrong answers cannot', async () => {
  const { db, item, runtime, request, getPack, setPack } = setup();
  await runtime.recordExposure({ ...request, when: 'prompt' });
  expect(db.all('SELECT * FROM course_surface_exposure')).toEqual([]);
  const reverse = {
    ...item,
    responseLanguage: 'en',
    presentation: {
      ...item.presentation,
      prompt: 'El gato',
      promptLanguage: 'es',
      language: 'en',
      acceptedAnswers: ['the cat'],
    },
    introductions: [
      {
        surfaceId: 'sf:spanish-prompt',
        surface: 'El gato',
        language: 'es',
        when: 'prompt' as const,
      },
    ],
  };
  setPack({ ...getPack(), runtimeItem: () => reverse });
  await runtime.recordExposure({ ...request, when: 'prompt' });
  expect(db.all('SELECT surface,language FROM course_surface_exposure')).toEqual([
    { surface: 'El gato', language: 'es' },
  ]);
});
it('[INV-SESS-01][INV-GRD-27] stale session, slot, item, variant and parked callbacks cannot create exposure', async () => {
  const { db, item, runtime, request, initial, sessions } = setup();
  sessions.put(wrongBanner(initial, item));
  for (const bad of [
    { ...request, sessionId: 'old' },
    { ...request, slotId: 'old' },
    { ...request, itemId: 'old' },
    { ...request, exerciseId: 'old' },
  ])
    await runtime.recordExposure(bad);
  sessions.park();
  await runtime.recordExposure(request);
  expect(db.all('SELECT * FROM course_surface_exposure')).toEqual([]);
});
it('[INV-PACK-41] a changed pack or mismatched decoded variant refuses the saved source before writing', async () => {
  for (const mismatch of ['hash', 'variant'] as const) {
    const { db, runtime, request, item, getPack, setPack, initial, sessions } = setup();
    sessions.put(wrongBanner(initial, item));
    setPack(
      mismatch === 'hash'
        ? { ...getPack(), contentHash: 'b'.repeat(64) }
        : { ...getPack(), runtimeItem: () => ({ ...item, exerciseId: 'other' }) },
    );
    expect(() => runtime.readSession()).toThrow();
    await expect(runtime.recordExposure(request)).rejects.toThrow();
    expect(db.all('SELECT * FROM course_surface_exposure')).toEqual([]);
  }
});
it('[INV-GRD-27] malformed visible evidence preserves the original receipt and all scheduler state', async () => {
  const { db, runtime, request, initial, sessions, getPack, setPack, item } = setup();
  sessions.put(wrongBanner(initial, item));
  await runtime.recordExposure(request);
  setPack({
    ...getPack(),
    runtimeItem: () => ({
      ...item,
      introductions: [
        { surfaceId: 'sf:gato', surface: 'different text', language: 'es', when: 'wrong-feedback' },
      ],
    }),
  });
  await expect(runtime.recordExposure(request)).rejects.toThrow();
  expect(db.get('SELECT surface FROM course_surface_exposure')?.surface).toBe('el gato');
});

it('[INV-PER-03][INV-GRD-27] failed visible receipt insertion rolls back and can be retried', async () => {
  const { db, item, runtime, request, initial, sessions } = setup();
  sessions.put(wrongBanner(initial, item));
  db.run(
    "CREATE TRIGGER kill_exposure BEFORE INSERT ON course_surface_exposure BEGIN SELECT RAISE(ABORT,'kill exposure');END",
  );
  await expect(runtime.recordExposure(request)).rejects.toThrow('kill exposure');
  expect(db.all('SELECT * FROM course_surface_exposure')).toEqual([]);
  db.run('DROP TRIGGER kill_exposure');
  await runtime.recordExposure(request);
  expect(db.all('SELECT * FROM course_surface_exposure')).toHaveLength(1);
});

it('[INV-SESS-21] the saved variant must still belong to its declared node and actual lesson', () => {
  for (const change of [{ unitId: 'other' }, { lessonIndex: 99 }]) {
    const { runtime, item, getPack, setPack } = setup();
    setPack({ ...getPack(), runtimeItem: () => ({ ...item, ...change }) });
    expect(() => runtime.readSession()).toThrow(/node/);
  }
  const { runtime, getPack, setPack } = setup();
  const current = getPack();
  setPack({
    ...current,
    pack: {
      ...current.pack,
      path: () => ({
        ...current.pack.path(),
        forNode: () => ({
          ...current.pack.path().forNode('node-1'),
          node: {
            ...current.pack.path().forNode('node-1').node,
            sessions: [{ lessonIndex: 1, exerciseIds: ['other'] }],
          },
        }),
      }),
    },
  });
  expect(() => runtime.readSession()).toThrow(/node/);
});

function picture(item: VerifiedRuntimeItem): VerifiedRuntimeItem {
  return {
    ...item,
    gradable: { ...item.gradable, family: 'select' },
    presentation: {
      ...item.presentation,
      type: 'pictureSelect',
      introduction: 'word',
      options: [
        { id: 'correct', text: 'el gato' },
        { id: 'wrong', text: 'el perro' },
      ],
    },
    introductions: [
      {
        when: 'prompt',
        location: 'option',
        optionId: 'correct',
        surfaceId: 'sf:gato',
        surface: 'el gato',
        language: 'es',
      },
    ],
  };
}
it('[INV-SCH-11][INV-GRD-27] the actual NEW WORD option render introduces only that visible target', async () => {
  const f = setup(picture);
  expect(f.runtime.readSession()?.challenge?.options?.[0]?.text).toBe('el gato');
  expect(f.db.all('SELECT * FROM course_surface_exposure')).toEqual([]);
  await f.runtime.recordExposure({ ...f.request, when: 'prompt' });
  expect(f.db.all('SELECT surface_id,surface,display_role FROM course_surface_exposure')).toEqual([
    { surface_id: 'sf:gato', surface: 'el gato', display_role: 'prompt' },
  ]);
  expect(f.db.all('SELECT * FROM course_attempt')).toEqual([]);
});
it.each(['type', 'marker', 'option', 'text', 'accepted', 'target', 'language'] as const)(
  '[INV-SCH-11] invalid current option witness cannot introduce a surface: %s',
  async (fault) => {
    const f = setup((item) => {
      const p = picture(item),
        i = p.introductions[0]!;
      if (fault === 'type')
        return { ...p, presentation: { ...p.presentation, type: 'meaningSelect' } };
      if (fault === 'marker')
        return { ...p, presentation: { ...p.presentation, introduction: 'phrase' } };
      if (fault === 'option')
        return {
          ...p,
          introductions: [{ ...i, when: 'prompt', location: 'option', optionId: 'wrong' }],
        };
      if (fault === 'text')
        return {
          ...p,
          presentation: { ...p.presentation, options: [{ id: 'correct', text: 'el perro' }] },
        };
      if (fault === 'accepted') return { ...p, gradable: { ...p.gradable, accepted: [] } };
      if (fault === 'target')
        return {
          ...p,
          schedulerSurfaces: p.schedulerSurfaces.map((t) => ({ ...t, kind: 'grammarConcept' })),
        };
      return { ...p, presentation: { ...p.presentation, language: 'en' } };
    });
    await expect(f.runtime.recordExposure({ ...f.request, when: 'prompt' })).rejects.toThrow();
    expect(f.db.all('SELECT * FROM course_surface_exposure')).toEqual([]);
  },
);

it('[INV-ECO-27][INV-SCH-11] actual display persists word and scheduler introduction before another answer or a new runtime instance', async () => {
  const f = setup();
  expect(new SqliteWordStore(f.db).readCounters()).toEqual({ wordsIntroduced: 0, wordsLearned: 0 });
  f.runtime.readSession();
  expect(f.db.all('SELECT * FROM course_item_surface')).toEqual([]);
  f.sessions.put(wrongBanner(f.initial, f.item));
  await f.runtime.recordExposure(f.request);
  expect(new SqliteWordStore(f.db).readCounters()).toEqual({ wordsIntroduced: 1, wordsLearned: 0 });
  const rows = [...new SqliteSchedulerStore(f.db).load('en-es', 'UTC').rows.values()];
  expect(rows).toHaveLength(1);
  expect(rows[0]!.introducedAt?.getTime()).toBe(at);
  await new SqliteLearningRuntime(f.db, f.ports).recordExposure(f.request);
  expect(new SqliteWordStore(f.db).readCounters().wordsIntroduced).toBe(1);
  expect(f.db.all('SELECT * FROM course_attempt')).toEqual([]);
});
it('[INV-ECO-27][INV-SCH-11] a later actual source gets its own receipt while the first full-surface introduction stays immutable', async () => {
  const f = setup();
  f.db.run('INSERT INTO course_surface_exposure VALUES(?,?,?,?,?,?,?,?,?,?)', [
    'en-es',
    'sf:gato',
    'el gato',
    'es',
    'earlier-session',
    'earlier-slot',
    'earlier-grammar-source',
    'a'.repeat(64),
    'prompt',
    at - 500,
  ]);
  const first = f.db.get('SELECT * FROM course_surface_exposure');
  f.sessions.put(wrongBanner(f.initial, f.item));
  await f.runtime.recordExposure(f.request);
  expect(new SqliteWordStore(f.db).readCounters().wordsIntroduced).toBe(1);
  expect(f.db.get('SELECT * FROM course_surface_exposure')).toEqual(first);
  expect(
    f.db.get('SELECT exercise_id,display_role,observed_at_utc_ms FROM course_source_exposure'),
  ).toEqual({ exercise_id: 'exercise-1', display_role: 'wrong-feedback', observed_at_utc_ms: at });
  expect(
    [
      ...new SqliteSchedulerStore(f.db).load('en-es', 'UTC').rows.values(),
    ][0]!.introducedAt?.getTime(),
  ).toBe(at - 500);
});
it('[INV-ECO-27][INV-PER-04] a failed word identity write rolls back the actual display and scheduler introduction together', async () => {
  const f = setup();
  f.sessions.put(wrongBanner(f.initial, f.item));
  const broken: Db = {
    ...f.db,
    run(sql, p) {
      if (sql.startsWith('INSERT INTO account_word VALUES')) throw new Error('SQLITE_FULL word');
      f.db.run(sql, p);
    },
  };
  await expect(
    new SqliteLearningRuntime(broken, f.ports).recordExposure(f.request),
  ).rejects.toThrow('SQLITE_FULL word');
  expect(f.db.all('SELECT * FROM course_surface_exposure')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_item_surface')).toEqual([]);
  expect(new SqliteWordStore(f.db).readCounters().wordsIntroduced).toBe(0);
  await f.runtime.recordExposure(f.request);
  expect(new SqliteWordStore(f.db).readCounters().wordsIntroduced).toBe(1);
});

it('[INV-ECO-27][INV-SCH-11][INV-PER-03] actual WAL file reopen retains display and lexical history without an extra introduction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freelingo-display-reopen-'));
  directories.push(dir);
  const location = join(dir, 'progress.db'),
    f = setup(undefined, location);
  f.sessions.put(wrongBanner(f.initial, f.item));
  await f.runtime.recordExposure(f.request);
  const expected = f.db.all('SELECT * FROM course_source_exposure');
  f.db.close();
  opened.splice(opened.indexOf(f.db), 1);
  const reopened = createNodeDb({ location });
  opened.push(reopened);
  expect(reopened.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
  expect(new SqliteWordStore(reopened).readCounters()).toEqual({
    wordsIntroduced: 1,
    wordsLearned: 0,
  });
  expect(
    [
      ...new SqliteSchedulerStore(reopened).load('en-es', 'UTC').rows.values(),
    ][0]!.introducedAt?.getTime(),
  ).toBe(at);
  await new SqliteLearningRuntime(reopened, f.ports).recordExposure(f.request);
  expect(reopened.all('SELECT * FROM course_source_exposure')).toEqual(expected);
  expect(new SqliteWordStore(reopened).readCounters().wordsIntroduced).toBe(1);
});
