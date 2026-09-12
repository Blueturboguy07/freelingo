import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS, createNodeDb } from '@freelingo/testkit';
import { planCommit } from '@freelingo/core';
import type { Db } from './db.js';
import {
  LATEST_USER_VERSION,
  MIGRATIONS,
  SCHEMA_TABLES_BY_VERSION,
  actualTables,
  checkSchemaIntegrity,
  currentUserVersion,
  migrate,
  schemaAt as shippedSchemaAt,
} from './migrations.js';
import {
  EXCLUDED_PLATFORMS,
  PACK_DB_LOCATION,
  PERSISTENT_PLATFORMS,
  PROGRESS_DB_LOCATION,
  isPersistencePlatformSupported,
} from './paths.js';

function freshDb() {
  const db = createNodeDb();
  migrate(db);
  return db;
}

/** The whole reward commit, as one exclusive transaction keyed by session_id. */
function commitSession(
  db: ReturnType<typeof createNodeDb>,
  outcome: { sessionId: string; xp: number; gems: number },
  options: { failMidway?: boolean } = {},
): boolean {
  const committed = db
    .all<{ session_id: string }>('SELECT session_id FROM committed_session')
    .map((r) => r.session_id);
  const delta = planCommit(outcome, committed);
  if (delta === null) return false;
  db.withExclusiveTransaction(() => {
    db.run('UPDATE account SET lifetime_xp = lifetime_xp + ?, gems = gems + ? WHERE id = 1', [
      delta.xp,
      delta.gems,
    ]);
    if (options.failMidway) throw new Error('killed mid-ceremony');
    db.run('INSERT INTO committed_session (session_id, committed_at) VALUES (?, ?)', [
      delta.sessionId,
      '2026-09-11T00:00:00Z',
    ]);
  });
  return true;
}

describe('migrations + reward commit', () => {
  it('migrates a fresh database to the latest user_version', () => {
    const db = freshDb();
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(
      LATEST_USER_VERSION,
    );
    db.close();
  });

  it('[INV-CER-01] the reward commit is one exclusive transaction: a kill leaves nothing applied', () => {
    const db = freshDb();
    expect(() =>
      commitSession(db, { sessionId: 's1', xp: 20, gems: 5 }, { failMidway: true }),
    ).toThrow(/killed mid-ceremony/);
    const account = db.get<{ lifetime_xp: number; gems: number }>(
      'SELECT lifetime_xp, gems FROM account WHERE id = 1',
    );
    expect(account).toEqual({ lifetime_xp: 0, gems: 0 });
    expect(db.all('SELECT session_id FROM committed_session')).toEqual([]);
    db.close();
  });

  it('[INV-CER-01] replaying a committed session awards nothing extra', () => {
    const db = freshDb();
    expect(commitSession(db, { sessionId: 's1', xp: 20, gems: 5 })).toBe(true);
    expect(commitSession(db, { sessionId: 's1', xp: 20, gems: 5 })).toBe(false);
    expect(commitSession(db, { sessionId: 's1', xp: 999, gems: 999 })).toBe(false);
    const account = db.get<{ lifetime_xp: number; gems: number }>(
      'SELECT lifetime_xp, gems FROM account WHERE id = 1',
    );
    expect(account).toEqual({ lifetime_xp: 20, gems: 5 });
    db.close();
  });
});

describe('persistence layout', () => {
  it('[INV-PER-06] progress lives in the document region and packs in cache, excluded from backup', () => {
    expect(PROGRESS_DB_LOCATION.region).toBe('document');
    expect(PROGRESS_DB_LOCATION.excludedFromBackup).toBe(false);
    expect(PACK_DB_LOCATION.region).toBe('cache');
    expect(PACK_DB_LOCATION.excludedFromBackup).toBe(true);
  });

  it('[INV-PER-06] the persistence gate names its platforms and excludes tvOS explicitly', () => {
    expect(PERSISTENT_PLATFORMS).toEqual(['ios', 'android']);
    expect(EXCLUDED_PLATFORMS).toContain('tvos');
    expect(isPersistencePlatformSupported('ios')).toBe(true);
    expect(isPersistencePlatformSupported('android')).toBe(true);
    expect(isPersistencePlatformSupported('tvos')).toBe(false);
  });
});

