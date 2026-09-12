/**
 * The clamp that stands between the device clock and FSRS (INV-SCH-02).
 *
 * EC-SCH-02: "Clamp elapsed-since-last-review to >= 0 BEFORE it reaches the scheduler and
 * record the anomaly. A negative or absurd interval silently inflates stability and pushes
 * a weak item months out — the one place tampering causes lasting harm rather than a
 * missed chest."
 *
 * Measured against ts-fsrs 5.4.2 on 2026-09-11, with a card last reviewed 163 days ago:
 *
 *   now - 1 day   -> S 496.41 (the honest answer at that instant is 499.34)
 *   now - 7 days  -> S 487.48
 *   now - 365 days-> throws `Invalid delta_t "-202"`
 *
 * So an unclamped backward clock does not merely perturb the model, it eventually throws
 * from inside the library mid-commit. Neither outcome is acceptable in the one subsystem
 * whose faults are permanent, and neither is visible to the learner.
 *
 * The clamp has a second jaw, the upper one. Clamping only at zero leaves the clock set
 * FORWARD, which is the direction that inflates: measured on the same card, +10 years
 * takes stability from 499 to 1,622 and +274 years to 2,781. `MAX_HONEST_ELAPSED_DAYS`
 * (config.ts) is the ceiling, and crossing it writes its own anomaly kind.
 */
import { MAX_HONEST_ELAPSED_MS } from './config.js';
import type { AnomalyRow, FsrsRowKey } from './types.js';

export interface ElapsedInput {
  /** When the row was last credited. `null` for a row that has never been reviewed. */
  readonly lastReviewAt: Date | null;
  /** The instant the answer was submitted, as the device reports it. */
  readonly now: Date;
  /** Milliseconds inside `[lastReviewAt, now)` the row spent held (`holds.ts`). */
  readonly heldMs: number;
  readonly rowKey: FsrsRowKey;
}

export interface ElapsedResult {
  /** What the device claimed. Negative when the clock went backwards. */
  readonly rawElapsedMs: number;
  /** After the two-sided clamp, before holds. */
  readonly clampedElapsedMs: number;
  /** What actually reaches FSRS: the clamped elapsed minus the held measure. */
  readonly effectiveElapsedMs: number;
  readonly heldMs: number;
  /** One row per clamp. Empty when the clock was honest and nothing was held. */
  readonly anomalies: readonly AnomalyRow[];
}

export function resolveElapsed(input: ElapsedInput): ElapsedResult {
  const { lastReviewAt, now, rowKey } = input;
  const raw = lastReviewAt === null ? 0 : now.getTime() - lastReviewAt.getTime();
  const anomalies: AnomalyRow[] = [];

  let clamped = raw;
  if (clamped < 0) {
    anomalies.push({
      kind: 'negativeElapsed',
      rowKey,
      at: now,
      observedMs: raw,
      usedMs: 0,
      note: 'device clock moved backwards since the last review; elapsed clamped to 0',
    });
    clamped = 0;
  } else if (clamped > MAX_HONEST_ELAPSED_MS) {
    anomalies.push({
      kind: 'implausibleElapsed',
      rowKey,
      at: now,
      observedMs: raw,
      usedMs: MAX_HONEST_ELAPSED_MS,
      note: 'elapsed exceeds one maximum scheduling interval; clamped to the honest ceiling',
    });
    clamped = MAX_HONEST_ELAPSED_MS;
  }

  // A hold can never remove more time than actually passed: `heldMs` is measured inside
  // `[lastReviewAt, now)` by construction, but the clamp above may have shortened that
  // interval, and a caller can always pass nonsense.
  const held = Math.min(Math.max(0, input.heldMs), clamped);
  return {
    rawElapsedMs: raw,
    clampedElapsedMs: clamped,
    effectiveElapsedMs: clamped - held,
    heldMs: held,
    anomalies,
  };
}
