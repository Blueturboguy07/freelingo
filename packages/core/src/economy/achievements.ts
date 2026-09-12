/**
 * The achievement registry (S125, "Awards"), and the rules that keep the grid honest.
 *
 * Owns INV-ECO-25 (every achievement names a counter that EXISTS in the schema and is
 * incremented by at least one REACHABLE event; grep gate: `crown` and `skill` appear in
 * no achievement config), INV-ECO-26 (an achievement whose every incrementing surface is
 * disabled is NOT RENDERED), INV-ECO-28 (every rendered achievement has a non-empty,
 * ascending threshold ladder whose first tier is reachable under the installed packs)
 * and INV-ECO-33 (Sharpshooter never increments on a lesson with no punitive item).
 *
 * Two names Duolingo ships are deliberately absent. **Regal** counts crowns and
 * **Conqueror** counts "every skill in a course to Level n" — Freelingo's path has
 * neither crowns nor skills, so shipping those rows would render a grid whose source
 * column resolves to a mechanic the path lacks, which is INV-ECO-25's named falsifier.
 * Their slots are taken by `Pathfinder` and `Completionist`, which count things that
 * exist. Champion/Winner/Friendly/Photogenic are cut by [DEPART D-NOSOCIAL] and replaced
 * by `Reviewer` so the grid has no holes; Challenger and Unrivaled are not in the 2026
 * bundle at all (duoplanet 2023 only) and are not invented back.
 */
import type { ExerciseType } from '../types/index.js';
import { isPunitive } from '../types/index.js';

/**
 * Every event that can increment a counter. A surface is "reachable" when it is in
 * `ENABLED_SURFACES` — the shipped config — and a pack feature it needs is installed.
 */
export const ACHIEVEMENT_SURFACES = [
  'lessonCompleted',
  'perfectLesson',
  'streakDay',
  'nodeCompleted',
  'unitLegendary',
  'sectionCompleted',
  'guidebookThenLesson',
  'weekendPair',
  'storyCompleted',
  'nightLesson',
  'itemRetired',
  // Surfaces that exist as types and are DISABLED in v1. They are named so an
  // achievement can depend on one and be correctly hidden (INV-ECO-26) rather than
  // rendered at 0/40 forever.
  'timedChallenge',
  'leaderboardFinish',
  'friendFollowed',
  'profilePicture',
] as const;

export type AchievementSurface = (typeof ACHIEVEMENT_SURFACES)[number];

/** The surfaces the shipped v1 config actually fires. */
export const ENABLED_SURFACES: readonly AchievementSurface[] = [
  'lessonCompleted',
  'perfectLesson',
  'streakDay',
  'nodeCompleted',
  'unitLegendary',
  'sectionCompleted',
  'guidebookThenLesson',
  'weekendPair',
  'storyCompleted',
  'nightLesson',
  'itemRetired',
] as const;

/** Pack features an achievement can depend on. `null` = every pack has it. */
export type PackFeature = 'stories' | 'radio' | 'characters';

export interface Achievement {
  readonly id: string;
  readonly displayName: string;
  /** The account-region column the tier ladder reads. Must exist in the schema. */
  readonly counterColumn: string;
  readonly surfaces: readonly AchievementSurface[];
  /** Strictly ascending, non-empty (INV-ECO-28). */
  readonly tiers: readonly number[];
  readonly requiresPackFeature: PackFeature | null;
  /** OBSERVED 2026 copy where one exists, `{{n}}` for the tier threshold. */
  readonly copy: string;
}

