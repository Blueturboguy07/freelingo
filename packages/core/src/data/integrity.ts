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
 *
 * ## What a damaged DB actually looks like, measured
 *
 * The first version of this module classified on a list of SQLite *symbolic* codes
 * (`SQLITE_CORRUPT`, `SQLITE_NOTADB`, …) that **no runtime in this app ever produces**,
 * and its test manufactured the inputs. The census in `integrity.test.ts` now flips one
 * byte at eight offsets in each of a 26-page fixture's pages and records what happens;
 * on node 24.18 (`node:sqlite`) the 208 mutations come back as:
 *
 * | outcome                                        | count |
 * |------------------------------------------------|-------|
 * | `PRAGMA integrity_check` **returned** failure rows | 128 |
 * | it **threw**, `code: ERR_SQLITE_ERROR`, `errcode: 11` (`SQLITE_CORRUPT`) | 48 |
 * | it **threw**, `code: ERR_SQLITE_ERROR`, `errcode: 26` (`SQLITE_NOTADB`)  |  3 |
 * | the flip landed in unused space and the DB was fine | 29 |
 *
 * So **both channels are real** and neither may be the only one handled. And the driver's
 * `code` is a *wrapper* code, identical for every SQLite failure; the discriminating
 * value is the numeric primary result code (`errcode`), or, where a driver does not
 * surface one, the message SQLite itself produced. Hence `classifySqliteError`, which is
 * an adapter over the two runtimes this app actually has:
 *
 * | runtime                | `code`                      | numeric code | message |
 * |------------------------|-----------------------------|--------------|---------|
 * | `node:sqlite` (tests)  | `ERR_SQLITE_ERROR`          | `errcode`    | `errstr` |
 * | `expo-sqlite` (device) | `ERR_INTERNAL_SQLITE_ERROR` | — (none)     | `sqlite3_errmsg` |
 *
 * `expo-sqlite`'s shape is read off its own source: `SQLiteErrorException` on iOS
 * (`ios/Exceptions.swift`) and Android (`SQLExceptions.kt`) both carry the code
 * `ERR_INTERNAL_SQLITE_ERROR` and `convertSqlLiteErrorToString(db)` as the message, with
 * no numeric field — which is why the message fragments below are load-bearing and not
 * belt-and-braces. That arm is unproven on a device until P3 puts a build on hardware;
 * `integrityAdapterCoverage()` exists so the test can say which arms are proven by a real
 * runtime and which are proven only against a recorded shape.
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

// ---------------------------------------------------------------------------
// The driver adapter: a thrown SQLite error → a verdict about the file
// ---------------------------------------------------------------------------

/** The runtimes this app opens SQLite through. Named so a test can enumerate them. */
export const SQLITE_RUNTIMES = ['node:sqlite', 'expo-sqlite'] as const;
export type SqliteRuntime = (typeof SQLITE_RUNTIMES)[number];

/**
 * The wrapper `code` each driver stamps on **every** SQLite failure. Useless for
 * classification on its own — that is the point of recording it here rather than in a
 * list that looks like it discriminates.
 */
export const SQLITE_DRIVER_ERROR_CODES: Readonly<Record<SqliteRuntime, string>> = {
  'node:sqlite': 'ERR_SQLITE_ERROR',
  'expo-sqlite': 'ERR_INTERNAL_SQLITE_ERROR',
} as const;

/**
 * SQLite primary result codes that mean *the file itself is damaged*, by number, because
 * the number is what a driver can pass through unambiguously.
 * 11 `SQLITE_CORRUPT`, 26 `SQLITE_NOTADB`. (`SQLITE_CORRUPT_VTAB` is extended code
 * 11 | (1<<8) = 267; masking to the low byte is how SQLite says "primary code".)
 */
export const CORRUPTION_RESULT_CODES: Readonly<Record<string, number>> = {
  SQLITE_CORRUPT: 11,
  SQLITE_NOTADB: 26,
} as const;

/**
 * The messages SQLite emits for those codes, for the driver that surfaces no number.
 * Measured from `node:sqlite`'s `errstr` (see the census above); they are `sqlite3_errstr`
 * output, so they are the same strings `expo-sqlite` forwards.
 */
export const CORRUPTION_MESSAGE_FRAGMENTS: readonly string[] = [
  'database disk image is malformed',
  'file is not a database',
  'malformed database schema',
] as const;

export type SqliteFailureClass = 'corruption' | 'other';

/** Mask an extended result code (`11 | 1<<8`) down to its primary code. */
export function primaryResultCode(code: number): number {
  return code & 0xff;
}

/**
 * Classify a thrown SQLite error. `null` means "this was not a SQLite error at all".
 *
 * Number first, message second. A driver that grows a numeric field later starts being
 * classified by it with no change here; a driver that never does keeps working.
 */
