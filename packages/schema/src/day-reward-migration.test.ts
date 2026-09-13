import { describe, expect, it } from 'vitest';
import { createNodeDb } from '@freelingo/testkit';
import { MIGRATIONS, currentUserVersion, migrate } from './migrations.js';
import { regionViolations } from './progress-schema.js';
import type { Db } from './db.js';
function prior() {
  const db = createNodeDb();
  for (const m of MIGRATIONS.filter((m) => m.userVersion <= 6))
    db.withExclusiveTransaction(() => {
      m.up(db);
      db.run(`PRAGMA user_version=${m.userVersion}`);
    });
  db.run("INSERT INTO course_progress(course_id,added_at) VALUES ('en-es','2026-09-13')");
  db.run(
    "INSERT INTO committed_session(session_id,committed_at,active_ms,xp_awarded) VALUES ('old','2026-09-12T12:00:00Z',1000,14)",
  );
  db.run('UPDATE account SET lifetime_xp=14,gems=20');
  return db;
}
function commit(db: Db) {
  db.run(`INSERT INTO committed_session(session_id,committed_at,active_ms,xp_awarded,started_at_utc_ms,start_tz_id,start_utc_offset_minutes,start_tz_source,started_local_day,completed_at_utc_ms,completion_tz_id,completion_utc_offset_minutes,completion_tz_source,completed_local_day,derived_completion_utc_ms,credited_local_day,reward_local_day,credited_by_grace,day_keying_deferred,gems_awarded,base_xp,multiplier_recorded,multiplier_applied,ladder_mode,award_explanation,outcome,graded_attempts)
  VALUES ('new','2026-09-13T05:02:00Z',120000,28,1789275480000,'America/Chicago',-300,'iana','2026-09-12',1789275720000,'America/Chicago',-300,'iana','2026-09-13',1789275720000,'2026-09-12','2026-09-13',1,0,5,14,2,2,'lesson','captured boost','completed',12)`);
}

