import { describe, expect, it } from 'vitest';
import { createNodeDb } from '@freelingo/testkit';
import { planCommit } from '@freelingo/core';
import { LATEST_USER_VERSION, migrate } from './migrations.js';
import {
  EXCLUDED_PLATFORMS,
  PACK_DB_LOCATION,
  PERSISTENT_PLATFORMS,
  PROGRESS_DB_LOCATION,
  isPersistencePlatformSupported,
} from './paths.js';

function freshDb() {
  const db = createNodeDb();
  migrate(db);
  return db;
}

/** The whole reward commit, as one exclusive transaction keyed by session_id. */
function commitSession(
  db: ReturnType<typeof createNodeDb>,
  outcome: { sessionId: string; xp: number; gems: number },
  options: { failMidway?: boolean } = {},
): boolean {
  const committed = db
    .all<{ session_id: string }>('SELECT session_id FROM committed_session')
    .map((r) => r.session_id);
  const delta = planCommit(outcome, committed);
  if (delta === null) return false;
  db.withExclusiveTransaction(() => {
    db.run('UPDATE account SET xp = xp + ?, gems = gems + ? WHERE id = 1', [delta.xp, delta.gems]);
    if (options.failMidway) throw new Error('killed mid-ceremony');
    db.run('INSERT INTO committed_session (session_id, committed_at) VALUES (?, ?)', [
      delta.sessionId,
      '2026-09-11T00:00:00Z',
    ]);
  });
  return true;
}

describe('migrations + reward commit', () => {
  it('migrates a fresh database to the latest user_version', () => {
    const db = freshDb();
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(
      LATEST_USER_VERSION,
    );
    db.close();
  });

  it('[INV-CER-01] the reward commit is one exclusive transaction: a kill leaves nothing applied', () => {
    const db = freshDb();
    expect(() =>
      commitSession(db, { sessionId: 's1', xp: 20, gems: 5 }, { failMidway: true }),
    ).toThrow(/killed mid-ceremony/);
    const account = db.get<{ xp: number; gems: number }>(
      'SELECT xp, gems FROM account WHERE id = 1',
    );
    expect(account).toEqual({ xp: 0, gems: 0 });
    expect(db.all('SELECT session_id FROM committed_session')).toEqual([]);
    db.close();
  });

  it('[INV-CER-01] replaying a committed session awards nothing extra', () => {
    const db = freshDb();
    expect(commitSession(db, { sessionId: 's1', xp: 20, gems: 5 })).toBe(true);
    expect(commitSession(db, { sessionId: 's1', xp: 20, gems: 5 })).toBe(false);
    expect(commitSession(db, { sessionId: 's1', xp: 999, gems: 999 })).toBe(false);
    const account = db.get<{ xp: number; gems: number }>(
      'SELECT xp, gems FROM account WHERE id = 1',
    );
    expect(account).toEqual({ xp: 20, gems: 5 });
    db.close();
  });
});

describe('persistence layout', () => {
  it('[INV-PER-06] progress lives in the document region and packs in cache, excluded from backup', () => {
    expect(PROGRESS_DB_LOCATION.region).toBe('document');
    expect(PROGRESS_DB_LOCATION.excludedFromBackup).toBe(false);
    expect(PACK_DB_LOCATION.region).toBe('cache');
    expect(PACK_DB_LOCATION.excludedFromBackup).toBe(true);
  });

  it('[INV-PER-06] the persistence gate names its platforms and excludes tvOS explicitly', () => {
    expect(PERSISTENT_PLATFORMS).toEqual(['ios', 'android']);
    expect(EXCLUDED_PLATFORMS).toContain('tvos');
    expect(isPersistencePlatformSupported('ios')).toBe(true);
    expect(isPersistencePlatformSupported('android')).toBe(true);
    expect(isPersistencePlatformSupported('tvos')).toBe(false);
  });
});