export function classifySqliteError(error: unknown): SqliteFailureClass | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown };
  const driverCode = typeof e.code === 'string' ? e.code : null;
  const isSqlite =
    driverCode !== null && Object.values(SQLITE_DRIVER_ERROR_CODES).includes(driverCode);
  if (!isSqlite) return null;

  if (typeof e.errcode === 'number' && Number.isFinite(e.errcode)) {
    const primary = primaryResultCode(e.errcode);
    const corrupt = Object.values(CORRUPTION_RESULT_CODES).includes(primary);
    return corrupt ? 'corruption' : 'other';
  }

  const text = `${typeof e.errstr === 'string' ? e.errstr : ''} ${
    typeof e.message === 'string' ? e.message : ''
  }`.toLowerCase();
  const corrupt = CORRUPTION_MESSAGE_FRAGMENTS.some((fragment) => text.includes(fragment));
  return corrupt ? 'corruption' : 'other';
}

/**
 * `PRAGMA integrity_check` returns one row reading `ok`, or up to 100 rows naming
 * problems. Both are *returns*: the pragma failing to run at all is the throw channel.
 */
export function integrityCheckRowsVerdict(
  rows: readonly { readonly integrity_check?: unknown }[],
): 'ok' | 'failed' {
  if (rows.length !== 1) return 'failed';
  return rows[0]?.integrity_check === 'ok' ? 'ok' : 'failed';
}

/** What the open ladder saw. Produced by `observeOpen`, never hand-written in shipping code. */
export interface OpenObservation {
  /** How a thrown error classified, or `null` when nothing threw. */
  readonly failure: SqliteFailureClass | null;
  /** The driver's wrapper code, kept for the diagnostic line on S147. */
  readonly driverErrorCode: string | null;
  /** SQLite's own message, kept for the same reason. */
  readonly message: string | null;
  /** `PRAGMA integrity_check` — `ok`, the rows it returned, or it never ran. */
  readonly integrityCheck: 'ok' | 'failed' | 'not-run';
  /** Did WAL recovery run and succeed before the check? */
  readonly walRecovered: boolean;
}

/** The observation a throw produces. The shell passes the caught value in, unedited. */
export function observeOpenFailure(error: unknown, walRecovered = false): OpenObservation {
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    errstr?: unknown;
    message?: unknown;
  };
  return {
    failure: classifySqliteError(error),
    driverErrorCode: typeof e.code === 'string' ? e.code : null,
    message:
      typeof e.errstr === 'string'
        ? e.errstr
        : typeof e.message === 'string'
          ? e.message
          : null,
    // The pragma threw instead of answering; it did not answer "ok".
    integrityCheck: 'not-run',
    walRecovered,
  };
}

/** The observation a successful `PRAGMA integrity_check` produces. */
export function observeOpenSuccess(
  rows: readonly { readonly integrity_check?: unknown }[],
  walRecovered = true,
): OpenObservation {
  return {
    failure: null,
    driverErrorCode: null,
    message: null,
    integrityCheck: integrityCheckRowsVerdict(rows),
    walRecovered,
  };
}

export type IntegrityVerdict = 'healthy' | 'corrupt';

export function integrityVerdict(observation: OpenObservation): IntegrityVerdict {
  if (observation.failure === 'corruption') return 'corrupt';
  if (observation.integrityCheck === 'failed') return 'corrupt';
  return 'healthy';
}

/**
 * Which arms of the adapter a runtime has actually exercised. The test asserts the
 * `node:sqlite` arms are proven by a real damaged file and states, in the same assertion,
 * that the `expo-sqlite` arm is proven only against a recorded shape until P3.
 */
export interface AdapterArm {
  readonly runtime: SqliteRuntime;
  /** Does this runtime surface a numeric primary result code? */
  readonly hasNumericCode: boolean;
  readonly provenBy: 'real-runtime' | 'recorded-shape';
}

export function integrityAdapterCoverage(): readonly AdapterArm[] {
  return [
    { runtime: 'node:sqlite', hasNumericCode: true, provenBy: 'real-runtime' },
    { runtime: 'expo-sqlite', hasNumericCode: false, provenBy: 'recorded-shape' },
  ];
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
// INV-PER-02 — the rollover precondition, and ONLY the precondition
// ---------------------------------------------------------------------------

/**
 * `rolloverTo()` is **not** here. The day walk — civil dates, the EC-FRZ-01 freeze rule
 * ("a freeze is consumed for a missed day iff it was owned before that day began"), long
 * absences, month settlement — lives in `day/rollover.ts` and is owned by the
 * `p1/day-freeze-recovery` lane. An earlier version of this file shipped a second
 * function of the same name with a `min(freezesOwned, missedDays)` walk of its own, which
 * (a) contradicted that ruling and (b) collided with the real one the moment
 * `packages/core/src/index.ts` re-exported both barrels. A test that guards a shadow
 * function guards nothing.
 *
 * What `data/` owns is the **precondition** (EC-PER-02): a rollover against damaged rows
 * could burn a freeze or break a streak because of corruption rather than behaviour, and
 * **freeze consumption is irreversible** — there is no server to appeal to. So the guard
 * below wraps whatever walk it is handed and refuses before that walk is entered at all.
 *
 * Integration (filed as a blocker for the integrate task): `day/rollover.ts`'s
 * `rolloverTo` is wrapped once at its call site with `guardRolloverForIntegrity`, so the
 * function the app actually calls refuses on a failed-integrity DB.
 */
export type RolloverPrecondition = 'ok' | 'failed-integrity';

export function rolloverAllowed(integrity: IntegrityVerdict): RolloverPrecondition {
  return integrity === 'healthy' ? 'ok' : 'failed-integrity';
}

/** What a guarded rollover returns instead of a walk result. */
export interface RolloverRefused {
  readonly refused: 'failed-integrity';
  /** S148: abandon with no ceremony; the day stays unresolved. */
  readonly screen: 'S148';
  readonly freezesConsumed: 0;
  readonly daysProcessed: 0;
}

export const ROLLOVER_REFUSED: RolloverRefused = {
  refused: 'failed-integrity',
  screen: 'S148',
  freezesConsumed: 0,
  daysProcessed: 0,
};

export function rolloverWasRefused(result: unknown): result is RolloverRefused {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { refused?: unknown }).refused === 'failed-integrity'
  );
}

