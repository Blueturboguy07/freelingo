/**
 * The achievement slot: INV-CER-07.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  achievementSlot,
  PERSONAL_RECORDS_RENDER_A_SCREEN,
  type TierCrossing,
} from './achievements.js';
import { CEREMONY_SLOTS, runCeremony } from './queue.js';
import { ceremonyState, ceremonyStateArb } from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

describe('achievements', () => {
  it('[INV-CER-07] falsifier: two Sage tiers and one Wildfire tier render one screen, two rows, one gem sum', () => {
    const input = falsifier('INV-CER-07');
    const crossings = input.crossings as TierCrossing[];
    const expected = input.expect as Record<string, number>;
    const slot = achievementSlot(crossings);
    expect(slot.screens).toHaveLength(expected.screens!);
    expect(slot.screens[0]?.rows).toHaveLength(expected.rows!);
    const sage = slot.screens[0]?.rows.find((r) => r.achievementId === 'sage');
    expect(sage?.tier).toBe(expected.sageTier);
    expect(sage?.extraTiers).toBe(expected.sageExtraTiers);
    expect(slot.gems).toBe(expected.gems);

    // The gems land in the ONE chest, never also on the card.
    const result = runCeremony(ceremonyState({ achievementCrossings: crossings }));
    expect(result.bundle.gems).toBe(expected.gems);
    expect(result.chain.filter((s) => s === 'S079_achievement')).toHaveLength(1);
    expect(result.chain.filter((s) => s === 'S080_rewardBundle')).toHaveLength(1);
  });

  it('[INV-CER-07] at most one achievement screen per session, over generated states', () => {
    fc.assert(
      fc.property(ceremonyStateArb, (state) => {
        const result = runCeremony(state);
        expect(result.chain.filter((s) => s === 'S079_achievement').length).toBeLessThanOrEqual(1);
        expect(result.achievements.screens.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-CER-07] the screen shows the highest tier per achievement and sums every tier gem', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            achievementId: fc.constantFrom('a', 'b', 'c'),
            achievementName: fc.constantFrom('A', 'B', 'C'),
            tier: fc.integer({ min: 1, max: 8 }),
            gems: fc.nat({ max: 50 }),
          }),
          { maxLength: 12 },
        ),
        (crossings) => {
          const slot = achievementSlot(crossings);
          expect(slot.gems).toBe(crossings.reduce((n, c) => n + c.gems, 0));
          const rows = slot.screens[0]?.rows ?? [];
          expect(rows.length).toBe(new Set(crossings.map((c) => c.achievementId)).size);
          for (const row of rows) {
            const mine = crossings.filter((c) => c.achievementId === row.achievementId);
            expect(row.tier).toBe(Math.max(...mine.map((c) => c.tier)));
            expect(row.extraTiers).toBe(mine.length - 1);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-CER-07] no crossings means no screen and no gems', () => {
    const slot = achievementSlot([]);
    expect(slot.screens).toEqual([]);
    expect(slot.gems).toBe(0);
  });

  it('[INV-CER-07] Personal Records have no slot in the queue at all', () => {
    expect(PERSONAL_RECORDS_RENDER_A_SCREEN).toBe(false);
    expect(CEREMONY_SLOTS.filter((s) => /record/i.test(s))).toEqual([]);
  });
});
