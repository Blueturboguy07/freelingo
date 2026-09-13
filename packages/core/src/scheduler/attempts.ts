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
 * Explicit target children (2026-09-13 integration) retain that one parent while
 * giving each verified MATCH semantic target its own FSRS idempotency key. A parent
 * without explicit target evidence keeps the historical first-write-wins behavior.
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
  /** Explicit signed target identity; absent for historical single-target callers. */
  readonly targetSurfaceId?: string;
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
  /** Scheduling children; parent rows above remain one per answered exercise. */
  readonly targetRows: ReadonlyMap<AttemptKey, AttemptRow>;
}

export const EMPTY_ATTEMPT_LEDGER: AttemptLedger = { rows: new Map(), targetRows: new Map() };

/** A target is independently idempotent inside its one parent accuracy attempt. */
export function attemptTargetKeyOf(
  row: Pick<AttemptRow, 'sessionId' | 'exerciseIndex' | 'itemId'> & {
    readonly targetSurfaceId: string;
  },
): AttemptKey {
  if (typeof row.targetSurfaceId !== 'string' || row.targetSurfaceId.trim().length === 0)
    throw new RangeError('Scheduler target surface identity is required.');
  return JSON.stringify([
    row.sessionId,
    row.exerciseIndex,
    row.itemId,
    row.targetSurfaceId,
  ]) as AttemptKey;
}

export function hasEncounter(
  ledger: AttemptLedger,
  row: Pick<AttemptRow, 'sessionId' | 'exerciseIndex' | 'itemId' | 'targetSurfaceId'>,
): boolean {
  const parent = ledger.rows.get(attemptKeyOf(row.sessionId, row.exerciseIndex));
  if (row.targetSurfaceId === undefined) return parent !== undefined;
  const key = attemptTargetKeyOf({ ...row, targetSurfaceId: row.targetSurfaceId });
  // A historical parent has no target set: it must never be replayed as new children.
  return (
    (parent !== undefined && parent.targetSurfaceId === undefined) || ledger.targetRows.has(key)
  );
}

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
  if (hasEncounter(ledger, row)) return ledger;
  const parentKey = attemptKeyOf(row.sessionId, row.exerciseIndex);
  const rows = new Map(ledger.rows);
  if (!rows.has(parentKey)) rows.set(parentKey, row);
  if (row.targetSurfaceId === undefined) return { rows, targetRows: ledger.targetRows };
  const targetRows = new Map(ledger.targetRows);
  targetRows.set(attemptTargetKeyOf({ ...row, targetSurfaceId: row.targetSurfaceId }), row);
  return { rows, targetRows };
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
  let seen = ledger;
  const pending: AttemptRow[] = [];
  for (const row of batch) {
    const next = appendAttempt(seen, row);
    if (next === seen) continue;
    seen = next;
    pending.push(row);
  }
  return pending;
}
