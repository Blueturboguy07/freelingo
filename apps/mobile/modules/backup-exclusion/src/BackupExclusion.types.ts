/**
 * The backup-exclusion contract, one function wide.
 *
 * iOS sets `URLResourceValues.isExcludedFromBackup` on the path and returns the flag it
 * reads back. Android returns `true`: the exclusion is declared statically by the config
 * plugin, so there is nothing to set at runtime. Both reject a path that does not exist.
 */
export interface BackupExclusion {
  setExcludedFromBackup(path: string): Promise<boolean>;
}
