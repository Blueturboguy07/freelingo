/**
 * The progress schema: two regions, one declaration, one gate.
 *
 * `account` is global and survives course removal. `course_progress` is per course and is
 * destroyed with it. INV-ECO-04 is the rule that **no table straddles the two**, and the
 * gate below is what makes that a build failure rather than a code-review habit:
 *
 *   account region        no `course_id` column, no foreign key into `course_progress`
 *   course_progress       a NOT NULL `course_id` with `REFERENCES course_progress(course_id)
 *                         ON DELETE CASCADE`
 *
 * The cascade is not decoration. It is how "course XP, Score, path state, mistakes and
 * FSRS rows are destroyed on removal while every account-region counter stays
 * bit-identical" (INV-ECO-13, INV-CRS-03) becomes a property of the database instead of a
 * sequence of DELETEs somebody has to remember to write.
 *
 * Two sources of truth would defeat the whole thing, so there is one: `PROGRESS_TABLES`
 * declares the region of each table and `describeSchema()` reads what SQLite actually
 * built. `regionViolations()` compares them. A table created by a migration and missing
 * from the declaration is a violation; so is a declared table that no migration creates.
 *
 * Specs: plan §Architecture (Data model), docs/invariants.md §8 ECO, §13 PER, §15 SESS.
 * Screens: S118-S126 (economy surfaces), S132 (goal), S149 (data).
 */
import type { Db } from './db.js';

export type SchemaRegion = 'account' | 'course_progress';

export interface TableSpec {
  readonly name: string;
  readonly region: SchemaRegion;
  /** Why the table exists, in one line, and which invariant leans on it. */
  readonly purpose: string;
}

/**
 * Every table in the progress database, with its region.
 *
 * Adding a table without adding it here fails `regionViolations()`; adding it here
 * without a migration that creates it fails the same test from the other side.
 */
export const PROGRESS_TABLES: readonly TableSpec[] = [
  /* ------------------------------------------------------------ account region */
  {
    name: 'account',
    region: 'account',
    purpose:
      'Singleton row. `lifetime_xp` (INV-ECO-13) plus every achievement counter column (INV-ECO-25).',
  },
  {
    name: 'account_day',
    region: 'account',
    purpose: 'One row per local_day: goal, earned XP, the chest grant (INV-ECO-05), day source.',
  },
  {
    name: 'account_daily_xp',
    region: 'account',
    purpose:
      'The per-mode XP ladder, keyed (local_day, ladder_mode) GLOBALLY — no course_id, which is exactly INV-ECO-06.',
  },
  {
    name: 'account_boost',
    region: 'account',
    purpose: 'Boost grants: inventory when not running, the active boost when it is (INV-ECO-03).',
  },
  {
    name: 'account_freeze',
    region: 'account',
    purpose:
      'One row per owned freeze, with the day it was acquired — EC-FRZ-01 needs "owned before that day began".',
  },
  {
    name: 'account_cosmetic',
    region: 'account',
    purpose: 'Purchased cosmetics, the only gem sink besides freezes (INV-ECO-12).',
  },
  {
    name: 'account_quest',
    region: 'account',
    purpose:
      "The day's quests, keyed (local_day, quest_id), a pure function of the day (INV-ECO-11).",
  },
  {
    name: 'account_monthly_badge',
    region: 'account',
    purpose: 'Monthly badge keyed by the YYYY-MM of max_local_day_seen (INV-ECO-22).',
  },
  {
    name: 'account_personal_record',
    region: 'account',
    purpose: 'Personal records and when each was last celebrated (INV-ECO-23).',
  },
  {
    name: 'account_streak_repair',
    region: 'account',
    purpose: 'One row per repaired month: idempotent on (year, month) by primary key (EC-FRZ-08).',
  },

  /* ---------------------------------------------------- course_progress region */
  {
    name: 'course_progress',
    region: 'course_progress',
    purpose: 'The region root: course XP, Score and score_floor. Deleting the row cascades.',
  },
  {
    name: 'course_display',
    region: 'course_progress',
    purpose:
      'Display preferences keyed by course_id so two courses hold different furigana values at once (INV-PER-11).',
  },
  {
    name: 'course_node',
    region: 'course_progress',
    purpose: 'Path state, with `legendary_awarded_at` set once per node ever (INV-ECO-07).',
  },
  {
    name: 'course_item',
    region: 'course_progress',
    purpose:
      'FSRS rows on content-hashed item ids, with `countable` and `quarantined` (INV-ECO-27, INV-PACK-02).',
  },
  {
    name: 'course_attempt',
    region: 'course_progress',
    purpose:
      'Append-only attempts keyed (session_id, exercise_index); every counter recomputes from these.',
  },
  {
    name: 'course_mistake',
    region: 'course_progress',
    purpose: 'The mistake queue: in-session recycles and the hub backlog.',
  },
  {
    name: 'course_session_state',
    region: 'course_progress',
    purpose:
      'The resume row: all nine fields of the resume guarantee, keyed (course_id, session_kind, node_ref).',
  },
] as const;

