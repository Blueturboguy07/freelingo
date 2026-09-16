// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, type Db } from '@freelingo/schema';
import { toLocalDay } from '@freelingo/core/day';
import { asItemId } from '@freelingo/core/scheduler';
import { dailyRefreshSetForDay } from '@freelingo/core/economy';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { SqlitePoolStore } from './SqlitePoolStore';
const dbs: Db[] = [],
  dirs: string[] = [];
afterEach(() => {
  for (const db of dbs) db.close();
  dbs.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
const course = 'en-es',
  day = toLocalDay('2026-09-13'),
  nextDay = toLocalDay('2026-09-14');
const ids = ['b', 'a', 'd', 'c', 'f', 'e', 'h', 'g'].map(asItemId);
function open(path = ':memory:') {
  const db = createNodeDb({ location: path });
  dbs.push(db);
  migrate(db);
  return db;
}
function seed(db: Db) {
  db.run('INSERT INTO course_progress(course_id,added_at) VALUES(?,?)', [
    course,
    '2026-09-13T00:00:00Z',
  ]);
  for (const id of ids)
    db.run('INSERT INTO course_item(course_id,item_id,countable) VALUES(?,?,1)', [course, id]);
}
it('[INV-ECO-11] freezes the actual serving order and seeded refresh subset across close/reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'freelingo-pool-'));
  dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const db = open(path);
  seed(db);
  const expected = new SqlitePoolStore(db).open(course, day, 'seed', ids, 1000);
  expect(expected.pool.itemIds).toEqual(ids);
  expect(expected.refresh.itemIds).toEqual(dailyRefreshSetForDay(day, 'seed', ids));
  db.close();
  dbs.splice(dbs.indexOf(db), 1);
  const store = new SqlitePoolStore(open(path));
  expect(store.open(course, day, 'different-seed', [...ids].reverse(), 2000)).toEqual(expected);
});
it('[INV-ECO-11] distinguishes an unopened pool from an intentionally empty frozen day', () => {
  const db = open();
  seed(db);
  const store = new SqlitePoolStore(db);
  expect(store.load(course, day)).toBeNull();
  store.open(course, day, 'seed', [], 1000);
  expect(store.open(course, day, 'seed', ids, 2000)?.pool.itemIds).toEqual([]);
  expect(store.load(course, day)?.refresh.itemIds).toEqual([]);
});
it('[INV-SCH-05] both entry points consume one marker at serve time, including abandoned sessions', () => {
  const db = open();
  seed(db);
  const store = new SqlitePoolStore(db);
  store.open(course, day, 'seed', ids, 1000);
  expect(store.reserve(course, day, 'todaysReview', [ids[0]!, ids[1]!]).served).toEqual(
    ids.slice(0, 2),
  );
  expect(store.reserve(course, day, 'dailyRefresh', [ids[1]!, ids[2]!]).served).toEqual([ids[2]!]);
  const reopened = new SqlitePoolStore(db).load(course, day)!;
  expect([...reopened.pool.spentBy]).toEqual([
    [ids[0], 'todaysReview'],
    [ids[1], 'todaysReview'],
    [ids[2], 'dailyRefresh'],
  ]);
  expect(reopened.refresh.spentItemIds).toEqual(
    reopened.refresh.itemIds.filter((id) => ids.slice(0, 3).includes(asItemId(id))),
  );
  expect(store.reserve(course, day, 'todaysReview', ids.slice(0, 3)).served).toEqual([]);
});
it('[INV-SCH-05] reset is civil-day keyed and visiting an earlier day cannot refill its marker', () => {
  const db = open();
  seed(db);
  const store = new SqlitePoolStore(db);
  store.open(course, day, 'seed', ids, 1000);
  store.reserve(course, day, 'todaysReview', [ids[0]!]);
  expect(store.open(course, nextDay, 'seed', ids, 2000).pool.spentBy.size).toBe(0);
  expect(store.open(course, day, 'seed', ids, 3000).pool.spentBy.get(ids[0]!)).toBe('todaysReview');
});
it('[INV-SCH-05] refuses malformed/gapped durable order without repairing the stored rows', () => {
  const db = open();
  seed(db);
  const store = new SqlitePoolStore(db);
  store.open(course, day, 'seed', ids, 1000);
  db.run(
    'UPDATE course_review_pool_item SET position=19 WHERE course_id=? AND local_day=? AND position=0',
    [course, day],
  );
  const rows = db.all('SELECT * FROM course_review_pool_item');
  expect(() => store.load(course, day)).toThrow(/order/);
  expect(() => store.reserve(course, day, 'todaysReview', ids)).toThrow(/order/);
  expect(db.all('SELECT * FROM course_review_pool_item')).toEqual(rows);
});
it('[INV-ECO-11] rejects a refresh subset outside its pool rather than serving an unselected item', () => {
  const db = open();
  seed(db);
  const store = new SqlitePoolStore(db);
  store.open(course, day, 'seed', ids.slice(0, 2), 1000);
  db.run(
    'UPDATE course_daily_refresh_item SET item_id=? WHERE course_id=? AND local_day=? AND position=0',
    [ids[5], course, day],
  );
  expect(() => store.load(course, day)).toThrow(/refresh/);
});
it('[INV-CER-01] a failed containing launch transaction rolls back the reservation', () => {
  const db = open();
  seed(db);
  const store = new SqlitePoolStore(db);
  store.open(course, day, 'seed', ids, 1000);
  const tx: Db = {
    run: db.run.bind(db),
    all: db.all.bind(db),
    get: db.get.bind(db),
    withExclusiveTransaction: (fn) => fn(),
    close: () => {
      throw Error('transaction view');
    },
  };
  expect(() =>
    db.withExclusiveTransaction(() => {
      new SqlitePoolStore(tx).reserve(course, day, 'todaysReview', ids.slice(0, 2));
      throw Error('checkpoint write failed');
    }),
  ).toThrow('checkpoint write failed');
  expect(store.load(course, day)?.pool.spentBy.size).toBe(0);
});
it('[INV-DAT-03] removed courses and unknown eligible rows cannot create a replacement pool', () => {
  const db = open();
  seed(db);
  const store = new SqlitePoolStore(db);
  expect(() => store.open(course, day, 'seed', [asItemId('unknown')], 1000)).toThrow();
  expect(db.all('SELECT * FROM course_review_pool_day')).toEqual([]);
  db.run('DELETE FROM course_progress WHERE course_id=?', [course]);
  expect(() => store.open(course, day, 'seed', [], 1000)).toThrow();
  expect(db.all('SELECT * FROM course_review_pool_day')).toEqual([]);
});

it('[INV-DAY-04] rejects safe integers beyond the actual Date domain on durable reload', () => {
  const db = open();
  seed(db);
  const store = new SqlitePoolStore(db);
  store.open(course, day, 'seed', ids, 1000);
  db.run('UPDATE course_review_pool_day SET opened_at_utc_ms=?', [8640000000000001]);
  expect(() => store.load(course, day)).toThrow(/timestamp/);
  expect(db.get('SELECT opened_at_utc_ms FROM course_review_pool_day')?.opened_at_utc_ms).toBe(
    8640000000000001,
  );
});
