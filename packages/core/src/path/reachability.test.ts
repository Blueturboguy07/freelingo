/**
 * "Can this learner extend their streak right now?": INV-PATH-15.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  EXERCISE_BUDGET,
  GOAL_TIERS,
  GOAL_XP,
  routesFrom,
  sessionLength,
  shortRouteFor,
  UNIT_REVIEW_MAX_EXERCISES,
  type GoalTier,
} from './reachability.js';
import { buildModel, linearModelArb } from './__falsifiers__/fixtures.js';
import type { NodeType } from './types.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

describe('short-route reachability', () => {
  it('[INV-PATH-15] falsifier: a Casual learner facing only a Unit Review still has a two-tap route', () => {
    const input = falsifier('INV-PATH-15');
    const model = buildModel(
      input.shape as readonly (readonly (readonly NodeType[])[])[],
      input.completedNodeCount as number,
    );
    const tier = input.tier as GoalTier;
    const expected = input.expect as Record<string, number | boolean>;
    // The flat length is the bug: 15 > the Casual budget of 14.
    expect(input.flatUnitReviewLength).toBeGreaterThan(EXERCISE_BUDGET[tier]);
    expect(UNIT_REVIEW_MAX_EXERCISES).toBe(input.flatUnitReviewLength);
    // Sized from the stored goal, it fits.
    expect(sessionLength('unitReview', tier, 99)).toBe(expected.sizedUnitReviewLength);
    const verdict = shortRouteFor(model, tier);
    expect(verdict.ok).toBe(expected.ok);
    expect(verdict.route?.taps).toBeLessThanOrEqual(2);
    expect(verdict.route?.exercises).toBeLessThanOrEqual(EXERCISE_BUDGET[tier]);
    expect(verdict.route?.streakExtending).toBe(true);
  });

  it('[INV-PATH-15] every reachable state and every tier has a short route or a defer control', () => {
    fc.assert(
      fc.property(
        linearModelArb,
        fc.constantFrom(...GOAL_TIERS),
        fc.integer({ min: 9, max: 14 }),
        ({ model }, tier, contentLength) => {
          const verdict = shortRouteFor(model, tier, contentLength);
          expect(verdict.ok).toBe(true);
          if (verdict.route !== null) {
            expect(verdict.route.taps).toBeLessThanOrEqual(2);
            expect(verdict.route.exercises).toBeLessThanOrEqual(EXERCISE_BUDGET[tier]);
            expect(verdict.route.streakExtending).toBe(true);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-15] Unit Review and practice are sized from the goal, never flat', () => {
    for (const tier of GOAL_TIERS) {
      expect(sessionLength('unitReview', tier, 99)).toBeLessThanOrEqual(EXERCISE_BUDGET[tier]);
      expect(sessionLength('practice', tier, 99)).toBeLessThanOrEqual(EXERCISE_BUDGET[tier]);
    }
    // Intense is generous enough that the content length wins.
    expect(sessionLength('unitReview', 'intense', 99)).toBe(UNIT_REVIEW_MAX_EXERCISES);
  });

  it('[INV-PATH-15] the goal tiers are the ratified table (ruling EC-ECO-01)', () => {
    expect(GOAL_XP).toEqual({ casual: 10, regular: 20, serious: 30, intense: 50 });
  });

  it('[INV-PATH-15] a failed test flavour is not a streak-extending route', () => {
    const model = buildModel([[['lesson', 'unitReview']]], 0);
    const routes = routesFrom(model, 'casual');
    expect(routes.every((r) => r.flavour !== 'jumpHere' || !r.streakExtending)).toBe(true);
  });
});