export const ACCOUNT_TABLES: readonly string[] = PROGRESS_TABLES.filter(
  (t) => t.region === 'account',
).map((t) => t.name);

export const COURSE_TABLES: readonly string[] = PROGRESS_TABLES.filter(
  (t) => t.region === 'course_progress',
).map((t) => t.name);

/**
 * The nine fields the resume guarantee restores byte-identically
 * (`queue, index, answers, hearts, combo, usedInterstitialKeys, inputMode, hardMode,
 * optionSeeds`), as their column names. A schema with fewer fields fails by construction.
 */
export const SESSION_STATE_RESUME_COLUMNS: readonly string[] = [
  'queue_json',
  'cursor_index',
  'answers_json',
  'hearts_remaining',
  'combo',
  'used_interstitial_keys_json',
  'input_mode',
  'hard_mode',
  'option_seeds_json',
] as const;

/* ============================================================== the DDL, v2 */

/**
 * `user_version = 2`: the full progress schema.
 *
 * P0's migration 1 created a two-column `account` and a `committed_session` ledger. This
 * migration grows that `account` in place with `ALTER TABLE … RENAME COLUMN` and
 * `ADD COLUMN` rather than dropping and recreating it, because a real device arrives here
 * with a row in it: `xp` becomes `lifetime_xp` carrying its value, and every counter
 * column arrives at 0. Recreating the table would be simpler to read and would silently
 * reset the one number the achievements depend on.
 *
 * Ordered: `course_progress` is created before anything that references it.
 */
