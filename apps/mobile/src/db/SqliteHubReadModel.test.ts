// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { migrate, type Db } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { ES_PACK, ES_UNIT } from '../../../../packages/core/src/grading/packs/es';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import type { LearningRuntimePorts } from './learningRuntimePorts';
import { emptySchedulerState } from '@freelingo/core/scheduler';
import { buildHub, nextHubChoice } from '@freelingo/core/hub';
import { fixtureLexemes } from './learningCompletion.fixtures';
import { registerSources } from './learningSources';
import { SqliteSchedulerStore } from './SqliteSchedulerStore';
import { SqliteHubReadModel } from './SqliteHubReadModel';
import { SqlitePoolStore } from './SqlitePoolStore';
import { toLocalDay } from '@freelingo/core/day';
const opened: Db[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));
const at = Date.parse('2026-09-13T12:00:00Z'),
  hash = 'a'.repeat(64),
  zone = { tzId: 'UTC', utcOffsetMinutes: 0, tzSource: 'iana' } as const;
function setup() {
  const db = createNodeDb();
  opened.push(db);
  migrate(db);
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
        itemId: 'word-cat',
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
  };
}
it('[INV-HUB-04][INV-SCH-11] merely loading registered pack sources does not introduce a word or offer a practice session', () => {
  const f = setup(),
    before = f.db.get('SELECT total_changes() AS n');
  const input = f.model.read('en-es');
  expect(input.items).toEqual([]);
  expect(input.practiceItems).toEqual([]);
  expect(buildHub(input).hero).toBeNull();
  expect(f.db.get('SELECT total_changes() AS n')).toEqual(before);
});
it('[INV-HUB-11][INV-HUB-03] actual exposure projects one lexical row and its distinct exercise source without incrementing counters', () => {
  const f = setup();
  f.teach();
  const before = f.db.get('SELECT total_changes() AS n'),
    input = f.model.read('en-es');
  expect(input.items).toHaveLength(1);
  expect(input.items[0]).toMatchObject({
    itemId: 'word-cat',
    kind: 'lexeme',
    text: 'gato',
    introducedAtUtc: new Date(at - 86400000).toISOString(),
  });
  expect(input.items[0]!.gloss.trim()).not.toBe('');
  expect(input.items[0]!.example.trim()).not.toBe('');
  expect(input.practiceItems?.[0]).toMatchObject({
    itemId: 'aggregate-cat',
    targetItemIds: ['word-cat'],
  });
  expect(buildHub(input).modes.find((m) => m.kind === 'today')!.offer?.itemIds).toEqual([
    'aggregate-cat',
  ]);
  expect(f.db.get('SELECT total_changes() AS n')).toEqual(before);
});
it('[INV-SCH-10][INV-HUB-09] newly introduced words remain visible while production practice waits four hours', () => {
  const f = setup();
  f.teach(at - 1000);
  const input = f.model.read('en-es');
  expect(input.items).toHaveLength(1);
  expect(input.practiceItems).toEqual([]);
  expect(buildHub(input).hero).toBeNull();
  f.setNow(at + 4 * 3600000);
  expect(f.model.read('en-es').practiceItems).toHaveLength(1);
});
it('[INV-SCH-05][INV-HUB-05] entry freezes the actual shared pool once and reflects another surface spending it', () => {
  const f = setup();
  f.teach();
  const input = f.model.read('en-es');
  f.model.save(buildHub(input).daily);
  expect(f.model.read('en-es').daily).toEqual(buildHub(input).daily);
  const day = toLocalDay('2026-09-13');
  new SqlitePoolStore(f.db).reserve('en-es', day, 'dailyRefresh', ['aggregate-cat' as never]);
  expect(buildHub(f.model.read('en-es')).modes.find((m) => m.kind === 'today')!.offer).toBeNull();
  expect(f.model.read('en-es').items).toHaveLength(1);
});
it('[INV-HUB-10][INV-HUB-05] a cross-midnight callback rolls back new day/menu/pool writes', () => {
  const f = setup();
  f.teach();
  const requested = nextHubChoice(buildHub(f.model.read('en-es'))).daily;
  f.setNow(at + 86400000);
  expect(() => f.model.save(requested)).toThrow();
  expect(f.db.all('SELECT * FROM course_hub_day')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_review_pool_day')).toEqual([]);
});
it('[INV-SCH-07][INV-HUB-11] quarantine removes an introduced target and every practice source that includes it', () => {
  const f = setup();
  f.teach();
  f.db.run("UPDATE course_item SET quarantined=1 WHERE item_id='word-cat'");
  const input = f.model.read('en-es');
  expect(input.items).toEqual([]);
  expect(input.practiceItems).toEqual([]);
});
it('[INV-HUB-11] missing reviewed lexical metadata is an explicit data error, never an invented gloss', () => {
  const f = setup();
  f.teach();
  f.setPack({ ...f.pack, runtimeItem: () => ({ ...f.item, lexicalBindings: [] }) });
  expect(() => f.model.read('en-es')).toThrow(/lexical/);
});

it('[INV-HUB-07] a timezone change preserves the actual recorded last-seen local day', () => {
  const f = setup();
  f.teach(Date.parse('2026-09-12T02:00:00Z'));
  const changed = new SqliteHubReadModel(f.db, {
    ...f.ports,
    clock: () => ({
      ...f.ports.clock(),
      zone: { tzId: 'Pacific/Honolulu', utcOffsetMinutes: -600, tzSource: 'iana' },
    }),
  });
  expect(changed.read('en-es').items[0]!.lastSeenLocalDay).toBe('2026-09-12');
});
