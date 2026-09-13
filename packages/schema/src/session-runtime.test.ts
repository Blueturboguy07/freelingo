import { afterEach, describe, expect, it } from 'vitest';
import { createNodeDb } from '@freelingo/testkit';
import { migrate, MIGRATIONS } from './migrations.js';
import type { Db } from './db.js';
const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
function database() {
  const db = createNodeDb();
  opened.push(db);
  return db;
}
function seed(db: Db) {
  for (const id of ['en-es', 'en-fr'])
    db.run('INSERT INTO course_progress (course_id, added_at) VALUES (?, ?)', [
      id,
      '2026-09-13T00:00:00Z',
    ]);
}
function insert(db: Db, course: string, active: number, raw: string | null = '{}') {
  db.run(
    `INSERT INTO course_session_state
    (course_id, session_kind, node_ref, session_id, flavour, is_graded, is_active,
     started_at_monotonic_ms, checkpoint_at, queue_json, cursor_index, answers_json,
     input_mode, runtime_json)
    VALUES (?, 'graded', 'node-1', ?, 'lesson', 1, ?, 0, '0', '[]', 0, '[]', 'bank', ?)`,
    [course, 'session-' + course, active, raw],
  );
}
describe('durable runtime migration', () => {
  it('[INV-SESS-07][INV-SESS-17] stores two graded lessons while enforcing one active lesson', () => {
    const db = database();
    migrate(db);
    seed(db);
    insert(db, 'en-es', 1);
    insert(db, 'en-fr', 0);
    expect(db.all('SELECT course_id FROM course_session_state')).toHaveLength(2);
    expect(() =>
      db.run(`UPDATE course_session_state SET is_active = 1 WHERE course_id = 'en-fr'`),
    ).toThrow(/UNIQUE|constraint/i);
    db.withExclusiveTransaction(() => {
      db.run('UPDATE course_session_state SET is_active = 0');
      db.run(`UPDATE course_session_state SET is_active = 1 WHERE course_id = 'en-fr'`);
    });
    expect(db.get('SELECT course_id FROM course_session_state WHERE is_active = 1')).toEqual({
      course_id: 'en-fr',
    });
  });
  it('[INV-SESS-01][INV-SESS-15] preserves opaque unfinished input and rejects invalid JSON', () => {
    const db = database();
    migrate(db);
    seed(db);
    const raw = JSON.stringify({
      inFlight: {
        text: 'か',
        caret: 1,
        partialState: {
          stroke: [
            [1, 2],
            [3, 4],
          ],
          tileIds: ['same-text-2'],
        },
      },
    });
    insert(db, 'en-es', 1, raw);
    expect(db.get('SELECT runtime_json FROM course_session_state')).toEqual({ runtime_json: raw });
    expect(() => insert(db, 'en-fr', 0, '{broken')).toThrow(/CHECK|constraint/i);
  });
  it('[INV-PER-03] migrates existing v2 rows without fabricating missing resume state', () => {
    const db = database();
    for (const m of MIGRATIONS.filter((m) => m.userVersion <= 2))
      db.withExclusiveTransaction(() => {
        m.up(db);
        db.run('PRAGMA user_version = ' + m.userVersion);
      });
    seed(db);
    db.run(`INSERT INTO course_session_state
      (course_id,session_kind,node_ref,session_id,flavour,is_graded,started_at_monotonic_ms,checkpoint_at,queue_json,cursor_index,answers_json,input_mode)
      VALUES ('en-es','graded','node-1','old-session','lesson',1,72,'73','[]',0,'[]','bank')`);
    const before = db.get('SELECT * FROM course_session_state');
    migrate(db);
    expect(db.get('SELECT * FROM course_session_state')).toEqual({
      ...before,
      is_active: 1,
      runtime_json: null,
    });
  });
});
