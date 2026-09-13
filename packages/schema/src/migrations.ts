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
import { SCHEDULER_SCHEMA_V5_DDL, SCHEDULER_TABLES } from './scheduler-schema.js';
import {
  LEARNING_CONTEXT_SCHEMA_V6_DDL,
  LEARNING_CONTEXT_COURSE_TABLES,
  LEARNING_CONTEXT_ACCOUNT_TABLES,
} from './learning-context-schema.js';

import {
  DAY_REWARD_SCHEMA_V7_DDL,
  DAY_REWARD_ACCOUNT_TABLES,
  DAY_REWARD_COURSE_TABLES,
} from './day-reward-schema.js';

import {
  LEARNING_EVIDENCE_SCHEMA_V8_DDL,
  LEARNING_EVIDENCE_COURSE_TABLES,
} from './learning-evidence-schema.js';

import { PATH_STATE_SCHEMA_V9_DDL, PATH_STATE_COURSE_TABLES } from './path-state-schema.js';

import {
  WORD_EVIDENCE_ACCOUNT_TABLES,
  WORD_EVIDENCE_SCHEMA_V10_DDL,
} from './word-evidence-schema.js';

import { WORD_REVIEW_ACCOUNT_TABLES, WORD_REVIEW_SCHEMA_V11_DDL } from './word-review-schema.js';

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

/** P3 runtime bridge, 2026-09-13. Graded describes the kind; active describes the
 * global lease. A parked graded lesson retains its complete checkpoint. Legacy v2
 * rows are preserved with a null runtime payload so the app can offer start-over
 * explicitly instead of inventing the missing banner, replay and unfinished input. */
const SESSION_RUNTIME: Migration = {
  userVersion: 3,
  name: 'complete-session-runtime-and-parked-lessons',
  up(db) {
    db.run(
      'ALTER TABLE course_session_state ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))',
    );
    db.run(
      'ALTER TABLE course_session_state ADD COLUMN runtime_json TEXT CHECK (runtime_json IS NULL OR json_valid(runtime_json))',
    );
    db.run('DROP INDEX one_graded_session_in_flight');
    db.run(
      'CREATE UNIQUE INDEX one_graded_session_in_flight ON course_session_state(is_active) WHERE is_graded = 1 AND is_active = 1',
    );
  },
};

/** P4 settings, 2026-09-13. General lesson switches are account-scoped (deep07 §global split).
 * Existing per-course modality choices and the global suspension record stay intact. */
const DURABLE_SETTINGS: Migration = {
  userVersion: 4,
  name: 'durable-account-preferences',
  up(db) {
    db.run(
      "ALTER TABLE account ADD COLUMN appearance TEXT NOT NULL DEFAULT 'system' CHECK (appearance IN ('light', 'dark', 'system'))",
    );
    db.run('ALTER TABLE account ADD COLUMN imported_at_utc TEXT');
    db.run(
      'ALTER TABLE account ADD COLUMN sound_effects_enabled INTEGER NOT NULL DEFAULT 1 CHECK (sound_effects_enabled IN (0, 1))',
    );
    db.run(
      'ALTER TABLE account ADD COLUMN animations_enabled INTEGER NOT NULL DEFAULT 1 CHECK (animations_enabled IN (0, 1))',
    );
    db.run(
      'ALTER TABLE account ADD COLUMN motivational_messages_enabled INTEGER NOT NULL DEFAULT 1 CHECK (motivational_messages_enabled IN (0, 1))',
    );
  },
};

const DURABLE_SCHEDULER: Migration = {
  userVersion: 5,
  name: 'durable-surface-scheduler-and-answer-receipts',
  up(db) {
    for (const statement of SCHEDULER_SCHEMA_V5_DDL) db.run(statement);
  },
};

const DURABLE_LEARNING_CONTEXT: Migration = {
  userVersion: 6,
  name: 'frozen-session-bindings-pools-and-onboarding',
  up(db) {
    for (const statement of LEARNING_CONTEXT_SCHEMA_V6_DDL) db.run(statement);
  },
};

const DURABLE_DAY_REWARD: Migration = {
  userVersion: 7,
  name: 'normalized-day-reward-and-frozen-ceremony',
  up(db) {
    for (const statement of DAY_REWARD_SCHEMA_V7_DDL) db.run(statement);
  },
};