export const ACHIEVEMENTS: readonly Achievement[] = [
  {
    id: 'wildfire',
    displayName: 'Wildfire',
    counterColumn: 'longest_streak',
    surfaces: ['streakDay'],
    tiers: [3, 7, 14, 30, 50, 100, 150, 200, 300, 365],
    requiresPackFeature: null,
    copy: 'Reach a {{n}} day streak',
  },
  {
    id: 'sage',
    displayName: 'Sage',
    counterColumn: 'lifetime_xp',
    surfaces: ['lessonCompleted', 'storyCompleted', 'sectionCompleted'],
    tiers: [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 20000, 30000],
    requiresPackFeature: null,
    copy: 'Earn {{n}} XP',
  },
  {
    id: 'scholar',
    displayName: 'Scholar',
    counterColumn: 'words_learned',
    surfaces: ['lessonCompleted'],
    tiers: [50, 100, 200, 350, 500, 750, 1000, 1250, 1500, 2000],
    requiresPackFeature: null,
    copy: 'Learn {{n}} words',
  },
  {
    id: 'sharpshooter',
    displayName: 'Sharpshooter',
    counterColumn: 'perfect_lessons',
    surfaces: ['perfectLesson'],
    tiers: [1, 5, 20, 50, 100],
    requiresPackFeature: null,
    copy: 'Complete {{n}} lesson(s) with no mistakes',
  },
  {
    id: 'pathfinder',
    displayName: 'Pathfinder',
    counterColumn: 'nodes_completed',
    surfaces: ['nodeCompleted'],
    tiers: [5, 15, 40, 80, 150, 250],
    requiresPackFeature: null,
    copy: 'Complete {{n}} path nodes',
  },
  {
    id: 'completionist',
    displayName: 'Completionist',
    counterColumn: 'units_legendary',
    surfaces: ['unitLegendary'],
    tiers: [1, 3, 10, 25, 50],
    requiresPackFeature: null,
    copy: 'Earn {{n}} Legendary trophies',
  },
  {
    id: 'strategist',
    displayName: 'Strategist',
    counterColumn: 'guidebook_then_lesson',
    surfaces: ['guidebookThenLesson'],
    tiers: [1],
    requiresPackFeature: null,
    copy: 'Read a tip',
  },
  {
    id: 'weekend-warrior',
    displayName: 'Weekend Warrior',
    counterColumn: 'weekend_pairs',
    surfaces: ['weekendPair'],
    tiers: [1],
    requiresPackFeature: null,
    copy: 'Complete a lesson on Saturday and Sunday',
  },
  {
    id: 'trailblazer',
    displayName: 'Trailblazer',
    counterColumn: 'sections_completed',
    surfaces: ['sectionCompleted'],
    tiers: [1, 2, 3, 4, 5],
    requiresPackFeature: null,
    copy: 'Complete {{n}} section(s)',
  },
  {
    id: 'page-turner',
    displayName: 'Page Turner',
    counterColumn: 'stories_completed',
    surfaces: ['storyCompleted'],
    tiers: [1, 5, 15, 30, 60],
    requiresPackFeature: 'stories',
    copy: 'Read {{n}} stor(y/ies)',
  },
  {
    id: 'night-owl',
    displayName: 'Night Owl',
    counterColumn: 'night_lessons',
    surfaces: ['nightLesson'],
    tiers: [1, 5, 10, 25, 50, 100, 150, 200, 300, 400],
    requiresPackFeature: null,
    copy: 'Complete {{n}} lesson(s) between 22:00 and 23:59',
  },
  {
    id: 'reviewer',
    displayName: 'Reviewer',
    counterColumn: 'items_retired',
    surfaces: ['itemRetired'],
    tiers: [25, 100, 300, 750, 1500],
    requiresPackFeature: null,
    copy: 'Retire {{n}} items from your review queue',
  },
] as const;

/** OBSERVED 2026: the two category names are Duolingo's own, not "Achievements". */
export const ACHIEVEMENT_CATEGORIES = ['Awards', 'Personal Records'] as const;

/** LEGACY 2023-03-16: "roughly 25 gems" per completed tier. DERIVED: a flat 25. */
export const ACHIEVEMENT_TIER_GEMS = 25;

/* ------------------------------------------------------------------ the gates */

export interface InstalledFeatures {
  readonly enabledSurfaces: readonly AchievementSurface[];
  readonly packFeatures: readonly PackFeature[];
}

export const DEFAULT_INSTALLED_FEATURES: InstalledFeatures = {
  enabledSurfaces: ENABLED_SURFACES,
  packFeatures: ['stories'],
};

/** INV-ECO-25: at least one of the achievement's surfaces actually fires. */
export function hasReachableSurface(
  achievement: Achievement,
  installed: InstalledFeatures,
): boolean {
  return achievement.surfaces.some((surface) => installed.enabledSurfaces.includes(surface));
}

/** INV-ECO-28: the ladder is non-empty and strictly ascending. */
export function hasValidTierLadder(achievement: Achievement): boolean {
  if (achievement.tiers.length === 0) return false;
  for (let i = 1; i < achievement.tiers.length; i += 1) {
    const previous = achievement.tiers[i - 1] as number;
    const current = achievement.tiers[i] as number;
    if (current <= previous) return false;
  }
  return (achievement.tiers[0] as number) > 0;
}

/**
 * INV-ECO-26: an achievement is rendered only when something can move it.
 *
 * Every incrementing surface disabled, or a required pack feature missing, means the row
 * would sit at `0/40` forever. It is not rendered at all — a permanently unearnable row
 * is worse than a missing one, because the learner cannot tell which it is.
 */
export function isRenderable(
  achievement: Achievement,
  installed: InstalledFeatures = DEFAULT_INSTALLED_FEATURES,
): boolean {
  if (!hasValidTierLadder(achievement)) return false;
  if (!hasReachableSurface(achievement, installed)) return false;
  if (
    achievement.requiresPackFeature !== null &&
    !installed.packFeatures.includes(achievement.requiresPackFeature)
  ) {
    return false;
  }
  return true;
}

export function renderedAchievements(
  installed: InstalledFeatures = DEFAULT_INSTALLED_FEATURES,
): Achievement[] {
  return ACHIEVEMENTS.filter((achievement) => isRenderable(achievement, installed));
}

/** Every counter column the registry names. Cross-checked against the schema. */
export function achievementCounterColumns(): string[] {
  return [...new Set(ACHIEVEMENTS.map((achievement) => achievement.counterColumn))].sort();
}

/* ---------------------------------------------------------------- Sharpshooter */

/**
 * INV-ECO-33: "A lesson whose scorable set contains no punitive item never increments
 * Sharpshooter."
 *
 * The falsifier is re-running one kana Letters node 100 times to unlock tier 5 while
 * accuracy is formally undefined. A session of nothing but tracing, speaking and
 * read-and-respond has no mistakes available to avoid, so avoiding them is not perfect —
 * it is empty.
 */
export function sharpshooterIncrements(
  exerciseTypes: readonly ExerciseType[],
  mistakeCount: number,
): boolean {
  const punitive = exerciseTypes.filter(isPunitive);
  if (punitive.length === 0) return false;
  return mistakeCount === 0;
}
