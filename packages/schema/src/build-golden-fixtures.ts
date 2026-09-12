/**
 * Builds the golden-DB corpus: one `.db` per shipped `user_version`, plus the committed
 * expectation of what each becomes after migrating forward.
 *
 *   FREELINGO_REBUILD_GOLDEN=1 pnpm vitest run --project schema -t 'rebuild the golden'
 *
 * Through vitest rather than `node --experimental-strip-types`, because Node does not
 * resolve a `.js` specifier onto a `.ts` file and every import in this package is written
 * that way (probed 2026-09-11: `ERR_MODULE_NOT_FOUND .../testkit/src/zones.js`).
 *
 * Run it ONLY when a new `user_version` ships. Re-running it after changing a migration
 * rewrites the expectations, which is the one way to make `golden.test.ts` agree with a
 * broken migration — so the diff it produces is the thing a reviewer reads.
 *
 * Everything here is deterministic: fixed ids, fixed timestamps, no clock, no randomness.
 * A rebuild that changes a byte for no reason would make every future diff unreadable.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeDb } from '@freelingo/testkit';
import type { Db } from './db.js';
import { MIGRATIONS, migrate } from './migrations.js';
import { dumpProgress } from './golden.js';

export const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/golden/', import.meta.url));

/** The pre-migration case: a file that exists and has never been migrated. */
export const V0_FIXTURE = 'v0-fresh.db';

export function fixtureName(userVersion: number): string {
  return `v${userVersion}.db`;
}

export function expectationName(fixture: string): string {
  return `${fixture.replace(/\.db$/, '')}.expected.json`;
}

/** Migrate up to (and including) `userVersion`, and no further. */
function migrateTo(db: Db, userVersion: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.userVersion > userVersion) break;
    db.withExclusiveTransaction(() => {
      migration.up(db);
      db.run(`PRAGMA user_version = ${migration.userVersion}`);
    });
  }
}

/* --------------------------------------------------------------- the fixture data */

/** v1 is P0's schema: a two-column account and the committed-session ledger. */
function seedV1(db: Db): void {
  db.run('UPDATE account SET xp = 1830, gems = 515 WHERE id = 1');
  for (let i = 1; i <= 4; i += 1) {
    db.run('INSERT INTO committed_session (session_id, committed_at) VALUES (?, ?)', [
      `s_v1_${i}`,
      `2026-08-0${i}T18:30:00Z`,
    ]);
  }
}

/**
 * v2 carries the shape INV-PACK-35 names: **40 completed nodes**, two courses, account
 * counters with non-zero values, and FSRS rows that a major pack bump will strand.
 */
