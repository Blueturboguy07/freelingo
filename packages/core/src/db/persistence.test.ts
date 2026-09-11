import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  PERSISTENT_PATH_MARKER,
  PRE_MIGRATION_COPIES_KEPT,
  dbPathIsPersistent,
  parsePreMigrationCopyName,
  preMigrationCopiesToDelete,
  preMigrationCopyName,
  toFileSafeIso8601,
} from './persistence.js';

/**
 * The resolver moved into `packages/core` at P0 so the rule the device gate asserts
 * (`e2e/flows/p0-db-path.yaml`) is the same rule a unit test can falsify. The
 * region/backup-flag half of INV-PER-06 stays in `packages/schema`.
 */
describe('progress DB path (INV-PER-06)', () => {
  it('[INV-PER-06] a document-region path is persistent on the platform it names', () => {
    expect(
      dbPathIsPersistent(
        'ios',
        'file:///var/mobile/Containers/Data/Application/1E1/Documents/freelingo-progress.db',
      ),
    ).toBe(true);
    expect(
      dbPathIsPersistent(
        'android',
        'file:///data/user/0/org.freelingo.app/files/freelingo-progress.db',
      ),
    ).toBe(true);
  });

  it('[INV-PER-06] a cache-region path is not accepted as the progress DB path', () => {
    expect(
      dbPathIsPersistent(
        'ios',
        'file:///var/mobile/Containers/Data/Application/1E1/Library/Caches/freelingo-progress.db',
      ),
    ).toBe(false);
    expect(
      dbPathIsPersistent(
        'android',
        'file:///data/user/0/org.freelingo.app/cache/freelingo-progress.db',
      ),
    ).toBe(false);
  });

  it('[INV-PER-06] the gate names its platforms: an unnamed platform is never persistent', () => {
    expect(Object.keys(PERSISTENT_PATH_MARKER).sort()).toEqual(['android', 'ios']);
    // tvOS is excluded explicitly: its document directory is evictable.
    expect(dbPathIsPersistent('tvos', '/private/var/mobile/Documents/freelingo-progress.db')).toBe(
      false,
    );
    expect(dbPathIsPersistent('web', '/Documents/freelingo-progress.db')).toBe(false);
    expect(dbPathIsPersistent('macos', '/Documents/freelingo-progress.db')).toBe(false);
  });

  it('[INV-PER-06] the Android marker is `/files/`, not the bare app id — `.../files_backup/` is not it', () => {
    expect(
      dbPathIsPersistent('android', 'file:///data/user/0/org.freelingo.app/files_x/x.db'),
    ).toBe(false);
    expect(dbPathIsPersistent('ios', 'file:///var/m/DocumentsArchive/x.db')).toBe(false);
  });
});

describe('pre-migration copies (INV-PER-06)', () => {
  it('[INV-PER-06] a pre-migration copy is named for the version it precedes, with a colon-free ISO 8601 instant', () => {
    const name = preMigrationCopyName(2, new Date('2026-09-11T17:42:33.123Z'));
    expect(name).toBe('freelingo-pre-v2-20260911T174233Z.db');
    expect(name).not.toContain(':');
    expect(toFileSafeIso8601(new Date('2026-01-02T03:04:05Z'))).toBe('20260102T030405Z');
  });

  it('[INV-PER-06] a copy name round-trips through the parser', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9_999 }),
        fc.date({
          min: new Date('2020-01-01T00:00:00Z'),
          max: new Date('2099-12-31T23:59:59Z'),
          noInvalidDate: true,
        }),
        (version, at) => {
          const parsed = parsePreMigrationCopyName(preMigrationCopyName(version, at));
          expect(parsed).not.toBeNull();
          expect(parsed?.toUserVersion).toBe(version);
          expect(parsed?.instant).toBe(toFileSafeIso8601(at));
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('[INV-PER-06] the pruner keeps the two most recent copies and deletes the rest', () => {
    const names = [
      'freelingo-pre-v2-20260101T000000Z.db',
      'freelingo-pre-v3-20260301T000000Z.db',
      'freelingo-pre-v4-20260401T000000Z.db',
      'freelingo-pre-v3-20260201T000000Z.db',
    ];
    expect(PRE_MIGRATION_COPIES_KEPT).toBe(2);
    expect(preMigrationCopiesToDelete(names).sort()).toEqual([
      'freelingo-pre-v2-20260101T000000Z.db',
      'freelingo-pre-v3-20260201T000000Z.db',
    ]);
  });

  it('[INV-PER-06] the pruner never names a file it does not own', () => {
    const foreign = [
      'freelingo-progress.db',
      'freelingo-progress.db-wal',
      'freelingo-progress.db-shm',
      'freelingo-pre-v2-2026-09-11T17:42:33Z.db',
      'packs',
      '.DS_Store',
    ];
    expect(preMigrationCopiesToDelete(foreign)).toEqual([]);
    expect(
      preMigrationCopiesToDelete([...foreign, 'freelingo-pre-v9-20260911T000000Z.db']),
    ).toEqual([]);
  });

  it('[INV-PER-06] pruning is idempotent and leaves exactly min(n, keep) copies for any set', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.tuple(
            fc.integer({ min: 1, max: 50 }),
            fc.date({
              min: new Date('2020-01-01T00:00:00Z'),
              max: new Date('2099-12-31T23:59:59Z'),
              noInvalidDate: true,
            }),
          ),
          { maxLength: 12 },
        ),
        fc.integer({ min: 0, max: 4 }),
        (pairs, keep) => {
          const names = [
            ...new Set(pairs.map(([version, at]) => preMigrationCopyName(version, at))),
          ];
          const doomed = preMigrationCopiesToDelete(names, keep);
          const survivors = names.filter((n) => !doomed.includes(n));
          expect(survivors).toHaveLength(Math.min(names.length, keep));
          // Every survivor is at least as new as every deleted copy.
          const instant = (n: string) => parsePreMigrationCopyName(n)?.instant ?? '';
          for (const gone of doomed) {
            for (const kept of survivors) {
              expect(instant(kept) >= instant(gone)).toBe(true);
            }
          }
          // Running the prune again deletes nothing more.
          expect(preMigrationCopiesToDelete(survivors, keep)).toEqual([]);
        },
      ),
      { numRuns: 10_000 },
    );
  });
});
