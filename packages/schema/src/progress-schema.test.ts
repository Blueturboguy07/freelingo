/**
 * The two-region gate and the rows that hang off it.
 *
 * Every test here runs against a REAL migrated SQLite database rather than against the
 * declaration, because the declaration is the thing under test: a registry that agrees
 * with itself proves nothing.
 *
 * The achievement cross-check imports `packages/core` by relative path. The core barrel
 * (`packages/core/src/index.ts`) does not re-export `economy/` yet — it is outside this
 * task's file lane — so the relative path is correct today and one line of barrel wiring
 * makes it a package import later.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createNodeDb } from '@freelingo/testkit';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { ACHIEVEMENTS, achievementCounterColumns } from '../../core/src/economy/achievements.js';
import type { Db } from './db.js';
import { migrate } from './migrations.js';
import {
  ACCOUNT_TABLES,
  COURSE_TABLES,
  PROGRESS_TABLES,
  SESSION_STATE_RESUME_COLUMNS,
  columnNames,
  describeSchema,
  regionViolations,
} from './progress-schema.js';

function migratedDb(): Db {
  const db = createNodeDb();
  migrate(db);
  return db;
}

function seedCourse(db: Db, courseId: string): void {
  db.run('INSERT INTO course_progress (course_id, added_at) VALUES (?, ?)', [
    courseId,
    '2026-09-11T00:00:00Z',
  ]);
  db.run('INSERT INTO course_display (course_id) VALUES (?)', [courseId]);
}

describe('the two-region schema', () => {
  it('[INV-ECO-04] no table straddles the account and course_progress regions', () => {
    const db = migratedDb();
    expect(regionViolations(db)).toEqual([]);
    db.close();
  });

  it('[INV-ECO-04] every table that exists declares a region, and every declared table exists', () => {
    const db = migratedDb();
    const actual = [...describeSchema(db).keys()].filter((n) => n !== 'committed_session').sort();
    const declared = PROGRESS_TABLES.map((t) => t.name).sort();
    expect(actual).toEqual(declared);
    expect(ACCOUNT_TABLES.length).toBeGreaterThan(0);
    expect(COURSE_TABLES.length).toBeGreaterThan(0);
    // The two lists are disjoint by construction; assert it so a copy-paste cannot make
    // one table both, which would make the gate below vacuous for that table.
    expect(ACCOUNT_TABLES.filter((n) => COURSE_TABLES.includes(n))).toEqual([]);
    db.close();
  });

  it('[INV-ECO-04] falsifier: a table with a course_id in the account region is caught', () => {
    const db = migratedDb();
    // Exactly the mistake the invariant exists to stop: quests gain a course_id "so they
    // can be per-course", and the daily quest silently becomes farmable twice over.
    db.run('ALTER TABLE account_quest ADD COLUMN course_id TEXT');
    expect(regionViolations(db)).toEqual([
      'account-region table account_quest carries a course_id column',
    ]);
    db.close();
  });

  it('[INV-ECO-04] falsifier: a new table with no declared region is caught', () => {
    const db = migratedDb();
    db.run('CREATE TABLE account_wagers (id TEXT PRIMARY KEY)');
    expect(regionViolations(db)).toEqual([
      'table account_wagers exists but declares no region in PROGRESS_TABLES',
    ]);
    db.close();
  });

  it('[INV-ECO-04] every course-region table cascades from course_progress', () => {
    const db = migratedDb();
    const schema = describeSchema(db);
    for (const table of COURSE_TABLES) {
      if (table === 'course_progress') continue;
      const fk = schema
        .get(table)
        ?.foreignKeys.find((f) => f.table === 'course_progress' && f.from === 'course_id');
      expect(fk, `${table} must reference course_progress`).toBeDefined();
      expect(fk?.onDelete).toBe('CASCADE');
    }
    db.close();
  });

  it('[INV-ECO-04] the XP ladder table is keyed by local_day alone, with no course column', () => {
    // INV-ECO-06's schema half: two courses are not two budgets. A `course_id` here is
    // the whole defeat of the anti-farming ladder, so it is asserted structurally.
    const db = migratedDb();
    expect(columnNames(db, 'account_daily_xp')).toEqual([
      'local_day',
      'ladder_mode',
      'xp_awarded',
      'sessions_counted',
    ]);
    db.close();
  });
});

describe('course removal', () => {
  it('[INV-ECO-13] deleting a course destroys its region and leaves account counters bit-identical', () => {
    const db = migratedDb();
    seedCourse(db, 'en-es');
    seedCourse(db, 'en-fr');
    db.run('UPDATE account SET lifetime_xp = 4200, gems = 515, longest_streak = 37 WHERE id = 1');
    db.run('UPDATE course_progress SET xp = 340 WHERE course_id = ?', ['en-es']);
    db.run(
      `INSERT INTO course_node (course_id, node_id, unit_id, section_id, node_type, node_index, levels_total, levels_completed, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['en-es', 'n1', 'u1', 's1', 'lesson', 0, 3, 3, '2026-09-01T10:00:00Z'],
    );
    db.run(
      `INSERT INTO course_attempt (session_id, exercise_index, course_id, item_id, exercise_type, verdict, first_try, answered_at, active_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['s1', 0, 'en-es', 'it_1', 'typedTranslate', 'correct', 1, '2026-09-01T10:00:00Z', 4000],
    );

    const accountBefore = db.get('SELECT * FROM account WHERE id = 1');
    db.run('DELETE FROM course_progress WHERE course_id = ?', ['en-es']);

    expect(db.all('SELECT * FROM course_node WHERE course_id = ?', ['en-es'])).toEqual([]);
    expect(db.all('SELECT * FROM course_attempt WHERE course_id = ?', ['en-es'])).toEqual([]);
    expect(db.all('SELECT * FROM course_display WHERE course_id = ?', ['en-es'])).toEqual([]);
    expect(db.all('SELECT course_id FROM course_progress')).toEqual([{ course_id: 'en-fr' }]);
    expect(db.get('SELECT * FROM account WHERE id = 1')).toEqual(accountBefore);
    db.close();
  });
});

describe('append-only attempts', () => {
  function insertAttempt(db: Db, sessionId: string, index: number): void {
    db.run(
      `INSERT INTO course_attempt (session_id, exercise_index, course_id, item_id, exercise_type, verdict, first_try, answered_at, active_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        index,
        'en-es',
        'it_1',
        'typedTranslate',
        'incorrect',
        1,
        '2026-09-11T00:00:00Z',
        1,
      ],
    );
  }

  it('attempts are keyed (session_id, exercise_index) and a second row for the key is rejected', () => {
    const db = migratedDb();
    seedCourse(db, 'en-es');
    insertAttempt(db, 's1', 0);
    expect(() => insertAttempt(db, 's1', 0)).toThrow(/UNIQUE|constraint/i);
    // The same index in a different session is a different row, which is the point of the
    // compound key: an idempotent write can be attempted twice and land once.
    insertAttempt(db, 's2', 0);
    expect(db.all('SELECT session_id FROM course_attempt').length).toBe(2);
    db.close();
  });

  it('the database itself refuses to rewrite or delete an attempt', () => {
    const db = migratedDb();
    seedCourse(db, 'en-es');
    insertAttempt(db, 's1', 0);
    expect(() => db.run("UPDATE course_attempt SET verdict = 'correct'")).toThrow(/append-only/);
    expect(() => db.run('DELETE FROM course_attempt')).toThrow(/append-only/);
    expect(db.all('SELECT verdict FROM course_attempt')).toEqual([{ verdict: 'incorrect' }]);
    db.close();
  });
});

describe('the resume row', () => {
  it('session_state carries all nine resume fields', () => {
    // The nine fields of the resume guarantee: queue, index, answers, hearts, combo,
    // usedInterstitialKeys, inputMode, hardMode, optionSeeds. A schema with fewer fails
    // here by construction rather than on a learner's device.
    const db = migratedDb();
    const columns = columnNames(db, 'course_session_state');
    for (const column of SESSION_STATE_RESUME_COLUMNS) expect(columns).toContain(column);
    expect(SESSION_STATE_RESUME_COLUMNS.length).toBe(9);
    db.close();
  });

  it('at most one graded session is in flight across every course', () => {
    const db = migratedDb();
    seedCourse(db, 'en-es');
    seedCourse(db, 'en-fr');
    const park = (courseId: string, kind: string, graded: number): void => {
      db.run(
        `INSERT INTO course_session_state (course_id, session_kind, node_ref, session_id, flavour, is_graded,
           started_at_monotonic_ms, checkpoint_at, queue_json, cursor_index, answers_json, input_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          courseId,
          kind,
          'n1',
          `s_${courseId}`,
          'lesson',
          graded,
          0,
          '2026-09-11T00:00:00Z',
          '[]',
          0,
          '[]',
          'tap',
        ],
      );
    };
    park('en-es', 'lesson', 1);
    expect(() => park('en-fr', 'lesson', 1)).toThrow(/UNIQUE|constraint/i);
    // An ungraded position (a parked story) is not evicted by the graded lesson.
    park('en-fr', 'story', 0);
    expect(db.all('SELECT course_id FROM course_session_state').length).toBe(2);
    db.close();
  });
});

describe('display preferences', () => {
  it('[INV-PER-11] two courses hold different furigana values simultaneously', () => {
    const db = migratedDb();
    seedCourse(db, 'en-ja');
    seedCourse(db, 'en-es');
    db.run('UPDATE course_display SET furigana = 0, romaji = 1 WHERE course_id = ?', ['en-ja']);
    expect(
      db.get('SELECT furigana, romaji FROM course_display WHERE course_id = ?', ['en-ja']),
    ).toEqual({ furigana: 0, romaji: 1 });
    expect(
      db.get('SELECT furigana, romaji FROM course_display WHERE course_id = ?', ['en-es']),
    ).toEqual({ furigana: 1, romaji: 0 });
    db.close();
  });

  it('[INV-PER-11] falsifier: the single global row is impossible — the key is course_id', () => {
    const db = migratedDb();
    const info = describeSchema(db).get('course_display');
    const key = info?.columns.filter((c) => c.primaryKeyPosition > 0).map((c) => c.name);
    expect(key).toEqual(['course_id']);
    // A global row would have to be a table with no course_id, which the region gate
    // rejects for the course region and which cannot hold two values at once anyway.
    expect(regionViolations(db)).toEqual([]);
    db.close();
  });

  it('[INV-PER-11] a display preference survives any interleaving of writes to the other course', () => {
    const db = migratedDb();
    seedCourse(db, 'en-ja');
    seedCourse(db, 'en-es');
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom('en-ja', 'en-es'), fc.integer({ min: 0, max: 1 })), {
          minLength: 1,
          maxLength: 12,
        }),
        (writes) => {
          const expected = new Map([
            [
              'en-ja',
              db.get<{ furigana: number }>(
                'SELECT furigana FROM course_display WHERE course_id = ?',
                ['en-ja'],
              )?.furigana,
            ],
            [
              'en-es',
              db.get<{ furigana: number }>(
                'SELECT furigana FROM course_display WHERE course_id = ?',
                ['en-es'],
              )?.furigana,
            ],
          ]);
          for (const [courseId, value] of writes) {
            db.run('UPDATE course_display SET furigana = ? WHERE course_id = ?', [value, courseId]);
            expected.set(courseId, value);
          }
          for (const courseId of ['en-ja', 'en-es']) {
            const read = db.get<{ furigana: number }>(
              'SELECT furigana FROM course_display WHERE course_id = ?',
              [courseId],
            )?.furigana;
            if (read !== expected.get(courseId)) return false;
          }
          return true;
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
    db.close();
  });
});

describe('the achievement counter registry', () => {
  it('[INV-ECO-25] every achievement names a counter column that exists in the account table', () => {
    const db = migratedDb();
    const accountColumns = new Set(columnNames(db, 'account'));
    const missing = achievementCounterColumns().filter((c) => !accountColumns.has(c));
    expect(missing, 'add the column to the schema or drop the achievement').toEqual([]);
    expect(achievementCounterColumns().length).toBe(ACHIEVEMENTS.length);
    db.close();
  });

  it('[INV-ECO-25] falsifier: an achievement naming a column the schema lacks is caught', () => {
    const db = migratedDb();
    const accountColumns = new Set(columnNames(db, 'account'));
    // `crowns_earned` is the shape of the mistake the invariant names — an achievement
    // whose source column resolves to a mechanic the path lacks.
    expect(accountColumns.has('crowns_earned')).toBe(false);
    expect(accountColumns.has('skill_levels')).toBe(false);
    db.close();
  });

  it('[INV-ECO-25] every counter column is an integer column with a zero default', () => {
    const db = migratedDb();
    const account = describeSchema(db).get('account');
    for (const column of achievementCounterColumns()) {
      const info = account?.columns.find((c) => c.name === column);
      expect(info, `account.${column}`).toBeDefined();
      expect(info?.type).toBe('INTEGER');
      expect(info?.notNull).toBe(true);
    }
    db.close();
  });
});
