/**
 * INV-GRD-06 — the accuracy denominator.
 *
 * The one the invariant registry calls out by name: "It is what makes 'speaking is
 * skippable' true rather than merely advertised."
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';

import {
  accuracyOf,
  isPerfectLesson,
  isScorable,
  NON_SCORABLE_FAMILIES,
  NON_SCORABLE_OUTCOMES,
} from './accuracy.js';
import type { AttemptOutcome, AttemptRow, ItemFamily } from './types.js';

const FAMILIES: readonly ItemFamily[] = [
  'typed-translate',
  'word-bank',
  'gap-fill',
  'match',
  'select',
  'listening',
  'speaking',
  'character-trace',
  'character-select',
  'read-and-respond',
  'listen-and-respond',
];

const OUTCOMES: readonly AttemptOutcome[] = [
  'graded',
  'skipped-speaking',
  'skipped-listening',
  'failed-speak',
  'trace-completed',
];

const arbAttempt = (): fc.Arbitrary<AttemptRow> =>
  fc.record({
    itemId: fc.constantFrom('i1', 'i2', 'i3', 'i4', 'i5'),
    family: fc.constantFrom(...FAMILIES),
    outcome: fc.constantFrom(...OUTCOMES),
    wrong: fc.boolean(),
    softCorrected: fc.boolean(),
  });

describe('accuracy', () => {
  it('[INV-GRD-06] the exclusions are exactly the ones the invariant names', () => {
    expect([...NON_SCORABLE_FAMILIES].sort()).toEqual([
      'character-trace',
      'listen-and-respond',
      'read-and-respond',
    ]);
    expect([...NON_SCORABLE_OUTCOMES].sort()).toEqual([
      'failed-speak',
      'skipped-listening',
      'skipped-speaking',
      'trace-completed',
    ]);
  });

  it('[INV-GRD-06] accuracy = correctFirstTry / scorable, and both agree with a reference count', () => {
    fc.assert(
      fc.property(fc.array(arbAttempt(), { maxLength: 14 }), (attempts) => {
        const summary = accuracyOf(attempts);
        // Independent reference, written from the invariant text: gradeable items
        // PRESENTED, once each, so first-attempt-per-item after the exclusions.
        const seen = new Set<string>();
        const firsts: AttemptRow[] = [];
        for (const attempt of attempts) {
          if (seen.has(attempt.itemId)) continue;
          seen.add(attempt.itemId);
          firsts.push(attempt);
        }
        const scorable = firsts.filter(isScorable);
        expect(summary.scorable).toBe(scorable.length);
        expect(summary.correctFirstTry).toBe(scorable.filter((a) => !a.wrong).length);
        if (scorable.length === 0) {
          // UNDEFINED, never 0%. The whole invariant is in this branch.
          expect(summary.accuracy).toBeUndefined();
          expect(summary.accuracy).not.toBe(0);
          expect(summary.renderTile).toBe(false);
        } else {
          expect(summary.renderTile).toBe(true);
          expect(summary.accuracy).toBeCloseTo(
            scorable.filter((a) => !a.wrong).length / scorable.length,
            12,
          );
          expect(summary.accuracy!).toBeGreaterThanOrEqual(0);
          expect(summary.accuracy!).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-06] adding a skip or a trace to any session changes neither half of the fraction', () => {
    fc.assert(
      fc.property(
        fc.array(arbAttempt(), { maxLength: 10 }),
        fc.constantFrom<AttemptOutcome>('skipped-speaking', 'skipped-listening', 'failed-speak'),
        (attempts, outcome) => {
          const before = accuracyOf(attempts);
          const skip: AttemptRow = {
            itemId: 'fresh-skip',
            family: 'speaking',
            outcome,
            wrong: false,
            softCorrected: false,
          };
          const trace: AttemptRow = {
            itemId: 'fresh-trace',
            family: 'character-trace',
            outcome: 'trace-completed',
            wrong: false,
            softCorrected: false,
          };
          const after = accuracyOf([...attempts, skip, trace]);
          expect(after.scorable).toBe(before.scorable);
          expect(after.correctFirstTry).toBe(before.correctFirstTry);
          expect(after.accuracy).toBe(before.accuracy);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-06] a session of skips plus correct answers is a Perfect lesson (EC-GRD-10)', () => {
    const rows: AttemptRow[] = [
      {
        itemId: 'a',
        family: 'typed-translate',
        outcome: 'graded',
        wrong: false,
        softCorrected: false,
      },
      {
        itemId: 'b',
        family: 'typed-translate',
        outcome: 'graded',
        wrong: false,
        softCorrected: true,
      },
      {
        itemId: 'c',
        family: 'speaking',
        outcome: 'skipped-speaking',
        wrong: false,
        softCorrected: false,
      },
      {
        itemId: 'd',
        family: 'speaking',
        outcome: 'failed-speak',
        wrong: false,
        softCorrected: false,
      },
    ];
    expect(isPerfectLesson(rows)).toBe(true);
    expect(accuracyOf(rows).accuracy).toBe(1);
    expect(accuracyOf(rows).scorable).toBe(2);
  });

  it('[INV-GRD-06] an all-speaking session yields undefined accuracy and the single-tile layout', () => {
    const rows: AttemptRow[] = Array.from({ length: 8 }, (_, i) => ({
      itemId: `s${i}`,
      family: 'speaking' as const,
      outcome: 'failed-speak' as const,
      wrong: false,
      softCorrected: false,
    }));
    const summary = accuracyOf(rows);
    expect(summary.accuracy).toBeUndefined();
    expect(summary.renderTile).toBe(false);
    expect(isPerfectLesson(rows)).toBe(true);
  });

  it('[INV-GRD-06] the end-of-lesson replay never overwrites the original miss (EC-GRD-12)', () => {
    const rows: AttemptRow[] = [
      {
        itemId: 'x',
        family: 'typed-translate',
        outcome: 'graded',
        wrong: true,
        softCorrected: false,
      },
      {
        itemId: 'x',
        family: 'typed-translate',
        outcome: 'graded',
        wrong: false,
        softCorrected: false,
      },
    ];
    expect(accuracyOf(rows)).toMatchObject({ scorable: 1, correctFirstTry: 0, accuracy: 0 });
    expect(isPerfectLesson(rows)).toBe(false);
  });
});
