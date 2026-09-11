/**
 * Where the two databases live (INV-PER-06, INV-PACK-11).
 *
 * Progress is the source of truth and lives in the document directory (backed up).
 * Packs are re-downloadable and live in the cache directory, excluded from backup by a
 * config plugin (`NSURLIsExcludedFromBackupKey` / `dataExtractionRules`).
 *
 * Named config — no path string is written anywhere else.
 */
export const PROGRESS_DB_FILENAME = 'freelingo-progress.db';
export const PACK_DB_DIRNAME = 'packs';

export type PersistenceRegion = 'document' | 'cache';

export interface DbLocation {
  readonly region: PersistenceRegion;
  readonly path: string;
  readonly excludedFromBackup: boolean;
}

export const PROGRESS_DB_LOCATION: DbLocation = {
  region: 'document',
  path: PROGRESS_DB_FILENAME,
  excludedFromBackup: false,
};

export const PACK_DB_LOCATION: DbLocation = {
  region: 'cache',
  path: PACK_DB_DIRNAME,
  excludedFromBackup: true,
};

/**
 * INV-PER-06 names the platforms whose document directory is persistent, and excludes
 * tvOS explicitly (its document directory is evictable).
 */
export const PERSISTENT_PLATFORMS: readonly string[] = ['ios', 'android'] as const;
export const EXCLUDED_PLATFORMS: readonly string[] = ['tvos', 'web'] as const;

export function isPersistencePlatformSupported(platform: string): boolean {
  return PERSISTENT_PLATFORMS.includes(platform);
}
