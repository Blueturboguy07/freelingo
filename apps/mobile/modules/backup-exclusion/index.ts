import BackupExclusionModule from './src/BackupExclusionModule';

export type { BackupExclusion } from './src/BackupExclusion.types';

/**
 * Exclude `path` from device backup (INV-PACK-11).
 *
 * Returns whether the path is excluded: on iOS the flag read back off the file system
 * after setting it, on Android `true` because the exclusion is declared statically by
 * this module's config plugin, on web `false`.
 *
 * Throws when `path` does not exist — the caller must create the directory first.
 */
export async function setExcludedFromBackup(path: string): Promise<boolean> {
  return await BackupExclusionModule.setExcludedFromBackup(path);
}

export default BackupExclusionModule;
