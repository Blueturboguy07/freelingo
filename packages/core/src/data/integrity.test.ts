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
  CORRUPTION_ERROR_CODES,
  assessRestore,
  corruptQuarantineName,
  integrityVerdict,
  isCorruptQuarantineName,
  planCorruptionRecovery,
  planMigrationLaunch,
  rolloverTo,
  type OpenObservation,
} from './integrity.js';

/** INV-PER-01, INV-PER-02, INV-PER-08, INV-DAT-07. */

const scratch = mkdtempSync(join(tmpdir(), 'freelingo-integrity-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A real SQLite file with enough pages that a corrupted range hits a b-tree page. */
function writeFixtureDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('CREATE TABLE attempt (session_id TEXT, exercise_index INTEGER, correct INTEGER)');
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO attempt VALUES (?, ?, ?)');
  for (let i = 0; i < 2000; i += 1) insert.run(`session-${i % 37}`, i, i % 2);
  db.exec('COMMIT');
  db.close();
}

/** Open it and report what the ladder would have seen. */
function observe(path: string): OpenObservation {
  try {
    const db = new DatabaseSync(path);
    try {
      const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
      const ok = rows.length === 1 && rows[0]!.integrity_check === 'ok';
      // Force a full table scan too: `integrity_check` on a small file can pass while a
      // read of the damaged page still throws.
      if (ok) db.prepare('SELECT count(*) AS n FROM attempt').get();
      return { errorCode: null, integrityCheck: ok ? 'ok' : 'failed', walRecovered: true };
    } finally {
      db.close();
    }
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'SQLITE_CORRUPT';
    return {
      errorCode: CORRUPTION_ERROR_CODES.includes(code) ? code : 'SQLITE_CORRUPT',
      integrityCheck: 'failed',
      walRecovered: false,
    };
  }
}

describe('INV-PER-01 corruption: rename, never delete', () => {
  it('[INV-PER-01] a corrupted byte range in a fixture DB is detected, the file survives under freelingo-corrupt-*, and the UI states what happened', () => {
    const path = join(scratch, 'progress.db');
    writeFixtureDb(path);
    expect(observe(path).integrityCheck).toBe('ok');

    // Corrupt a byte range: two whole pages from page 2 onward.
    const bytes = readFileSync(path);
    for (let i = 4096; i < 8192 && i < bytes.length; i += 1) bytes[i] = (i * 37) & 0xff;
    writeFileSync(path, bytes);

    const observation = observe(path);
    expect(integrityVerdict(observation), 'the corruption was not detected at all').toBe('corrupt');

    const at = new Date('2026-09-11T17:42:33.123Z');
    const plan = planCorruptionRecovery(observation, at);
    expect(plan.action).toBe('rename-and-start-fresh');
    expect(plan.deletes, 'the damaged file is the only copy of what is left').toEqual([]);
    expect(plan.renameTo).toBe('freelingo-corrupt-20260911T174233Z.db');
    expect(isCorruptQuarantineName(plan.renameTo!)).toBe(true);
    // Never a zeroed profile that reads as a fresh install (EC-PER-01).
    expect(plan.screen).toBe('S147');
    expect(plan.copyKeys.length).toBeGreaterThan(0);
    expect(plan.offers).toEqual(['import-a-backup', 'export-the-damaged-file']);
    expect(plan.rolloverInhibited).toBe(true);

    // Carry the plan out: the damaged bytes are still on disk afterwards.
    const quarantined = join(scratch, plan.renameTo!);
    renameSync(path, quarantined);
    expect(existsSync(quarantined)).toBe(true);
    expect(readFileSync(quarantined).length).toBe(bytes.length);

    // ...and a fresh DB starts beside it.
    writeFixtureDb(path);
    expect(observe(path).integrityCheck).toBe('ok');
    expect(existsSync(quarantined)).toBe(true);
  });

  it('[INV-PER-01] the plan never deletes anything, whatever the ladder saw', () => {
    fc.assert(
      fc.property(
        fc.record({
          errorCode: fc.option(
            fc.constantFrom(...CORRUPTION_ERROR_CODES, 'SQLITE_BUSY', 'SQLITE_FULL'),
            { nil: null },
          ),
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
    const plan = planCorruptionRecovery(
      { errorCode: null, integrityCheck: 'ok', walRecovered: true },
      new Date(),
    );
    expect(plan).toMatchObject({ action: 'none', screen: 'none', rolloverInhibited: false });
  });

  it('[INV-PER-01] a busy or full database is not corruption', () => {
    for (const code of ['SQLITE_BUSY', 'SQLITE_FULL', 'SQLITE_LOCKED']) {
      expect(integrityVerdict({ errorCode: code, integrityCheck: 'ok', walRecovered: true })).toBe(
        'healthy',
      );
    }
  });

  it('[INV-PER-01] the quarantine name is filename-safe on both platforms', () => {
    const name = corruptQuarantineName(new Date('2026-12-01T05:06:07Z'));
    // A colon is rendered as `/` by the macOS file APIs and is reserved on Android FAT.
    expect(name).not.toContain(':');
    expect(name).toBe('freelingo-corrupt-20261201T050607Z.db');
  });
});

describe('INV-PER-02 rolloverTo has an integrity precondition', () => {
  const arbRollover = fc.record({
    missedDays: fc.integer({ min: 0, max: 30 }),
    freezesOwned: fc.integer({ min: 0, max: 5 }),
    streak: fc.integer({ min: 0, max: 900 }),
  });

  it('[INV-PER-02] with the DB in a failed-integrity state, no freeze is consumed and no streak is broken', () => {
    fc.assert(
      fc.property(arbRollover, (input) => {
        const outcome = rolloverTo({
          integrity: 'corrupt',
          fromDay: toLocalDay('2026-09-01'),
          toDay: toLocalDay('2026-09-11'),
          ...input,
        });
        expect(outcome.applied).toBe(false);
        // Freeze consumption is irreversible and there is no server to appeal to.
        expect(outcome.freezesConsumed).toBe(0);
        expect(outcome.streakBroken).toBe(false);
        expect(outcome.streakAfter).toBe(input.streak);
        expect(outcome.refusal).toBe('failed-integrity');
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PER-02] a healthy DB does roll over, so the precondition is not just a permanent no', () => {
    fc.assert(
      fc.property(arbRollover, (input) => {
        const outcome = rolloverTo({
          integrity: 'healthy',
          fromDay: toLocalDay('2026-09-01'),
          toDay: toLocalDay('2026-09-11'),
          ...input,
        });
        expect(outcome.applied).toBe(true);
        expect(outcome.freezesConsumed).toBe(Math.min(input.freezesOwned, input.missedDays));
        expect(outcome.streakBroken).toBe(input.missedDays > input.freezesOwned);
      }),
      { numRuns: PROPERTY_RUNS },
    );
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

  it('[INV-PER-08] the blocking screen still exposes export and audio removal', () => {
    const plan = planMigrationLaunch({
      pendingMigrations: 1,
      dbBytes: 40 * 1024 * 1024,
      freeBytes: 20 * 1024 * 1024,
      backupVerified: false,
      currentUserVersion: 2,
      targetUserVersion: 3,
    });
    expect(plan.screen).toBe('S149-blocking-free-space');
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

  it('[INV-DAT-07] every export and backup path checkpoints first', () => {
    expect(CHECKPOINT_STEP).toBe('wal_checkpoint(TRUNCATE)');
  });
});