export const PROGRESS_SCHEMA_V2_DDL: readonly string[] = [
  /* ---- account: grow P0's stub into the real singleton --------------------- */
  `ALTER TABLE account RENAME COLUMN xp TO lifetime_xp`,
  `ALTER TABLE account ADD COLUMN daily_goal_xp INTEGER NOT NULL DEFAULT 20`,
  `ALTER TABLE account ADD COLUMN daily_goal_tier TEXT NOT NULL DEFAULT 'regular'`,
  `ALTER TABLE account ADD COLUMN streak INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE account ADD COLUMN longest_streak INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE account ADD COLUMN streak_start_day TEXT`,
  `ALTER TABLE account ADD COLUMN max_local_day_seen TEXT`,
  `ALTER TABLE account ADD COLUMN society_entered_on_day TEXT`,
  `ALTER TABLE account ADD COLUMN equipped_cosmetic_id TEXT`,
  `ALTER TABLE account ADD COLUMN modality_suspension_until TEXT`,
  // Achievement counter columns. Every one of these is named by ACHIEVEMENTS
  // (packages/core economy/achievements.ts); INV-ECO-25 is the cross-check that the
  // registry never names a column this list does not have.
  `ALTER TABLE account ADD COLUMN words_introduced INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE account ADD COLUMN words_learned INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE account ADD COLUMN perfect_lessons INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE account ADD COLUMN nodes_completed INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE account ADD COLUMN units_legendary INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE account ADD COLUMN sections_completed INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE account ADD COLUMN guidebook_then_lesson INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE account ADD COLUMN weekend_pairs INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE account ADD COLUMN stories_completed INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE account ADD COLUMN night_lessons INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE account ADD COLUMN items_retired INTEGER NOT NULL DEFAULT 0`,

  /* ---- account region: the rest ------------------------------------------- */
  `CREATE TABLE account_day (
     local_day TEXT PRIMARY KEY,
     goal_xp INTEGER NOT NULL,
     earned_xp INTEGER NOT NULL DEFAULT 0,
     goal_met INTEGER NOT NULL DEFAULT 0,
     chest_granted_at TEXT,
     freeze_consumed INTEGER NOT NULL DEFAULT 0,
     day_source TEXT NOT NULL DEFAULT 'lived'
       CHECK (day_source IN ('lived', 'unlived', 'imported'))
   )`,
  `CREATE TABLE account_daily_xp (
     local_day TEXT NOT NULL,
     ladder_mode TEXT NOT NULL,
     xp_awarded INTEGER NOT NULL DEFAULT 0,
     sessions_counted INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (local_day, ladder_mode)
   )`,
  `CREATE TABLE account_boost (
     grant_id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     multiplier INTEGER NOT NULL,
     duration_minutes INTEGER NOT NULL,
     granted_at TEXT NOT NULL,
     started_at TEXT,
     expires_at TEXT
   )`,
  `CREATE TABLE account_freeze (
     freeze_id TEXT PRIMARY KEY,
     acquired_on_day TEXT NOT NULL,
     consumed_for_day TEXT
   )`,
  `CREATE TABLE account_cosmetic (
     cosmetic_id TEXT PRIMARY KEY,
     purchased_at TEXT NOT NULL,
     price_gems_paid INTEGER NOT NULL
   )`,
  `CREATE TABLE account_quest (
     local_day TEXT NOT NULL,
     quest_id TEXT NOT NULL,
     template_id TEXT NOT NULL,
     target INTEGER NOT NULL,
     progress INTEGER NOT NULL DEFAULT 0,
     completed_at TEXT,
     PRIMARY KEY (local_day, quest_id)
   )`,
  `CREATE TABLE account_monthly_badge (
     month_key TEXT PRIMARY KEY,
     target_quests INTEGER NOT NULL,
     completed_quests INTEGER NOT NULL DEFAULT 0,
     tier TEXT,
     archived_at TEXT
   )`,
  `CREATE TABLE account_personal_record (
     record_kind TEXT PRIMARY KEY,
     value INTEGER NOT NULL,
     achieved_on_day TEXT NOT NULL,
     celebrated_at TEXT
   )`,
  `CREATE TABLE account_streak_repair (
     month_key TEXT PRIMARY KEY,
     repaired_on_day TEXT NOT NULL,
     restored_streak INTEGER NOT NULL
   )`,

  /* ---- course_progress region --------------------------------------------- */
  `CREATE TABLE course_progress (
     course_id TEXT PRIMARY KEY,
     xp INTEGER NOT NULL DEFAULT 0,
     score INTEGER NOT NULL DEFAULT 0,
     score_floor INTEGER NOT NULL DEFAULT 0,
     pack_content_hash TEXT,
     pack_state TEXT NOT NULL DEFAULT 'not-downloaded',
     added_at TEXT NOT NULL,
     CHECK (score >= score_floor)
   )`,
  `CREATE TABLE course_display (
     course_id TEXT PRIMARY KEY
       REFERENCES course_progress(course_id) ON DELETE CASCADE,
     furigana INTEGER NOT NULL DEFAULT 1,
     romaji INTEGER NOT NULL DEFAULT 0,
     script_variant TEXT NOT NULL DEFAULT 'default',
     listening_enabled INTEGER NOT NULL DEFAULT 1,
     speaking_enabled INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE course_node (
     course_id TEXT NOT NULL
       REFERENCES course_progress(course_id) ON DELETE CASCADE,
     node_id TEXT NOT NULL,
     unit_id TEXT NOT NULL,
     section_id TEXT NOT NULL,
     node_type TEXT NOT NULL,
     node_index INTEGER NOT NULL,
     levels_total INTEGER NOT NULL,
     levels_completed INTEGER NOT NULL DEFAULT 0,
     completed_at TEXT,
     legendary_awarded_at TEXT,
     PRIMARY KEY (course_id, node_id)
   )`,
  `CREATE TABLE course_item (
     course_id TEXT NOT NULL
       REFERENCES course_progress(course_id) ON DELETE CASCADE,
     item_id TEXT NOT NULL,
     stability REAL NOT NULL DEFAULT 0,
     difficulty REAL NOT NULL DEFAULT 0,
     due_day TEXT,
     reps INTEGER NOT NULL DEFAULT 0,
     lapses INTEGER NOT NULL DEFAULT 0,
     last_review_day TEXT,
     introduced_at TEXT,
     learned_at TEXT,
     countable INTEGER NOT NULL DEFAULT 1,
     quarantined INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (course_id, item_id)
   )`,
  `CREATE TABLE course_attempt (
     session_id TEXT NOT NULL,
     exercise_index INTEGER NOT NULL,
     course_id TEXT NOT NULL
       REFERENCES course_progress(course_id) ON DELETE CASCADE,
     item_id TEXT NOT NULL,
     exercise_type TEXT NOT NULL,
     verdict TEXT NOT NULL,
     first_try INTEGER NOT NULL,
     answered_at TEXT NOT NULL,
     active_ms INTEGER NOT NULL,
     PRIMARY KEY (session_id, exercise_index)
   )`,
  // Append-only, enforced by the database. "Every counter is recomputable from the
  // attempts" is only true while nothing rewrites one; a trigger says so in the one place
  // no caller can route around.
  `CREATE TRIGGER course_attempt_is_append_only_update
     BEFORE UPDATE ON course_attempt
     BEGIN SELECT RAISE(ABORT, 'course_attempt is append-only'); END`,
  `CREATE TRIGGER course_attempt_is_append_only_delete
     BEFORE DELETE ON course_attempt
     WHEN (SELECT COUNT(*) FROM course_progress WHERE course_id = OLD.course_id) > 0
     BEGIN SELECT RAISE(ABORT, 'course_attempt is append-only'); END`,
  `CREATE TABLE course_mistake (
     course_id TEXT NOT NULL
       REFERENCES course_progress(course_id) ON DELETE CASCADE,
     session_id TEXT NOT NULL,
     exercise_index INTEGER NOT NULL,
     item_id TEXT NOT NULL,
     recycle_count INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     retired_at TEXT,
     PRIMARY KEY (course_id, session_id, exercise_index)
   )`,
  // The resume row. The nine resume columns are SESSION_STATE_RESUME_COLUMNS above, and
  // `schema.test.ts` fails if the table and that list ever disagree.
  `CREATE TABLE course_session_state (
     course_id TEXT NOT NULL
       REFERENCES course_progress(course_id) ON DELETE CASCADE,
     session_kind TEXT NOT NULL,
     node_ref TEXT NOT NULL,
     session_id TEXT NOT NULL,
     flavour TEXT NOT NULL,
     is_graded INTEGER NOT NULL DEFAULT 1,
     boost_multiplier_at_start INTEGER NOT NULL DEFAULT 1,
     boost_expires_at TEXT,
     started_at_monotonic_ms INTEGER NOT NULL,
     checkpoint_at TEXT NOT NULL,
     queue_json TEXT NOT NULL,
     cursor_index INTEGER NOT NULL,
     answers_json TEXT NOT NULL,
     hearts_remaining INTEGER,
     combo INTEGER NOT NULL DEFAULT 0,
     used_interstitial_keys_json TEXT NOT NULL DEFAULT '[]',
     input_mode TEXT NOT NULL,
     hard_mode INTEGER NOT NULL DEFAULT 0,
     option_seeds_json TEXT NOT NULL DEFAULT '{}',
     PRIMARY KEY (course_id, session_kind, node_ref)
   )`,
  // INV-SESS-17's global half: at most one GRADED session in flight, across every course.
  // A partial unique index on a constant makes that the database's problem.
  `CREATE UNIQUE INDEX one_graded_session_in_flight
     ON course_session_state(is_graded) WHERE is_graded = 1`,
] as const;

