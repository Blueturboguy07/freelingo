// @vitest-environment node
import { migrate } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { ES_PACK, ES_UNIT } from '../../../../packages/core/src/grading/packs/es';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import type { LearningRuntimePorts } from './learningRuntimePorts';
import { emptySchedulerState } from '@freelingo/core/scheduler';
import { fixtureLexemes } from './learningCompletion.fixtures';
import { registerSources } from './learningSources';
import { SqliteSchedulerStore } from './SqliteSchedulerStore';
import { SqliteWordStore } from './SqliteWordStore';
import { SqliteHubReadModel } from './SqliteHubReadModel';
const at = Date.parse('2026-09-13T12:00:00Z'),
  hash = 'a'.repeat(64),
  zone = { tzId: 'UTC', utcOffsetMinutes: 0, tzSource: 'iana' } as const;
export function hubFixture(separateTarget = true, freshWordHistory = false) {
  const db = createNodeDb();
  migrate(db);
  if (freshWordHistory)
    new SqliteWordStore(db).initializeFreshHistory(at, { databaseWasCreated: true });
  db.run('UPDATE account SET selection_seed=7');
  db.run('INSERT INTO course_progress(course_id,added_at,pack_content_hash) VALUES(?,?,?)', [
    'en-es',
    '2026-09-01',
    hash,
  ]);
  db.run("INSERT INTO course_selection(course_id,is_active,is_selected) VALUES('en-es',1,1)");
  db.run("INSERT INTO course_path_state VALUES('en-es',100,0,0)");
  const item: VerifiedRuntimeItem = fixtureLexemes({
    schemaVersion: 1,
    exerciseId: 'exercise-cat',
    itemId: 'aggregate-cat',
    unitId: 'u1',
    lessonIndex: 1,
    profileId: 'es',
    responseLanguage: 'en',
    proof: {
      sourceId: 'source-cat',
      sourceSha256: hash,
      approvalId: 'review-cat',
      approvalSha256: hash,
      draftSha256: hash,
    },
    gradable: {
      itemId: 'aggregate-cat',
      family: 'typed-translate',
      accepted: [{ surface: 'cat', surfaceId: 'english-cat', rank: 1 }],
    },
    presentation: {
      itemId: 'aggregate-cat',
      type: 'typedTranslate',
      instruction: 'Translate',
      prompt: 'gato',
      promptLanguage: 'es',
      language: 'en',
      acceptedAnswers: ['cat'],
    },
    schedulerSurfaces: [
      {
        itemId: separateTarget ? 'word-cat' : 'aggregate-cat',
        kind: 'lexeme',
        itemRef: 'gato',
        surfaceId: 'spanish-cat',
        surface: 'gato',
        language: 'es',
        canonical: true,
      },
    ],
    introductions: [{ when: 'prompt', surfaceId: 'spanish-cat', surface: 'gato', language: 'es' }],
    lexicalBindings: [],
    explanation: 'Cat is gato.',
    grading: { pack: ES_PACK, unit: ES_UNIT, profileId: 'es', responseLanguage: 'en' },
  });
  const node = {
    nodeId: 'n1',
    type: 'lesson',
    sessions: [{ lessonIndex: 1, exerciseIds: [item.exerciseId] }],
    introducesScriptUnits: [],
    requiresScriptUnits: [],
  };
  const path = {
    manifest: {
      courseId: 'en-es',
      languageName: 'Spanish',
      supportedCefrBands: ['early A1'],
      scoreCeiling: 9,
      legendaryDenominator: ['lesson'],
      supportedNodeTypes: ['lesson'],
      supportsLetters: false,
      hasDailyRefresh: true,
    },
    sections: [
      {
        sectionIndex: 1,
        title: 'Start',
        band: 'early A1',
        units: [
          { unitId: 'u1', unitIndex: 1, title: 'First words', colourIndex: 0, nodes: [node] },
        ],
      },
    ],
    forNode: (id: string) => {
      if (id !== 'n1') throw Error('unknown node');
      return { node, unitId: 'u1', unitIndex: 0, sectionIndex: 0 };
    },
  };
  let pack = {
    courseId: 'en-es',
    contentHash: hash,
    pack: { meta: { lang: 'es', courseId: 'en-es' }, path: () => path },
    runtimeItem: (id: string) => {
      if (id !== item.exerciseId) throw Error('unknown exercise');
      return item;
    },
    audioUri: () => null,
  } as unknown as VerifiedInstalledPack;
  let now = at;
  const ports: LearningRuntimePorts = {
    packs: { get: (id) => (id === 'en-es' ? pack : null) },
    clock: () => ({ utcMs: now, monotonicMs: 60000, zone }),
    modalityClock: () => null,
    newSessionId: () => {
      throw Error('read must not allocate session');
    },
    canPlayAudio: () => false,
    canRecognizeSpeech: () => false,
    hasTargetScriptInput: () => true,
    reduceMotion: () => false,
    screenReaderActive: () => false,
  };
  const store = new SqliteSchedulerStore(db);
  store.save(
    'en-es',
    registerSources(db, 'en-es', emptySchedulerState('UTC'), [{ item }], ports.clock()),
  );
  const teach = (time = at - 86400000) => {
    db.run('INSERT INTO course_surface_exposure VALUES(?,?,?,?,?,?,?,?,?,?)', [
      'en-es',
      'spanish-cat',
      'gato',
      'es',
      'observed-session',
      'observed-slot',
      item.exerciseId,
      hash,
      'prompt',
      time,
    ]);
    store.save(
      'en-es',
      registerSources(db, 'en-es', store.load('en-es', 'UTC'), [{ item }], ports.clock()),
    );
  };
  return {
    db,
    item,
    ports,
    store,
    teach,
    model: new SqliteHubReadModel(db, ports),
    setNow: (n: number) => {
      now = n;
    },
    setPack: (p: VerifiedInstalledPack) => {
      pack = p;
    },
    pack,
    path,
  };
}
