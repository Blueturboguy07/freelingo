/**
 * The reward bundle and its one screen (S080).
 *
 * INV-CER-09 / EC-CER-13, EC-CER-25: the reward screen is **one component over a bundle**
 * `{gems?, freeze?, boost?}`, with copy selected by bundle contents, and no second
 * gems-only screen exists. The build's own copy proves the bundle: `Nice job reaching your
 * daily goal! Keep your streak protected with this one-time Streak Freeze.` (L559),
 * `You earned {{n}} gems and a double XP Boost for the next 15 min` (L2212), `You earned a
 * Streak Freeze, {{n}} gems, and a double XP Boost...` (L2213-2214).
 *
 * Ruling EC-CER-14 lives here too: after five consecutive goal-met days the quests and
 * chest screens collapse into a row on S067 **only when the bundle is gems-only**. Any
 * freeze, boost or tier grant keeps its full screen.
 */

export interface XpBoost {
  readonly multiplier: number;
  /** Duration is server/pack data with at least two live values, 15 and 30 (ADV 02/A8). */
  readonly durationMinutes: number;
}

export interface RewardBundle {
  readonly gems: number;
  readonly freezes: number;
  readonly boost: XpBoost | null;
  /** A Streak Society / milestone tier grant rides in the same bundle (EC-CER-26). */
  readonly tierGrant: string | null;
}

export const EMPTY_BUNDLE: RewardBundle = { gems: 0, freezes: 0, boost: null, tierGrant: null };

export function isEmptyBundle(b: RewardBundle): boolean {
  return b.gems === 0 && b.freezes === 0 && b.boost === null && b.tierGrant === null;
}

/** Gems and nothing else. The only bundle shape the dwell collapse may touch. */
export function isGemsOnly(b: RewardBundle): boolean {
  return b.gems > 0 && b.freezes === 0 && b.boost === null && b.tierGrant === null;
}

/** Consecutive goal-met days after which a gems-only chain collapses (ruling EC-CER-14). */
export const COLLAPSE_AFTER_CONSECUTIVE_GOAL_DAYS = 5;

/**
 * Should S078 (quests) and S080 (chest) collapse into a row on S067?
 *
 * Only for a gems-only bundle. A freeze, a boost or a tier grant is a thing the learner
 * has never seen before in that shape and keeps its full screen - which is the half of the
 * ruling that stops the collapse from eating real news.
 */
export function collapseGoalChain(consecutiveGoalMetDays: number, bundle: RewardBundle): boolean {
  return consecutiveGoalMetDays >= COLLAPSE_AFTER_CONSECUTIVE_GOAL_DAYS && isGemsOnly(bundle);
}

/** Copy for the single reward screen, selected by the bundle's contents. */
export function bundleCopy(bundle: RewardBundle, reachedDailyGoal: boolean): string {
  const parts: string[] = [];
  if (bundle.gems > 0) parts.push(`${bundle.gems} gems`);
  if (bundle.freezes > 0) {
    parts.push(bundle.freezes === 1 ? 'a Streak Freeze' : `${bundle.freezes} Streak Freezes`);
  }
  if (bundle.boost !== null) {
    parts.push(
      `a ${bundle.boost.multiplier}x XP Boost for the next ${bundle.boost.durationMinutes} min`,
    );
  }
  if (bundle.tierGrant !== null) parts.push(bundle.tierGrant);
  const list =
    parts.length === 0
      ? 'nothing'
      : parts.length === 1
        ? parts[0]
        : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  const headline = `You earned ${list}!`;
  return reachedDailyGoal ? `${headline} Nice job reaching your daily goal!` : headline;
}

export function mergeBundles(a: RewardBundle, b: RewardBundle): RewardBundle {
  return {
    gems: a.gems + b.gems,
    freezes: a.freezes + b.freezes,
    boost: a.boost ?? b.boost,
    tierGrant: a.tierGrant ?? b.tierGrant,
  };
}
