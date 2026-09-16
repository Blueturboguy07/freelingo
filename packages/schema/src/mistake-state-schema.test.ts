import { afterEach, expect, it } from 'vitest';
import { createNodeDb } from '@freelingo/testkit';
import { migrate, MIGRATIONS, currentUserVersion, LATEST_USER_VERSION } from './migrations.js';
import { regionViolations } from './progress-schema.js';
import type { Db } from './db.js';
const opened: Db[] = [];
afterEach(() => {
  opened.forEach((db) => db.close());
  opened.length = 0;
});
function setup() {
  const db = createNodeDb();
  opened.push(db);
  migrate(db);
  db.run(
    "INSERT INTO course_progress(course_id,added_at) VALUES('en-es','2026-09-13'),('en-fr','2026-09-13')",
  );
  return db;
}
function attempt(
  db: Db,
  wrong = true,
  child = 'child',
  grade = wrong ? 1 : 3,
  verdict = wrong ? 'wrong' : 'correct',
  session = 'session',
) {
  db.run(
    "INSERT INTO course_attempt(course_id,session_id,exercise_index,item_id,exercise_type,verdict,first_try,answered_at,slot_id,queue,soft_corrected,cost_paid,skipped,scorable,note,attempt_sequence,exercise_id,pack_content_hash,active_ms) VALUES('en-es',?,0,'aggregate','matchPairs',?,1,'2026-09-13T12:00:00.000Z','slot','main',0,?,0,1,NULL,(SELECT COALESCE(MAX(attempt_sequence),-1)+1 FROM course_attempt WHERE course_id='en-es'),'exercise',?,0)",
    [session, verdict, wrong ? 1 : 0, 'a'.repeat(64)],
  );
  db.run(
    "INSERT INTO course_attempt_target VALUES('en-es',?,0,?,'surface','gato','recognition',0,?,0,'scheduled',1789300800000)",
    [session, child, grade],
  );
}
function state(db: Db, course = 'en-es', item = 'child') {
  db.run(
    "INSERT INTO course_mistake_state(course_id,item_id,concept_id,created_in_session_id,created_exercise_index,source_exercise_id,pack_content_hash,review_streak,misses,last_missed_at_utc_ms,last_missed_local_day,retired_at_utc_ms,last_sequence) VALUES(?,?,'concept','session',0,'exercise',?,0,1,1789300800000,'2026-09-13',NULL,0)",
    [course, item, 'a'.repeat(64)],
  );
}
function event(db: Db, correct = false, session = 'session', sequence = 0, creates = true) {
  db.run(
    "INSERT INTO course_mistake_encounter(course_id,item_id,sequence,session_id,exercise_index,target_surface_id,exercise_id,pack_content_hash,concept_id,correct,creates_mistake,answered_at_utc_ms,local_day) VALUES('en-es','child',?,?,0,'surface','exercise',?,'concept',?,?,1789300800000,'2026-09-13')",
    [sequence, session, 'a'.repeat(64), Number(correct), Number(creates)],
  );
}
it('[INV-MIS-04][INV-PER-03] durable mistake cache and encounters require actual same-course wrong source/target receipts', () => {
  const db = setup();
  expect(() => state(db)).toThrow();
  attempt(db);
  event(db);
  state(db);
  expect(db.get('SELECT review_streak FROM course_mistake_state')?.review_streak).toBe(0);
  expect(() => state(db, 'en-fr')).toThrow();
  expect(() => state(db, 'en-es', 'untapped')).toThrow();
});
it('[INV-MIS-04] a correct parent or correct target cannot originate a new mistake', () => {
  const a = setup();
  attempt(a, false);
  expect(() => state(a)).toThrow();
  expect(() => event(a, true)).toThrow();
  const b = setup();
  attempt(b, true, 'child', 3);
  expect(() => state(b)).toThrow();
  expect(() => event(b)).toThrow();
});
it('[INV-MIS-04][INV-PER-03] normalized retention cannot accept source mismatch or impossible cache counters', () => {
  const db = setup();
  attempt(db);
  event(db);
  state(db);
  for (const sql of [
    "UPDATE course_mistake_state SET source_exercise_id='other'",
    'UPDATE course_mistake_state SET review_streak=2',
    'UPDATE course_mistake_state SET review_streak=-1',
    'UPDATE course_mistake_state SET misses=0',
    'UPDATE course_mistake_state SET last_sequence=0.5',
    'UPDATE course_mistake_state SET retired_at_utc_ms=1',
  ])
    expect(() => db.run(sql)).toThrow();
});
it('[INV-MIS-04][INV-PER-03] mistake encounter receipts are append-only and course removal cascades while legacy rows are untouched', () => {
  const db = setup();
  attempt(db);
  db.run(
    "INSERT INTO course_mistake(course_id,session_id,exercise_index,item_id,created_at) VALUES('en-es','legacy',8,'old','2020-01-01')",
  );
  const old = db.all('SELECT * FROM course_mistake');
  event(db);
  state(db);
  expect(() => db.run('UPDATE course_mistake_encounter SET correct=1')).toThrow();
  expect(() => db.run('DELETE FROM course_mistake_encounter')).toThrow();
  expect(() => event(db)).toThrow();
  expect(db.all('SELECT * FROM course_mistake')).toEqual(old);
  db.run("DELETE FROM course_progress WHERE course_id='en-es'");
  expect(db.all('SELECT * FROM course_mistake_state')).toEqual([]);
  expect(db.all('SELECT * FROM course_mistake_encounter')).toEqual([]);
});

