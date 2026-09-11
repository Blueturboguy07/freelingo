/**
 * What the app does to the file system before anything else (INV-PER-06, INV-PACK-11).
 *
 * 1. Open the progress DB in `Paths.document`, in WAL, migrated to the latest
 *    `PRAGMA user_version` inside one exclusive transaction.
 * 2. Create the packs directory, `Paths.cache/packs`.
 * 3. Ask the platform to keep the packs directory out of device backup.
 *
 * Every value it learns is returned rather than logged, so the DevDiagnostics screen can
 * render the real thing and `e2e/flows/p0-db-path.yaml` can assert on it on a device.
 */
import { Platform } from 'react-native';
import { dbPathIsPersistent } from '@freelingo/core';
import { setExcludedFromBackup } from '../../modules/backup-exclusion';
import { ensurePacksDirectory, openProgressDb, type OpenedProgressDb } from './ExpoDb';

export interface PersistenceStatus {
  readonly platform: string;
  readonly dbPath: string;
  /** Whether `dbPath` is on this platform's persistent region — the INV-PER-06 gate. */
  readonly dbPathPersistent: boolean;
  readonly journalMode: string;
  readonly userVersion: number;
  readonly packsDir: string;
  /** `null` when the platform call threw; the reason is in `packsExcludedError`. */
  readonly packsExcluded: boolean | null;
  readonly packsExcludedError: string | null;
  readonly preMigrationBackup: string | null;
  readonly preMigrationBackupsDeleted: readonly string[];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startPersistence(): Promise<{
  readonly opened: OpenedProgressDb;
  readonly status: PersistenceStatus;
}> {
  const opened = await openProgressDb();
  const packs = ensurePacksDirectory();

  let packsExcluded: boolean | null = null;
  let packsExcludedError: string | null = null;
  try {
    packsExcluded = await setExcludedFromBackup(packs.uri);
  } catch (error) {
    packsExcludedError = describe(error);
  }

  return {
    opened,
    status: {
      platform: Platform.OS,
      dbPath: opened.dbPath,
      dbPathPersistent: dbPathIsPersistent(Platform.OS, opened.dbPath),
      journalMode: opened.journalMode,
      userVersion: opened.userVersion,
      packsDir: packs.uri,
      packsExcluded,
      packsExcludedError,
      preMigrationBackup: opened.backup.taken,
      preMigrationBackupsDeleted: opened.backup.deleted,
    },
  };
}
