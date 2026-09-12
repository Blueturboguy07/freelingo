import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { toLocalDay, type LocalDay } from '../day/civil.js';
import {
  CHECKPOINT_STEP,
  CORRUPTION_MESSAGE_FRAGMENTS,
  CORRUPTION_RESULT_CODES,
  MIGRATION_BLOCKED_SCREEN,
  MIGRATION_BLOCKED_STATE,
  SQLITE_DRIVER_ERROR_CODES,
  assessRestore,
  classifySqliteError,
  corruptQuarantineName,
  guardRolloverForIntegrity,
  integrityAdapterCoverage,
  integrityCheckRowsVerdict,
  integrityVerdict,
  isCorruptQuarantineName,
  observeOpenFailure,
  observeOpenSuccess,
  planCorruptionRecovery,
  planMigrationLaunch,
  rolloverAllowed,
  rolloverWasRefused,
  type OpenObservation,
  type RolloverRefused,
} from './integrity.js';
import {
  FILE_PRODUCING_PATHS,
  expectedFileProducingPaths,
  pathsMissingCheckpoint,
} from './durability.js';

/** INV-PER-01, INV-PER-02, INV-PER-08, INV-DAT-07. */

const scratch = mkdtempSync(join(tmpdir(), 'freelingo-integrity-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PAGE_BYTES = 4096;

/** A real SQLite file with enough pages that a corrupted range hits a b-tree page. */
function writeFixtureDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('CREATE TABLE attempt (session_id TEXT, exercise_index INTEGER, correct INTEGER)');
  db.exec('CREATE INDEX attempt_by_session ON attempt(session_id)');
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO attempt VALUES (?, ?, ?)');
  for (let i = 0; i < 3000; i += 1) insert.run(`session-${i % 37}`, i, i % 2);
  db.exec('COMMIT');
  db.close();
}

/**
 * Open the file and report what the ladder would have seen — **nothing is rewritten**.
 *
 * The previous version of this helper caught the thrown error and replaced its code with
 * `SQLITE_CORRUPT` when it did not recognise it, then stamped `integrityCheck: 'failed'`
 * by hand. That manufactured both inputs to `integrityVerdict`, so the classifier could
 * have been entirely wrong and this file would still have been green. The caught value now
 * goes to `observeOpenFailure` unedited, and the returned rows go to `observeOpenSuccess`
 * unedited, which is the same pair of calls the shell makes.
 */
function observe(path: string): OpenObservation {
  try {
    const db = new DatabaseSync(path);
    try {
      const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
      const observation = observeOpenSuccess(rows);
      // Force a full table and index scan too: `integrity_check` can pass while a read of
      // the damaged page still throws.
      if (observation.integrityCheck === 'ok') {
        db.prepare('SELECT count(*) AS n FROM attempt').get();
        db.prepare("SELECT count(*) AS n FROM attempt WHERE session_id = 'session-3'").get();
      }
      return observation;
    } finally {
      db.close();
    }
  } catch (error) {
    return observeOpenFailure(error);
  }
}

describe('INV-PER-01 corruption: rename, never delete', () => {
  /**
   * The census. One byte flipped at eight offsets in each of the fixture's pages, and what
   * a real `node:sqlite` did about it. Both of the two channels — the pragma RETURNING
   * failure rows, and the pragma THROWING — have to occur for this file to mean anything,
   * so the counts are asserted rather than printed.
   */
  it('[INV-PER-01] a corrupted byte range in a fixture DB is detected through BOTH real channels, and every detection renames rather than deletes', () => {
    const source = join(scratch, 'census-source.db');
    writeFixtureDb(source);
    const original = readFileSync(source);
    expect(observe(source).integrityCheck, 'the fixture itself must be healthy').toBe('ok');

    const target = join(scratch, 'census-target.db');
    const tally = { threwCorruption: 0, returnedFailureRows: 0, survived: 0, threwOther: 0 };
    const seenResultCodes = new Set<string>();

    for (let page = 0; page < original.length / PAGE_BYTES; page += 1) {
      for (const offset of [0, 8, 16, 100, 1000, 2048, 3000, 4090]) {
        const bytes = Buffer.from(original);
        const at = page * PAGE_BYTES + offset;
        if (at >= bytes.length) continue;
        bytes[at] = bytes[at]! ^ 0xff;
        writeFileSync(target, bytes);

        const observation = observe(target);
        if (observation.failure === 'corruption') {
          tally.threwCorruption += 1;
          seenResultCodes.add(observation.message ?? '');
        } else if (observation.failure === 'other') {
          tally.threwOther += 1;
        } else if (observation.integrityCheck === 'failed') {
          tally.returnedFailureRows += 1;
        } else {
          tally.survived += 1;
        }

        const verdict = integrityVerdict(observation);
        const corrupted =
          observation.failure === 'corruption' || observation.integrityCheck === 'failed';
        expect(verdict).toBe(corrupted ? 'corrupt' : 'healthy');

        const plan = planCorruptionRecovery(observation, new Date('2026-09-11T17:42:33Z'));
        // Rename, never delete — for every single one of the mutations, healthy included.
        expect(plan.deletes).toEqual([]);
        if (corrupted) {
          expect(plan.action).toBe('rename-and-start-fresh');
          expect(plan.screen).toBe('S147');
          expect(plan.rolloverInhibited).toBe(true);
        }
      }
    }

    // Both channels are real. Neither may be the only one the classifier handles.
    expect(tally.threwCorruption, 'no mutation made SQLite throw a corruption error').toBeGreaterThan(0);
    expect(
      tally.returnedFailureRows,
      'no mutation made PRAGMA integrity_check RETURN a failure row',
    ).toBeGreaterThan(0);
    // Some flips land in unused space; if none did, the fixture is not a realistic file.
    expect(tally.survived).toBeGreaterThan(0);
    // The messages SQLite actually produced are the ones the adapter matches on.
    for (const message of seenResultCodes) {
      expect(
        CORRUPTION_MESSAGE_FRAGMENTS.some((fragment) => message.toLowerCase().includes(fragment)),
        `unhandled SQLite corruption message: ${message}`,
      ).toBe(true);
    }
  });

  it('[INV-PER-01] the damaged file survives on disk under freelingo-corrupt-*, and a fresh DB starts beside it', () => {
    const path = join(scratch, 'progress.db');
    writeFixtureDb(path);
    expect(observe(path).integrityCheck).toBe('ok');

    const bytes = readFileSync(path);
    for (let i = PAGE_BYTES; i < PAGE_BYTES * 2 && i < bytes.length; i += 1) {
      bytes[i] = (i * 37) & 0xff;
    }
    writeFileSync(path, bytes);

    const observation = observe(path);
    expect(integrityVerdict(observation), 'the corruption was not detected at all').toBe('corrupt');

    const plan = planCorruptionRecovery(observation, new Date('2026-09-11T17:42:33.123Z'));
    expect(plan.renameTo).toBe('freelingo-corrupt-20260911T174233Z.db');
    expect(isCorruptQuarantineName(plan.renameTo!)).toBe(true);
    expect(plan.copyKeys.length).toBeGreaterThan(0);
    expect(plan.offers).toEqual(['import-a-backup', 'export-the-damaged-file']);

    const quarantined = join(scratch, plan.renameTo!);
    renameSync(path, quarantined);
    expect(existsSync(quarantined)).toBe(true);
    expect(readFileSync(quarantined).length).toBe(bytes.length);

    writeFixtureDb(path);
    expect(observe(path).integrityCheck).toBe('ok');
    expect(existsSync(quarantined), 'the only copy of what was left was deleted').toBe(true);
  });

  it('[INV-PER-01] the classifier recognises what node:sqlite really throws, by number', () => {
    // Measured, not assumed: `PRAGMA integrity_check` on a file whose header is destroyed
    // throws `code: ERR_SQLITE_ERROR, errcode: 26` — the wrapper code is the same for every
    // SQLite failure, so the number is what discriminates.
    const path = join(scratch, 'notadb.db');
    writeFixtureDb(path);
    const bytes = readFileSync(path);
    for (let i = 0; i < 16; i += 1) bytes[i] = 0x41;
    writeFileSync(path, bytes);

    let caught: unknown = null;
    try {
      const db = new DatabaseSync(path);
      db.prepare('PRAGMA integrity_check').all();
      db.close();
    } catch (error) {
      caught = error;
    }
    expect(caught, 'destroying the header no longer throws; re-measure the adapter').not.toBeNull();
    const raw = caught as { code?: string; errcode?: number; errstr?: string };
    expect(raw.code).toBe(SQLITE_DRIVER_ERROR_CODES['node:sqlite']);
    expect(raw.errcode).toBe(CORRUPTION_RESULT_CODES.SQLITE_NOTADB);
    expect(classifySqliteError(caught)).toBe('corruption');
    expect(integrityVerdict(observeOpenFailure(caught))).toBe('corrupt');
  });

  it('[INV-PER-01] the classifier recognises the expo-sqlite shape, which carries no number', () => {
    // Recorded from expo-sqlite 57.0.3's own sources: `SQLiteErrorException` on iOS
    // (ios/Exceptions.swift) and Android (SQLExceptions.kt) both stamp
    // `ERR_INTERNAL_SQLITE_ERROR` and carry `sqlite3_errmsg` as the message, with no
    // numeric field. Unproven on a device until P3 puts a build on hardware.
    const expoShape = {
      code: SQLITE_DRIVER_ERROR_CODES['expo-sqlite'],
      message: 'database disk image is malformed',
    };
    expect(classifySqliteError(expoShape)).toBe('corruption');
    expect(integrityVerdict(observeOpenFailure(expoShape))).toBe('corrupt');

    const expoBusy = { code: SQLITE_DRIVER_ERROR_CODES['expo-sqlite'], message: 'database is locked' };
    expect(classifySqliteError(expoBusy)).toBe('other');
    expect(integrityVerdict(observeOpenFailure(expoBusy))).toBe('healthy');

    const coverage = integrityAdapterCoverage();
    expect(coverage.map((arm) => arm.runtime)).toEqual(['node:sqlite', 'expo-sqlite']);
    expect(coverage.find((arm) => arm.runtime === 'node:sqlite')?.provenBy).toBe('real-runtime');
    expect(coverage.find((arm) => arm.runtime === 'expo-sqlite')?.provenBy).toBe('recorded-shape');
  });

  it('[INV-PER-01] an extended result code masks down to its primary code', () => {
    // SQLITE_CORRUPT_VTAB = 11 | (1 << 8) = 267. A classifier that compared the raw number
    // would call it "other" and skip the ladder.
    const vtab = { code: SQLITE_DRIVER_ERROR_CODES['node:sqlite'], errcode: 267 };
    expect(classifySqliteError(vtab)).toBe('corruption');
  });

  it('[INV-PER-01] the plan never deletes anything, whatever the ladder saw', () => {
    fc.assert(
      fc.property(
        fc.record({
          failure: fc.option(fc.constantFrom<'corruption' | 'other'>('corruption', 'other'), {
            nil: null,
          }),
          driverErrorCode: fc.option(
            fc.constantFrom(...Object.values(SQLITE_DRIVER_ERROR_CODES)),
            { nil: null },
          ),
          message: fc.option(fc.string({ maxLength: 60 }), { nil: null }),
          integrityCheck: fc.constantFrom<OpenObservation['integrityCheck']>(
            'ok',
            'failed',
            'not-run',
          ),
          walRecovered: fc.boolean(),
        }),
        fc.date({
          min: new Date('2024-01-01T00:00:00Z'),
          max: new Date('2030-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        (observation, at) => {
          const plan = planCorruptionRecovery(observation, at);
          expect(plan.deletes).toEqual([]);
          if (plan.verdict === 'corrupt') {
            expect(plan.screen).toBe('S147');
            expect(isCorruptQuarantineName(plan.renameTo!)).toBe(true);
            expect(plan.rolloverInhibited).toBe(true);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PER-01] a healthy open changes nothing', () => {
    const plan = planCorruptionRecovery(observeOpenSuccess([{ integrity_check: 'ok' }]), new Date());
    expect(plan).toMatchObject({ action: 'none', screen: 'none', rolloverInhibited: false });
  });

  it('[INV-PER-01] a busy, locked or full database is not corruption', () => {
    for (const errcode of [5, 6, 13]) {
      const error = { code: SQLITE_DRIVER_ERROR_CODES['node:sqlite'], errcode };
      expect(classifySqliteError(error)).toBe('other');
      expect(integrityVerdict(observeOpenFailure(error))).toBe('healthy');
    }
  });

  it('[INV-PER-01] a non-SQLite throw is not classified as corruption', () => {
    expect(classifySqliteError(new TypeError('undefined is not a function'))).toBeNull();
    expect(classifySqliteError(null)).toBeNull();
    expect(classifySqliteError('SQLITE_CORRUPT')).toBeNull();
  });

  it('[INV-PER-01] integrity_check rows are read as SQLite writes them', () => {
    expect(integrityCheckRowsVerdict([{ integrity_check: 'ok' }])).toBe('ok');
    // The real shape of a failure, copied from the census output.
    expect(
      integrityCheckRowsVerdict([
        { integrity_check: '*** in database main ***\nTree 2 page 4 cell 0: Offset out of range' },
        { integrity_check: 'database disk image is malformed' },
      ]),
    ).toBe('failed');
    expect(integrityCheckRowsVerdict([])).toBe('failed');
  });

  it('[INV-PER-01] the quarantine name is filename-safe on both platforms', () => {
    const name = corruptQuarantineName(new Date('2026-12-01T05:06:07Z'));
    // A colon is rendered as `/` by the macOS file APIs and is reserved on Android FAT.
    expect(name).not.toContain(':');
    expect(name).toBe('freelingo-corrupt-20261201T050607Z.db');
  });
});

describe('INV-PER-02 the rollover walk has an integrity precondition', () => {
  /**
   * The guard is quantified over *arbitrary* walks, including malicious ones. `data/` owns
   * the precondition; the walk itself is `day/rollover.ts`, and restating its rules here
   * is how the previous attempt ended up with a second `rolloverTo` whose freeze rule
   * contradicted the plan's EC-FRZ-01 ruling.
   */
  interface WalkResult {
    readonly freezesConsumed: number;
    readonly daysProcessed: number;
    readonly streakAfter: number;
    readonly streakBroken: boolean;
  }

  const arbWalkResult = fc.record<WalkResult>({
    freezesConsumed: fc.integer({ min: 0, max: 5 }),
    daysProcessed: fc.integer({ min: 0, max: 400 }),
    streakAfter: fc.integer({ min: 0, max: 900 }),
    streakBroken: fc.boolean(),
  });

  it('[INV-PER-02] with the DB in a failed-integrity state, no freeze is consumed, no streak is broken, and the walk is never entered', () => {
    fc.assert(
      fc.property(arbWalkResult, fc.integer({ min: 0, max: 900 }), (result, streakBefore) => {
        let calls = 0;
        const walk = (_state: { streak: number }, _today: LocalDay): WalkResult => {
          calls += 1;
          return result;
        };
        const guarded = guardRolloverForIntegrity(walk);
        const outcome = guarded('corrupt', { streak: streakBefore }, toLocalDay('2026-09-11'));

        expect(rolloverWasRefused(outcome)).toBe(true);
        // Not merely "the result was zeroed": the walk was not run at all, so nothing it
        // would have written can have been written. Freeze consumption is irreversible.
        expect(calls, 'the walk ran against a DB that cannot be trusted').toBe(0);
        expect((outcome as RolloverRefused).freezesConsumed).toBe(0);
        expect((outcome as RolloverRefused).daysProcessed).toBe(0);
        expect((outcome as RolloverRefused).screen).toBe('S148');
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PER-02] a healthy DB runs the walk untouched, so the precondition is not just a permanent no', () => {
    fc.assert(
      fc.property(arbWalkResult, (result) => {
        let calls = 0;
        const walk = (): WalkResult => {
          calls += 1;
          return result;
        };
        const outcome = guardRolloverForIntegrity(walk)('healthy');
        expect(calls).toBe(1);
        expect(rolloverWasRefused(outcome)).toBe(false);
        // The guard returns the walk's own result, unmodified — it owns no day rules.
        expect(outcome).toBe(result);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PER-02] the precondition is a total function of the verdict', () => {
    expect(rolloverAllowed('healthy')).toBe('ok');
    expect(rolloverAllowed('corrupt')).toBe('failed-integrity');
  });

  it('[INV-PER-02] data/ exports no rollover walk of its own', async () => {
    // The walk is day/rollover.ts's. Two functions named `rolloverTo` in packages/core is
    // an ambiguous re-export the moment the barrels meet, and the one nobody calls is the
    // one whose freeze rule silently disagrees with the plan.
    const module = (await import('./integrity.js')) as Record<string, unknown>;
    expect(Object.keys(module)).not.toContain('rolloverTo');
    const barrel = (await import('./index.js')) as Record<string, unknown>;
    expect(Object.keys(barrel)).not.toContain('rolloverTo');
  });
});

describe('INV-PER-08 no DDL without a verified backup', () => {
  const arbLaunch = fc.record({
    pendingMigrations: fc.integer({ min: 1, max: 4 }),
    dbBytes: fc.integer({ min: 0, max: 80_000_000 }),
    freeBytes: fc.integer({ min: 0, max: 80_000_000 }),
    currentUserVersion: fc.integer({ min: 0, max: 8 }),
  });

  it('[INV-PER-08] below the backup requirement no DDL runs at all and user_version is unchanged', () => {
    fc.assert(
      fc.property(arbLaunch, (input) => {
        const plan = planMigrationLaunch({
          ...input,
          backupVerified: false,
          targetUserVersion: input.currentUserVersion + 1,
        });
        expect(plan.ddlAllowed).toBe(false);
        expect(plan.userVersionAfter).toBe(input.currentUserVersion);
        expect(plan.openReadOnly).toBe(true);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PER-08] the blocking screen is a real product-map screen and still exposes export and audio removal', () => {
    const plan = planMigrationLaunch({
      pendingMigrations: 1,
      dbBytes: 40 * 1024 * 1024,
      freeBytes: 20 * 1024 * 1024,
      backupVerified: false,
      currentUserVersion: 2,
      targetUserVersion: 3,
    });
    // S149 in 00-PRODUCT-MAP.md is `Interrupted migration / mismatch-detected`, which is a
    // different failure and routes to S147. EC-PER-14's blocking free-space screen has no
    // id of its own, so it is the low-disk screen's new state.
    expect(plan.screen).toBe(MIGRATION_BLOCKED_SCREEN);
    expect(plan.screen).toBe('S150');
    expect(plan.screenState).toBe(MIGRATION_BLOCKED_STATE);
    expect(plan.offers).toEqual(['export-my-data', 'remove-downloaded-audio']);
    expect(plan.shortfallBytes).toBeGreaterThan(0);
  });

  it('[INV-PER-08] a verified backup lets the migration run', () => {
    const plan = planMigrationLaunch({
      pendingMigrations: 1,
      dbBytes: 10 * 1024 * 1024,
      freeBytes: 500 * 1024 * 1024,
      backupVerified: true,
      currentUserVersion: 2,
      targetUserVersion: 3,
    });
    expect(plan.ddlAllowed).toBe(true);
    expect(plan.userVersionAfter).toBe(3);
    expect(plan.screen).toBe('none');
    expect(plan.screenState).toBeNull();
  });
});

describe('INV-DAT-07 a missing -wal is an incomplete restore', () => {
  const day = (value: string): LocalDay => toLocalDay(value);

  it('[INV-DAT-07] a DB restored without its -wal is an incomplete restore, not a healthy open', () => {
    expect(
      assessRestore({
        dbPresent: true,
        walPresent: false,
        checkpointedAtSource: false,
        declaredRowCount: 100,
        actualRowCount: 100,
        maxLocalDaySeen: day('2026-09-10'),
        newestSessionDay: day('2026-09-10'),
      }),
    ).toBe('incomplete-restore');
  });

  it('[INV-DAT-07] a short row count is an incomplete restore even when integrity_check passes', () => {
    // `integrity_check` proves validity, never completeness.
    expect(
      assessRestore({
        dbPresent: true,
        walPresent: true,
        checkpointedAtSource: true,
        declaredRowCount: 100,
        actualRowCount: 61,
        maxLocalDaySeen: day('2026-09-10'),
        newestSessionDay: day('2026-09-10'),
      }),
    ).toBe('incomplete-restore');
  });

  it('[INV-DAT-07] max_local_day_seen ahead of the newest session row is an incomplete restore', () => {
    expect(
      assessRestore({
        dbPresent: true,
        walPresent: true,
        checkpointedAtSource: true,
        declaredRowCount: 100,
        actualRowCount: 100,
        maxLocalDaySeen: day('2026-09-11'),
        newestSessionDay: day('2026-09-04'),
      }),
    ).toBe('incomplete-restore');
  });

  it('[INV-DAT-07] a checkpointed, complete restore opens normally', () => {
    expect(
      assessRestore({
        dbPresent: true,
        walPresent: false,
        checkpointedAtSource: true,
        declaredRowCount: 100,
        actualRowCount: 100,
        maxLocalDaySeen: day('2026-09-10'),
        newestSessionDay: day('2026-09-10'),
      }),
    ).toBe('complete');
  });

  it('[INV-DAT-07] EVERY path that produces a file begins with the checkpoint', () => {
    // EC-PER-19 quantifies over "every export, backup window and suspension", so the gate
    // walks the enumerated paths rather than asserting a constant against its own literal.
    expect(FILE_PRODUCING_PATHS.length).toBeGreaterThan(0);
    for (const path of FILE_PRODUCING_PATHS) {
      expect(path.steps.length, `${path.id} has no steps`).toBeGreaterThan(0);
      expect(path.steps[0], `${path.id} writes a file without checkpointing first`).toBe(
        CHECKPOINT_STEP,
      );
      // …and only once, at the front.
      expect(path.steps.filter((step) => step === CHECKPOINT_STEP)).toHaveLength(1);
    }
    expect(pathsMissingCheckpoint()).toEqual([]);
  });

  it('[INV-DAT-07] the enumerated paths are exactly the ones EC-PER-19 names', () => {
    // A new file-producing path that is never added to the registry would otherwise pass
    // the gate above for free, because the gate only walks what is in the registry.
    expect([...FILE_PRODUCING_PATHS.map((path) => path.id)].sort()).toEqual(
      [...expectedFileProducingPaths()].sort(),
    );
    expect(FILE_PRODUCING_PATHS.filter((path) => path.kind === 'backup-window').length).toBe(2);
    expect(FILE_PRODUCING_PATHS.some((path) => path.kind === 'suspension')).toBe(true);
    expect(FILE_PRODUCING_PATHS.some((path) => path.kind === 'export')).toBe(true);
  });
});
