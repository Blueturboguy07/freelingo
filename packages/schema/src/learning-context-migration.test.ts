import { describe, expect, it } from 'vitest';
import { createNodeDb } from '@freelingo/testkit';
import { MIGRATIONS, currentUserVersion, migrate } from './migrations.js';
import { regionViolations } from './progress-schema.js';
import type { Db } from './db.js';
function oldDb() {
  const db = createNodeDb();
  for (const migration of MIGRATIONS.filter((m) => m.userVersion <= 5))
    db.withExclusiveTransaction(() => {
      migration.up(db);
      db.run(`PRAGMA user_version=${migration.userVersion}`);
    });
  for (const id of ['en-es', 'en-fr'])
    db.run("INSERT INTO course_progress(course_id,added_at) VALUES (?,'2026-09-13')", [id]);
  db.run("INSERT INTO course_item(course_id,item_id) VALUES ('en-es','item-a')");
  return db;
}
function context(db: Db, id = 'session-a') {
  db.run(
    `INSERT INTO course_session_context(session_id,course_id,session_kind,node_ref,started_at_utc_ms,started_at_monotonic_ms,start_tz_id,start_utc_offset_minutes,start_tz_source,started_local_day,economy_flavour,practice_item_ratio,pack_content_hash,origin,origin_offer_id,origin_local_day)
    VALUES (?,'en-es','nodePractice','hub-a',1789214400000,5000.25,'America/Chicago',-300,'iana','2026-09-12','hubWords',0.5,'sha256-pack-a','hub','hub-offer-a','2026-09-12')`,
    [id],
  );
}
const completion = `UPDATE course_session_context SET completed_at_utc_ms=1789214460000,completed_at_monotonic_ms=65000.5,completion_tz_id='America/Chicago',completion_utc_offset_minutes=-300,completion_tz_source='iana',completion_outcome='completed',completion_intent_at_utc='2026-09-12T12:01:00Z'`;