describe('day engine and reward carriers', () => {
  it('[INV-PER-03] interrupted reward migration retains the old ledger and schema version', () => {
    const db = prior();
    try {
      const before = db.get('SELECT * FROM committed_session');
      const interrupted: Db = {
        ...db,
        run(sql, params) {
          db.run(sql, params);
          if (sql.includes('CREATE TABLE account_recovery_challenge'))
            throw new Error('kill reward migration');
        },
      };
      expect(() => migrate(interrupted)).toThrow('kill reward migration');
      expect(currentUserVersion(db)).toBe(6);
      expect(db.get('SELECT * FROM committed_session')).toEqual(before);
      migrate(db);
      expect(regionViolations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('[INV-DAY-04][INV-DAY-08][INV-DAY-15] stores both zones and separate streak/reward days without inventing legacy stamps', () => {
    const db = prior();
    try {
      migrate(db);
      commit(db);
      expect(
        db.get(
          "SELECT started_at_utc_ms,credited_local_day,reward_local_day FROM committed_session WHERE session_id='old'",
        ),
      ).toEqual({ started_at_utc_ms: null, credited_local_day: null, reward_local_day: null });
      expect(
        db.get(
          "SELECT started_local_day,completed_local_day,credited_local_day,reward_local_day,credited_by_grace,multiplier_recorded,multiplier_applied FROM committed_session WHERE session_id='new'",
        ),
      ).toEqual({
        started_local_day: '2026-09-12',
        completed_local_day: '2026-09-13',
        credited_local_day: '2026-09-12',
        reward_local_day: '2026-09-13',
        credited_by_grace: 1,
        multiplier_recorded: 2,
        multiplier_applied: 2,
      });
    } finally {
      db.close();
    }
  });
  it('[INV-FRZ-03] retains zero-applied grants and exact consumption dates independently of current balance', () => {
    const db = prior();
    try {
      migrate(db);
      db.run(
        "INSERT INTO account_freeze_grant VALUES ('capped','reward_chest',NULL,'2026-09-12',2,0)",
      );
      expect(() =>
        db.run(
          "INSERT INTO account_freeze_grant VALUES ('capped','reward_chest',NULL,'2026-09-13',2,2)",
        ),
      ).toThrow();
      expect(() =>
        db.run("UPDATE account_freeze_grant SET applied=2 WHERE grant_key='capped'"),
      ).toThrow('append-only');
      db.run(
        "INSERT INTO account_freeze_grant VALUES ('gift','milestone_grant',NULL,'2026-09-11',1,1)",
      );
      db.run(
        "INSERT INTO account_freeze(freeze_id,acquired_on_day,acquired_via,grant_key,consumed_for_day,consumed_on_day) VALUES ('f1','2026-09-11','milestone_grant','gift','2026-09-12','2026-09-13')",
      );
      expect(() =>
        db.run(
          "INSERT INTO account_freeze(freeze_id,acquired_on_day,consumed_for_day) VALUES ('f2','2026-09-11','2026-09-12')",
        ),
      ).toThrow();
      expect(
        db.get("SELECT requested,applied FROM account_freeze_grant WHERE grant_key='capped'"),
      ).toEqual({ requested: 2, applied: 0 });
    } finally {
      db.close();
    }
  });
  it('[INV-REC-01][INV-REC-03][INV-DAY-06] retains live break dates and exact recovery/repair progress', () => {
    const db = prior();
    try {
      migrate(db);
      db.run("INSERT INTO account_streak_break VALUES (1,'2026-09-11',22)");
      db.run("INSERT INTO account_streak_break_day VALUES ('2026-09-11',1)");
      db.run("INSERT INTO account_streak_break_day VALUES ('2026-09-12',1)");
      db.run(
        "INSERT INTO account_recovery_challenge VALUES (1,'2026-09-11',22,'2026-09-13',3,2,NULL)",
      );
      expect(() => db.run('UPDATE account_recovery_challenge SET lessons_done=4')).toThrow();
      db.run("INSERT INTO account_streak_repair VALUES ('2026-09','2026-09-13',22)");
      db.run("INSERT INTO account_streak_repair_day VALUES ('2026-09','2026-09-11')");
      expect(db.get('SELECT lessons_done,earned_on_day FROM account_recovery_challenge')).toEqual({
        lessons_done: 2,
        earned_on_day: null,
      });
      expect(
        db.all('SELECT local_day FROM account_streak_break_day ORDER BY local_day'),
      ).toHaveLength(2);
    } finally {
      db.close();
    }
  });
  it('[INV-CER-01][INV-CER-02] frozen ceremony and actual reward ledger roll back together and cursor CAS cannot repeat', () => {
    const db = prior();
    try {
      migrate(db);
      expect(() =>
        db.withExclusiveTransaction(() => {
          commit(db);
          db.run('UPDATE account SET lifetime_xp=lifetime_xp+28');
          db.run(`INSERT INTO course_ceremony VALUES ('new','en-es',1,'{"chain":[]}',0,NULL)`);
          throw new Error('kill after ceremony');
        }),
      ).toThrow();
      expect(db.get("SELECT 1 FROM committed_session WHERE session_id='new'")).toBeUndefined();
      expect(db.get('SELECT lifetime_xp FROM account')).toEqual({ lifetime_xp: 14 });
      commit(db);
      db.run(
        `INSERT INTO course_ceremony VALUES ('new','en-es',1,'{"chain":["result","return"]}',0,NULL)`,
      );
      db.run("UPDATE course_ceremony SET cursor=1 WHERE session_id='new' AND cursor=0");
      db.run("UPDATE course_ceremony SET cursor=2 WHERE session_id='new' AND cursor=0");
      expect(db.get('SELECT cursor FROM course_ceremony')).toEqual({ cursor: 1 });
      expect(() => db.run(`UPDATE course_ceremony SET presentation_json='{}'`)).toThrow(
        'immutable',
      );
    } finally {
      db.close();
    }
  });
  it('[INV-ECO-04][INV-CRS-03] removing a course preserves global reward identity and claimed achievement tiers', () => {
    const db = prior();
    try {
      migrate(db);
      commit(db);
      db.run(
        "INSERT INTO account_achievement_award VALUES ('sage',0,'2026-09-13T05:02:00Z','new')",
      );
      db.run(
        "INSERT INTO course_session_commit_link VALUES ('new','en-es',NULL,'hubWords','words-offer','2026-09-13')",
      );
      db.run(`INSERT INTO course_ceremony VALUES ('new','en-es',1,'{"chain":[]}',0,NULL)`);
      db.run("DELETE FROM course_progress WHERE course_id='en-es'");
      expect(db.all('SELECT * FROM course_ceremony')).toEqual([]);
      expect(db.all('SELECT * FROM course_session_commit_link')).toEqual([]);
      expect(db.get("SELECT session_id FROM committed_session WHERE session_id='new'")).toEqual({
        session_id: 'new',
      });
      expect(db.get('SELECT achievement_id FROM account_achievement_award')).toEqual({
        achievement_id: 'sage',
      });
      expect(regionViolations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('[INV-CER-01] a Hub completion must bind an actual committed session', () => {
    const db = prior();
    try {
      migrate(db);
      db.run("INSERT INTO course_hub_day VALUES ('en-es','2026-09-13',0)");
      expect(() =>
        db.run(
          "INSERT INTO course_hub_completion VALUES ('en-es','2026-09-13','words','nonexistent')",
        ),
      ).toThrow();
      db.run("INSERT INTO course_hub_completion VALUES ('en-es','2026-09-13','words','old')");
      expect(db.get('SELECT completed_session_id FROM course_hub_completion')).toEqual({
        completed_session_id: 'old',
      });
    } finally {
      db.close();
    }
  });
  it('[INV-CER-08][INV-CER-14] stores course ceiling/unlock and global decline sentinel distinctly', () => {
    const db = prior();
    try {
      migrate(db);
      expect(db.get('SELECT score_unlocked,score_ceiling_beat_shown FROM course_progress')).toEqual(
        { score_unlocked: null, score_ceiling_beat_shown: null },
      );
      db.run('UPDATE account SET streak_goal_declined=1,streak_goal_presentations=2');
      expect(() => db.run('UPDATE account SET streak_goal_value=7')).toThrow();
      db.run(
        'UPDATE course_progress SET exposure_fraction=0.5,score_unlocked=1,score_ceiling_beat_shown=1',
      );
      expect(() => db.run('UPDATE course_progress SET exposure_fraction=1.1')).toThrow();
      expect(db.get('SELECT streak_goal_value,streak_goal_declined FROM account')).toEqual({
        streak_goal_value: null,
        streak_goal_declined: 1,
      });
    } finally {
      db.close();
    }
  });
});
