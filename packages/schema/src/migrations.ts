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
