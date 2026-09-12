/**
 * The achievement grid's honesty gates: INV-ECO-25 (a counter that exists and a
 * reachable event; no `crown`, no `skill`), INV-ECO-26 (no permanently unearnable row is
 * rendered), INV-ECO-28 (non-empty ascending ladders, first tier reachable) and
 * INV-ECO-33 (Sharpshooter needs a punitive item).
 *
 * The schema half of INV-ECO-25 — "a counter that exists in the schema" — is asserted in
 * `packages/schema/src/achievement-columns.test.ts`, where the schema is.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { EXERCISE_TYPES, NON_PUNITIVE_EXERCISE_TYPES, isPunitive } from '../types/index.js';
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_CATEGORIES,
  DEFAULT_INSTALLED_FEATURES,
  ENABLED_SURFACES,
  NOT_IN_2026_BUNDLE_ACHIEVEMENT_IDS,
  RULED_ACHIEVEMENT_LADDERS,
  SOCIAL_CUT_ACHIEVEMENT_IDS,
  VERIFIED_2026_ACHIEVEMENT_IDS,
  achievementCounterColumns,
  hasReachableSurface,
  hasValidTierLadder,
  isRenderable,
  renderedAchievements,
  sharpshooterIncrements,
} from './achievements.js';

const RUNS = { numRuns: PROPERTY_RUNS } as const;

describe('the achievement registry', () => {
  it('[INV-ECO-25] every achievement is incremented by at least one reachable event', () => {
    for (const achievement of renderedAchievements()) {
      expect(
        hasReachableSurface(achievement, DEFAULT_INSTALLED_FEATURES),
        `${achievement.id} has no enabled incrementing surface`,
      ).toBe(true);
    }
  });

  it('[INV-ECO-25] falsifier: no achievement config mentions crowns or skills', () => {
    // Freelingo's path has neither. EC-ECO-30's fix is to RE-DENOMINATE rather than
    // delete: Regal and Conqueror keep their names and their ladders and count legendary
    // levels and fully-legendary units instead of crowns and skills.
    const blob = JSON.stringify(ACHIEVEMENTS).toLowerCase();
    expect(blob).not.toContain('crown');
    expect(blob).not.toContain('skill');
    expect(ACHIEVEMENTS.some((a) => a.id === 'regal')).toBe(true);
    expect(ACHIEVEMENTS.some((a) => a.id === 'conqueror')).toBe(true);
  });

  it('[INV-ECO-25] the verified 2026 names are all present, re-denominated where the mechanic changed', () => {
    // Product map S125 lists the verified names; only Champion/Winner/Friendly/Photogenic
    // are cut, by D-NOSOCIAL. An earlier version of this registry also deleted Regal and
    // Conqueror and invented `Completionist` in their place.
    for (const id of VERIFIED_2026_ACHIEVEMENT_IDS) {
      expect(
        ACHIEVEMENTS.some((a) => a.id === id),
        `${id} is a verified 2026 name and must be rendered`,
      ).toBe(true);
    }
    expect(ACHIEVEMENTS.some((a) => a.id === 'completionist')).toBe(false);
  });

  it('[INV-ECO-25] every achievement names exactly one counter column, and names are unique', () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const achievement of ACHIEVEMENTS) {
      expect(achievement.counterColumn).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(achievement.surfaces.length).toBeGreaterThan(0);
    }
    // Two achievements MAY read one column: EC-ECO-30 fixes Regal's ladder and
    // EC-ECO-33 fixes Legendary's, and both are denominated in legendary levels. What
    // must be unique is the achievement id, not the column it reads.
    expect(achievementCounterColumns().length).toBeLessThanOrEqual(ACHIEVEMENTS.length);
    expect(achievementCounterColumns().length).toBeGreaterThan(0);
  });

  it("[INV-ECO-25] the two category names are Duolingo's own: Awards and Personal Records", () => {
    expect([...ACHIEVEMENT_CATEGORIES]).toEqual(['Awards', 'Personal Records']);
  });

  it('[INV-ECO-25] the social achievements cut by D-NOSOCIAL leave no hole in the grid', () => {
    // Two DIFFERENT reasons, kept apart because they are different facts about the
    // bundle. Champion/Winner/Friendly/Photogenic exist upstream and Freelingo cuts them;
    // Challenger and Unrivaled are simply not in the 2026 bundle (duoplanet 2023 only)
    // and are not invented back. The old version of this test called all six "cut by
    // D-NOSOCIAL", which the product map contradicts.
    expect([...SOCIAL_CUT_ACHIEVEMENT_IDS]).toEqual([
      'champion',
      'winner',
      'friendly',
      'photogenic',
    ]);
    expect([...NOT_IN_2026_BUNDLE_ACHIEVEMENT_IDS]).toEqual(['challenger', 'unrivaled']);
    for (const id of [...SOCIAL_CUT_ACHIEVEMENT_IDS, ...NOT_IN_2026_BUNDLE_ACHIEVEMENT_IDS]) {
      expect(ACHIEVEMENTS.some((a) => a.id === id)).toBe(false);
    }
    // The grid is still a grid: at least ten rows render under the default install.
    expect(renderedAchievements().length).toBeGreaterThanOrEqual(10);
  });
});

describe('unearnable rows', () => {
  it('[INV-ECO-26] falsifier: an achievement whose every surface is disabled is NOT rendered', () => {
    const nothingEnabled = { enabledSurfaces: [], packFeatures: [] } as const;
    expect(renderedAchievements(nothingEnabled)).toEqual([]);
    for (const achievement of ACHIEVEMENTS) {
      expect(isRenderable(achievement, nothingEnabled)).toBe(false);
    }
  });

  it('[INV-ECO-26] a pack with no stories does not render Page Turner at 0/50', () => {
    const noStories = { enabledSurfaces: ENABLED_SURFACES, packFeatures: [] } as const;
    const rendered = renderedAchievements(noStories).map((a) => a.id);
    expect(rendered).not.toContain('page-turner');
    expect(rendered).toContain('wildfire');
  });

  it('[INV-ECO-26] rendering is monotone in the enabled surfaces: enabling never hides a row', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...ENABLED_SURFACES), {
          maxLength: ENABLED_SURFACES.length,
        }),
        fc.constantFrom(...ENABLED_SURFACES),
        (subset, extra) => {
          const before = new Set(
            renderedAchievements({ enabledSurfaces: subset, packFeatures: ['stories'] }).map(
              (a) => a.id,
            ),
          );
          const after = new Set(
            renderedAchievements({
              enabledSurfaces: [...new Set([...subset, extra])],
              packFeatures: ['stories'],
            }).map((a) => a.id),
          );
          for (const id of before) expect(after.has(id)).toBe(true);
        },
      ),
      RUNS,
    );
  });
});

describe('tier ladders', () => {
  it('[INV-ECO-28] every rendered achievement has a non-empty, strictly ascending ladder', () => {
    for (const achievement of renderedAchievements()) {
      expect(hasValidTierLadder(achievement), `${achievement.id} ladder`).toBe(true);
      expect(achievement.tiers.length).toBeGreaterThan(0);
      expect(achievement.tiers[0]).toBeGreaterThan(0);
    }
  });

  it('[INV-ECO-28] falsifier: a badge with a null denominator or a zero first tier is not renderable', () => {
    const nullDenominator = { ...ACHIEVEMENTS[0]!, tiers: [] as readonly number[] };
    expect(hasValidTierLadder(nullDenominator)).toBe(false);
    expect(isRenderable(nullDenominator)).toBe(false);

    const zeroFirstTier = { ...ACHIEVEMENTS[0]!, tiers: [0, 5, 10] };
    expect(hasValidTierLadder(zeroFirstTier)).toBe(false);

    const nonAscending = { ...ACHIEVEMENTS[0]!, tiers: [5, 5, 10] };
    expect(hasValidTierLadder(nonAscending)).toBe(false);
  });

  it('[INV-ECO-28] the first tier of every rendered achievement is reachable under the installed packs', () => {
    for (const achievement of renderedAchievements()) {
      if (achievement.requiresPackFeature !== null) {
        expect(DEFAULT_INSTALLED_FEATURES.packFeatures).toContain(achievement.requiresPackFeature);
      }
      expect(hasReachableSurface(achievement, DEFAULT_INSTALLED_FEATURES)).toBe(true);
    }
  });
});

describe('Sharpshooter', () => {
  it('[INV-ECO-33] falsifier: 100 runs of an all-tracing node never increment it', () => {
    const kanaLesson = [...NON_PUNITIVE_EXERCISE_TYPES];
    for (let run = 0; run < 100; run += 1) {
      expect(sharpshooterIncrements(kanaLesson, 0)).toBe(false);
    }
  });

  it('[INV-ECO-33] increments exactly when the scorable set is non-empty and the session was clean', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...EXERCISE_TYPES), { maxLength: 20 }),
        fc.integer({ min: 0, max: 5 }),
        (types, mistakes) => {
          const punitive = types.filter(isPunitive).length;
          expect(sharpshooterIncrements(types, mistakes)).toBe(punitive > 0 && mistakes === 0);
        },
      ),
      RUNS,
    );
  });
});


/* -------------------------------------------------------------------- INV-ECO-28 */

