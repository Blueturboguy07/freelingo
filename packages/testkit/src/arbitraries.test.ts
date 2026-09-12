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
import {
  arbAttemptHistory,
  arbPackManifest,
  arbSession,
  arbSessionQueue,
  twoCourseFixture,
} from './engine-arbitraries.js';
import { seededPrng } from './prng.js';
import {
  EXERCISE_TYPES,
  NON_PUNITIVE_EXERCISE_TYPES,
  SESSION_FLAVOURS,
  SESSION_OUTCOMES,
} from '../../core/src/types/index.js';

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

/**
 * Shape floors for the engine generators (P1).
 *
 * Same rule as above, applied to every new generator: a property is only as good as the
 * share of its cases that could falsify the invariant. Each floor below is measured at
 * SAMPLES and set well under the measurement so a fast-check seed change cannot flake it.
 * A generator added without a floor here is a generator nobody has looked at.
 */
describe('engine arbitraries have shape floors', () => {
  const share = <T>(items: readonly T[], predicate: (item: T) => boolean) =>
    items.filter(predicate).length / items.length;

  it('arbSessionQueue reaches the ordinary lesson length and the long-test length', () => {
    const queues = fc.sample(arbSessionQueue(), SAMPLES);
    expect(share(queues, (q) => q.length >= 9 && q.length <= 14)).toBeGreaterThan(0.35);
    expect(share(queues, (q) => q.length >= 15)).toBeGreaterThan(0.1);
    expect(share(queues, (q) => q.length <= 5)).toBeGreaterThan(0.1);
  });

  it('arbSessionQueue produces every exercise type, punitive and non-punitive alike', () => {
    const seen = new Set<string>();
    for (const queue of fc.sample(arbSessionQueue(), 2_000)) {
      for (const exercise of queue) seen.add(exercise.exerciseType);
    }
    expect([...seen].sort()).toEqual([...EXERCISE_TYPES].sort());
  });

  it('arbSessionQueue reaches an all-non-punitive queue, which INV-ECO-33 is about', () => {
    // A queue of nothing but speak/readRespond/character is where accuracy is undefined.
    // It is rare by construction (3 of 11 types), so the floor is low and non-zero: at
    // zero, the Sharpshooter property would never see the case it exists for.
    const queues = fc.sample(arbSessionQueue(), SAMPLES);
    const allNonPunitive = queues.filter(
      (q) => q.length > 0 && q.every((e) => NON_PUNITIVE_EXERCISE_TYPES.includes(e.exerciseType)),
    );
    expect(allNonPunitive.length).toBeGreaterThan(0);
  });

  it('arbAttemptHistory is dense enough in first-try misses to move a mistake queue', () => {
    const histories = fc.sample(arbAttemptHistory(), 5_000);
    expect(
      share(histories, (h) => h.some((a) => a.verdict === 'incorrect' && a.firstTry)),
    ).toBeGreaterThan(0.5);
    // ... and still produces the flawless session the perfect-lesson rules need.
    expect(
      share(histories, (h) => h.length > 0 && h.every((a) => a.verdict !== 'incorrect')),
    ).toBeGreaterThan(0.002);
  });

  it('arbAttemptHistory keys every row (session_id, exercise_index) with no gaps', () => {
    for (const history of fc.sample(arbAttemptHistory(), 1_000)) {
      const ids = new Set(history.map((a) => a.sessionId));
      expect(ids.size).toBeLessThanOrEqual(1);
      history.forEach((attempt, index) => expect(attempt.exerciseIndex).toBe(index));
    }
  });

  it('arbSession covers every flavour and every outcome', () => {
    const sessions = fc.sample(arbSession(), SAMPLES);
    expect(new Set(sessions.map((s) => s.flavour)).size).toBe(SESSION_FLAVOURS.length);
    expect(new Set(sessions.map((s) => s.outcome)).size).toBe(SESSION_OUTCOMES.length);
    // A combo high enough to reach the bonus cap (15 in a row) must be reachable.
    expect(share(sessions, (s) => s.maxCombo >= 15)).toBeGreaterThan(0.1);
  });

  it('arbPackManifest reaches both sides of the 2% defect gate and both CEFR arms', () => {
    const manifests = fc.sample(arbPackManifest(), SAMPLES);
    expect(share(manifests, (m) => m.defectRate <= 0.02)).toBeGreaterThan(0.2);
    expect(share(manifests, (m) => m.defectRate > 0.02)).toBeGreaterThan(0.2);
    expect(share(manifests, (m) => m.cefrChecked)).toBeGreaterThan(0.3);
  });

  it('the two-course fixture shares ids between courses, so a SUM cannot pass for a UNION', () => {
    const fixture = twoCourseFixture();
    expect(fixture.courses).toHaveLength(2);
    expect(fixture.sharedItemIds.length).toBeGreaterThan(0);
    const rowSum = fixture.courses.reduce((n, c) => n + c.introducedItemIds.length, 0);
    expect(rowSum).toBeGreaterThan(fixture.distinctIntroducedCount);
  });
});

describe('seededPrng', () => {
  it('is deterministic for a seed and different across seeds', () => {
    const a = seededPrng('freelingo').shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = seededPrng('freelingo').shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    const c = seededPrng('freelingo-2').shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('covers its integer range end to end', () => {
    const prng = seededPrng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i += 1) seen.add(prng.int(0, 9));
    expect(seen.size).toBe(10);
  });
});
