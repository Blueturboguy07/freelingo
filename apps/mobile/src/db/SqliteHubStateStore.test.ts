// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { migrate, type Db } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { buildHub, nextHubChoice, type HubInput } from '@freelingo/core/hub';
import { toLocalDay } from '@freelingo/core/day';
import { SqliteHubStateStore } from './SqliteHubStateStore';
const opened: Db[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));
const day = toLocalDay('2026-09-13');
function setup() {
  const db = createNodeDb();
  opened.push(db);
  migrate(db);
  for (const id of ['en-es', 'en-fr'])
    db.run('INSERT INTO course_progress(course_id,added_at) VALUES(?,?)', [id, day]);
  db.run("INSERT INTO course_selection(course_id,is_active,is_selected) VALUES('en-es',1,1)");
  const store = new SqliteHubStateStore(db);
  const input: HubInput = {
    courseId: 'en-es',
    courseLabel: 'Spanish',
    localDay: day,
    nowUtc: day + 'T12:00:00Z',
    seed: '4',
    items: Array.from({ length: 10 }, (_, i) => ({
      itemId: 'item-' + i,
      unitIndex: 0,
      introducedAtUtc: '2026-09-01T00:00:00Z',
      lastSeenAtUtc: '2026-09-12T00:00:00Z',
      lastSeenLocalDay: toLocalDay('2026-09-12'),
      dueAtUtc: '2026-09-12T00:00:00Z',
      text: 'hola',
      gloss: 'hello',
      readingForm: '',
      kind: 'lexeme',
      example: 'Hola.',
      audioRef: null,
      retrievability: 0.5,
      modalities: ['text', 'listen', 'speak'],
    })),
    mistakes: [],
    sharedReview: { localDay: day, itemIds: [], spentIds: [] },
    completedUnitIndices: [],
    currentUnitIndex: 0,
    unitLastOfferedDays: {},
    pathOffer: null,
    lastPathCompletedDay: day,
    preferences: {
      listening: true,
      speaking: true,
      listeningUntilUtc: null,
      speakingUntilUtc: null,
    },
    audioAvailable: true,
    microphoneAvailable: true,
    packReady: true,
    daily: null,
    activeBoost: null,
    ladders: {},
    otherCourseMistakes: [],
  };
  const read = () => ({ ...input, daily: store.load('en-es', day) });
  return { db, store, input, read };
}
function commit(
  db: Db,
  id: string,
  offer: string,
  course = 'en-es',
  outcome = 'completed',
  originDay = day,
) {
  const flavour =
    (
      { speak: 'hubPronunciation', listen: 'hubListenUp', rewind: 'hubUnitRewind' } as Record<
        string,
        string
      >
    )[offer.split('/')[2]!] ?? 'hubWords';
  db.run(
    'INSERT INTO committed_session(session_id,committed_at,flavour,outcome,graded_attempts) VALUES(?,?,?,?,1)',
    [id, day + 'T12:00:00Z', flavour, outcome],
  );
  db.run('INSERT INTO course_session_commit_link VALUES(?,?,NULL,?,?,?)', [
    id,
    course,
    flavour,
    offer,
    originDay,
  ]);
}
it('[INV-HUB-05] daily choices and switch cursor survive a new store without consuming a review item', () => {
  const f = setup(),
    offered = buildHub(f.read()),
    next = nextHubChoice(offered);
  expect(next.daily.cursor).not.toBe(offered.daily.cursor);
  f.store.save(f.read, next.daily);
  expect(new SqliteHubStateStore(f.db).load('en-es', day)).toEqual(next.daily);
  expect(f.db.all('SELECT * FROM course_review_pool_day')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_attempt')).toEqual([]);
  f.store.save(f.read, next.daily);
  expect(f.db.all('SELECT * FROM course_hub_choice')).toHaveLength(next.daily.choiceIds.length);
});
it.each(['choices', 'completion', 'cursor', 'course', 'day'] as const)(
  '[INV-HUB-05][INV-HUB-10] rejects forged %s and rolls back the daily freeze',
  (change) => {
    const f = setup(),
      next = nextHubChoice(buildHub(f.read())).daily;
    const bad = { ...next };
    if (change === 'choices') bad.choiceIds = [...next.choiceIds].reverse();
    if (change === 'completion') bad.completedIds = [next.choiceIds[0]!];
    if (change === 'cursor') bad.cursor = 900;
    if (change === 'course') bad.courseId = 'en-fr';
    if (change === 'day') bad.localDay = toLocalDay('2026-09-14');
    expect(() => f.store.save(f.read, bad)).toThrow();
    expect(f.db.all('SELECT * FROM course_hub_day')).toEqual([]);
  },
);
it('[INV-HUB-10] a queued Spanish switch cannot write after the active course changes', () => {
  const f = setup(),
    next = nextHubChoice(buildHub(f.read())).daily;
  f.db.run('UPDATE course_selection SET is_active=0,is_selected=0');
  f.db.run("INSERT INTO course_selection(course_id,is_active,is_selected) VALUES('en-fr',1,1)");
  expect(() => f.store.save(f.read, next)).toThrow(/active course/);
  expect(f.db.all('SELECT * FROM course_hub_day')).toEqual([]);
});
it('[INV-HUB-05] completed IDs derive from actual completed source links, including fallback offers', () => {
  const f = setup(),
    offered = buildHub(f.read()).daily;
  f.store.save(f.read, offered);
  const offer = day + '/en-es/words/';
  commit(f.db, 'complete', offer);
  commit(f.db, 'quit', day + '/en-es/listen/', 'en-es', 'quit');
  commit(f.db, 'foreign', day + '/en-fr/speak/', 'en-fr');
  expect(f.store.load('en-es', day)!.completedIds).toEqual([offer]);
  expect(f.store.load('en-fr', day)!.completedIds).toEqual([day + '/en-fr/speak/']);
  expect(f.db.all('SELECT * FROM course_hub_completion')).toEqual([]);
});
it('[INV-HUB-05] a stale switch may not erase a completion that committed after render', () => {
  const f = setup(),
    next = nextHubChoice(buildHub(f.read())).daily;
  commit(f.db, 'complete', day + '/en-es/words/');
  expect(() => f.store.save(f.read, next)).toThrow();
  expect(f.store.load('en-es', day)!.completedIds).toEqual([day + '/en-es/words/']);
});
it('[INV-HUB-05] legacy completion cache cannot bless a quit or another course source', () => {
  const f = setup();
  f.store.save(f.read, buildHub(f.read()).daily);
  const offer = day + '/en-es/words/';
  commit(f.db, 'quit', offer, 'en-es', 'quit');
  f.db.run('INSERT INTO course_hub_completion VALUES(?,?,?,?)', ['en-es', day, offer, 'quit']);
  expect(() => f.store.load('en-es', day)).toThrow(/completion/);
});
it('[INV-HUB-05] corrupted saved serving positions cannot silently reroll the day', () => {
  const f = setup();
  f.store.save(f.read, buildHub(f.read()).daily);
  f.db.run('UPDATE course_hub_choice SET position=position+10');
  expect(() => f.store.load('en-es', day)).toThrow(/order/);
});
it('[INV-HUB-08] rewind history comes from saved choices and committed launches, with exact course/day binding', () => {
  const f = setup();
  f.db.run('INSERT INTO course_hub_day VALUES(?,?,0)', ['en-es', '2026-09-12']);
  f.db.run('INSERT INTO course_hub_choice VALUES(?,?,?,0)', [
    'en-es',
    '2026-09-12',
    '2026-09-12/en-es/rewind/1',
  ]);
  commit(f.db, 'rewind', '2026-09-13/en-es/rewind/2');
  f.db.run(
    "UPDATE course_session_commit_link SET economy_flavour='hubUnitRewind' WHERE session_id='rewind'",
  );
  expect(f.store.rewindDays('en-es', [0, 1, 2], day)).toEqual({ 1: '2026-09-12', 2: '2026-09-13' });
  expect(f.store.rewindDays('en-fr', [0, 1, 2], day)).toEqual({});
});
it('[INV-HUB-05] an injected storage fault leaves no half-frozen choices', () => {
  const f = setup(),
    next = nextHubChoice(buildHub(f.read())).daily;
  f.db.run(
    "CREATE TRIGGER fail_choice BEFORE INSERT ON course_hub_choice WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT,'disk fault'); END",
  );
  expect(() => f.store.save(f.read, next)).toThrow(/disk fault/);
  expect(f.db.all('SELECT * FROM course_hub_day')).toEqual([]);
  expect(f.db.all('SELECT * FROM course_hub_choice')).toEqual([]);
});

it.each(['offer', 'receipt'] as const)(
  '[INV-HUB-05] independent wrong %s flavour cannot certify a completed mode',
  (changed) => {
    const f = setup(),
      words = day + '/en-es/words/';
    commit(f.db, 'done', words);
    if (changed === 'offer')
      f.db.run("UPDATE course_session_commit_link SET origin_offer_id=? WHERE session_id='done'", [
        day + '/en-es/speak/',
      ]);
    else f.db.run("UPDATE committed_session SET flavour='lesson' WHERE session_id='done'");
    expect(() => f.store.load('en-es', day)).toThrow(/completion flavour/);
  },
);