/* ==================================================================== the gate */

export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly primaryKeyPosition: number;
}

export interface ForeignKeyInfo {
  readonly from: string;
  readonly table: string;
  readonly to: string;
  readonly onDelete: string;
}

export interface TableInfo {
  readonly name: string;
  readonly columns: readonly ColumnInfo[];
  readonly foreignKeys: readonly ForeignKeyInfo[];
}

/** Tables SQLite maintains for itself. Not ours, not regionable. */
const SQLITE_INTERNAL = /^sqlite_/;

/** What the database actually contains, read back through PRAGMA. */
export function describeSchema(db: Db): Map<string, TableInfo> {
  const tables = db
    .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .map((row) => row.name)
    .filter((name) => !SQLITE_INTERNAL.test(name));

  const out = new Map<string, TableInfo>();
  for (const name of tables) {
    // PRAGMA takes no bound parameters; `name` comes from sqlite_master, never a user.
    const columns = db
      .all<{ name: string; type: string; notnull: number; pk: number }>(
        `PRAGMA table_info(${quoteIdent(name)})`,
      )
      .map((row) => ({
        name: row.name,
        type: row.type,
        notNull: row.notnull === 1,
        primaryKeyPosition: row.pk,
      }));
    const foreignKeys = db
      .all<{ from: string; table: string; to: string; on_delete: string }>(
        `PRAGMA foreign_key_list(${quoteIdent(name)})`,
      )
      .map((row) => ({
        from: row.from,
        table: row.table,
        to: row.to,
        onDelete: row.on_delete,
      }));
    out.set(name, { name, columns, foreignKeys });
  }
  return out;
}

