/**
 * The integrity ladder: what the app does when the progress DB cannot be trusted
 * (INV-PER-01, INV-PER-02, INV-PER-08, INV-DAT-07; screens S147–S150).
 *
 * The total-loss case has no spec anywhere (EC-PER-01), and with no server a vanished
 * 300-day streak is indistinguishable from a bug that ate it. So three rules, and they
 * are all about *not* being clever:
 *
 * 1. **Rename, never delete.** The damaged file is the only copy of whatever is left.
 * 2. **Never present a zeroed profile that reads as a fresh install.** Starting fresh is
 *    fine; starting fresh *silently* is the failure.
 * 3. **`integrity_check` proves validity, never completeness** (EC-PER-19). A DB restored
 *    without its `-wal` opens cleanly, passes the check, and is missing the last
 *    sessions. That is a different state with a different screen.
 */
import { toFileSafeIso8601 } from '../db/persistence.js';
import type { LocalDay } from '../day/civil.js';

/** The prefix a damaged progress DB is renamed to. Never a delete, never a suffix. */
export const CORRUPT_QUARANTINE_PREFIX = 'freelingo-corrupt-';
export const CORRUPT_QUARANTINE_SUFFIX = '.db';

/** `freelingo-corrupt-20260911T174233Z.db` — ISO 8601 basic, for the same reason as the
 * pre-migration copies: a colon is rendered as `/` by the macOS file APIs and is reserved
 * on Android's FAT volumes. */
export function corruptQuarantineName(at: Date): string {
  return `${CORRUPT_QUARANTINE_PREFIX}${toFileSafeIso8601(at)}${CORRUPT_QUARANTINE_SUFFIX}`;
}

export function isCorruptQuarantineName(name: string): boolean {
  return /^freelingo-corrupt-\d{8}T\d{6}Z\.db$/.test(name);
}

/** What the open ladder saw. */
export interface OpenObservation {
  /** The SQLite result code, if opening or reading threw one. */
  readonly errorCode: string | null;
  /** `PRAGMA integrity_check` — `ok` or the first problem it reported. */
  readonly integrityCheck: 'ok' | 'failed' | 'not-run';
  /** Did WAL recovery run and succeed before the check? */
  readonly walRecovered: boolean;
}

export type IntegrityVerdict = 'healthy' | 'corrupt';

/** The SQLite result codes that mean the file itself is damaged. */
export const CORRUPTION_ERROR_CODES: readonly string[] = [
  'SQLITE_CORRUPT',
  'SQLITE_NOTADB',
  'SQLITE_CORRUPT_VTAB',
] as const;

export function integrityVerdict(observation: OpenObservation): IntegrityVerdict {
  if (observation.errorCode !== null && CORRUPTION_ERROR_CODES.includes(observation.errorCode)) {
    return 'corrupt';
  }
  if (observation.integrityCheck === 'failed') return 'corrupt';
  return 'healthy';
}

/**
 * The recovery plan. It is data, not an effect, so the decision can be property-tested
 * and the shell's job is reduced to carrying it out in order.
 */
export interface CorruptionRecoveryPlan {
  readonly verdict: IntegrityVerdict;
  /** `rename` — never `delete`. The field is an enum of one for exactly that reason. */
  readonly action: 'none' | 'rename-and-start-fresh';
  readonly renameTo: string | null;
  /** Files this plan deletes. Always empty. Asserted by the property. */
  readonly deletes: readonly string[];
  /** S147. The learner lands here; they are never dropped into a fresh-looking profile. */
  readonly screen: 'none' | 'S147';
  readonly copyKeys: readonly string[];
  /** The actions S147 offers: import a backup, export the damaged file. */
  readonly offers: readonly ('import-a-backup' | 'export-the-damaged-file')[];
  /** Rollover is inhibited until integrity is re-established (INV-PER-02). */
  readonly rolloverInhibited: boolean;
}

export function planCorruptionRecovery(
  observation: OpenObservation,
  at: Date,
): CorruptionRecoveryPlan {
  const verdict = integrityVerdict(observation);
  if (verdict === 'healthy') {
    return {
      verdict,
      action: 'none',
      renameTo: null,
      deletes: [],
      screen: 'none',
      copyKeys: [],
      offers: [],
      rolloverInhibited: false,
    };
  }
  return {
    verdict,
    action: 'rename-and-start-fresh',
    renameTo: corruptQuarantineName(at),
    deletes: [],
    screen: 'S147',
    copyKeys: ['data.corrupt.title', 'data.corrupt.savedAs'],
    offers: ['import-a-backup', 'export-the-damaged-file'],
    rolloverInhibited: true,
  };
}

// ---------------------------------------------------------------------------
// INV-PER-02 — the rollover precondition
// ---------------------------------------------------------------------------

export interface RolloverInput {
  readonly integrity: IntegrityVerdict;
  readonly fromDay: LocalDay;
  readonly toDay: LocalDay;
  /** Days between them that the learner did not meet their goal. */
  readonly missedDays: number;
  readonly freezesOwned: number;
  readonly streak: number;
}

export interface RolloverOutcome {
  readonly applied: boolean;
  readonly freezesConsumed: number;
  readonly streakAfter: number;
  readonly streakBroken: boolean;
  readonly refusal: 'failed-integrity' | null;
}

