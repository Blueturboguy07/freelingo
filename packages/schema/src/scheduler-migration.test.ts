import { describe, expect, it } from 'vitest';
import { createNodeDb } from '@freelingo/testkit';
import { MIGRATIONS, currentUserVersion, migrate } from './migrations.js';
import { columnNames, regionViolations } from './progress-schema.js';
import type { Db } from './db.js';

function legacy() {
  const db = createNodeDb();
  for (const migration of MIGRATIONS.filter((entry) => entry.userVersion <= 4)) {
    db.withExclusiveTransaction(() => {
      migration.up(db);
      db.run(`PRAGMA user_version = ${migration.userVersion}`);
    });
  }
  db.run('UPDATE account SET lifetime_xp=321, gems=42');
  db.run("INSERT INTO course_progress(course_id,added_at) VALUES ('en-es','2026-09-13')");
  db.run(
    "INSERT INTO course_item(course_id,item_id,stability,due_day) VALUES ('en-es','memory-a',8.5,'2026-09-20')",
  );
  db.run(`INSERT INTO course_attempt(session_id,exercise_index,course_id,item_id,exercise_type,verdict,first_try,answered_at,active_ms)
    VALUES ('old',-1,'en-es','memory-a','typedTranslate','correct',0,'2026-09-13T12:00:00Z',1234)`);
  return db;
}
function insertSurface(db: Db, surface = 'hablo') {
  db.run(
    `INSERT INTO course_item_surface(course_id,item_id,surface,kind,due_utc_ms,last_review_utc_ms,stability,difficulty,elapsed_days,scheduled_days,learning_steps,reps,lapses,state,retrievability,introduced_at_utc_ms,last_review_kind)
    VALUES ('en-es','memory-a',?,'lexeme',1789300800000,1789214400000,8.5,5.4,1.25,2.5,1,4,2,2,0.82,1789041600000,'scheduled')`,
    [surface],
  );
}
const ATTEMPT_SQL = `INSERT INTO course_attempt(session_id,exercise_index,course_id,item_id,exercise_type,verdict,first_try,answered_at,active_ms,surface,scheduler_grade,encounter_role,scheduler_review_kind,ruby_shown,slot_id,queue,soft_corrected,cost_paid,skipped,scorable,note,attempt_sequence)
  VALUES (?,?,'en-es','memory-a','typedTranslate','correct',0,?,1234,'hablo',3,'production','scheduled',0,'slot-a','mistakes',0,0,0,1,'replayed',?)`;

