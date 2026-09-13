// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { migrate } from '@freelingo/schema';
import { openPack } from '@freelingo/core/packs';
import type { PackReader } from '@freelingo/core/packs';
import { readPathModel, PathHistoryUnavailable } from './readPathModel';
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
function setup(known = true) {
  const source = new DatabaseSync(
    new URL('../../../../tools/coursekit/tests/fixtures/path/loader-pack.sqlite', import.meta.url),
    { readOnly: true },
  );
  const reader: PackReader = {
    all: <T>(sql: string, p: readonly unknown[] = []) =>
      source.prepare(sql).all(...(p as never[])) as T[],
    get: <T>(sql: string, p: readonly unknown[] = []) =>
      source.prepare(sql).get(...(p as never[])) as T | undefined,
  };
  const pack = openPack(reader, { packRoot: '/test-only-pack' }),
    db = createNodeDb();
  migrate(db);
  db.run(
    "INSERT INTO course_progress(course_id,added_at,pack_content_hash,pack_state) VALUES ('en-es','2026-09-13',?,'installed')",
    ['a'.repeat(64)],
  );
  if (known) db.run("INSERT INTO course_path_state VALUES('en-es',100,0,0)");
  closers.push(() => {
    source.close();
    db.close();
  });
  const verified = { courseId: 'en-es', contentHash: 'a'.repeat(64), pack };
  return { db, verified, read: () => readPathModel(db, verified) };
}
function node(db: ReturnType<typeof setup>['db'], done: number) {
  db.run("INSERT INTO course_node VALUES('en-es','u001:learn','u001','1','lesson',0,2,?,?,NULL)", [
    done,
    done === 2 ? '2026-09-13T00:00:00Z' : null,
  ]);
}
it('[INV-PATH-06] absent legacy header is unknown and reading never manufactures a known-empty history', () => {
  const { db, read } = setup(false);
  expect(() => read()).toThrow(PathHistoryUnavailable);
  expect(db.all('SELECT * FROM course_path_state')).toEqual([]);
});
it('[INV-PACK-03][INV-PATH-01] known fresh course renders exact declared nodes and empty durable progress without inserts', () => {
  const { db, read } = setup();
  const model = read();
  expect(model.sections[0]!.units.map((u) => u.nodes.map((n) => n.id))).toEqual([
    ['u001:learn'],
    ['u002:learn'],
  ]);
  expect(model.sections[0]!.units[0]!.nodes[0]).toMatchObject({
    subLessonsDone: 0,
    subLessonsTotal: 2,
    legendary: false,
  });
  expect(db.all('SELECT * FROM course_node')).toEqual([]);
});
it('[INV-PATH-20] exact persisted completion and legendary facts drive unit fractions', () => {
  const { db, read } = setup();
  node(db, 1);
  expect(read().completedUnits).toEqual([]);
  db.run(
    "UPDATE course_node SET levels_completed=2,completed_at='2026-09-13T00:00:00Z',legendary_awarded_at='2026-09-13T01:00:00Z'",
  );
  expect(read().completedUnits).toEqual([0]);
  expect(read().sections[0]!.units[0]!.nodes[0]!.legendary).toBe(true);
});
it('[INV-PATH-06][INV-SCH-09] stable unit-ID jump evidence and mastery/floor remain independent', () => {
  const { db, read } = setup();
  db.run(
    "INSERT INTO committed_session(session_id,committed_at,outcome) VALUES('jump','2026-09-13','completed')",
  );
  db.run(
    "INSERT INTO course_session_commit_link VALUES('jump','en-es','u002:learn','jumpHere',NULL,NULL)",
  );
  db.run("INSERT INTO course_path_jump VALUES('en-es','u002','jump')");
  db.run('UPDATE course_progress SET score=7,score_floor=5,mastery_high_water_points=7');
  const model = read();
  expect(model.jumpUnlockedUnits).toEqual([1]);
  expect(model.scoreEarned).toBe(7);
  expect(model.scoreFloor).toBe(5);
  expect(model.completedUnits).toEqual([]);
});
it.each([
  "UPDATE course_node SET unit_id='u002'",
  'UPDATE course_node SET levels_total=3',
  "UPDATE course_node SET node_type='practice'",
  'UPDATE course_node SET node_index=1',
])('rejects conflicting same-node source identity: %s', (sql) => {
  const { db, read } = setup();
  node(db, 1);
  db.run(sql);
  expect(read).toThrow(/path/i);
});
it('stale verified hash and unknown saved node cannot be silently projected onto a new pack', () => {
  const { db, verified, read } = setup();
  expect(() => readPathModel(db, { ...verified, contentHash: 'b'.repeat(64) })).toThrow(/path/i);
  node(db, 1);
  db.run("UPDATE course_node SET node_id='removed-node'");
  expect(read).toThrow(/path/i);
});
it('[INV-PATH-21] saved viewport and completion presentation latch are independent of the frontier', () => {
  const { db, read } = setup();
  db.run('UPDATE course_path_state SET daily_refresh_unlocked=1');
  expect(read().dailyRefreshUnlocked).toBe(true);
  expect(read().completedUnits).toEqual([]);
  db.run('UPDATE course_path_state SET viewing_section=9');
  expect(read).toThrow(/path/i);
});
