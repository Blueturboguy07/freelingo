// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_USER_VERSION, PROGRESS_DB_FILENAME } from '@freelingo/schema';
import { openProgressDb } from './ExpoDb';
import { SqliteWordStore } from './SqliteWordStore';
const roots: string[] = [];
const handles: DatabaseSync[] = [];
const calls: string[] = [];
let directory = '';
let failWordWrite = false;
vi.mock('expo-file-system', () => ({
  Paths: {
    get document() {
      return { uri: directory, list: () => readdirSync(directory).map((name) => ({ name })) };
    },
    get cache() {
      return { uri: directory };
    },
  },
  Directory: class {},
  File: class {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = parts
        .map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri))
        .join('/');
    }
    get exists() {
      calls.push('exists');
      return existsSync(this.uri);
    }
    copySync(destination: { uri: string }) {
      copyFileSync(this.uri, destination.uri);
    }
    delete() {
      rmSync(this.uri);
    }
  },
}));
vi.mock('expo-sqlite', () => ({
  openDatabaseSync: (name: string, _options: unknown, dir: string) => {
    calls.push('open');
    const h = new DatabaseSync(join(dir, name));
    handles.push(h);
    let inTransaction = false;
    const adapter = {
      execSync(sql: string) {
        calls.push(sql);
        h.exec(sql);
      },
      runSync(sql: string, params: unknown[] = []) {
        if (failWordWrite && sql.startsWith('INSERT INTO account_word_state'))
          throw new Error('SQLITE_FULL word header');
        return h.prepare(sql).run(...(params as never[]));
      },
      getAllSync: (sql: string, params: unknown[] = []) =>
        h.prepare(sql).all(...(params as never[])),
      getFirstSync: (sql: string, params: unknown[] = []) =>
        h.prepare(sql).get(...(params as never[])),
      isInTransactionSync: () => inTransaction,
      async withExclusiveTransactionAsync(work: (handle: unknown) => Promise<void>) {
        calls.push('BEGIN EXCLUSIVE');
        h.exec('BEGIN EXCLUSIVE');
        inTransaction = true;
        try {
          await work(adapter);
          h.exec('COMMIT');
          calls.push('COMMIT');
        } catch (error) {
          h.exec('ROLLBACK');
          calls.push('ROLLBACK');
          throw error;
        } finally {
          inTransaction = false;
        }
      },
      closeSync() {
        calls.push('close');
        handles.splice(handles.indexOf(h), 1);
        h.close();
      },
    };
    return adapter;
  },
}));
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  calls.length = 0;
  failWordWrite = false;
});
const at = new Date('2026-09-13T12:00:00Z');
function setup() {
  directory = mkdtempSync(join(tmpdir(), 'freelingo-progress-open-'));
  roots.push(directory);
  return join(directory, PROGRESS_DB_FILENAME);
}
it('[INV-ECO-27][INV-PER-03] actual new file creation initializes empty word history in the migration transaction', async () => {
  const file = setup();
  expect(existsSync(file)).toBe(false);
  const opened = await openProgressDb(at);
  expect(calls.indexOf('exists')).toBeLessThan(calls.indexOf('open'));
  expect(opened.dbPath).toBe(file);
  expect(opened.journalMode).toBe('wal');
  expect(opened.userVersion).toBe(LATEST_USER_VERSION);
  expect(opened.db.get('SELECT * FROM account_word_state')).toEqual({
    id: 1,
    initialized_at_utc_ms: at.getTime(),
  });
  expect(new SqliteWordStore(opened.db).readCounters()).toEqual({
    wordsIntroduced: 0,
    wordsLearned: 0,
  });
  expect(calls.filter((c) => c === 'BEGIN EXCLUSIVE')).toHaveLength(1);
  expect(calls.filter((c) => c === 'COMMIT')).toHaveLength(1);
});
it('[INV-ECO-27] reopening the actual initialized file preserves its history epoch without another initialization', async () => {
  setup();
  const first = await openProgressDb(at);
  expect(new SqliteWordStore(first.db).readCounters().wordsIntroduced).toBe(0);
  first.db.close();
  const reopened = await openProgressDb(new Date(at.getTime() + 10000));
  expect(reopened.db.get('SELECT initialized_at_utc_ms FROM account_word_state')).toEqual({
    initialized_at_utc_ms: at.getTime(),
  });
  expect(reopened.backup.taken).toBeNull();
});
it('[INV-ECO-27] a pre-existing version-zero file never masquerades as a newly created account', async () => {
  const file = setup();
  writeFileSync(file, '');
  const opened = await openProgressDb(at);
  expect(opened.userVersion).toBe(LATEST_USER_VERSION);
  expect(opened.db.all('SELECT * FROM account_word_state')).toEqual([]);
  expect(() => new SqliteWordStore(opened.db).readCounters()).toThrow('unknown word history');
});
it('[INV-ECO-27][INV-PER-03] migrating an actual populated legacy database preserves unknown vocabulary and takes a real backup', async () => {
  const file = setup();
  copyFileSync(new URL('../../../../packages/schema/fixtures/golden/v2.db', import.meta.url), file);
  const prior = new DatabaseSync(file);
  const counters = prior
    .prepare('SELECT words_introduced,words_learned,lifetime_xp FROM account WHERE id=1')
    .get();
  prior.close();
  const opened = await openProgressDb(at);
  expect(
    opened.db.get('SELECT words_introduced,words_learned,lifetime_xp FROM account WHERE id=1'),
  ).toEqual(counters);
  expect(opened.db.all('SELECT * FROM account_word_state')).toEqual([]);
  expect(opened.backup.taken).not.toBeNull();
  const backup = new DatabaseSync(join(directory, opened.backup.taken!));
  expect(backup.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
  expect(
    backup
      .prepare('SELECT words_introduced,words_learned,lifetime_xp FROM account WHERE id=1')
      .get(),
  ).toEqual(counters);
  backup.close();
});
it('[INV-PER-03][INV-PER-04] failure during fresh history initialization rolls back schema and closes the failed handle while preserving the file', async () => {
  const file = setup();
  failWordWrite = true;
  await expect(openProgressDb(at)).rejects.toThrow('SQLITE_FULL word header');
  expect(handles).toEqual([]);
  expect(calls.at(-1)).toBe('close');
  expect(calls).toContain('ROLLBACK');
  expect(existsSync(file)).toBe(true);
  const failed = new DatabaseSync(file);
  expect(failed.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
  expect(failed.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
  failed.close();
});
