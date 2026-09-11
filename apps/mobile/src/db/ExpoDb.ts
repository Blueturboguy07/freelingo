/**
 * `Db` implemented on expo-sqlite — the app-runtime half of the pair whose other half is
 * `packages/testkit/src/nodeDb.ts` (Node 24 `node:sqlite`, used by CI).
 *
 * Everything above this file talks to `Db` and cannot tell which one it has.
 *
 * This file is also the compile-time drift gate between the two identical `Db`
 * declarations: `createExpoDb` is typed as `@freelingo/core`'s `Db` and its result is
 * handed to `@freelingo/schema`'s `migrate()`, so `pnpm typecheck` fails the moment
 * either declaration moves.
 */
import { openDatabaseSync, type SQLiteBindParams, type SQLiteDatabase } from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';
import type { Db, DbRow } from '@freelingo/core';
import { preMigrationCopiesToDelete, preMigrationCopyName } from '@freelingo/core';
import {
  LATEST_USER_VERSION,
  PACK_DB_DIRNAME,
  PROGRESS_DB_FILENAME,
  migrate,
} from '@freelingo/schema';

/**
 * Named config for the app's SQLite knobs. The *paths* are named once, in
 * `@freelingo/schema` (`PROGRESS_DB_FILENAME`, `PACK_DB_DIRNAME`), and are never spelled
 * out here; these are the pragmas.
 */
export const JOURNAL_MODE = 'WAL';

/**
 * Checkpointed before a pre-migration copy is taken: in WAL the newest committed pages
 * live in `-wal`, so copying the `.db` alone would quietly archive a stale database.
 */
const CHECKPOINT = 'PRAGMA wal_checkpoint(TRUNCATE)';

/**
 * Wrap an expo-sqlite handle (a database, or the `txn` handle handed to
 * `withExclusiveTransactionAsync`) as a `Db`.
 *
 * `withExclusiveTransaction` joins an already-open transaction on purpose. `migrate()`
 * opens one exclusive transaction per migration and `onInit` runs the whole migration
 * run inside `withExclusiveTransactionAsync`; SQLite has no nested transactions, so an
 * inner call joins the one it is already in. That strengthens what INV-CER-01 wants —
 * one commit, one transaction, a kill leaves nothing applied — rather than weakening it:
 * the outermost scope is the only one that commits.
 */
export function createExpoDb(handle: SQLiteDatabase): Db {
  return {
    run(sql, params = []) {
      handle.runSync(sql, params as SQLiteBindParams);
    },
    all<T extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []) {
      return handle.getAllSync<T>(sql, params as SQLiteBindParams);
    },
    get<T extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []) {
      return handle.getFirstSync<T>(sql, params as SQLiteBindParams) ?? undefined;
    },
    withExclusiveTransaction<T>(fn: () => T): T {
      if (handle.isInTransactionSync()) return fn();
      handle.execSync('BEGIN EXCLUSIVE');
      try {
        const result = fn();
        handle.execSync('COMMIT');
        return result;
      } catch (error) {
        handle.execSync('ROLLBACK');
        throw error;
      }
    },
    close() {
      handle.closeSync();
    },
  };
}

export interface PreMigrationBackup {
  /** Name of the copy this open took, or `null` when there was nothing to protect. */
  readonly taken: string | null;
  /** Copies pruned by this open: everything but the two most recent. */
  readonly deleted: readonly string[];
}

export interface OpenedProgressDb {
  readonly db: Db;
  readonly handle: SQLiteDatabase;
  /** `file://` URI of the progress DB, inside `Paths.document` (INV-PER-06). */
  readonly dbPath: string;
  /** What `PRAGMA journal_mode` reports after init; the device gate wants `wal`. */
  readonly journalMode: string;
  readonly userVersion: number;
  readonly backup: PreMigrationBackup;
}

const NO_BACKUP: PreMigrationBackup = { taken: null, deleted: [] };

export function progressDbFile(): File {
  return new File(Paths.document, PROGRESS_DB_FILENAME);
}

/** `Paths.cache/packs`, created if absent. Re-downloadable, excluded from backup. */
export function ensurePacksDirectory(): Directory {
  const dir = new Directory(Paths.cache, PACK_DB_DIRNAME);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/**
 * Copy the progress DB beside itself before the first migration of this run touches it,
 * then prune everything but the two most recent copies. Both the name and the retention
 * rule are decided in `packages/core` so they stay unit-testable off-device.
 */
function takePreMigrationCopy(
  handle: SQLiteDatabase,
  toUserVersion: number,
  at: Date,
): PreMigrationBackup {
  const file = progressDbFile();
  if (!file.exists) return NO_BACKUP;

  handle.execSync(CHECKPOINT);
  const taken = preMigrationCopyName(toUserVersion, at);
  file.copySync(new File(Paths.document, taken), { overwrite: true });

  const deleted: string[] = [];
  const present = Paths.document.list().map((entry) => entry.name);
  for (const stale of preMigrationCopiesToDelete(present)) {
    const copy = new File(Paths.document, stale);
    if (!copy.exists) continue;
    copy.delete();
    deleted.push(stale);
  }
  return { taken, deleted };
}

/**
 * Pragmas, pre-migration copy, then the migration registry against `PRAGMA user_version`
 * inside ONE `withExclusiveTransactionAsync`.
 *
 * `journal_mode` is set first and outside any transaction: SQLite refuses to change the
 * journal mode from inside one.
 */
async function onInit(handle: SQLiteDatabase, now: Date): Promise<PreMigrationBackup> {
  handle.execSync(`PRAGMA journal_mode = ${JOURNAL_MODE}`);
  handle.execSync('PRAGMA foreign_keys = ON');

  const current =
    handle.getFirstSync<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
  if (current >= LATEST_USER_VERSION) return NO_BACKUP;

  // Nothing to protect when the file is brand new (user_version 0, no rows yet).
  const backup = current > 0 ? takePreMigrationCopy(handle, LATEST_USER_VERSION, now) : NO_BACKUP;

  await handle.withExclusiveTransactionAsync(async (txn) => {
    migrate(createExpoDb(txn));
  });

  return backup;
}

/** Open the progress DB in `Paths.document`, in WAL, migrated to the latest schema. */
export async function openProgressDb(now: Date = new Date()): Promise<OpenedProgressDb> {
  const handle = openDatabaseSync(PROGRESS_DB_FILENAME, {}, Paths.document.uri);
  const backup = await onInit(handle, now);

  const journalMode =
    handle.getFirstSync<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode ?? 'unknown';
  const userVersion =
    handle.getFirstSync<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1;

  return {
    db: createExpoDb(handle),
    handle,
    dbPath: progressDbFile().uri,
    journalMode: journalMode.toLowerCase(),
    userVersion,
    backup,
  };
}
