// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { migrate, type Db } from '@freelingo/schema';
import { freshSession, serialiseSession } from '@freelingo/core/session';
import { SqliteSessionStore, UnrestorableSessionError } from './SqliteSessionStore';
const databases: Db[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function open(location?: string) {
  const db = createNodeDb(location ? { location } : {});
  databases.push(db);
  migrate(db);
  return db;
}
function seed(db: Db) {
  for (const id of ['en-es', 'en-fr'])
    db.run('INSERT OR IGNORE INTO course_progress (course_id,added_at) VALUES (?,?)', [
      id,
      '2026-09-13T00:00:00Z',
    ]);
}
function state(courseId = 'en-es') {
  const s = freshSession({ courseId, sessionId: 'run-' + courseId });
  return {
    ...s,
    shellState: 'banner.wrong' as const,
    inFlight: {
      ...s.inFlight,
      text: 'か',
      caret: 1,
      partialState: { tileIds: ['tile-two'], matchRuntime: { attempts: ['tap-1'] } },
    },
  };
}
describe('SQLite session store', () => {
  it('[INV-SESS-01][INV-SESS-04][INV-SESS-15] restores banner and unfinished input byte-identical after a real close/reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'freelingo-runtime-'));
    dirs.push(dir);
    const path = join(dir, 'progress.db');
    const db = open(path);
    seed(db);
    const saved = state();
    new SqliteSessionStore(db).put(saved);
    databases.splice(databases.indexOf(db), 1);
    db.close();
    const reopened = new SqliteSessionStore(open(path));
    expect(serialiseSession(reopened.get('en-es', 'graded', 'node-1')!)).toBe(
      serialiseSession(saved),
    );
    expect(reopened.activeGraded()?.sessionId).toBe(saved.sessionId);
  });
  it('[INV-SESS-07][INV-SESS-09][INV-SESS-17] parks both courses durably with a single active graded lease', () => {
    const db = open();
    seed(db);
    const store = new SqliteSessionStore(db);
    const es = state(),
      fr = state('en-fr');
    store.put(es);
    store.put(fr);
    expect(store.all()).toHaveLength(2);
    expect(store.activeGraded()?.courseId).toBe('en-es');
    expect(() => store.activate(fr)).toThrow(/in flight/);
    store.park();
    expect(new SqliteSessionStore(db).activeGraded()).toBeNull();
    store.activate(fr);
    expect(store.forCourse('en-es')).toHaveLength(1);
    expect(store.activeGraded()?.courseId).toBe('en-fr');
    store.delete('en-es', 'graded', 'node-1');
    expect(store.activeGraded()?.courseId).toBe('en-fr');
    store.delete('en-fr', 'graded', 'node-1');
    expect(store.activeGraded()).toBeNull();
  });
  it('[INV-SESS-17][INV-SEC-02] binds arbitrary keys and upserts only that checkpoint', () => {
    const db = open();
    seed(db);
    const store = new SqliteSessionStore(db);
    const s = { ...state(), nodeRef: "node'); DROP TABLE account;--" };
    store.put(s);
    store.put({ ...s, inFlight: { ...s.inFlight, text: 'updated' } });
    expect(store.all()).toHaveLength(1);
    expect(store.get('en-es', 'graded', s.nodeRef)?.inFlight.text).toBe('updated');
    expect(db.get('SELECT id FROM account')).toEqual({ id: 1 });
  });
  it('[INV-PER-03][INV-SESS-15] preserves legacy and corrupt checkpoints for explicit recovery', () => {
    const db = open();
    seed(db);
    const store = new SqliteSessionStore(db);
    store.put(state());
    db.run('UPDATE course_session_state SET runtime_json = NULL');
    expect(() => store.get('en-es', 'graded', 'node-1')).toThrow(UnrestorableSessionError);
    db.run(`UPDATE course_session_state SET runtime_json = '{"courseId":"en-fr"}'`);
    expect(() => store.all()).toThrow(UnrestorableSessionError);
    expect(db.all('SELECT session_id FROM course_session_state')).toHaveLength(1);
  });
  it('[INV-PER-07][INV-SESS-01] failed writes roll back all checkpoint columns', () => {
    const db = open();
    seed(db);
    const store = new SqliteSessionStore(db);
    const es = state();
    store.put(es);
    db.run(
      `CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON course_session_state BEGIN SELECT RAISE(ABORT, 'disk-write-failed'); END`,
    );
    expect(() =>
      store.put({
        ...es,
        core: { ...es.core, index: 5 },
        inFlight: { ...es.inFlight, text: 'lost' },
      }),
    ).toThrow('disk-write-failed');
    expect(serialiseSession(store.get('en-es', 'graded', 'node-1')!)).toBe(serialiseSession(es));
  });
});