/* ------------------------------------------------------ INV-PER-03: one transaction */

/**
 * A `Db` that dies on the Nth statement, exactly like a process kill would.
 *
 * The kill must happen INSIDE `run`, after the caller has decided to issue the statement,
 * because that is where a real kill happens. Throwing from the wrapper makes
 * `withExclusiveTransaction` roll back, which is precisely the behaviour under test: if
 * the DDL and the `PRAGMA user_version` bump were not in one transaction, the rollback
 * would leave one without the other.
 */
function killingDb(inner: Db, killBeforeStatement: number): Db {
  let statements = 0;
  return {
    run(sql, params) {
      statements += 1;
      if (statements === killBeforeStatement) throw new Error(`killed at statement ${statements}`);
      inner.run(sql, params);
    },
    all: (sql, params) => inner.all(sql, params),
    get: (sql, params) => inner.get(sql, params),
    withExclusiveTransaction: (fn) => inner.withExclusiveTransaction(fn),
    close: () => inner.close(),
  } as Db;
}

/**
 * The set of tables a database at `user_version` v must have, built from a clean run.
 *
 * Memoised: the property below calls it on every case, and rebuilding the whole schema
 * 10,000 times to compare against it doubles the run for no extra coverage.
 */
const SCHEMA_AT_CACHE = new Map<number, string[]>();

function schemaAt(version: number): string[] {
  const cached = SCHEMA_AT_CACHE.get(version);
  if (cached !== undefined) return cached;
  const db = createNodeDb();
  for (const migration of MIGRATIONS) {
    if (migration.userVersion > version) break;
    db.withExclusiveTransaction(() => {
      migration.up(db);
      db.run(`PRAGMA user_version = ${migration.userVersion}`);
    });
  }
  const tables = tableNames(db);
  db.close();
  SCHEMA_AT_CACHE.set(version, tables);
  return tables;
}

function tableNames(db: Db): string[] {
  return db
    .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_'))
    .sort();
}

/** How many statements a full migration from scratch issues. Counted, never guessed. */
function statementCount(): number {
  let count = 0;
  const inner = createNodeDb();
  const counting: Db = {
    run(sql, params) {
      count += 1;
      inner.run(sql, params);
    },
    all: (sql, params) => inner.all(sql, params),
    get: (sql, params) => inner.get(sql, params),
    withExclusiveTransaction: (fn) => inner.withExclusiveTransaction(fn),
    close: () => inner.close(),
  };
  migrate(counting);
  inner.close();
  return count;
}

