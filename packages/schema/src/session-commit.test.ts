/**
 * INV-ECO-20's schema half: "Every committed session row carries a non-null `active_ms`
 * written in the same exclusive transaction as XP."
 *
 * The falsifier is "a weekly-report figure derived from wall-clock session spans", so the
 * tests below check two different things: that the COLUMN exists and cannot be null, and
 * that the WRITE is atomic with the XP it accompanies.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS, createNodeDb } from '@freelingo/testkit';
import { migrate } from './migrations.js';
import { describeSchema } from './progress-schema.js';
import { activeMsForDay, commitSession, committedSessions } from './session-commit.js';

const RUNS = { numRuns: PROPERTY_RUNS } as const;

function db() {
  const handle = createNodeDb();
  migrate(handle);
  handle.run(
    `INSERT INTO course_progress (course_id, xp, score, score_floor, pack_state, added_at)
     VALUES ('en-es', 0, 0, 0, 'installed', '2026-09-11T00:00:00Z')`,
  );
  return handle;
}

describe('the committed-session ledger', () => {
  it('[INV-ECO-20] the committed session row carries a NOT NULL active_ms column', () => {
    const handle = db();
    const table = describeSchema(handle).get('committed_session');
    const column = table?.columns.find((c) => c.name === 'active_ms');
    expect(column, 'committed_session.active_ms is where INV-ECO-20 lives').toBeDefined();
    expect(column?.notNull).toBe(true);
    expect(column?.type).toBe('INTEGER');
    // The database refuses a null, so "non-null" is not a habit of the writer.
    expect(() =>
      handle.run(
        `INSERT INTO committed_session (session_id, committed_at, active_ms) VALUES ('x', 'y', NULL)`,
      ),
    ).toThrow(/NOT NULL/i);
    handle.close();
  });

  it('[INV-ECO-20] active_ms and XP land in ONE exclusive transaction, or neither lands', () => {
    const handle = db();
    commitSession(handle, {
      sessionId: 's1',
      courseId: 'en-es',
      localDay: '2026-09-11',
      flavour: 'lesson',
      committedAtUtc: '2026-09-11T20:00:00Z',
      xpAwarded: 14,
      activeMs: 183_000,
    });
    const rows = committedSessions(handle);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.active_ms).toBe(183_000);
    expect(rows[0]?.xp_awarded).toBe(14);
    expect(handle.get<{ lifetime_xp: number }>('SELECT lifetime_xp FROM account')?.lifetime_xp).toBe(
      14,
    );
    expect(handle.get<{ xp: number }>('SELECT xp FROM course_progress')?.xp).toBe(14);

    // A kill inside the transaction leaves NOTHING: no ledger row, no XP.
    expect(() =>
      handle.withExclusiveTransaction(() => {
        handle.run('UPDATE account SET lifetime_xp = lifetime_xp + 99 WHERE id = 1');
        throw new Error('killed mid-ceremony');
      }),
    ).toThrow(/killed mid-ceremony/);
    expect(handle.get<{ lifetime_xp: number }>('SELECT lifetime_xp FROM account')?.lifetime_xp).toBe(
      14,
    );
    handle.close();
  });

  it('[INV-ECO-20] the minutes figure is a SUM OF STORED COLUMNS, never of wall-clock spans', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            activeMs: fc.integer({ min: 0, max: 900_000 }),
            gapMs: fc.integer({ min: 0, max: 86_400_000 }),
            xp: fc.integer({ min: 0, max: 60 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (sessions) => {
          const handle = db();
          let clock = Date.parse('2026-09-11T08:00:00Z');
          let expected = 0;
          sessions.forEach((session, index) => {
            // The wall-clock span between commits is ARBITRARY — a phone in a pocket
            // between two lessons. A report that derives minutes from it is the falsifier.
            clock += session.gapMs;
            commitSession(handle, {
              sessionId: `s_${index}`,
              courseId: 'en-es',
              localDay: '2026-09-11',
              flavour: 'lesson',
              committedAtUtc: new Date(clock).toISOString(),
              xpAwarded: session.xp,
              activeMs: session.activeMs,
            });
            expected += session.activeMs;
          });
          expect(activeMsForDay(handle, '2026-09-11')).toBe(expected);
          handle.close();
        },
      ),
      RUNS,
    );
  });

  it('[INV-CER-01] a replayed commit is idempotent: the ledger row is the idempotency key', () => {
    const handle = db();
    const commit = {
      sessionId: 's1',
      courseId: 'en-es',
      localDay: '2026-09-11',
      flavour: 'lesson',
      committedAtUtc: '2026-09-11T20:00:00Z',
      xpAwarded: 14,
      activeMs: 100_000,
    };
    expect(commitSession(handle, commit).committed).toBe(true);
    const again = commitSession(handle, commit);
    expect(again.committed).toBe(false);
    expect(again.alreadyCommitted).toBe(true);
    expect(handle.get<{ lifetime_xp: number }>('SELECT lifetime_xp FROM account')?.lifetime_xp).toBe(
      14,
    );
    handle.close();
  });

  it('[INV-ECO-20] a negative or non-finite active_ms is floored to 0, never stored', () => {
    const handle = db();
    commitSession(handle, {
      sessionId: 's_bad',
      courseId: 'en-es',
      localDay: '2026-09-11',
      flavour: 'lesson',
      committedAtUtc: '2026-09-11T20:00:00Z',
      xpAwarded: Number.NaN,
      activeMs: -5_000,
    });
    const row = committedSessions(handle)[0];
    expect(row?.active_ms).toBe(0);
    expect(row?.xp_awarded).toBe(0);
    handle.close();
  });
});
