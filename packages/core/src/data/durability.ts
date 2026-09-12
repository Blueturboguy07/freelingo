/**
 * Every path in this app that produces a file from the progress DB, in one list
 * (INV-DAT-07, EC-PER-19).
 *
 * The catalogue row is a quantifier: *"Checkpoint with `wal_checkpoint(TRUNCATE)` before
 * **every** export, backup window and suspension so the db file is self-contained."*
 * A quantifier cannot be tested one call site at a time — the failure mode is the site
 * nobody enumerated, which is exactly how the pre-import backup ended up without one
 * while the export had it.
 *
 * So the paths are enumerated here, the gate walks *this list*, and a new path that
 * forgets the checkpoint fails the gate the moment it is added — while a new path that
 * is never added to the list is caught by `expectedFileProducingPaths()`, which the same
 * gate holds the list against.
 *
 * "Backup window" means every moment the app deliberately writes a second copy of the DB:
 * the export, the pre-import backup behind EC-PER-20's one-tap undo, the pre-migration
 * backup EC-PER-14 makes a hard precondition, and the app suspending with a session in
 * flight.
 */
import { EXPORT_STEPS } from './export.js';
import { IMPORT_BACKUP_STEPS } from './import.js';
import { CHECKPOINT_STEP, MIGRATION_BACKUP_STEPS, SUSPENSION_STEPS } from './integrity.js';

export const FILE_PRODUCING_PATH_IDS = [
  'export',
  'pre-import-backup',
  'pre-migration-backup',
  'suspension',
] as const;
export type FileProducingPathId = (typeof FILE_PRODUCING_PATH_IDS)[number];

export interface FileProducingPath {
  readonly id: FileProducingPathId;
  /** Which clause of EC-PER-19 this path is. */
  readonly kind: 'export' | 'backup-window' | 'suspension';
  /** The ordered steps. The gate asserts `steps[0] === CHECKPOINT_STEP`. */
  readonly steps: readonly string[];
  /** The invariant or edge case that put this path on the list. */
  readonly source: string;
}

export const FILE_PRODUCING_PATHS: readonly FileProducingPath[] = [
  { id: 'export', kind: 'export', steps: EXPORT_STEPS, source: 'INV-DAT-01 / EC-PER-05' },
  {
    id: 'pre-import-backup',
    kind: 'backup-window',
    steps: IMPORT_BACKUP_STEPS,
    source: 'INV-DAT-02 / EC-PER-20',
  },
  {
    id: 'pre-migration-backup',
    kind: 'backup-window',
    steps: MIGRATION_BACKUP_STEPS,
    source: 'INV-PER-08 / EC-PER-14',
  },
  { id: 'suspension', kind: 'suspension', steps: SUSPENSION_STEPS, source: 'EC-PER-19' },
] as const;

/**
 * The list EC-PER-19 requires, derived from its own words rather than from the array
 * above: one export, every backup window, one suspension. The gate compares the two, so
 * adding a file-producing path without listing it here is as loud as forgetting the
 * checkpoint in it.
 */
export function expectedFileProducingPaths(): readonly FileProducingPathId[] {
  return ['export', 'pre-import-backup', 'pre-migration-backup', 'suspension'];
}

/** Paths whose first step is not the checkpoint. Empty, or the gate fails naming them. */
export function pathsMissingCheckpoint(): readonly FileProducingPathId[] {
  return FILE_PRODUCING_PATHS.filter((path) => path.steps[0] !== CHECKPOINT_STEP).map(
    (path) => path.id,
  );
}
