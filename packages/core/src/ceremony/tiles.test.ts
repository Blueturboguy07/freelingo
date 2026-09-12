/**
 * The S1b tile registry and the accuracy tiers: INV-CER-15.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  accuracyLabel,
  ACCURACY_TIERS,
  CEREMONY_TILES,
  FORBIDDEN_TILE_SLOTS,
  loadingTiles,
  resolvedTiles,
} from './tiles.js';
import { sessionCard } from './queue.js';
import { BASE_SESSION } from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

describe('the tile registry', () => {
  it('[INV-CER-15] falsifier: the resolved layout is exactly two tiles and no variant declares COMMITTED or a time', () => {
    const input = falsifier('INV-CER-15');
    const expected = input.expect as { resolvedTiles: number; forbiddenSlots: string[] };
    expect(resolvedTiles()).toHaveLength(expected.resolvedTiles);
    expect(FORBIDDEN_TILE_SLOTS).toEqual(expected.forbiddenSlots);
    for (const tile of CEREMONY_TILES) {
      expect(FORBIDDEN_TILE_SLOTS).not.toContain(tile.headerSlot);
      expect(FORBIDDEN_TILE_SLOTS).not.toContain(tile.id);
    }
  });

  it('[INV-CER-15] the resolved tiles are gold TOTAL XP and green accuracy, in that order', () => {
    expect(resolvedTiles().map((t) => t.id)).toEqual(['totalXp', 'accuracy']);
    expect(resolvedTiles().map((t) => t.treatment)).toEqual(['gold', 'green']);
  });

  it('[INV-CER-15] the loading phase has exactly one tile, and it is COMBO', () => {
    expect(loadingTiles().map((t) => t.id)).toEqual(['combo']);
  });

  it('[INV-CER-15] a resolved lesson card renders two tiles; Perfect lesson! renders one', () => {
    expect(sessionCard({ ...BASE_SESSION, mistakes: 1 }).tileCount).toBe(resolvedTiles().length);
    expect(sessionCard({ ...BASE_SESSION, mistakes: 0 }).tileCount).toBe(loadingTiles().length);
  });

  it('[INV-CER-15] the registry is closed: there is no third resolved variant to render', () => {
    expect(CEREMONY_TILES).toHaveLength(3);
    expect(new Set(CEREMONY_TILES.map((t) => t.id)).size).toBe(3);
    expect(CEREMONY_TILES.filter((t) => t.phase === 'resolved')).toHaveLength(2);
  });
});

describe('accuracy tiers', () => {
  it('[INV-CER-15] AMAZING carries no exclamation mark and GREAT!/GOOD! do', () => {
    expect(accuracyLabel(1)).toBe('AMAZING');
    expect(accuracyLabel(0.92)).toBe('GREAT!');
    expect(accuracyLabel(0.87)).toBe('GOOD!');
  });

  it('[INV-CER-15] the tier table is total and monotone over any accuracy', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
        (accuracy) => {
          const label = accuracyLabel(accuracy);
          expect(ACCURACY_TIERS.map((t) => t.label)).toContain(label);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
