// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { migrate } from '@freelingo/schema';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { rowAt } from '../../../../packages/core/src/day/__testsupport__';
import { SqliteWordStore } from '../db/SqliteWordStore';
import { readSqliteWidgetHistory } from './SqliteWidgetHistory';
const dbs: ReturnType<typeof createNodeDb>[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const day = '2026-09-13';
function fixture(fresh = true) {
  const db = createNodeDb();
  dbs.push(db);
  migrate(db);
  if (fresh)
    new SqliteWordStore(db).initializeFreshHistory(Date.parse('2026-09-01T00:00:00Z'), {
      databaseWasCreated: true,
    });
  function receipt(
    id: string,
    flavour = 'lesson',
    outcome = 'completed',
    credited: string | null = day,
    completed = day,
  ) {
    const row = rowAt({
      sessionId: id,
      startUtc:
        credited === null
          ? '1970-01-01T00:02:00Z'
          : credited !== completed
            ? credited + 'T23:58:00Z'
            : completed + 'T00:02:00Z',
      durationMs: 180000,
      tzId: 'UTC',
    });
    const fields = {
      session_id: id,
      committed_at: new Date(row.derivedCompletionUtcMs).toISOString(),
      flavour,
      outcome,
      graded_attempts: 1,
      started_at_utc_ms: row.startedAtUtcMs,
      started_local_day: row.startedLocalDay,
      start_tz_id: row.startZone.tzId,
      start_utc_offset_minutes: row.startZone.utcOffsetMinutes,
      start_tz_source: row.startZone.tzSource,
      completed_at_utc_ms: row.completedAtUtcMs,
      completion_tz_id: row.completionZone.tzId,
      completion_utc_offset_minutes: row.completionZone.utcOffsetMinutes,
      completion_tz_source: row.completionZone.tzSource,
      derived_completion_utc_ms: row.derivedCompletionUtcMs,
      completed_local_day: row.completedLocalDay,
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
  }
  return { db, receipt };
}
it('[INV-WID-10] migration and zero counters cannot establish an empty lifetime history', () => {
  const f = fixture(false);
  expect(readSqliteWidgetHistory(f.db, day)).toEqual({ kind: 'unavailable' });
  f.receipt('known-row');
  expect(readSqliteWidgetHistory(f.db, day)).toEqual({ kind: 'unavailable' });
});
it('[INV-WID-05][INV-WID-10] the native fresh-file origin proof permits actual empty history without a write', () => {
  const f = fixture();
  const before = f.db.get('SELECT total_changes() AS n');
  expect(readSqliteWidgetHistory(f.db, day)).toEqual({
    kind: 'known',
    observedLocalDay: day,
    lifetimeSessions: 0,
    lastCompletedLocalDay: null,
  });
  expect(f.db.get('SELECT total_changes() AS n')).toEqual(before);
});
it('[INV-WID-08][INV-ECO-17] successful zero-XP placement and practice count; failed and quit sessions do not', () => {
  const f = fixture();
  f.receipt('placement', 'placement');
  f.receipt('words', 'hubWords');
  f.receipt('replay', 'legendary', 'replayed');
  f.receipt('fail', 'legendary', 'failed');
  f.receipt('quit', 'lesson', 'quit');
  f.receipt('placement-replay', 'placement', 'replayed');
  expect(readSqliteWidgetHistory(f.db, day)).toEqual({
    kind: 'known',
    observedLocalDay: day,
    lifetimeSessions: 3,
    lastCompletedLocalDay: day,
  });
});
it('[INV-WID-01][INV-DAY-15] last completed streak day uses the retained grace credit, never the completion or freeze day', () => {
  const f = fixture();
  f.receipt('grace', 'lesson', 'completed', '2026-09-12');
  f.receipt('failed-today', 'legendary', 'failed');
  f.db.run(
    "INSERT INTO account_day(local_day,goal_xp,disposition) VALUES('2026-09-13',20,'frozen')",
  );
  expect(readSqliteWidgetHistory(f.db, day)).toMatchObject({
    kind: 'known',
    lifetimeSessions: 1,
    lastCompletedLocalDay: '2026-09-12',
  });
});
it('[INV-WID-01][INV-DAY-14] deferred day keys retain lifetime completion without inventing a completed civil day', () => {
  const f = fixture();
  f.receipt('deferred', 'lesson', 'completed', null);
  expect(readSqliteWidgetHistory(f.db, day)).toMatchObject({
    kind: 'known',
    lifetimeSessions: 1,
    lastCompletedLocalDay: null,
  });
});
it('[INV-WID-10] an unknown legacy receipt invalidates the whole history even after a later stamped completion', () => {
  const f = fixture();
  f.db.run(
    "INSERT INTO committed_session(session_id,committed_at) VALUES('legacy','2026-09-10T12:00:00Z')",
  );
  f.receipt('new');
  expect(readSqliteWidgetHistory(f.db, day)).toEqual({ kind: 'unavailable' });
});
it('[INV-WID-10] future, malformed, unstamped and contradictory receipts never become known history', () => {
  for (const sql of [
    "UPDATE committed_session SET flavour='__proto__'",
    'UPDATE committed_session SET graded_attempts=0',
    'UPDATE committed_session SET derived_completion_utc_ms=NULL',
    "UPDATE committed_session SET committed_at='2026-09-12T00:05:00Z'",
    "UPDATE committed_session SET credited_local_day='2026-09-14'",
    "UPDATE committed_session SET credited_local_day='2026-02-30'",
    'UPDATE committed_session SET day_keying_deferred=1',
    'UPDATE committed_session SET credited_by_grace=1',
    'UPDATE committed_session SET reward_local_day=NULL',
  ]) {
    const f = fixture();
    f.receipt('bad');
    f.db.run(sql);
    expect(readSqliteWidgetHistory(f.db, day), sql).toEqual({ kind: 'unavailable' });
  }
});
it('[INV-WID-01][INV-CRS-03] removing the source course preserves global lifetime history', () => {
  const f = fixture();
  f.receipt('retained');
  f.db.run(
    "INSERT INTO course_progress(course_id,added_at) VALUES('en-es','2026-09-01T00:00:00Z')",
  );
  f.db.run(
    "INSERT INTO course_session_commit_link(session_id,course_id,economy_flavour) VALUES('retained','en-es','lesson')",
  );
  f.db.run("DELETE FROM course_progress WHERE course_id='en-es'");
  expect(f.db.all('SELECT * FROM course_session_commit_link')).toEqual([]);
  expect(readSqliteWidgetHistory(f.db, day)).toMatchObject({
    kind: 'known',
    lifetimeSessions: 1,
    lastCompletedLocalDay: day,
  });
});
