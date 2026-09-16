// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { migrate } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { SqliteWordStore } from '../db/SqliteWordStore';
import { readSqliteWidgetHistory } from './SqliteWidgetHistory';
import { rowAt } from '../../../../packages/core/src/day/__testsupport__';
import { toLocalDay } from '@freelingo/core/day';
const dbs: ReturnType<typeof createNodeDb>[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function insert(options: Parameters<typeof rowAt>[0]) {
  const row = rowAt(options),
    db = createNodeDb();
  dbs.push(db);
  migrate(db);
  new SqliteWordStore(db).initializeFreshHistory(Date.parse('2026-09-01T00:00:00Z'), {
    databaseWasCreated: true,
  });
  const fields = {
    session_id: row.sessionId,
    committed_at: new Date(row.derivedCompletionUtcMs).toISOString(),
    flavour: 'lesson',
    outcome: 'completed',
    graded_attempts: 1,
    started_at_utc_ms: row.startedAtUtcMs,
    start_tz_id: row.startZone.tzId,
    start_utc_offset_minutes: row.startZone.utcOffsetMinutes,
    start_tz_source: row.startZone.tzSource,
    started_local_day: row.startedLocalDay,
    completed_at_utc_ms: row.completedAtUtcMs,
    completion_tz_id: row.completionZone.tzId,
    completion_utc_offset_minutes: row.completionZone.utcOffsetMinutes,
    completion_tz_source: row.completionZone.tzSource,
    completed_local_day: row.completedLocalDay,
    derived_completion_utc_ms: row.derivedCompletionUtcMs,
    credited_local_day: row.creditedLocalDay,
    reward_local_day: row.rewardLocalDay,
    credited_by_grace: Number(row.creditedByGrace),
    day_keying_deferred: Number(row.dayKeyingDeferred),
  };
  db.run(
    'INSERT INTO committed_session(' +
      Object.keys(fields).join(',') +
      ') VALUES(' +
      Object.keys(fields)
        .map(() => '?')
        .join(',') +
      ')',
    Object.values(fields),
  );
  return { db, row };
}
it('[INV-DAY-04][INV-WID-01] actual Tokyo-to-LA core credit remains valid non-grace history', () => {
  const { db, row } = insert({
    sessionId: 'zone',
    startUtc: '2026-09-12T15:52:00Z',
    durationMs: 660000,
    tzId: 'Asia/Tokyo',
    completionTzId: 'America/Los_Angeles',
  });
  expect(row.startedLocalDay).toBe('2026-09-13');
  expect(row.completedLocalDay).toBe('2026-09-12');
  expect(row.creditedLocalDay).toBe('2026-09-13');
  expect(row.creditedByGrace).toBe(false);
  expect(readSqliteWidgetHistory(db, '2026-09-13')).toMatchObject({
    kind: 'known',
    lifetimeSessions: 1,
    lastCompletedLocalDay: '2026-09-13',
  });
});
it('[INV-DAY-04][INV-WID-01] actual opposite zone transition may credit older start without grace', () => {
  const { db, row } = insert({
    sessionId: 'east',
    startUtc: '2026-09-12T15:52:00Z',
    durationMs: 660000,
    tzId: 'America/Los_Angeles',
    completionTzId: 'Asia/Tokyo',
  });
  expect(row.creditedLocalDay).toBe('2026-09-12');
  expect(row.completedLocalDay).toBe('2026-09-13');
  expect(row.creditedByGrace).toBe(false);
  expect(readSqliteWidgetHistory(db, '2026-09-13')).toMatchObject({
    kind: 'known',
    lastCompletedLocalDay: '2026-09-12',
  });
});
it('[INV-DAY-04][INV-WID-01] zone-change completion credit is preserved when start already satisfied', () => {
  const { db, row } = insert({
    sessionId: 'other',
    startUtc: '2026-09-12T15:52:00Z',
    durationMs: 660000,
    tzId: 'Asia/Tokyo',
    completionTzId: 'America/Los_Angeles',
    satisfied: [toLocalDay('2026-09-13')],
  });
  expect(row.creditedLocalDay).toBe('2026-09-12');
  expect(readSqliteWidgetHistory(db, '2026-09-13')).toMatchObject({
    kind: 'known',
    lastCompletedLocalDay: '2026-09-12',
  });
});
it('[INV-DAY-08][INV-WID-01] actual same-zone grace remains prior-date credit', () => {
  const { db, row } = insert({
    sessionId: 'grace',
    startUtc: '2026-09-12T23:58:00Z',
    durationMs: 180000,
    tzId: 'UTC',
  });
  expect(row.creditedByGrace).toBe(true);
  expect(readSqliteWidgetHistory(db, '2026-09-13')).toMatchObject({
    kind: 'known',
    lastCompletedLocalDay: '2026-09-12',
  });
});
it('[INV-DAY-08][INV-WID-01] actual long same-zone session credits completion date without grace', () => {
  const { db, row } = insert({
    sessionId: 'long',
    startUtc: '2026-09-12T21:00:00Z',
    durationMs: 14400000,
    tzId: 'UTC',
  });
  expect(row.creditedByGrace).toBe(false);
  expect(row.creditedLocalDay).toBe('2026-09-13');
  expect(readSqliteWidgetHistory(db, '2026-09-13')).toMatchObject({
    kind: 'known',
    lastCompletedLocalDay: '2026-09-13',
  });
});
it('[INV-DAY-14][INV-WID-10] actual deferred core row counts lifetime without inventing a credited day', () => {
  const { db, row } = insert({
    sessionId: 'deferred',
    startUtc: '1970-01-01T00:00:00Z',
    durationMs: 180000,
    tzId: 'UTC',
  });
  expect(row.dayKeyingDeferred).toBe(true);
  expect(readSqliteWidgetHistory(db, '2026-09-13')).toMatchObject({
    kind: 'known',
    lifetimeSessions: 1,
    lastCompletedLocalDay: null,
  });
});