const DURABLE_LEARNING_EVIDENCE: Migration = {
  userVersion: 8,
  name: 'observed-surfaces-and-per-answer-targets',
  up(db) {
    for (const statement of LEARNING_EVIDENCE_SCHEMA_V8_DDL) db.run(statement);
  },
};

const DURABLE_PATH_STATE: Migration = {
  userVersion: 9,
  name: 'known-path-viewport-and-proven-unlocks',
  up(db) {
    for (const statement of PATH_STATE_SCHEMA_V9_DDL) db.run(statement);
  },
};

const DURABLE_WORD_EVIDENCE: Migration = {
  userVersion: 10,
  name: 'permanent-source-declared-lexical-evidence',
  up(db) {
    for (const statement of WORD_EVIDENCE_SCHEMA_V10_DDL) db.run(statement);
  },
};

const DURABLE_WORD_REVIEWS: Migration = {
  userVersion: 11,
  name: 'permanent-ordered-lexical-review-evidence',
  up(db) {
    for (const statement of WORD_REVIEW_SCHEMA_V11_DDL) db.run(statement);
  },
};

export const MIGRATIONS: readonly Migration[] = [
  LEDGER_AND_COMMITTED_SESSIONS,
  PROGRESS_SCHEMA,
  SESSION_RUNTIME,
  DURABLE_SETTINGS,
  DURABLE_SCHEDULER,
  DURABLE_LEARNING_CONTEXT,
  DURABLE_DAY_REWARD,
  DURABLE_LEARNING_EVIDENCE,
  DURABLE_PATH_STATE,
  DURABLE_WORD_EVIDENCE,
  DURABLE_WORD_REVIEWS,
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

  3: [
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
  4: [
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

  5: [
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
    ...SCHEDULER_TABLES,
  ],

  6: [
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
    ...SCHEDULER_TABLES,
    ...LEARNING_CONTEXT_COURSE_TABLES,
    ...LEARNING_CONTEXT_ACCOUNT_TABLES,
  ],

  7: [
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
    ...SCHEDULER_TABLES,
    ...LEARNING_CONTEXT_COURSE_TABLES,
    ...LEARNING_CONTEXT_ACCOUNT_TABLES,
    ...DAY_REWARD_COURSE_TABLES,
    ...DAY_REWARD_ACCOUNT_TABLES,
  ],
  8: [
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
    ...SCHEDULER_TABLES,
    ...LEARNING_CONTEXT_COURSE_TABLES,
    ...LEARNING_CONTEXT_ACCOUNT_TABLES,
    ...DAY_REWARD_COURSE_TABLES,
    ...DAY_REWARD_ACCOUNT_TABLES,
    ...LEARNING_EVIDENCE_COURSE_TABLES,
  ],

  9: [
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
    ...SCHEDULER_TABLES,
    ...LEARNING_CONTEXT_COURSE_TABLES,
    ...LEARNING_CONTEXT_ACCOUNT_TABLES,
    ...DAY_REWARD_COURSE_TABLES,
    ...DAY_REWARD_ACCOUNT_TABLES,
    ...LEARNING_EVIDENCE_COURSE_TABLES,
    ...PATH_STATE_COURSE_TABLES,
  ],
  10: [
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
    ...SCHEDULER_TABLES,
    ...LEARNING_CONTEXT_COURSE_TABLES,
    ...LEARNING_CONTEXT_ACCOUNT_TABLES,
    ...DAY_REWARD_COURSE_TABLES,
    ...DAY_REWARD_ACCOUNT_TABLES,
    ...LEARNING_EVIDENCE_COURSE_TABLES,
    ...PATH_STATE_COURSE_TABLES,
    ...WORD_EVIDENCE_ACCOUNT_TABLES,
  ],
  11: [
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
    ...SCHEDULER_TABLES,
    ...LEARNING_CONTEXT_COURSE_TABLES,
    ...LEARNING_CONTEXT_ACCOUNT_TABLES,
    ...DAY_REWARD_COURSE_TABLES,
    ...DAY_REWARD_ACCOUNT_TABLES,
    ...LEARNING_EVIDENCE_COURSE_TABLES,
    ...PATH_STATE_COURSE_TABLES,
    ...WORD_EVIDENCE_ACCOUNT_TABLES,
    ...WORD_REVIEW_ACCOUNT_TABLES,
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
