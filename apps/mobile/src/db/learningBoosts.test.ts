// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { migrate, type Db } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { readLearningBoosts, persistLearningBoosts } from './learningBoosts';
const opened: Db[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));
const at = Date.parse('2026-09-13T12:00:00Z');
function setup(expiry = at + 900000) {
  const db = createNodeDb();
  opened.push(db);
  migrate(db);
  db.run('INSERT INTO account_boost VALUES(?,?,?,?,?,?,?,?,?,?)', [
    'boost',
    'xpBoost',
    2,
    15,
    900,
    new Date(at).toISOString(),
    new Date(at).toISOString(),
    1000,
    new Date(at).toISOString(),
    new Date(expiry).toISOString(),
  ]);
  return db;
}
it('[INV-ECO-02][INV-ECO-15] an active boost projects its shortened durable deadline without any read writes', () => {
  const db = setup(at + 90000),
    before = db.all('SELECT * FROM account_boost'),
    out = readLearningBoosts(db, { utcMs: at + 60000, monotonicMs: 61000 });
  expect(out.active).toMatchObject({
    multiplier: 2,
    expiresAtUtc: new Date(at + 90000).toISOString(),
  });
  expect(db.all('SELECT * FROM account_boost')).toEqual(before);
});
it('[INV-ECO-02] an expired saved deadline cannot revive after a restored wall clock or sequence', () => {
  const db = setup(at + 30000);
  const first = readLearningBoosts(db, { utcMs: at + 60000, monotonicMs: 61000 });
  expect(first.active).toBeNull();
  persistLearningBoosts(db, first);
  expect(db.get('SELECT expires_at FROM account_boost')?.expires_at).toBe(
    new Date(at + 30000).toISOString(),
  );
  expect(readLearningBoosts(db, { utcMs: at + 60000, monotonicMs: 100 }).active).toBeNull();
});
it('[INV-ECO-02] an elapsed real boost is durably shortened before another clock reset', () => {
  const db = setup();
  const out = readLearningBoosts(db, { utcMs: at + 60000, monotonicMs: 901000 });
  expect(out.active).toBeNull();
  persistLearningBoosts(db, out);
  expect(db.get('SELECT expires_at FROM account_boost')?.expires_at).toBe(
    new Date(at + 60000).toISOString(),
  );
  expect(readLearningBoosts(db, { utcMs: at + 60000, monotonicMs: 1000 }).active).toBeNull();
});
it.each([
  'expires_at',
  'tamper_high_water_utc',
  'duration_seconds',
  'activation_sequence_ms',
] as const)('[INV-ECO-02] incomplete activated %s is a recoverable error', (field) => {
  const db = setup();
  db.run('UPDATE account_boost SET ' + field + '=?', [field === 'duration_seconds' ? 0 : null]);
  expect(() => readLearningBoosts(db, { utcMs: at + 60000, monotonicMs: 61000 })).toThrow();
});
it('[INV-ECO-02] two genuinely running grants require recovery while an expired one does not', () => {
  const db = setup();
  db.run(
    "INSERT INTO account_boost SELECT 'other',kind,multiplier,duration_minutes,duration_seconds,granted_at,activated_at_utc,activation_sequence_ms,tamper_high_water_utc,expires_at FROM account_boost",
  );
  expect(() => readLearningBoosts(db, { utcMs: at + 60000, monotonicMs: 61000 })).toThrow(
    /Multiple/,
  );
  db.run("UPDATE account_boost SET expires_at=? WHERE grant_id='other'", [
    new Date(at).toISOString(),
  ]);
  expect(readLearningBoosts(db, { utcMs: at + 60000, monotonicMs: 61000 }).active?.multiplier).toBe(
    2,
  );
});
