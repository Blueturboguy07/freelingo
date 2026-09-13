import { expect, it } from 'vitest';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { migrate } from '@freelingo/schema';
import { readSqliteWidgetAccount } from './SqliteWidgetSource';

it('[INV-WID-10] a database with no explicit history authority never becomes a known-empty widget', () => {
  const db = createNodeDb();
  try {
    migrate(db);
    expect(
      readSqliteWidgetAccount(
        db,
        { nowMs: 0, zone: 'UTC' },
        { kind: 'unavailable' },
        { courseId: 'en-es', activeNodeId: null, hasResumableSession: false },
      ),
    ).toEqual({ kind: 'unavailable', reason: 'unknown-history' });
  } finally {
    db.close();
  }
});
it('[INV-WID-10] missing settled account/day/selection facts fail closed across schema versions', () => {
  const db = createNodeDb();
  try {
    migrate(db);
    const result = readSqliteWidgetAccount(
      db,
      { nowMs: 0, zone: 'UTC' },
      {
        kind: 'known',
        observedLocalDay: '1970-01-01',
        lifetimeSessions: 0,
        lastCompletedLocalDay: null,
      },
      { courseId: 'en-es', activeNodeId: null, hasResumableSession: false },
    );
    expect(result.kind).toBe('unavailable');
  } finally {
    db.close();
  }
});
