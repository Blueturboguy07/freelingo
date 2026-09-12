/**
 * INV-GRD-07 (one mistake row per grid) and INV-GRD-25 (a reading pair advances the
 * reading row only).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';

import { gradeMatch, schedulerTargetsFor, type MatchTap } from './match.js';
import type { GradableItem, MatchPair } from './types.js';

const PAIRS: readonly MatchPair[] = [
  { leftLexemeId: 'l1', rightLexemeId: 'r1', left: 'gato', right: 'cat', facet: 'meaning' },
  { leftLexemeId: 'l2', rightLexemeId: 'r2', left: 'casa', right: 'house', facet: 'meaning' },
  { leftLexemeId: 'l3', rightLexemeId: 'r3', left: 'carta', right: 'letter', facet: 'meaning' },
  { leftLexemeId: 'l4', rightLexemeId: 'r4', left: 'come', right: 'eats', facet: 'meaning' },
  { leftLexemeId: 'l5', rightLexemeId: 'r5', left: 'una', right: 'a', facet: 'meaning' },
];

const GRID: GradableItem = {
  itemId: 'grid',
  family: 'match',
  accepted: [],
  pairs: PAIRS,
};

const LEFTS = PAIRS.map((p) => p.leftLexemeId);
const RIGHTS = PAIRS.map((p) => p.rightLexemeId);

const arbTaps = (): fc.Arbitrary<MatchTap[]> =>
  fc.array(
    fc.record({
      leftLexemeId: fc.constantFrom(...LEFTS),
      rightLexemeId: fc.constantFrom(...RIGHTS),
    }),
    { maxLength: 8 },
  );

describe('match exercises', () => {
  it('[INV-GRD-07] a grid with any wrong pair yields exactly ONE mistake row and ONE accuracy miss', () => {
    fc.assert(
      fc.property(arbTaps(), (taps) => {
        const outcome = gradeMatch(GRID, taps);
        const wrongTaps = taps.filter((tap) => {
          const pair = PAIRS.find((p) => p.leftLexemeId === tap.leftLexemeId);
          return pair?.rightLexemeId !== tap.rightLexemeId;
        });
        const anyWrong = wrongTaps.length > 0;
        expect(outcome.verdict.mistakeLexemeIds).toHaveLength(anyWrong ? 1 : 0);
        expect(outcome.accuracyMisses).toBe(anyWrong ? 1 : 0);
        expect(outcome.verdict.wrong).toBe(anyWrong);
        // The one row is the LEFT-hand lexeme of the FIRST wrong pair (EC-GRD-13).
        if (anyWrong) {
          expect(outcome.verdict.mistakeLexemeIds[0]).toBe(wrongTaps[0]!.leftLexemeId);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-07] five wrong taps are still one mistake row — the grid is ONE item', () => {
    const allWrong: MatchTap[] = PAIRS.map((pair, i) => ({
      leftLexemeId: pair.leftLexemeId,
      rightLexemeId: PAIRS[(i + 1) % PAIRS.length]!.rightLexemeId,
    }));
    const outcome = gradeMatch(GRID, allWrong);
    expect(outcome.wrongTapCount).toBe(5);
    expect(outcome.verdict.mistakeLexemeIds).toEqual(['l1']);
    expect(outcome.accuracyMisses).toBe(1);
    // Hearts are the exception: the rules table charges one per wrong tap, immediately.
    expect(outcome.heartsSpent).toBe(5);
  });

  it('[INV-GRD-25] a reading pair advances the reading row and never the meaning row', () => {
    const readingGrid: GradableItem = {
      itemId: 'ja-grid',
      family: 'match',
      accepted: [],
      pairs: [
        {
          leftLexemeId: 'gakkou',
          rightLexemeId: 'gakkou-kana',
          left: '学校',
          right: 'がっこう',
          facet: 'reading',
        },
      ],
    };
    const targets = schedulerTargetsFor(readingGrid);
    expect(targets).toEqual([{ itemId: 'gakkou', facet: 'reading' }]);
    expect(targets.some((t) => t.facet === 'meaning')).toBe(false);
  });

  it('[INV-GRD-25] the facet is read from the pack for every pair, mixed grids included', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<'meaning' | 'reading'>('meaning', 'reading'), {
          minLength: 1,
          maxLength: 5,
        }),
        (facets) => {
          const item: GradableItem = {
            itemId: 'mixed',
            family: 'match',
            accepted: [],
            pairs: facets.map((facet, i) => ({
              leftLexemeId: `l${i}`,
              rightLexemeId: `r${i}`,
              left: `a${i}`,
              right: `b${i}`,
              facet,
            })),
          };
          const targets = schedulerTargetsFor(item);
          expect(targets.map((t) => t.facet)).toEqual(facets);
          // A reading pair never contributes a meaning target for the same lexeme.
          facets.forEach((facet, i) => {
            if (facet !== 'reading') return;
            expect(targets.filter((t) => t.itemId === `l${i}`)).toEqual([
              { itemId: `l${i}`, facet: 'reading' },
            ]);
          });
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
