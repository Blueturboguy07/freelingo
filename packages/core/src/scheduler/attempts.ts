/**
 * The attempt ledger (INV-SCH-03).
 *
 * "Attempt rows are written exactly once per answered exercise, keyed by
 * `(session_id, exercise_index)`; replay of any commit is idempotent."
 *
 * Plan §Data model: "Attempts are append-only events keyed `(session_id, exercise_index)`;
 * every counter is recomputable from them." Two consequences this file enforces:
 *
 * - FIRST WRITE WINS. A replayed commit whose payload differs — a retried network-free
 *   write, a resumed session that re-grades, `START OVER` after an abandoned session
 *   (EC-SCH-03, EC-SES-03) — must not overwrite the row that is already there, because
 *   every counter downstream was computed from that row. Overwriting is not idempotent;
 *   it is a silent correction.
 * - ORDER IS THE LEDGER'S OWN. Rows keep insertion order, so `attemptsForSession` returns
 *   what happened rather than what the map happens to iterate.
 *
 * `@freelingo/schema` owns the transaction that persists this; the engine decides what a
 * commit contains, exactly as `ceremony/commit.ts` does for rewards.
 */
import type { Grade, ItemId, ReviewKind, SessionId, Surface } from './types.js';

export interface AttemptRow {
  readonly sessionId: SessionId;
  readonly exerciseIndex: number;
  readonly itemId: ItemId;
  readonly surface: Surface;
  readonly grade: Grade;
  readonly at: Date;
  /** What the scheduler did with it. `early` and `uncredited` are still attempts. */
  readonly reviewKind: ReviewKind;
}

/** `(session_id, exercise_index)`, the one key an attempt has. */
export type AttemptKey = string & { readonly __brand: 'AttemptKey' };

export function attemptKeyOf(sessionId: SessionId, exerciseIndex: number): AttemptKey {
  return `${sessionId}\u001f${exerciseIndex}` as AttemptKey;
}

export interface AttemptLedger {
  /** Insertion-ordered. A `Map` keeps that guarantee; a plain object does not. */
  readonly rows: ReadonlyMap<AttemptKey, AttemptRow>;
}

export const EMPTY_ATTEMPT_LEDGER: AttemptLedger = { rows: new Map() };

export function attemptLedgerOf(rows: Iterable<AttemptRow> = []): AttemptLedger {
  return commitAttempts(EMPTY_ATTEMPT_LEDGER, rows);
}

/**
 * Append one attempt. Already present -> the ledger is returned unchanged, by identity.
 *
 * Returning the same object rather than an equal one matters: a caller that commits a
 * replayed session can test `next === prev` and skip the whole write.
 */
export function appendAttempt(ledger: AttemptLedger, row: AttemptRow): AttemptLedger {
  const key = attemptKeyOf(row.sessionId, row.exerciseIndex);
  if (ledger.rows.has(key)) return ledger;
  const rows = new Map(ledger.rows);
  rows.set(key, row);
  return { rows };
}

/** Commit a batch. Idempotent as a whole and per row, in any order, any number of times. */
export function commitAttempts(ledger: AttemptLedger, rows: Iterable<AttemptRow>): AttemptLedger {
  let next = ledger;
  for (const row of rows) next = appendAttempt(next, row);
  return next;
}

export function hasAttempt(
  ledger: AttemptLedger,
  sessionId: SessionId,
  exerciseIndex: number,
): boolean {
  return ledger.rows.has(attemptKeyOf(sessionId, exerciseIndex));
}

export function attemptCount(ledger: AttemptLedger): number {
  return ledger.rows.size;
}

/** Every attempt of one session, in the order they were written. */
export function attemptsForSession(ledger: AttemptLedger, sessionId: SessionId): AttemptRow[] {
  return [...ledger.rows.values()].filter((row) => row.sessionId === sessionId);
}

/**
 * The rows of `batch` this ledger has not seen — what a commit would actually write.
 *
 * The session module needs this to decide whether a commit is a no-op before it opens a
 * transaction, and the property that "replay of any commit is idempotent" is most cheaply
 * stated as "the second call to this returns nothing".
 */
export function pendingAttempts(ledger: AttemptLedger, batch: readonly AttemptRow[]): AttemptRow[] {
  const seen = new Set<AttemptKey>(ledger.rows.keys());
  const pending: AttemptRow[] = [];
  for (const row of batch) {
    const key = attemptKeyOf(row.sessionId, row.exerciseIndex);
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(row);
  }
  return pending;
}