describe('migration atomicity', () => {
  const TOTAL_STATEMENTS = statementCount();

  it('the statement count is real, so the kill points below cover the whole migration', () => {
    expect(TOTAL_STATEMENTS).toBeGreaterThan(20);
  });

  /**
   * Exhaustive, not sampled, and deliberately so.
   *
   * The state space here is finite and small — one kill point per statement — so a
   * property drawing 10,000 samples from it would be 10,000 cases of the same few dozen.
   * The loop below visits EVERY kill point once, which is strictly stronger than any
   * number of samples. The property that follows covers what the loop cannot: a database
   * that already carries rows, at any starting version.
   */
  it('[INV-PER-03] killing before any statement leaves user_version consistent with the schema', () => {
    for (let killAt = 1; killAt <= TOTAL_STATEMENTS; killAt += 1) {
      const inner = createNodeDb();
      expect(() => migrate(killingDb(inner, killAt))).toThrow(/killed at statement/);
      const version = currentUserVersion(inner);
      expect(tableNames(inner), `kill at ${killAt}: version ${version}`).toEqual(schemaAt(version));
      // And the migration resumes: the next launch finishes the job.
      migrate(inner);
      expect(currentUserVersion(inner)).toBe(LATEST_USER_VERSION);
      expect(tableNames(inner)).toEqual(schemaAt(LATEST_USER_VERSION));
      inner.close();
    }
  });

  it('[INV-PER-03] a kill during any migration never half-applies it, for any starting state', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: TOTAL_STATEMENTS }),
        fc.integer({ min: 0, max: LATEST_USER_VERSION - 1 }),
        fc.integer({ min: 0, max: 100_000 }),
        (killAt, startVersion, xp) => {
          const inner = createNodeDb();
          // Bring the database to `startVersion` cleanly, with a row in it.
          for (const migration of MIGRATIONS) {
            if (migration.userVersion > startVersion) break;
            inner.withExclusiveTransaction(() => {
              migration.up(inner);
              inner.run(`PRAGMA user_version = ${migration.userVersion}`);
            });
          }
          if (startVersion >= 1) inner.run('UPDATE account SET xp = ? WHERE id = 1', [xp]);

          try {
            migrate(killingDb(inner, killAt));
          } catch {
            /* a kill is the case under test, not a failure */
          }
          const version = currentUserVersion(inner);
          const consistent =
            JSON.stringify(tableNames(inner)) === JSON.stringify(schemaAt(version));
          // Whatever happened, the XP that was there is still there — under its v1 name
          // if the rename never committed, under its v2 name if it did.
          const column = version >= 2 ? 'lifetime_xp' : 'xp';
          const preserved =
            startVersion < 1 ||
            inner.get<Record<string, number>>(`SELECT ${column} AS v FROM account WHERE id = 1`)
              ?.v === xp;
          inner.close();
          return consistent && preserved;
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PER-03] falsifier: bumping user_version outside the transaction is caught', () => {
    // The bug the invariant forbids, written out: DDL committed, version bumped after.
    const db = createNodeDb();
    db.withExclusiveTransaction(() => {
      MIGRATIONS[0]!.up(db);
    });
    db.run('PRAGMA user_version = 2'); // a lie: version 2's tables are not there
    expect(tableNames(db)).not.toEqual(schemaAt(currentUserVersion(db)));
    db.close();
  });
});

/* ---------------------------------------------------------------------- S149 */

describe('the schema-vs-version detector (S149)', () => {
  it('[INV-PER-03] the SHIPPED table list agrees with what the migrations actually build', () => {
    // `SCHEMA_TABLES_BY_VERSION` is a hand-written constant, which makes it exactly the
    // kind of thing that rots. The oracle is a clean run of the migrations themselves.
    for (const version of [0, 1, LATEST_USER_VERSION]) {
      expect([...shippedSchemaAt(version)].sort(), `user_version ${version}`).toEqual(
        schemaAt(version),
      );
    }
    expect(Object.keys(SCHEMA_TABLES_BY_VERSION).map(Number)).toContain(LATEST_USER_VERSION);
  });

  it('[INV-PER-03] a migrated database matches its recorded version', () => {
    const db = freshDb();
    const integrity = checkSchemaIntegrity(db);
    expect(integrity.ok).toBe(true);
    expect(integrity.userVersion).toBe(LATEST_USER_VERSION);
    db.close();
  });

  it('[INV-PER-03] falsifier: a schema that does not match its recorded version is CORRUPT, detectably', () => {
    // S149's `mismatch-detected` state. The exclusive transaction is what prevents this
    // happening; the detector is what routes it to S147 with the backup offer if it does.
    // Before this shipped, the only `schemaAt` in the tree lived inside this test file.
    const db = freshDb();
    db.run('DROP TABLE course_mistake');
    const integrity = checkSchemaIntegrity(db);
    expect(integrity.ok).toBe(false);
    if (!integrity.ok) {
      expect(integrity.missing).toContain('course_mistake');
      expect(integrity.unexpected).toEqual([]);
    }
    db.close();
  });

  it('[INV-PER-03] a database written by a FUTURE build is a mismatch, not something to migrate', () => {
    const db = freshDb();
    db.run(`PRAGMA user_version = ${LATEST_USER_VERSION + 7}`);
    const integrity = checkSchemaIntegrity(db);
    expect(integrity.ok).toBe(false);
    expect(actualTables(db).length).toBeGreaterThan(0);
    db.close();
  });
});