describe('durable scheduler migration', () => {
  it('[INV-SCH-11][INV-PER-03] keeps historical evidence without fabricating surface cards', () => {
    const db = legacy();
    try {
      const oldItem = db.get('SELECT * FROM course_item');
      migrate(db);
      expect(db.get('SELECT * FROM course_item')).toEqual(oldItem);
      expect(db.all('SELECT * FROM course_item_surface')).toEqual([]);
      expect(db.get('SELECT surface,attempt_sequence,scheduler_grade FROM course_attempt')).toEqual(
        { surface: null, attempt_sequence: null, scheduler_grade: null },
      );
      expect(db.get('SELECT mastery_high_water_points FROM course_progress')).toEqual({
        mastery_high_water_points: 0,
      });
      expect(regionViolations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('[INV-PER-03] an interrupted scheduler migration rolls back every table and column', () => {
    const db = legacy();
    try {
      const before = db.get('SELECT * FROM course_item');
      const interrupted: Db = {
        ...db,
        run(sql, params) {
          db.run(sql, params);
          if (sql.includes('CREATE TABLE course_scheduler_hold'))
            throw new Error('kill scheduler migration');
        },
      };
      expect(() => migrate(interrupted)).toThrow('kill scheduler migration');
      expect(currentUserVersion(db)).toBe(4);
      expect(columnNames(db, 'course_attempt')).not.toContain('surface');
      expect(
        db.get("SELECT name FROM sqlite_master WHERE name='course_item_surface'"),
      ).toBeUndefined();
      expect(db.get('SELECT * FROM course_item')).toEqual(before);
      migrate(db);
      expect(regionViolations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('[INV-SCH-11][INV-SCH-12] retains separate complete cards and arbitrary modality memberships', () => {
    const db = legacy();
    try {
      migrate(db);
      insertSurface(db);
      insertSurface(db, 'hablamos');
      db.run(
        "UPDATE course_item_surface SET stability=2,last_review_utc_ms=NULL,last_review_kind=NULL WHERE surface='hablamos'",
      );
      db.run(
        "INSERT INTO course_item_surface_modality VALUES ('en-es','memory-a','hablo','future-reviewed-modality')",
      );
      expect(
        db.all(
          'SELECT surface,stability,last_review_utc_ms FROM course_item_surface ORDER BY surface',
        ),
      ).toEqual([
        { surface: 'hablamos', stability: 2, last_review_utc_ms: null },
        { surface: 'hablo', stability: 8.5, last_review_utc_ms: 1789214400000 },
      ]);
      expect(
        db.get(
          "SELECT scheduled_days,elapsed_days,learning_steps,reps,lapses,state,retrievability FROM course_item_surface WHERE surface='hablo'",
        ),
      ).toEqual({
        scheduled_days: 2.5,
        elapsed_days: 1.25,
        learning_steps: 1,
        reps: 4,
        lapses: 2,
        state: 2,
        retrievability: 0.82,
      });
      for (const assignment of [
        'reps=-1',
        'reps=1.5',
        'state=4',
        'retrievability=1.1',
        'stability=-1',
        "kind='guessed'",
      ]) {
        expect(() => db.run(`UPDATE course_item_surface SET ${assignment}`)).toThrow();
      }
      expect(() =>
        db.run(
          "INSERT INTO course_item_surface_modality VALUES ('en-es','memory-a','absent','listening')",
        ),
      ).toThrow();
      expect(() =>
        db.run("INSERT INTO course_item_surface_modality VALUES ('en-es','memory-a','hablo','')"),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('[INV-SCH-10][INV-SCH-11] introductions retain sequence through a wall rewind and cannot be rewritten', () => {
    const db = legacy();
    try {
      migrate(db);
      insertSurface(db);
      insertSurface(db, 'hablamos');
      db.run(
        "INSERT INTO course_introduction VALUES ('en-es','memory-a','hablo',2000,'2026-09-13',0)",
      );
      db.run(
        "INSERT INTO course_introduction VALUES ('en-es','memory-a','hablamos',1000,'2026-09-12',1)",
      );
      expect(db.all('SELECT surface FROM course_introduction ORDER BY sequence')).toEqual([
        { surface: 'hablo' },
        { surface: 'hablamos' },
      ]);
      expect(() => db.run('UPDATE course_introduction SET introduced_at_utc_ms=0')).toThrow(
        'append-only',
      );
      expect(() => db.run('DELETE FROM course_introduction')).toThrow('append-only');
    } finally {
      db.close();
    }
  });

  it('[INV-SESS-11] orders replay attempts independently of signed indices and wall timestamps', () => {
    const db = legacy();
    try {
      migrate(db);
      db.run(ATTEMPT_SQL, ['new', 0, '2026-09-13T12:00:00Z', 0]);
      db.run(ATTEMPT_SQL, ['new', -2, '2026-09-13T11:00:00Z', 1]);
      expect(
        db.all(
          'SELECT exercise_index FROM course_attempt WHERE attempt_sequence IS NOT NULL ORDER BY attempt_sequence',
        ),
      ).toEqual([{ exercise_index: 0 }, { exercise_index: -2 }]);
      expect(() => db.run(ATTEMPT_SQL, ['duplicate', 0, '2026-09-13T11:00:00Z', 1])).toThrow();
      expect(() => db.run('UPDATE course_attempt SET scheduler_grade=4')).toThrow('append-only');
    } finally {
      db.close();
    }
  });

  it('[INV-SESS-07][INV-SESS-11] freezes exact variant and answer clocks alongside the checkpoint, with atomic rollback', () => {
    const db = legacy();
    try {
      migrate(db);
      const receipt = `INSERT INTO course_session_answer_receipt(session_id,exercise_index,course_id,receipt_sequence,slot_id,item_id,exercise_id,surface,encounter_role,ruby_shown,answered_at_utc_ms,answered_local_day,active_ms)
        VALUES ('new',-2,'en-es',0,'slot-a','memory-a','exercise-variant-b','hablo','production',0,1789214400000,'2026-09-12',1234)`;
      expect(() =>
        db.withExclusiveTransaction(() => {
          db.run(receipt);
          throw new Error('checkpoint write failed');
        }),
      ).toThrow();
      expect(db.all('SELECT * FROM course_session_answer_receipt')).toEqual([]);
      db.withExclusiveTransaction(() => db.run(receipt));
      expect(
        db.get(
          'SELECT exercise_id,item_id,answered_at_utc_ms,answered_local_day,active_ms FROM course_session_answer_receipt',
        ),
      ).toEqual({
        exercise_id: 'exercise-variant-b',
        item_id: 'memory-a',
        answered_at_utc_ms: 1789214400000,
        answered_local_day: '2026-09-12',
        active_ms: 1234,
      });
      db.run("DELETE FROM course_session_answer_receipt WHERE session_id='new'");
      expect(db.all('SELECT * FROM course_session_answer_receipt')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('[INV-SCH-07][INV-SCH-08][INV-SCH-02] retains closed holds and append-only anomalies for absent surfaces', () => {
    const db = legacy();
    try {
      migrate(db);
      db.run(
        "INSERT INTO course_scheduler_hold VALUES ('en-es','h1','modality',NULL,'listening','modalityDisabled',1000,2000)",
      );
      db.run(
        "INSERT INTO course_scheduler_hold VALUES ('en-es','h2','modality',NULL,'listening','modalityDisabled',3000,NULL)",
      );
      expect(
        db.all('SELECT from_utc_ms,until_utc_ms FROM course_scheduler_hold ORDER BY from_utc_ms'),
      ).toEqual([
        { from_utc_ms: 1000, until_utc_ms: 2000 },
        { from_utc_ms: 3000, until_utc_ms: null },
      ]);
      expect(() =>
        db.run(
          "INSERT INTO course_scheduler_hold VALUES ('en-es','bad','item','memory-a','listening','report',1000,2000)",
        ),
      ).toThrow();
      expect(() => db.run('UPDATE course_scheduler_hold SET until_utc_ms=0')).toThrow();
      db.run(
        "INSERT INTO course_scheduler_anomaly VALUES ('en-es',0,'uncreditedSurface','unknown','unseen',1000,-123,0,'no introduction')",
      );
      expect(db.get('SELECT observed_ms,used_ms FROM course_scheduler_anomaly')).toEqual({
        observed_ms: -123,
        used_ms: 0,
      });
      expect(() => db.run("UPDATE course_scheduler_anomaly SET note='erased'")).toThrow(
        'append-only',
      );
      expect(() => db.run('DELETE FROM course_scheduler_anomaly')).toThrow('append-only');
    } finally {
      db.close();
    }
  });

  it('[INV-ECO-04][INV-CRS-03] course removal cascades new evidence and preserves account totals', () => {
    const db = legacy();
    try {
      migrate(db);
      insertSurface(db);
      db.run("INSERT INTO course_scheduler_mastery VALUES ('en-es','memory-a')");
      db.run(
        "INSERT INTO course_introduction VALUES ('en-es','memory-a','hablo',1000,'2026-09-13',0)",
      );
      db.run(
        "INSERT INTO course_item_surface_modality VALUES ('en-es','memory-a','hablo','listening')",
      );
      db.run(
        "INSERT INTO course_scheduler_hold VALUES ('en-es','h1','item','memory-a',NULL,'report',1000,NULL)",
      );
      db.run(
        "INSERT INTO course_scheduler_anomaly VALUES ('en-es',0,'negativeElapsed',NULL,NULL,1000,-5,0,'rewind')",
      );
      db.run("DELETE FROM course_progress WHERE course_id='en-es'");
      for (const table of [
        'course_item_surface',
        'course_introduction',
        'course_item_surface_modality',
        'course_scheduler_mastery',
        'course_scheduler_hold',
        'course_scheduler_anomaly',
        'course_attempt',
      ])
        expect(db.all(`SELECT * FROM ${table}`)).toEqual([]);
      expect(db.get('SELECT lifetime_xp,gems FROM account')).toEqual({
        lifetime_xp: 321,
        gems: 42,
      });
      expect(regionViolations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
