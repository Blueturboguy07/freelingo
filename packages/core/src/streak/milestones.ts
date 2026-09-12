/**
 * Streak milestones — the phoenix screen.
 *
 * Duolingo's own design post names "one week, one month, 100-day, one year and beyond"
 * and teases "your 100th, or even 1,000th, day" (blog.duolingo.com, 2022-01-21). The
 * Freelingo set below is DERIVED from that plus the Wildfire achievement tiers
 * (`deep/04` §6).
 *
 * The rule this file exists to make testable: **a restore can never vault the number past
 * a milestone without landing on it** (INV-REC-07). `milestonesCrossed` is the only way to
 * ask, and it returns a list rather than a boolean precisely so a caller that fires two
 * screens is visibly wrong.
 */

/** 7, 14, 30, 50, 100, 150, 180, 200, 250, 300, 365, every 100 to 1000, then every 365. */
export const STREAK_MILESTONES: readonly number[] = (() => {
  const base = [7, 14, 30, 50, 100, 150, 180, 200, 250, 300, 365];
  const hundreds: number[] = [];
  for (let n = 400; n <= 1000; n += 100) hundreds.push(n);
  const years: number[] = [];
  for (let n = 730; n <= 365 * 10; n += 365) years.push(n);
  return [...new Set([...base, ...hundreds, ...years])].sort((a, b) => a - b);
})();

/** Milestones strictly above `from` and at most `to`. Empty when the streak did not grow. */
export function milestonesCrossed(from: number, to: number): number[] {
  if (to <= from) return [];
  return STREAK_MILESTONES.filter((m) => m > from && m <= to);
}

/** Is this exact streak number a milestone? */
export function isMilestone(streak: number): boolean {
  return STREAK_MILESTONES.includes(streak);
}
