/**
 * Reward commit planning (INV-CER-01 seed).
 *
 * The entire reward commit is ONE exclusive transaction keyed by `session_id`.
 * The engine only decides *what* to apply; `@freelingo/schema` owns the transaction that
 * applies it. Replay of an already-committed session awards nothing extra.
 * The full ordered predicate queue (bundle screen, scope, tiers) lands in P1/P4.
 */

export interface SessionOutcome {
  readonly sessionId: string;
  readonly xp: number;
  readonly gems: number;
}

export interface LedgerDelta {
  readonly sessionId: string;
  readonly xp: number;
  readonly gems: number;
}

/**
 * Returns the delta to apply, or `null` when this session_id has already been committed.
 * Pure: no clock, no I/O.
 */
export function planCommit(
  outcome: SessionOutcome,
  committedSessionIds: Iterable<string>,
): LedgerDelta | null {
  const committed = new Set(committedSessionIds);
  if (committed.has(outcome.sessionId)) return null;
  return { sessionId: outcome.sessionId, xp: outcome.xp, gems: outcome.gems };
}
