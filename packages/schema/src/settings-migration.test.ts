import { describe, expect, it } from 'vitest';
import { createNodeDb } from '@freelingo/testkit';
import { MIGRATIONS, currentUserVersion, migrate } from './migrations.js';
import { columnNames, regionViolations } from './progress-schema.js';
import type { Db } from './db.js';

function oldDatabase() {
  const db = createNodeDb();
  for (const migration of MIGRATIONS.filter((entry) => entry.userVersion <= 3)) {
    db.withExclusiveTransaction(() => {
      migration.up(db);
      db.run(`PRAGMA user_version = ${migration.userVersion}`);
    });
  }
  db.run('UPDATE account SET lifetime_xp=75, gems=8');
  for (const id of ['en-es', 'en-fr']) {
    db.run('INSERT INTO course_progress (course_id, added_at) VALUES (?,?)', [
      id,
      '2026-09-13T00:00:00Z',
    ]);
    db.run(
      'INSERT INTO course_display (course_id,listening_enabled,speaking_enabled) VALUES (?,0,1)',
      [id],
    );
  }
  return db;
}

describe('P4 durable settings migration', () => {
  it('[INV-PER-03] migrates existing course choices without resetting them', () => {
    const db = oldDatabase();
    try {
      migrate(db);
      expect(
        db.get(
          'SELECT lifetime_xp,gems,appearance,imported_at_utc,sound_effects_enabled,animations_enabled,motivational_messages_enabled FROM account',
        ),
      ).toEqual({
        lifetime_xp: 75,
        gems: 8,
        appearance: 'system',
        imported_at_utc: null,
        sound_effects_enabled: 1,
        animations_enabled: 1,
        motivational_messages_enabled: 1,
      });
      const rows = db.all('SELECT * FROM course_display ORDER BY course_id');
      expect(rows).toHaveLength(2);
      for (const row of rows)
        expect(row).toMatchObject({
          listening_enabled: 0,
          speaking_enabled: 1,
        });
      expect(regionViolations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('[INV-PER-03] a kill after a settings ALTER leaves the entire old schema and choices intact', () => {
    const db = oldDatabase();
    try {
      const before = columnNames(db, 'course_display');
      const row = db.get('SELECT * FROM account');
      const interrupted: Db = {
        ...db,
        run(sql, params) {
          db.run(sql, params);
          if (sql.includes('ADD COLUMN animations_enabled')) throw new Error('killed after ALTER');
        },
      };
      expect(() => migrate(interrupted)).toThrow('killed after ALTER');
      expect(currentUserVersion(db)).toBe(3);
      expect(columnNames(db, 'course_display')).toEqual(before);
      expect(db.get('SELECT * FROM account')).toEqual(row);
      migrate(db);
      expect(currentUserVersion(db)).toBe(4);
    } finally {
      db.close();
    }
  });

  it('[INV-CRS-03] course removal preserves general settings and the global suspension', () => {
    const db = oldDatabase();
    try {
      migrate(db);
      const suspension =
        '{"family":"listening","untilUtc":"2026-09-13T01:15:00Z","untilMonotonicMs":999999}';
      db.run(
        "UPDATE account SET appearance='dark', animations_enabled=0, imported_at_utc='2026-09-13T01:00:00Z', modality_suspension_until=?",
        [suspension],
      );
      db.run("DELETE FROM course_progress WHERE course_id='en-es'");
      expect(db.all('SELECT course_id,listening_enabled FROM course_display')).toEqual([
        { course_id: 'en-fr', listening_enabled: 0 },
      ]);
      expect(
        db.get(
          'SELECT appearance,animations_enabled,imported_at_utc,modality_suspension_until FROM account',
        ),
      ).toEqual({
        appearance: 'dark',
        animations_enabled: 0,
        imported_at_utc: '2026-09-13T01:00:00Z',
        modality_suspension_until: suspension,
      });
      expect(columnNames(db, 'course_display')).not.toContain('animations_enabled');
      expect(columnNames(db, 'course_display')).not.toContain('listening_suspended_until_utc');
      expect(() => db.run("UPDATE account SET appearance='unknown'")).toThrow();
      expect(() => db.run('UPDATE account SET animations_enabled=2')).toThrow();
    } finally {
      db.close();
    }
  });
});
