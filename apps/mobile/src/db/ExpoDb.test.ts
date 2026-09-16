// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
let failMigration = false;
let afterRollback: ((db: DatabaseSync) => void) | undefined;
let failMove = false;
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
    moveSync(destination: { uri: string }) {
      calls.push('move');
      if (failMove) throw new Error('move denied');
      if (existsSync(destination.uri)) throw new Error('destination exists');
      renameSync(this.uri, destination.uri);
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
        if (failMigration && sql.includes('CREATE TABLE account_word_state'))
          throw new Error('SQLITE_FULL migration');
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
          afterRollback?.(h);
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
  failMigration = false;
  afterRollback = undefined;
  failMove = false;
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
it('[INV-PER-03][INV-PER-04] failure during fresh history initialization rolls back schema and closes the failed handle while preserving the file under its recovery name', async () => {
  const file = setup();
  failWordWrite = true;
  await expect(openProgressDb(at)).rejects.toThrow('SQLITE_FULL word header');
  expect(handles).toEqual([]);
  expect(calls.indexOf('close')).toBeLessThan(calls.indexOf('move'));
  expect(calls).toContain('ROLLBACK');
  expect(existsSync(file)).toBe(false);
  const recovery = readdirSync(directory).find((name) => name.startsWith('freelingo-corrupt-'));
  expect(recovery).toBeDefined();
  const failed = new DatabaseSync(join(directory, recovery!));
  expect(failed.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
  expect(failed.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
  failed.close();
});

it('[INV-ECO-27][INV-PER-04] failure then retry creates real fresh history and retains the failed bytes', async () => {
  const file = setup();
  failWordWrite = true;
  await expect(openProgressDb(at)).rejects.toThrow('SQLITE_FULL word header');
  expect(existsSync(file)).toBe(false);
  const recovered = readdirSync(directory);
  expect(recovered).toHaveLength(1);
  failWordWrite = false;
  const retry = await openProgressDb(new Date(at.getTime() + 1000));
  expect(new SqliteWordStore(retry.db).readCounters()).toEqual({
    wordsIntroduced: 0,
    wordsLearned: 0,
  });
  expect(retry.db.get('SELECT initialized_at_utc_ms FROM account_word_state')).toEqual({
    initialized_at_utc_ms: at.getTime() + 1000,
  });
  expect(readdirSync(directory)).toContain(recovered[0]);
});
for (const legacy of [false, true]) {
  it(`[INV-PER-03][INV-ECO-27] failed migration never moves a pre-existing ${legacy ? 'populated legacy' : 'empty version-zero'} file`, async () => {
    const file = setup();
    if (legacy)
      copyFileSync(
        new URL('../../../../packages/schema/fixtures/golden/v2.db', import.meta.url),
        file,
      );
    else writeFileSync(file, '');
    failMigration = true;
    await expect(openProgressDb(at)).rejects.toThrow('SQLITE_FULL migration');
    expect(existsSync(file)).toBe(true);
    expect(calls).not.toContain('move');
    const kept = new DatabaseSync(file);
    expect(kept.prepare('PRAGMA user_version').get()).toEqual({ user_version: legacy ? 2 : 0 });
    kept.close();
    failMigration = false;
    const reopened = await openProgressDb(at);
    expect(() => new SqliteWordStore(reopened.db).readCounters()).toThrow('unknown word history');
  });
}
for (const altered of ['rows', 'version'] as const) {
  it(`[INV-PER-03] newly created file with unexpected ${altered} is preserved for explicit recovery`, async () => {
    const file = setup();
    failWordWrite = true;
    afterRollback = (db) =>
      db.exec(
        altered === 'rows'
          ? 'CREATE TABLE sqliteXretained(value); INSERT INTO sqliteXretained VALUES(7)'
          : 'PRAGMA user_version=1',
      );
    await expect(openProgressDb(at)).rejects.toThrow();
    expect(existsSync(file)).toBe(true);
    expect(calls).not.toContain('move');
    const kept = new DatabaseSync(file);
    if (altered === 'rows')
      expect(kept.prepare('SELECT value FROM sqliteXretained').get()).toEqual({ value: 7 });
    else expect(kept.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    kept.close();
  });
}
it('[INV-PER-03] recovery naming never overwrites an earlier failed initialization', async () => {
  setup();
  failWordWrite = true;
  await expect(openProgressDb(at)).rejects.toThrow('SQLITE_FULL word header');
  const first = readdirSync(directory)[0];
  await expect(openProgressDb(at)).rejects.toThrow('SQLITE_FULL word header');
  const files = readdirSync(directory);
  expect(files).toHaveLength(2);
  expect(files).toContain(first);
});
it('[INV-PER-03] a failed recovery move preserves the main file and reports both errors', async () => {
  const file = setup();
  failWordWrite = true;
  failMove = true;
  const error = await openProgressDb(at).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual([
    'SQLITE_FULL word header',
    'move denied',
  ]);
  expect(existsSync(file)).toBe(true);
  expect(handles).toEqual([]);
});
