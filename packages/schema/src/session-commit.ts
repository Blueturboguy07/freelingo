/**
 * The reward commit, at the schema level — INV-ECO-20 and INV-CER-01's write half.
 *
 * INV-ECO-20: "Every committed session row carries a non-null `active_ms` written in the
 * same exclusive transaction as XP." Two claims, both about the WRITE:
 *
 *  1. the ledger row and every counter it moves land together or not at all, so a kill
 *     mid-ceremony leaves the ledger fully applied or fully unapplied (INV-CER-01); and
 *  2. `active_ms` is on the session row, not recomputed from spans at render time, which
 *     is the figure EC-ECO-23's falsifier ("a weekly-report figure derived from wall-clock
 *     session spans") is about.
 *
 * `withExclusiveTransaction`, never a deferred one (INV-PER-07): the deferred spelling
 * admits a second writer and can roll back under a caller who believed it committed, and
 * the reward commit is the one place in the app where that is unrecoverable because the
 * ceremony has already been shown.
 *
 * Idempotent on `session_id`: replaying a commit after a kill writes nothing and reports
 * `alreadyCommitted`, so the ceremony can be re-entered safely.
 */
import type { Db, DbRow } from './db.js';

export interface SessionCommit {
  readonly sessionId: string;
  readonly courseId: string;
  readonly localDay: string;
  readonly flavour: string;
  readonly committedAtUtc: string;
  /** The award the engine decided. Never recomputed here. */
  readonly xpAwarded: number;
  /**
   * Foregrounded, challenge-on-screen milliseconds (INV-ECO-20). Non-null by the column's
   * own constraint; negative and non-finite values are floored to 0 rather than stored.
   */
  readonly activeMs: number;
}

export interface SessionCommitResult {
  readonly committed: boolean;
  readonly alreadyCommitted: boolean;
}

/**
 * Commit one session: the ledger row, `account.lifetime_xp` and `course_progress.xp`, in
 * ONE exclusive transaction.
 *
 * The two XP counters of INV-ECO-13 move together and are the only two that exist:
 * `account.lifetime_xp` survives course removal and feeds Sage; `course_progress.xp` is
 * destroyed with the course by the region cascade.
 */
export function commitSession(db: Db, commit: SessionCommit): SessionCommitResult {
  const existing = db.get<{ session_id: string }>(
    'SELECT session_id FROM committed_session WHERE session_id = ?',
    [commit.sessionId],
  );
  if (existing !== undefined) return { committed: false, alreadyCommitted: true };

  const activeMs =
    Number.isFinite(commit.activeMs) && commit.activeMs > 0 ? Math.round(commit.activeMs) : 0;
  const xp =
    Number.isFinite(commit.xpAwarded) && commit.xpAwarded > 0 ? Math.round(commit.xpAwarded) : 0;

  db.withExclusiveTransaction(() => {
    db.run(
      `INSERT INTO committed_session (session_id, committed_at, active_ms, xp_awarded, local_day, flavour)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [commit.sessionId, commit.committedAtUtc, activeMs, xp, commit.localDay, commit.flavour],
    );
    db.run('UPDATE account SET lifetime_xp = lifetime_xp + ? WHERE id = 1', [xp]);
    db.run('UPDATE course_progress SET xp = xp + ? WHERE course_id = ?', [xp, commit.courseId]);
  });
  return { committed: true, alreadyCommitted: false };
}

export interface CommittedSessionRow extends DbRow {
  readonly session_id: string;
  readonly committed_at: string;
  readonly active_ms: number;
  readonly xp_awarded: number;
  readonly local_day: string | null;
  readonly flavour: string | null;
}

export function committedSessions(db: Db): CommittedSessionRow[] {
  return db.all<CommittedSessionRow>(
    'SELECT session_id, committed_at, active_ms, xp_awarded, local_day, flavour FROM committed_session ORDER BY session_id',
  );
}

/**
 * The minutes-shaped total every weekly-report string reads (INV-ECO-20).
 *
 * It is a SUM OF STORED COLUMNS, not of wall-clock spans reconstructed at render time.
 * That distinction is the whole invariant, so the query lives here rather than in a view
 * layer where the temptation to use `committed_at` differences would be one line away.
 */
export function activeMsForDay(db: Db, localDay: string): number {
  const row = db.get<{ total: number | null }>(
    'SELECT SUM(active_ms) AS total FROM committed_session WHERE local_day = ?',
    [localDay],
  );
  return row?.total ?? 0;
}