/**
 * Wrap a rollover walk in its integrity precondition.
 *
 * Generic over the walk's own signature on purpose: `data/` must not restate `day/`'s
 * argument list, or the two drift and the guard silently stops matching the function it
 * is supposed to be guarding. The property in `integrity.test.ts` quantifies over
 * *arbitrary* walks — including ones that consume every freeze and break every streak —
 * and asserts the guarded version never enters them.
 */
export function guardRolloverForIntegrity<A extends unknown[], R>(
  walk: (...args: A) => R,
): (integrity: IntegrityVerdict, ...args: A) => R | RolloverRefused {
  return (integrity, ...args) => {
    if (rolloverAllowed(integrity) === 'failed-integrity') return ROLLOVER_REFUSED;
    return walk(...args);
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

/**
 * Where the blocking screen lives.
 *
 * EC-PER-14's "blocking free-up-N-MB screen" has **no id in the product map**: S149 is
 * `Interrupted migration / mismatch-detected` (00-PRODUCT-MAP.md:335) and routes to S147,
 * which is a different failure. An earlier version returned the invented id
 * `S149-blocking-free-space`; the plan's non-negotiable #3 ("every product-map state has
 * a defined render; an undefined state is a build bug") makes an invented id a build bug
 * of its own.
 *
 * So it is routed to **S150**, the low-disk notice, whose existing states are
 * `warned-at-session-start` and `write-failed` — the same screen, the same copy family,
 * the same shortfall line. The new state `blocked-migration-needs-space` is a map
 * addition P1 discovered and is filed as a blocker for the integrate task; the state name
 * is here so the map row and this code cannot disagree about what it is called.
 */
export const MIGRATION_BLOCKED_SCREEN = 'S150' as const;
export const MIGRATION_BLOCKED_STATE = 'blocked-migration-needs-space' as const;

export interface MigrationLaunchPlan {
  /** The DDL that may run. Empty unless a verified backup exists. */
  readonly ddlAllowed: boolean;
  readonly userVersionAfter: number;
  readonly openReadOnly: boolean;
  readonly screen: 'none' | typeof MIGRATION_BLOCKED_SCREEN;
  /** The product-map state of that screen. `null` when nothing is blocked. */
  readonly screenState: typeof MIGRATION_BLOCKED_STATE | null;
  /** The blocking screen still exposes these — a dead end is not an option. */
  readonly offers: readonly ('export-my-data' | 'remove-downloaded-audio')[];
  readonly shortfallBytes: number;
}

/** Headroom a migration needs beyond the backup copy itself: WAL growth and the journal. */
export const MIGRATION_HEADROOM_BYTES = 8 * 1024 * 1024;

/** The pre-migration backup is a backup window, so it checkpoints first (EC-PER-19). */
export const MIGRATION_BACKUP_STEPS = [
  'wal_checkpoint(TRUNCATE)',
  'write-backup',
  'verify-backup',
] as const;

/** App suspension is the third backup window EC-PER-19 names. */
export const SUSPENSION_STEPS = ['wal_checkpoint(TRUNCATE)', 'flush-session-state'] as const;

export function planMigrationLaunch(input: MigrationLaunchInput): MigrationLaunchPlan {
  const required = input.dbBytes + MIGRATION_HEADROOM_BYTES;
  const blocked = !input.backupVerified;
  if (input.pendingMigrations === 0) {
    return {
      ddlAllowed: false,
      userVersionAfter: input.currentUserVersion,
      openReadOnly: false,
      screen: 'none',
      screenState: null,
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
      screen: MIGRATION_BLOCKED_SCREEN,
      screenState: MIGRATION_BLOCKED_STATE,
      offers: ['export-my-data', 'remove-downloaded-audio'],
      shortfallBytes: Math.max(0, required - input.freeBytes),
    };
  }
  return {
    ddlAllowed: true,
    userVersionAfter: input.targetUserVersion,
    openReadOnly: false,
    screen: 'none',
    screenState: null,
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
