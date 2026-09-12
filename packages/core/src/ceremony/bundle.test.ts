/**
 * The reward bundle, its one screen, and the EC-CER-14 dwell collapse: INV-CER-09.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  bundleCopy,
  collapseGoalChain,
  COLLAPSE_AFTER_CONSECUTIVE_GOAL_DAYS,
  EMPTY_BUNDLE,
  isEmptyBundle,
  isGemsOnly,
  mergeBundles,
  type RewardBundle,
} from './bundle.js';
import { CEREMONY_SLOTS, runCeremony } from './queue.js';
import { ceremonyState, ceremonyStateArb } from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

describe('the reward bundle screen', () => {
  it('[INV-CER-09] falsifier: every bundle shape renders ONE screen, with its own copy', () => {
    const input = falsifier('INV-CER-09');
    const bundles = input.bundles as RewardBundle[];
    const copies = new Set<string>();
    for (const bundle of bundles) {
      const chain = runCeremony(ceremonyState({ bundle })).chain;
      expect(chain.filter((s) => s === 'S080_rewardBundle')).toHaveLength(
        (input.expect as { screensPerBundle: number }).screensPerBundle,
      );
      copies.add(bundleCopy(bundle, true));
    }
    expect(copies.size).toBe((input.expect as { distinctCopies: number }).distinctCopies);
  });

  it('[INV-CER-09] there is no second gems-only slot in the whole queue', () => {
    const rewardSlots = CEREMONY_SLOTS.filter((s) => /gem|chest|reward/i.test(s));
    expect(rewardSlots).toEqual(['S080_rewardBundle']);
  });

  it('[INV-CER-09] at most one reward screen per session, over generated states', () => {
    fc.assert(
      fc.property(ceremonyStateArb, (state) => {
        const chain = runCeremony(state).chain;
        expect(chain.filter((s) => s === 'S080_rewardBundle').length).toBeLessThanOrEqual(1);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-CER-09] an empty bundle renders no screen', () => {
    expect(isEmptyBundle(EMPTY_BUNDLE)).toBe(true);
    expect(runCeremony(ceremonyState({ bundle: EMPTY_BUNDLE })).chain).not.toContain(
      'S080_rewardBundle',
    );
  });

  it('[INV-CER-09] copy names every component of the bundle', () => {
    const copy = bundleCopy(
      { gems: 5, freezes: 1, boost: { multiplier: 2, durationMinutes: 15 }, tierGrant: null },
      true,
    );
    expect(copy).toContain('5 gems');
    expect(copy).toContain('Streak Freeze');
    expect(copy).toContain('15 min');
    expect(copy).toContain('Nice job reaching your daily goal!');
  });

  it('[INV-CER-09] merging folds achievement gems into the single chest, never a second one', () => {
    const merged = mergeBundles(
      { gems: 5, freezes: 0, boost: null, tierGrant: null },
      { gems: 25, freezes: 0, boost: null, tierGrant: null },
    );
    expect(merged.gems).toBe(30);
  });
});

describe('the EC-CER-14 dwell collapse', () => {
  it('[INV-CER-09] falsifier: only a gems-only bundle collapses; a freeze, boost or grant keeps its screen', () => {
    const input = falsifier('EC-CER-14');
    const days = input.consecutiveGoalMetDays as number;
    const bundles = input.bundles as Record<string, RewardBundle>;
    expect(days).toBeGreaterThanOrEqual(COLLAPSE_AFTER_CONSECUTIVE_GOAL_DAYS);

    const collapsed = runCeremony(
      ceremonyState({
        consecutiveGoalMetDays: days,
        questsProgressed: 1,
        bundle: bundles.gemsOnly!,
      }),
    );
    expect(collapsed.chain).not.toContain('S078_quests');
    expect(collapsed.chain).not.toContain('S080_rewardBundle');
    expect(collapsed.collapsedGoalRow).toContain('gems');

    for (const key of ['withFreeze', 'withBoost', 'withTierGrant'] as const) {
      const kept = runCeremony(
        ceremonyState({
          consecutiveGoalMetDays: days,
          questsProgressed: 1,
          bundle: bundles[key]!,
        }),
      );
      expect(kept.chain, key).toContain('S080_rewardBundle');
      expect(kept.chain, key).toContain('S078_quests');
      expect(kept.collapsedGoalRow).toBeNull();
    }
  });

  it('[INV-CER-09] the collapse never fires before the fifth consecutive goal-met day', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 12 }),
        fc.record({
          gems: fc.nat({ max: 20 }),
          freezes: fc.nat({ max: 2 }),
          boost: fc.option(
            fc.record({ multiplier: fc.constant(2), durationMinutes: fc.constantFrom(15, 30) }),
            { nil: null },
          ),
          tierGrant: fc.option(fc.constant('VIP Status'), { nil: null }),
        }),
        (days, bundle) => {
          const collapsed = collapseGoalChain(days, bundle);
          expect(collapsed).toBe(
            days >= COLLAPSE_AFTER_CONSECUTIVE_GOAL_DAYS && isGemsOnly(bundle),
          );
          if (collapsed) {
            expect(bundle.freezes).toBe(0);
            expect(bundle.boost).toBeNull();
            expect(bundle.tierGrant).toBeNull();
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-CER-09] a collapsed chain still commits the identical ledger', () => {
    const bundle: RewardBundle = { gems: 5, freezes: 0, boost: null, tierGrant: null };
    const collapsed = runCeremony(
      ceremonyState({ consecutiveGoalMetDays: 9, questsProgressed: 1, bundle }),
    );
    const full = runCeremony(
      ceremonyState({ consecutiveGoalMetDays: 0, questsProgressed: 1, bundle }),
    );
    expect(JSON.stringify(collapsed.committed)).toBe(JSON.stringify(full.committed));
  });
});