/**
 * `rolloverTo()` with its integrity precondition (EC-PER-02).
 *
 * A rollover against damaged rows could burn a freeze or break a streak because of
 * corruption rather than behaviour, and **freeze consumption is irreversible** — there is
 * no server to appeal to. So a failed-integrity DB consumes nothing and breaks nothing;
 * the day stays unresolved until integrity is re-established.
 *
 * The freeze walk itself belongs to `day/` (INV-FRZ-01); this function owns only the
 * precondition and calls the walk with what it is given.
 */
export function rolloverTo(input: RolloverInput): RolloverOutcome {
  if (input.integrity !== 'healthy') {
    return {
      applied: false,
      freezesConsumed: 0,
      streakAfter: input.streak,
      streakBroken: false,
      refusal: 'failed-integrity',
    };
  }
  const consumed = Math.min(input.freezesOwned, Math.max(0, input.missedDays));
  const uncovered = Math.max(0, input.missedDays) - consumed;
  return {
    applied: true,
    freezesConsumed: consumed,
    streakAfter: uncovered > 0 ? 0 : input.streak,
    streakBroken: uncovered > 0,
    refusal: null,
  };
}

// ---------------------------------------------------------------------------
// INV-PER-08 — no DDL without a verified backup
// ---------------------------------------------------------------------------

/**
 * The pre-migration backup is a **hard precondition**, not a nicety (EC-PER-14). An
 * update ships a migration, the DB is ~40 MB and 20 MB are free: without this rule the
 * DDL runs, the write fails halfway, and the learner's only copy is a half-migrated file.
 */
export interface MigrationLaunchInput {
  readonly pendingMigrations: number;
  readonly dbBytes: number;
  readonly freeBytes: number;
  /** Did a backup file land on disk AND verify (size + digest)? */
  readonly backupVerified: boolean;
  readonly currentUserVersion: number;
  readonly targetUserVersion: number;
}

export interface MigrationLaunchPlan {
  /** The DDL that may run. Empty unless a verified backup exists. */
  readonly ddlAllowed: boolean;
  readonly userVersionAfter: number;
  readonly openReadOnly: boolean;
  readonly screen: 'none' | 'S149-blocking-free-space';
  /** The blocking screen still exposes these — a dead end is not an option. */
  readonly offers: readonly ('export-my-data' | 'remove-downloaded-audio')[];
  readonly shortfallBytes: number;
}

/** Headroom a migration needs beyond the backup copy itself: WAL growth and the journal. */
export const MIGRATION_HEADROOM_BYTES = 8 * 1024 * 1024;

export function planMigrationLaunch(input: MigrationLaunchInput): MigrationLaunchPlan {
  const required = input.dbBytes + MIGRATION_HEADROOM_BYTES;
  const blocked = !input.backupVerified;
  if (input.pendingMigrations === 0) {
    return {
      ddlAllowed: false,
      userVersionAfter: input.currentUserVersion,
      openReadOnly: false,
      screen: 'none',
      offers: [],
      shortfallBytes: 0,
    };
  }
  if (blocked) {
    return {
      ddlAllowed: false,
      // Unchanged. A user_version that moves without its DDL is EC-PER-03.
      userVersionAfter: input.currentUserVersion,
      openReadOnly: true,
      screen: 'S149-blocking-free-space',
      offers: ['export-my-data', 'remove-downloaded-audio'],
      shortfallBytes: Math.max(0, required - input.freeBytes),
    };
  }
  return {
    ddlAllowed: true,
    userVersionAfter: input.targetUserVersion,
    openReadOnly: false,
    screen: 'none',
    offers: [],
    shortfallBytes: 0,
  };
}

// ---------------------------------------------------------------------------
// INV-DAT-07 — an incomplete restore is not a healthy DB
// ---------------------------------------------------------------------------

export interface RestoreObservation {
  readonly dbPresent: boolean;
  /** Was a `-wal` sibling present alongside the db file? */
  readonly walPresent: boolean;
  /** Did the producing device checkpoint before it wrote the archive/backup? */
  readonly checkpointedAtSource: boolean;
  /** The manifest's row count for the attempts table. */
  readonly declaredRowCount: number;
  readonly actualRowCount: number;
  /** Device state, not archive state. */
  readonly maxLocalDaySeen: LocalDay;
  /** The newest session row actually in the file. */
  readonly newestSessionDay: LocalDay | null;
}

export type RestoreVerdict = 'complete' | 'incomplete-restore' | 'absent';

/**
 * `integrity_check` proves validity, never completeness. Three independent signals of an
 * incomplete restore, any one of which is enough:
 *
 * - the producer never checkpointed, so uncheckpointed pages were only ever in the `-wal`;
 * - the manifest's row count disagrees with the file's;
 * - `max_local_day_seen` is ahead of the newest session row — the device remembers days
 *   whose sessions are not in this file.
 */
export function assessRestore(observation: RestoreObservation): RestoreVerdict {
  if (!observation.dbPresent) return 'absent';
  if (!observation.checkpointedAtSource && !observation.walPresent) return 'incomplete-restore';
  if (observation.actualRowCount < observation.declaredRowCount) return 'incomplete-restore';
  if (
    observation.newestSessionDay !== null &&
    observation.maxLocalDaySeen > observation.newestSessionDay
  ) {
    return 'incomplete-restore';
  }
  return 'complete';
}

/** The first step of every export and every backup window. Named once. */
export const CHECKPOINT_STEP = 'wal_checkpoint(TRUNCATE)' as const;
