/**
 * Level legendary and the unit trophy: INV-PATH-05, INV-PATH-16, INV-PATH-25.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  legendaryDenominator,
  offersLegendary,
  trophyNodeOf,
  unitTrophyLegendary,
} from './legendary.js';
import { specFor } from './registry.js';
import { NODE_TYPES } from './types.js';
import type { NodeType, PackManifest } from './types.js';
import { FULL_MANIFEST, node, unit } from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

function unitFrom(shape: readonly NodeType[], legendaryTypes: readonly NodeType[]) {
  const budget = [...legendaryTypes];
  return unit(
    0,
    shape.map((type, i) => {
      const at = budget.indexOf(type);
      const legendary = at >= 0;
      if (at >= 0) budget.splice(at, 1);
      return node(`n${i}`, type, 0, {
        subLessonsDone: 3,
        subLessonsTotal: 3,
        legendary,
      });
    }),
  );
}

describe('the unit trophy', () => {
  it('[INV-PATH-16] falsifier: a chest in the unit must not make the trophy unreachable', () => {
    const input = falsifier('INV-PATH-16');
    const u = unitFrom(input.unitShape as NodeType[], input.legendaryNodes as NodeType[]);
    expect(legendaryDenominator(u, FULL_MANIFEST)).toHaveLength(
      (input.expect as { denominatorSize: number }).denominatorSize,
    );
    expect(unitTrophyLegendary(u, FULL_MANIFEST)).toBe(true);
  });

  it('[INV-PATH-25] falsifier: a Japanese unit turns gold with every non-letters level legendary', () => {
    const input = falsifier('INV-PATH-25');
    const u = unitFrom(input.unitShape as NodeType[], input.legendaryNodes as NodeType[]);
    expect(unitTrophyLegendary(u, FULL_MANIFEST)).toBe(true);
    const letters = u.nodes.find((n) => n.type === 'letters');
    expect(letters).toBeDefined();
    expect(offersLegendary(letters!)).toBe(false);
  });

  it('[INV-PATH-25] the legendary offer never fires on a script node', () => {
    expect(specFor('letters').offersLegendary).toBe(false);
    expect(specFor('letters').launchable).not.toContain('legendary');
  });

  it('[INV-PATH-05] falsifier: every level legendary turns the trophy gold', () => {
    const input = falsifier('INV-PATH-05');
    const u = unitFrom(input.unitShape as NodeType[], input.legendaryNodes as NodeType[]);
    expect(unitTrophyLegendary(u, FULL_MANIFEST)).toBe(
      (input.expect as { trophyLegendary: boolean }).trophyLegendary,
    );
  });

  it('[INV-PATH-05] the trophy is legendary iff every node in the denominator is legendary', () => {
    const denominatorTypes: readonly NodeType[] = ['lesson', 'practice'];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<NodeType>(...NODE_TYPES.filter((t) => t !== 'jumpHere')), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
        (types, flags) => {
          const u = unit(
            0,
            types.map((type, i) =>
              node(`n${i}`, type, 0, {
                subLessonsDone: 3,
                subLessonsTotal: 3,
                legendary: flags[i % flags.length] ?? false,
              }),
            ),
          );
          const denominator = legendaryDenominator(u, FULL_MANIFEST);
          for (const n of denominator) expect(denominatorTypes).toContain(n.type);
          const expected = denominator.length > 0 && denominator.every((n) => n.legendary);
          expect(unitTrophyLegendary(u, FULL_MANIFEST)).toBe(expected);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-16] a unit with no qualifying node never awards the trophy', () => {
    const u = unitFrom(['chest', 'story', 'unitReview'], []);
    expect(legendaryDenominator(u, FULL_MANIFEST)).toEqual([]);
    expect(unitTrophyLegendary(u, FULL_MANIFEST)).toBe(false);
  });

  it('[INV-PATH-16] the denominator is pack-declared: narrowing it narrows the fold', () => {
    const lessonsOnly: PackManifest = { ...FULL_MANIFEST, legendaryDenominator: ['lesson'] };
    const u = unitFrom(['lesson', 'practice', 'unitReview'], ['lesson']);
    expect(unitTrophyLegendary(u, FULL_MANIFEST)).toBe(false); // practice is not legendary
    expect(unitTrophyLegendary(u, lessonsOnly)).toBe(true);
  });

  it('[INV-PATH-16] the trophy is the existing Unit Review node, never a seventh node', () => {
    const u = unitFrom(['lesson', 'chest', 'unitReview'], ['lesson']);
    expect(trophyNodeOf(u)?.type).toBe('unitReview');
    expect(u.nodes).toHaveLength(3);
  });
});
