/**
 * The declared ranges an imported value is clamped into, and the achievement recompute
 * (INV-DAT-10, EC-SEC-07).
 *
 * A `.freelingo` archive is a diffable file on the learner's own device. There is **no
 * cheat to police locally** — a local-only app with no server and no accounts has no
 * business pretending otherwise — but the app must not *break*: a 99,999-day streak must
 * not overflow the widget's digit budget, a billion gems must not reflow the Shop, and an
 * unearned achievement tier must not appear on a profile that cannot justify it.
 *
 * So every imported number has a declared range, and every achievement is recomputed from
 * the counters rather than read from the archive's flags.
 *
 * **These are display-and-sanity bounds, not the economy.** The real economy constants
 * (freeze cap, freeze price, goal tiers, XP per flavour) live in the economy config table
 * owned by another P1 task; `applyImport` takes the freeze cap from the *device* and
 * clamps against that, so this file never becomes a second place where a cap is decided.
 */

export interface Range {
  readonly min: number;
  readonly max: number;
}

export function clampToRange(range: Range, value: number): number {
  if (!Number.isFinite(value)) return range.min;
  const floored = Math.floor(value);
  if (floored < range.min) return range.min;
  if (floored > range.max) return range.max;
  return floored;
}

/**
 * Ten years of daily streak, a million gems, a hundred million lifetime XP. Each is
 * comfortably beyond anything a real learner reaches and comfortably inside what every
 * surface can render: the widget's small size fits four digits, the profile fits seven.
 */
export const IMPORT_RANGES = {
  streak: { min: 0, max: 3650 },
  gems: { min: 0, max: 1_000_000 },
  lifetimeXp: { min: 0, max: 100_000_000 },
  freezes: { min: 0, max: 10 },
  sessionsCompleted: { min: 0, max: 1_000_000 },
  lessonsCompleted: { min: 0, max: 1_000_000 },
  perfectLessons: { min: 0, max: 1_000_000 },
  daysGoalMet: { min: 0, max: 3650 },
  wordsLearned: { min: 0, max: 100_000 },
} as const satisfies Record<string, Range>;

export interface ImportCounters {
  readonly sessionsCompleted: number;
  readonly lessonsCompleted: number;
  readonly perfectLessons: number;
  readonly daysGoalMet: number;
  readonly wordsLearned: number;
}

export type AchievementTiers = Readonly<Record<string, number>>;

/** One achievement: a counter and the thresholds at which each tier is earned. */
export interface AchievementRung {
  readonly id: string;
  readonly counter: keyof ImportCounters;
  readonly thresholds: readonly number[];
}

/**
 * A P1 placeholder ladder. The full thirteen achievements with their tiers land at P4
 * (§Phases, Quests/Badges); what P1 needs is the *rule* — a tier is a function of a
 * counter — so that `applyImport` can be held to it now and the ladder can grow without
 * the import path changing.
 */
export const IMPORTED_ACHIEVEMENT_LADDER: readonly AchievementRung[] = [
  { id: 'wildfire', counter: 'daysGoalMet', thresholds: [3, 7, 14, 30, 50, 100, 365] },
  { id: 'sage', counter: 'lessonsCompleted', thresholds: [10, 50, 100, 250, 500, 1000] },
  { id: 'scholar', counter: 'wordsLearned', thresholds: [50, 125, 300, 500, 1000, 2000] },
  { id: 'sharpshooter', counter: 'perfectLessons', thresholds: [5, 15, 30, 60, 120] },
  { id: 'regular', counter: 'sessionsCompleted', thresholds: [10, 30, 60, 120, 300] },
] as const;

/**
 * Tiers from counters. Deterministic, and a function of the counters **only** — the
 * archive's claimed tiers are not an argument, so they cannot influence the result.
 */
export function recomputeAchievements(
  counters: ImportCounters,
  ladder: readonly AchievementRung[] = IMPORTED_ACHIEVEMENT_LADDER,
): AchievementTiers {
  const tiers: Record<string, number> = {};
  for (const rung of ladder) {
    const value = counters[rung.counter];
    tiers[rung.id] = rung.thresholds.filter((threshold) => value >= threshold).length;
  }
  return tiers;
}

/** The highest tier any achievement can reach — used to bound a profile's layout. */
export function maxAchievementTier(
  ladder: readonly AchievementRung[] = IMPORTED_ACHIEVEMENT_LADDER,
): number {
  return ladder.reduce((max, rung) => Math.max(max, rung.thresholds.length), 0);
}