describe('the ladders the rulings fix', () => {
  it('[INV-ECO-28] Regal, Conqueror, Page Turner and Legendary carry EXACTLY their ruled thresholds', () => {
    // "Non-empty and strictly ascending" is true of every wrong ladder too — it was true
    // of the 1/5/15/30/60 Page Turner this table replaced, and of an achievement grid
    // with no legendary-levels row at all. EC-ECO-30 fixes Regal at
    // 3/7/12/18/25/35/50/65/80/100 and Conqueror at 1-5; EC-ECO-33 fixes Page Turner at
    // 1/5/10/25/50 and Legendary at 1/5/20/50/100.
    for (const [id, tiers] of Object.entries(RULED_ACHIEVEMENT_LADDERS)) {
      const achievement = ACHIEVEMENTS.find((a) => a.id === id);
      expect(achievement, `${id} is missing from the registry`).toBeDefined();
      expect(achievement?.tiers, id).toEqual(tiers);
    }
    expect(RULED_ACHIEVEMENT_LADDERS['page-turner']).toEqual([1, 5, 10, 25, 50]);
    expect(RULED_ACHIEVEMENT_LADDERS['legendary']).toEqual([1, 5, 20, 50, 100]);
    expect(RULED_ACHIEVEMENT_LADDERS['regal']).toEqual([3, 7, 12, 18, 25, 35, 50, 65, 80, 100]);
    expect(RULED_ACHIEVEMENT_LADDERS['conqueror']).toEqual([1, 2, 3, 4, 5]);
  });

  it('[INV-ECO-28] every ruled ladder is also a VALID ladder, and every achievement has one', () => {
    for (const achievement of ACHIEVEMENTS) {
      expect(hasValidTierLadder(achievement), achievement.id).toBe(true);
    }
  });

  it('[INV-ECO-25] the legendary-levels counter is a real column both ladders read', () => {
    const regal = ACHIEVEMENTS.find((a) => a.id === 'regal');
    const legendary = ACHIEVEMENTS.find((a) => a.id === 'legendary');
    expect(regal?.counterColumn).toBe('legendary_levels_earned');
    expect(legendary?.counterColumn).toBe('legendary_levels_earned');
    // Conqueror reads the unit-trophy counter, not the level counter (EC-ECO-30).
    expect(ACHIEVEMENTS.find((a) => a.id === 'conqueror')?.counterColumn).toBe('units_legendary');
  });
});
