/**
 * Failed Legendary and failed jump-here.
 *
 * INV-PATH-04 / EC-PTH-05, EC-PTH-08: failing changes **no persistent state except an
 * attempt log**, and the retry is immediately available at zero cost. Failure is
 * non-punitive and retryable - `Try again with fewer mistakes to get closer to Legendary`
 * (str:1214), `You didn't unlock Unit {{n}}, but you can try again later!` (str:2704).
 *
 * Freelingo ships the Super variant, so there is no gem price, no attempt cap and no
 * heart wall: "zero cost" is the whole point, not a discount.
 */
import type { PathModel } from './types.js';

export type AttemptKind = 'legendary' | 'jumpHere' | 'sectionTest';

export interface AttemptRecord {
  readonly kind: AttemptKind;
  readonly nodeId: string;
  readonly localDay: number;
  readonly passed: boolean;
  /** Did the run reach the mid-challenge checkpoint? Drives consolation XP. */
  readonly reachedCheckpoint: boolean;
}

export interface AttemptLog {
  readonly records: readonly AttemptRecord[];
}

export const EMPTY_ATTEMPT_LOG: AttemptLog = { records: [] };

export interface Retry {
  readonly available: boolean;
  readonly costGems: number;
  /** Retained challenge progress. Always none (EC-PTH-27: `deep/02` EC11 wins). */
  readonly retainedProgress: null;
}

export interface FailedAttemptResult {
  readonly model: PathModel;
  readonly log: AttemptLog;
  readonly retry: Retry;
}

/**
 * Record a failed attempt. `model` comes back **by reference** when nothing changed, so a
 * test can assert identity rather than deep equality - the strongest available form of
 * "changes no persistent state".
 */
export function recordFailedAttempt(
  model: PathModel,
  log: AttemptLog,
  record: AttemptRecord,
): FailedAttemptResult {
  return {
    model,
    log: { records: [...log.records, { ...record, passed: false }] },
    retry: { available: true, costGems: 0, retainedProgress: null },
  };
}

/**
 * EC-PTH-27: the checkpoint consolation is paid at most once per node per local day, or
 * unlimited free attempts make checkpoint-abandon a ~20 XP/minute farm.
 */
export function consolationPayable(log: AttemptLog, nodeId: string, localDay: number): boolean {
  return !log.records.some(
    (r) => r.nodeId === nodeId && r.localDay === localDay && r.reachedCheckpoint && !r.passed,
  );
}