/** SQLite identifier quoting. Doubling `"` is the whole escape. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * INV-ECO-04, executable.
 *
 * Returns one string per violation; an empty array is the invariant holding. Six ways a
 * table can straddle the regions, all of them silent in review:
 */
export function regionViolations(db: Db): string[] {
  const actual = describeSchema(db);
  const declared = new Map(PROGRESS_TABLES.map((spec) => [spec.name, spec] as const));
  const violations: string[] = [];

  for (const name of actual.keys()) {
    if (name === 'committed_session') continue; // P0's ledger, region-free by design.
    if (!declared.has(name)) {
      violations.push(`table ${name} exists but declares no region in PROGRESS_TABLES`);
    }
  }

  for (const spec of PROGRESS_TABLES) {
    const info = actual.get(spec.name);
    if (info === undefined) {
      violations.push(`table ${spec.name} is declared ${spec.region} but no migration creates it`);
      continue;
    }
    const courseColumn = info.columns.find((column) => column.name === 'course_id');
    const cascade = info.foreignKeys.find(
      (fk) => fk.table === 'course_progress' && fk.from === 'course_id',
    );

    if (spec.region === 'account') {
      if (courseColumn !== undefined) {
        violations.push(`account-region table ${spec.name} carries a course_id column`);
      }
      if (info.foreignKeys.some((fk) => fk.table === 'course_progress')) {
        violations.push(`account-region table ${spec.name} references course_progress`);
      }
      continue;
    }

    if (courseColumn === undefined) {
      violations.push(`course-region table ${spec.name} has no course_id column`);
      continue;
    }
    // `course_progress` itself is the region root: it IS the referenced table.
    if (spec.name === 'course_progress') {
      if (courseColumn.primaryKeyPosition !== 1) {
        violations.push(`course_progress.course_id must be the primary key`);
      }
      continue;
    }
    if (!courseColumn.notNull && courseColumn.primaryKeyPosition === 0) {
      violations.push(`course-region table ${spec.name} has a nullable course_id`);
    }
    if (cascade === undefined) {
      violations.push(`course-region table ${spec.name} does not reference course_progress`);
    } else if (cascade.onDelete !== 'CASCADE') {
      violations.push(
        `course-region table ${spec.name} references course_progress ON DELETE ${cascade.onDelete}, not CASCADE`,
      );
    }
  }

  return violations.sort();
}

/** Column names of one table, in declaration order. */
export function columnNames(db: Db, table: string): string[] {
  return (
    describeSchema(db)
      .get(table)
      ?.columns.map((column) => column.name) ?? []
  );
}