describe('durable launch, daily pools and startup', () => {
  it('[INV-PER-03] interruption leaves v5 intact including its scheduler evidence', () => {
    const db = oldDb();
    try {
      const interrupted: Db = {
        ...db,
        run(sql, params) {
          db.run(sql, params);
          if (sql.includes('CREATE TABLE course_hub_day'))
            throw new Error('kill context migration');
        },
      };
      expect(() => migrate(interrupted)).toThrow('kill context migration');
      expect(currentUserVersion(db)).toBe(5);
      expect(
        db.get("SELECT name FROM sqlite_master WHERE name='course_session_context'"),
      ).toBeUndefined();
      migrate(db);
      expect(regionViolations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('[INV-SESS-07][INV-ECO-03] keeps launch flavour, ratio, pack hash and fractional monotonic clocks immutable', () => {
    const db = oldDb();
    try {
      migrate(db);
      context(db);
      expect(
        db.get(
          'SELECT economy_flavour,practice_item_ratio,pack_content_hash,started_at_monotonic_ms FROM course_session_context',
        ),
      ).toEqual({
        economy_flavour: 'hubWords',
        practice_item_ratio: 0.5,
        pack_content_hash: 'sha256-pack-a',
        started_at_monotonic_ms: 5000.25,
      });
      for (const change of [
        "pack_content_hash='new-pack'",
        "economy_flavour='lesson'",
        'practice_item_ratio=1',
        "started_local_day='2026-09-13'",
      ])
        expect(() => db.run(`UPDATE course_session_context SET ${change}`)).toThrow('immutable');
      db.run('UPDATE course_session_context SET active_ms=9000');
      expect(db.get('SELECT active_ms FROM course_session_context')).toEqual({ active_ms: 9000 });
    } finally {
      db.close();
    }
  });
  it('[INV-CER-01][INV-SESS-07] completion intent is complete and first-write-wins across retries', () => {
    const db = oldDb();
    try {
      migrate(db);
      context(db);
      expect(() => db.run('UPDATE course_session_context SET completed_at_utc_ms=1')).toThrow();
      db.run(completion);
      expect(() => db.run('UPDATE course_session_context SET active_ms=99999')).toThrow(
        'immutable',
      );
      expect(() =>
        db.run('UPDATE course_session_context SET completed_at_utc_ms=1789300860000'),
      ).toThrow('immutable');
      expect(() =>
        db.run('UPDATE course_session_context SET completion_intent_at_utc=NULL'),
      ).toThrow();
      expect(db.get('SELECT completed_at_utc_ms FROM course_session_context')).toEqual({
        completed_at_utc_ms: 1789214460000,
      });
    } finally {
      db.close();
    }
  });
  it('[INV-SESS-07] exact slot variants share context ownership and cascade with it', () => {
    const db = oldDb();
    try {
      migrate(db);
      context(db);
      db.run(
        "INSERT INTO course_session_slot VALUES ('session-a','slot-a','en-es','exercise-a','item-a','hablo','production',0)",
      );
      expect(() =>
        db.run(
          "INSERT INTO course_session_slot VALUES ('session-a','slot-b','en-fr','exercise-b','item-a','hablo','recognition',0)",
        ),
      ).toThrow();
      db.withExclusiveTransaction(() =>
        db.run(
          "UPDATE course_session_slot SET exercise_id='exercise-b',encounter_role='recognition' WHERE slot_id='slot-a'",
        ),
      );
      expect(db.get('SELECT exercise_id,item_id FROM course_session_slot')).toEqual({
        exercise_id: 'exercise-b',
        item_id: 'item-a',
      });
      db.run("DELETE FROM course_session_context WHERE session_id='session-a'");
      expect(db.all('SELECT * FROM course_session_slot')).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('[INV-SCH-05] an empty daily pool remains distinguishable and reservations roll back with failed launch', () => {
    const db = oldDb();
    try {
      migrate(db);
      db.run("INSERT INTO course_review_pool_day VALUES ('en-es','2026-09-12',1789214400000)");
      expect(db.all('SELECT * FROM course_review_pool_item')).toEqual([]);
      expect(db.get('SELECT local_day FROM course_review_pool_day')).toEqual({
        local_day: '2026-09-12',
      });
      db.run("INSERT INTO course_review_pool_item VALUES ('en-es','2026-09-12','item-a',0,NULL)");
      expect(() =>
        db.withExclusiveTransaction(() => {
          db.run("UPDATE course_review_pool_item SET spent_by='dailyRefresh'");
          context(db);
          throw new Error('checkpoint failed');
        }),
      ).toThrow();
      expect(db.get('SELECT spent_by FROM course_review_pool_item')).toEqual({ spent_by: null });
      expect(db.all('SELECT * FROM course_session_context')).toEqual([]);
      db.run("INSERT INTO course_hub_day VALUES ('en-es','2026-09-12',0)");
      db.run("INSERT INTO course_hub_choice VALUES ('en-es','2026-09-12','choice-a',0)");
      db.run(
        "INSERT INTO course_hub_completion VALUES ('en-es','2026-09-12','fallback-offer','s-complete')",
      );
      expect(db.get('SELECT offer_id FROM course_hub_completion')).toEqual({
        offer_id: 'fallback-offer',
      });
    } finally {
      db.close();
    }
  });
  it('[INV-ECO-04][INV-CRS-03] global onboarding and seed survive course removal without dangling selections', () => {
    const db = oldDb();
    try {
      migrate(db);
      db.run('UPDATE account SET selection_seed=1234,lifetime_xp=900');
      db.run(
        "INSERT INTO account_onboarding(id,step,completed_at_utc) VALUES (1,'pack-detail',NULL)",
      );
      db.run(
        "INSERT INTO course_selection(course_id,is_active,is_selected,placement_choice,self_report_level) VALUES ('en-es',1,1,'test','basic')",
      );
      expect(() =>
        db.run(
          "INSERT INTO course_selection(course_id,is_active,is_selected) VALUES ('en-fr',1,0)",
        ),
      ).toThrow();
      expect(() =>
        db.run(
          "INSERT INTO course_selection(course_id,is_active,is_selected) VALUES ('en-fr',0,1)",
        ),
      ).toThrow();
      db.run("DELETE FROM course_progress WHERE course_id='en-es'");
      expect(db.all('SELECT * FROM course_selection')).toEqual([]);
      expect(db.get('SELECT step FROM account_onboarding')).toEqual({ step: 'pack-detail' });
      expect(db.get('SELECT selection_seed,lifetime_xp FROM account')).toEqual({
        selection_seed: 1234,
        lifetime_xp: 900,
      });
      expect(regionViolations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
