/**
 * The migration registry. `PRAGMA user_version` is the only version marker.
 *
 * INV-PER-03 (EC-PER-03): the schema DDL and the `PRAGMA user_version` bump occur in ONE
 * exclusive transaction. A kill at any instant therefore leaves `user_version` consistent
 * with the schema that is actually there — the next launch resumes — rather than a
 * half-applied schema wearing the new number, which is the state S149 has to treat as
 * corrupt and offer a backup for.
 *
 * `withExclusiveTransaction`, never a deferred one: a deferred transaction admits another
 * writer and can be rolled back under a caller who believed it committed (INV-PER-07,
 * EC-PER-12). `exclusive-transaction-gate.test.ts` greps for the difference.
 *
 * The golden-DB corpus (`fixtures/golden/`, `golden.test.ts`) migrates one committed
 * database per shipped version forward and diffs the result row by row. Ship a migration
 * without a fixture and that test is red.
 */
import type { Db } from './db.js';
import { PROGRESS_SCHEMA_V2_DDL } from './progress-schema.js';

export interface Migration {
  readonly userVersion: number;
  readonly name: string;
  up(db: Db): void;
}

/**
 * P0's seed: the two-column account and the committed-session ledger INV-CER-01 is
 * asserted against. Left exactly as it shipped — a migration that has run on a device is
 * history and is never edited, only superseded.
 */
const LEDGER_AND_COMMITTED_SESSIONS: Migration = {
  userVersion: 1,
  name: 'ledger-and-committed-sessions',
  up(db) {
    db.run(`CREATE TABLE IF NOT EXISTS account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        xp INTEGER NOT NULL DEFAULT 0,
        gems INTEGER NOT NULL DEFAULT 0
      )`);
    db.run(`INSERT OR IGNORE INTO account (id, xp, gems) VALUES (1, 0, 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS committed_session (
        session_id TEXT PRIMARY KEY,
        committed_at TEXT NOT NULL
      )`);
  },
};

/**
 * P1: the full progress schema, in the two declared regions plus the per-course display
 * region (INV-ECO-04, INV-PER-11). The statements themselves live in `progress-schema.ts`
 * beside the declaration they have to agree with, so the region gate and the DDL cannot
 * drift apart in a review.
 */
const PROGRESS_SCHEMA: Migration = {
  userVersion: 2,
  name: 'progress-schema-two-regions',
  up(db) {
    for (const statement of PROGRESS_SCHEMA_V2_DDL) db.run(statement);
  },
};

export const MIGRATIONS: readonly Migration[] = [
  LEDGER_AND_COMMITTED_SESSIONS,
  PROGRESS_SCHEMA,
] as const;

export const LATEST_USER_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.userVersion), 0);

/** What the database says it is. 0 for a file that has never been migrated. */
export function currentUserVersion(db: Db): number {
  return db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
}

/**
 * Bring a database to `LATEST_USER_VERSION`.
 *
 * Idempotent: a relaunch is not a migration, and running this twice changes nothing.
 * Resumable: a migration that was killed rolled back whole, so the next call starts it
 * again from its own beginning.
 */
/**
 * The tables each shipped `user_version` is supposed to have.
 *
 * S149 ("Interrupted migration", `mismatch-detected`) says a schema that does not match
 * its recorded version is treated as CORRUPT and offered the pre-migration backup by name
 * and timestamp. That rule needs a detector that exists in the shipped app, not only
 * inside a test file — which is where this table used to live.
 */
export const SCHEMA_TABLES_BY_VERSION: Readonly<Record<number, readonly string[]>> = {
  0: [],
  1: ['account', 'committed_session'],
  2: [
    'account',
    'account_boost',
    'account_cosmetic',
    'account_day',
    'account_daily_xp',
    'account_freeze',
    'account_monthly_badge',
    'account_personal_record',
    'account_quest',
    'account_streak_repair',
    'committed_session',
    'course_attempt',
    'course_display',
    'course_item',
    'course_mistake',
    'course_node',
    'course_progress',
    'course_session_state',
  ],
};

export function schemaAt(userVersion: number): readonly string[] {
  return SCHEMA_TABLES_BY_VERSION[userVersion] ?? [];
}

/** The tables a database actually has, sorted. SQLite's own tables are not ours. */
export function actualTables(db: Db): string[] {
  return db
    .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_'));
}

export type SchemaIntegrity =
  | { readonly ok: true; readonly userVersion: number }
  | {
      readonly ok: false;
      readonly userVersion: number;
      readonly missing: readonly string[];
      readonly unexpected: readonly string[];
    };

/**
 * S149's detector, executable: does the schema match the version it claims?
 *
 * A half-applied migration wearing the new number is the state the exclusive transaction
 * exists to prevent (INV-PER-03) — but "prevented by construction" and "detected if it
 * happens anyway" are different guarantees, and an app that only has the first one has no
 * way to route a corrupted file to S147 with the backup offer.
 *
 * An unknown (future) `user_version` is a mismatch too: a database written by a newer
 * build is not something this build may migrate or quietly use.
 */
export function checkSchemaIntegrity(db: Db): SchemaIntegrity {
  const userVersion = currentUserVersion(db);
  const expected = SCHEMA_TABLES_BY_VERSION[userVersion];
  const actual = actualTables(db);
  if (expected === undefined) {
    return { ok: false, userVersion, missing: [], unexpected: actual };
  }
  const missing = expected.filter((table) => !actual.includes(table));
  const unexpected = actual.filter((table) => !expected.includes(table));
  if (missing.length === 0 && unexpected.length === 0) return { ok: true, userVersion };
  return { ok: false, userVersion, missing, unexpected };
}

export function migrate(db: Db): number {
  const current = currentUserVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.userVersion <= current) continue;
    db.withExclusiveTransaction(() => {
      migration.up(db);
      // PRAGMA takes no bound parameter; the value is an integer from this module.
      db.run(`PRAGMA user_version = ${migration.userVersion}`);
    });
  }
  return LATEST_USER_VERSION;
}
