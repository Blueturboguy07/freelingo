// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { migrate } from '@freelingo/schema';
import { SqlitePreferences } from './SqlitePreferences.js';

const opened: ReturnType<typeof createNodeDb>[] = [];
afterEach(() => {
  for (const db of opened) db.close();
  opened.length = 0;
});
function setup() {
  const db = createNodeDb();
  opened.push(db);
  migrate(db);
  for (const id of ['en-es', 'en-fr'])
    db.run('INSERT INTO course_progress (course_id,added_at) VALUES (?,?)', [
      id,
      '2026-09-13T00:00:00Z',
    ]);
  const clock = {
    utcMs: Date.parse('2026-09-13T00:15:00.000Z'),
    monotonicMs: 1000,
    bootId: 'boot-A',
  };
  return { db, clock, preferences: new SqlitePreferences(db, () => clock) };
}
describe('durable user preferences', () => {
  it('[INV-PER-11] preserves per-course modality choices and shared general preferences across adapter replacement', () => {
    const { db, clock, preferences } = setup();
    preferences.setCoursePreference('en-es', 'animations', false);
    preferences.setCoursePreference('en-es', 'listening', false);
    preferences.suspend('en-fr', 'listening');
    const resumed = new SqlitePreferences(db, () => clock);
    expect(resumed.readCourse('en-es').preferences).toMatchObject({
      animations: false,
      listening: false,
      speaking: true,
    });
    expect(resumed.readCourse('en-fr')).toMatchObject({
      preferences: { animations: false, listening: true },
      suspensions: { listening: '2026-09-13T01:15:00.000Z', speaking: null },
    });
  });
  it('[INV-MOD-03] explicitly enabling a modality clears only its own suspension', () => {
    const { preferences } = setup();
    preferences.suspend('en-es', 'listening');
    preferences.suspend('en-es', 'speaking');
    preferences.setCoursePreference('en-es', 'listening', true);
    expect(preferences.readCourse('en-es').suspensions).toEqual({
      listening: null,
      speaking: '2026-09-13T01:15:00.000Z',
    });
    preferences.setCoursePreference('en-es', 'speaking', false);
    expect(preferences.readCourse('en-es').suspensions.speaking).not.toBeNull();
  });
  it('[INV-PER-07] failing the second write rolls back preference creation and the change together', () => {
    const { db, preferences } = setup();
    db.run(
      "CREATE TRIGGER fail_settings BEFORE UPDATE ON course_display BEGIN SELECT RAISE(ABORT,'disk write failed'); END",
    );
    expect(() => preferences.setCoursePreference('en-es', 'listening', false)).toThrow(
      'disk write failed',
    );
    expect(db.all('SELECT * FROM course_display')).toEqual([]);
  });
  it('[INV-CRS-03] a removed course cannot be recreated by a stale settings callback', () => {
    const { db, preferences } = setup();
    preferences.setCoursePreference('en-es', 'soundEffects', false);
    db.run("DELETE FROM course_progress WHERE course_id='en-es'");
    expect(() => preferences.setCoursePreference('en-es', 'soundEffects', true)).toThrow(/course/i);
    expect(db.all('SELECT * FROM course_display')).toEqual([]);
  });
  it('[INV-PER-07] appearance persists without touching earned account or daily rewards', () => {
    const { db, clock, preferences } = setup();
    db.run('UPDATE account SET lifetime_xp=500,gems=12');
    db.run(
      "INSERT INTO account_day(local_day,goal_xp,earned_xp,goal_met,chest_granted_at) VALUES('2026-09-13',20,25,1,'2026-09-13T00:00:00Z')",
    );
    const before = db.all('SELECT * FROM account_day');
    preferences.setAppearance('dark');
    expect(new SqlitePreferences(db, () => clock).readAccount().appearance).toBe('dark');
    expect(db.get('SELECT lifetime_xp,gems FROM account')).toEqual({ lifetime_xp: 500, gems: 12 });
    expect(db.all('SELECT * FROM account_day')).toEqual(before);
  });
  it('[INV-SEC-01] course identifiers are bound values and invalid appearance is refused', () => {
    const { db, preferences } = setup();
    expect(() => preferences.setCoursePreference("en-es' OR 1=1 --", 'listening', false)).toThrow(
      /course/i,
    );
    expect(db.all('SELECT * FROM course_display')).toEqual([]);
    expect(() => preferences.setAppearance('invalid' as 'light')).toThrow(/appearance/i);
  });
  it.each([3, -3])(
    '[INV-MOD-01] projects the remaining monotonic suspension after a %i hour wall change',
    (hours) => {
      const { db, clock, preferences } = setup();
      preferences.suspend('en-es', 'speaking');
      const stored = db.get('SELECT modality_suspension_until FROM account');
      clock.monotonicMs += 10 * 60_000;
      clock.utcMs += hours * 3_600_000;
      expect(preferences.readCourse('en-es').suspensions.speaking).toBe(
        new Date(clock.utcMs + 50 * 60_000).toISOString(),
      );
      expect(db.get('SELECT modality_suspension_until FROM account')).toEqual(stored);
    },
  );
  it('[INV-MOD-01] unavailable OS time fails open on reads and cannot create a new pause', () => {
    const { db, preferences } = setup();
    preferences.suspend('en-es', 'speaking');
    const saved = db.get('SELECT modality_suspension_until FROM account');
    const unavailable = new SqlitePreferences(db, () => null);
    expect(unavailable.readCourse('en-es').suspensions.speaking).toBeNull();
    expect(unavailable.readCourse('en-es').preferences.speaking).toBe(true);
    expect(() => unavailable.suspend('en-es', 'listening')).toThrow(/device clock/i);
    expect(db.get('SELECT modality_suspension_until FROM account')).toEqual(saved);
  });
  it('[INV-MOD-01] account suspension survives course removal and expires after reboot', () => {
    const { db, clock, preferences } = setup();
    preferences.suspend('en-es', 'speaking');
    const before = db.get('SELECT modality_suspension_until FROM account');
    db.run("DELETE FROM course_progress WHERE course_id='en-es'");
    expect(preferences.readCourse('en-fr').suspensions.speaking).toBe('2026-09-13T01:15:00.000Z');
    expect(db.get('SELECT modality_suspension_until FROM account')).toEqual(before);
    clock.bootId = 'boot-B';
    expect(preferences.readCourse('en-fr').suspensions.speaking).toBeNull();
    expect(db.get('SELECT modality_suspension_until FROM account')).toEqual(before);
  });
});