function seedV2(db: Db): void {
  db.run(
    `UPDATE account SET lifetime_xp = 4210, gems = 515, streak = 37, longest_streak = 41,
       streak_start_day = '2026-08-06', max_local_day_seen = '2026-09-11',
       daily_goal_xp = 20, daily_goal_tier = 'regular',
       words_introduced = 412, words_learned = 260, perfect_lessons = 31,
       nodes_completed = 40, units_legendary = 3, sections_completed = 1,
       guidebook_then_lesson = 2, weekend_pairs = 4, stories_completed = 7,
       night_lessons = 12, items_retired = 88, legendary_levels_earned = 17
     WHERE id = 1`,
  );
  // One freeze per acquisition channel (S121), including the `one_time` subtype, so the
  // corpus carries every shape of the row the FRZ task will read.
  db.run(
    'INSERT INTO account_freeze (freeze_id, acquired_on_day, acquired_via, subtype) VALUES (?, ?, ?, ?)',
    ['fz_1', '2026-09-01', 'streak_freeze_refill', 'standard'],
  );
  db.run(
    `INSERT INTO account_freeze (freeze_id, acquired_on_day, acquired_via, subtype, consumed_for_day)
     VALUES (?, ?, ?, ?, ?)`,
    ['fz_2', '2026-08-20', 'milestone_grant', 'standard', '2026-08-29'],
  );
  db.run(
    'INSERT INTO account_freeze (freeze_id, acquired_on_day, acquired_via, subtype) VALUES (?, ?, ?, ?)',
    ['fz_3', '2026-08-10', 'reward_chest', 'one_time'],
  );
  db.run(
    `INSERT INTO account_day (local_day, goal_xp, earned_xp, goal_met, chest_granted_at)
     VALUES (?, ?, ?, ?, ?)`,
    ['2026-09-10', 20, 34, 1, '2026-09-10T21:04:00Z'],
  );
  db.run(
    'INSERT INTO account_daily_xp (local_day, ladder_mode, xp_awarded, sessions_counted) VALUES (?, ?, ?, ?)',
    ['2026-09-10', 'lesson', 34, 3],
  );
  db.run(
    `INSERT INTO account_quest (local_day, quest_id, template_id, target, progress, completed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['2026-09-10', 'q1', 'earn-xp', 30, 34, '2026-09-10T21:04:00Z'],
  );
  db.run(
    'INSERT INTO account_monthly_badge (month_key, target_quests, completed_quests, tier) VALUES (?, ?, ?, ?)',
    ['2026-09', 15, 9, null],
  );
  db.run(
    'INSERT INTO account_personal_record (record_kind, value, achieved_on_day, celebrated_at) VALUES (?, ?, ?, ?)',
    ['most_xp_in_a_day', 140, '2026-08-30', '2026-08-30T22:00:00Z'],
  );
  db.run(
    'INSERT INTO account_cosmetic (cosmetic_id, purchased_at, price_gems_paid) VALUES (?, ?, ?)',
    ['cosmetic-scarf-red', '2026-08-15T12:00:00Z', 150],
  );
  // A HELD grant (inventory: no activation columns yet) and a RUNNING one carrying the
  // EC-ECO-39 rewind-clamp columns, so the corpus exercises both shapes of the row.
  db.run(
    `INSERT INTO account_boost (grant_id, kind, multiplier, duration_minutes, duration_seconds, granted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['bg_1', 'xpBoost', 2, 15, 900, '2026-09-09T08:00:00Z'],
  );
  db.run(
    `INSERT INTO account_boost (grant_id, kind, multiplier, duration_minutes, duration_seconds,
       granted_at, activated_at_utc, activation_sequence_ms, tamper_high_water_utc, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'bg_2',
      'xpBoost',
      2,
      30,
      1800,
      '2026-09-10T18:00:00Z',
      '2026-09-10T18:00:00Z',
      4_200_000,
      '2026-09-10T18:06:00Z',
      '2026-09-10T18:30:00Z',
    ],
  );

  for (const [courseId, xp, score] of [
    ['en-es', 3800, 74],
    ['en-fr', 410, 11],
  ] as const) {
    db.run(
      'INSERT INTO course_progress (course_id, xp, score, score_floor, pack_content_hash, pack_state, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [courseId, xp, score, score - 4, `hash_${courseId}_v1`, 'installed', '2026-08-01T09:00:00Z'],
    );
    db.run('INSERT INTO course_display (course_id) VALUES (?)', [courseId]);
  }
  db.run('UPDATE course_display SET furigana = 0, romaji = 1 WHERE course_id = ?', ['en-fr']);

  // 40 completed nodes in the Spanish course. The number is INV-PACK-35's own falsifier
  // ("migrate a fixture with 40 completed nodes").
  for (let i = 0; i < 40; i += 1) {
    const index = String(i).padStart(3, '0');
    db.run(
      `INSERT INTO course_node (course_id, node_id, unit_id, section_id, node_type, node_index,
         levels_total, levels_completed, completed_at, legendary_awarded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'en-es',
        `n_${index}`,
        `u_${String(Math.floor(i / 8)).padStart(2, '0')}`,
        's_00',
        i % 8 === 7 ? 'chest' : 'lesson',
        i,
        3,
        3,
        `2026-08-${String((i % 28) + 1).padStart(2, '0')}T19:00:00Z`,
        i % 13 === 0 ? `2026-08-${String((i % 28) + 1).padStart(2, '0')}T19:30:00Z` : null,
      ],
    );
  }
  // One node in progress, so "no completed node becomes incomplete" is not vacuously true
  // of a database where every node is complete.
  db.run(
    `INSERT INTO course_node (course_id, node_id, unit_id, section_id, node_type, node_index,
       levels_total, levels_completed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['en-es', 'n_040', 'u_05', 's_00', 'lesson', 40, 3, 1],
  );

  for (let i = 0; i < 24; i += 1) {
    const index = String(i).padStart(2, '0');
    db.run(
      `INSERT INTO course_item (course_id, item_id, stability, difficulty, due_day, reps, lapses,
         last_review_day, introduced_at, learned_at, countable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'en-es',
        `it_es_${index}`,
        1 + i * 0.5,
        5 + (i % 4),
        '2026-09-14',
        3 + (i % 5),
        i % 3,
        '2026-09-08',
        '2026-08-02T10:00:00Z',
        i % 2 === 0 ? '2026-08-20T10:00:00Z' : null,
        i % 7 === 0 ? 0 : 1,
      ],
    );
  }

  for (let i = 0; i < 6; i += 1) {
    db.run(
      `INSERT INTO course_attempt (session_id, exercise_index, course_id, item_id, exercise_type,
         verdict, first_try, answered_at, active_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        's_golden_1',
        i,
        'en-es',
        `it_es_${String(i).padStart(2, '0')}`,
        i % 2 === 0 ? 'typedTranslate' : 'matchPairs',
        i === 3 ? 'incorrect' : 'correct',
        1,
        `2026-09-10T20:0${i}:00Z`,
        4000 + i * 250,
      ],
    );
  }
  db.run(
    `INSERT INTO course_mistake (course_id, session_id, exercise_index, item_id, recycle_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['en-es', 's_golden_1', 3, 'it_es_03', 1, '2026-09-10T20:03:00Z'],
  );
  db.run(
    `INSERT INTO course_session_state (course_id, session_kind, node_ref, session_id, flavour,
       is_graded, boost_multiplier_at_start, started_at_monotonic_ms, checkpoint_at,
       queue_json, cursor_index, answers_json, hearts_remaining, combo,
       used_interstitial_keys_json, input_mode, hard_mode, option_seeds_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'en-fr',
      'lesson',
      'n_003',
      's_parked_1',
      'lesson',
      1,
      2,
      812_344,
      '2026-09-11T07:45:00Z',
      '[{"itemId":"it_fr_01"},{"itemId":"it_fr_02"}]',
      1,
      '[{"verdict":"correct"}]',
      null,
      2,
      '["combo_2"]',
      'tap',
      0,
      '{"it_fr_02":[2,0,1,3]}',
    ],
  );
  // INV-ECO-20: the ledger row carries its own non-null `active_ms`, not a figure some
  // later query derives from `committed_at` differences.
  db.run(
    `INSERT INTO committed_session (session_id, committed_at, active_ms, xp_awarded, local_day, flavour)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['s_golden_1', '2026-09-10T20:06:00Z', 214_000, 14, '2026-09-10', 'lesson'],
  );
}

const SEEDS: Readonly<Record<number, (db: Db) => void>> = {
  1: seedV1,
  2: seedV2,
};

/* ------------------------------------------------------------------------ build */

export function buildFixtures(): string[] {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const written: string[] = [];

  // v0: a file that exists and has never been migrated.
  const fresh = createNodeDb({ location: join(FIXTURE_DIR, V0_FIXTURE) });
  fresh.run('CREATE TABLE IF NOT EXISTS placeholder (id INTEGER PRIMARY KEY)');
  fresh.run('DROP TABLE placeholder');
  fresh.close();
  written.push(V0_FIXTURE);

  for (const migration of MIGRATIONS) {
    const name = fixtureName(migration.userVersion);
    const db = createNodeDb({ location: join(FIXTURE_DIR, name) });
    migrateTo(db, migration.userVersion);
    SEEDS[migration.userVersion]?.(db);
    db.close();
    written.push(name);
  }

  // The expectation of each fixture: what it looks like after migrating all the way up.
  for (const name of written) {
    const scratch = join(FIXTURE_DIR, `.building-${name}`);
    copyDb(join(FIXTURE_DIR, name), scratch);
    const db = createNodeDb({ location: scratch });
    migrate(db);
    const dump = dumpProgress(db);
    db.close();
    writeFileSync(
      join(FIXTURE_DIR, expectationName(name)),
      `${JSON.stringify(dump, null, 2)}\n`,
      'utf8',
    );
    rmSync(scratch, { force: true });
  }

  return written;
}

function copyDb(from: string, to: string): void {
  // `VACUUM INTO` rather than a file copy: it produces one self-contained file with no
  // WAL or journal sidecar to remember to copy alongside it.
  const source = createNodeDb({ location: from });
  rmSync(to, { force: true });
  source.run(`VACUUM INTO ?`, [to]);
  source.close();
}

export { copyDb };