it('[INV-PER-03] killed v12 DDL retains exact legacy rows and version until retry succeeds', () => {
  const db = createNodeDb();
  opened.push(db);
  for (const m of MIGRATIONS.filter((m) => m.userVersion < 12))
    db.withExclusiveTransaction(() => {
      m.up(db);
      db.run(`PRAGMA user_version=${m.userVersion}`);
    });
  db.run("INSERT INTO course_progress(course_id,added_at) VALUES('en-es','2026-09-13')");
  db.run(
    "INSERT INTO course_mistake(course_id,session_id,exercise_index,item_id,created_at) VALUES('en-es','old',2,'word','2020-01-01')",
  );
  const old = db.all('SELECT * FROM course_mistake');
  expect(() =>
    migrate({
      ...db,
      run(sql, params) {
        db.run(sql, params);
        if (sql.startsWith('CREATE TABLE course_mistake_state')) throw new Error('kill v12');
      },
    }),
  ).toThrow('kill v12');
  expect(currentUserVersion(db)).toBe(11);
  expect(
    db.get("SELECT name FROM sqlite_master WHERE name='course_mistake_encounter'"),
  ).toBeUndefined();
  expect(db.all('SELECT * FROM course_mistake')).toEqual(old);
  migrate(db);
  expect(currentUserVersion(db)).toBe(LATEST_USER_VERSION);
  expect(regionViolations(db)).toEqual([]);
  expect(db.all('SELECT * FROM course_mistake_state')).toEqual([]);
  expect(db.all('SELECT * FROM course_mistake')).toEqual(old);
});

it.each(['noVerdict', 'correct-origin'] as const)(
  '[INV-MIS-04] parent verdict cannot fabricate mistake evidence: %s',
  (fault) => {
    const db = setup();
    if (fault === 'noVerdict') {
      attempt(db);
      event(db);
      state(db);
      attempt(db, false, 'child', 3, 'noVerdict', 'ungraded');
      expect(() => event(db, true, 'ungraded', 1, false)).toThrow(/graded target/);
    } else {
      attempt(db, false, 'child', 1, 'correct');
      expect(() => event(db, false)).toThrow(/graded target/);
    }
  },
);

it('[INV-MIS-04] an actual accepted parent may review an existing mistake but cannot create one', () => {
  const db = setup();
  attempt(db);
  event(db);
  state(db);
  attempt(db, false, 'child', 3, 'accepted', 'open-response');
  event(db, true, 'open-response', 1, false);
  expect(db.all('SELECT * FROM course_mistake_encounter')).toHaveLength(2);
  const fresh = setup();
  attempt(fresh, false, 'child', 3, 'accepted');
  expect(() => event(fresh, true)).toThrow();
});
