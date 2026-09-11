/**
 * The generators are the other half of the gate.
 *
 * 10,000 cases of a generator that cannot produce the interesting shape is 10,000 cases
 * of nothing. The first four-zone streak property drew 40 dates out of a four-year span
 * and hit a streak anchored at today-or-yesterday in 2.8% of cases — it ran green, fast,
 * and tested essentially the empty history. These floors are measured (20,000 samples,
 * 2026-09-11) and set well below the measurement so a seed change cannot flake them.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { arbDayOffsets, ARBITRARY_HISTORY_PAST_DAYS } from './arbitraries.js';

/** Named config: how often a generated history must be able to falsify a streak rule. */
const SAMPLES = 20_000;
const MIN_ANCHORED_SHARE = 0.45; // measured 65.9%
const MIN_RUN_OF_THREE_SHARE = 0.2; // measured 35.0%
const MIN_RUN_OF_TEN_SHARE = 0.08; // measured 20.5%

/** Length of the contiguous run ending at offset 0 or -1, 0 when there is none. */
function runLength(offsets: readonly number[]): number {
  const set = new Set(offsets);
  const anchor = set.has(0) ? 0 : set.has(-1) ? -1 : null;
  if (anchor === null) return 0;
  let length = 0;
  for (let cursor = anchor; set.has(cursor); cursor -= 1) length += 1;
  return length;
}

describe('arbDayOffsets', () => {
  const lengths = fc.sample(arbDayOffsets(), SAMPLES).map(runLength);
  const share = (predicate: (n: number) => boolean) =>
    lengths.filter(predicate).length / lengths.length;

  it('generates a streak anchored at today or yesterday in most cases', () => {
    expect(share((n) => n > 0)).toBeGreaterThan(MIN_ANCHORED_SHARE);
  });

  it('generates runs long enough to break a rule that only looks one day back', () => {
    expect(share((n) => n >= 3)).toBeGreaterThan(MIN_RUN_OF_THREE_SHARE);
    expect(share((n) => n >= 10)).toBeGreaterThan(MIN_RUN_OF_TEN_SHARE);
  });

  it('still generates the empty and unanchored histories', () => {
    expect(share((n) => n === 0)).toBeGreaterThan(0.05);
    expect(lengths.some((n) => n === 0)).toBe(true);
  });

  it('stays inside the declared window, so every case is cheap', () => {
    for (const offsets of fc.sample(arbDayOffsets(), 2_000)) {
      for (const offset of offsets) {
        expect(offset).toBeLessThanOrEqual(ARBITRARY_HISTORY_PAST_DAYS);
        expect(offset).toBeGreaterThanOrEqual(-2 * ARBITRARY_HISTORY_PAST_DAYS);
      }
    }
  });
});
