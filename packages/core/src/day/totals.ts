/**
 * The counters that are NOT day-keyed (INV-DAY-11).
 *
 * Score, gems and lifetime XP are monotone cumulative totals over the set of committed
 * sessions. No clock or zone manipulation in the matrix can move them, because no zone
 * or civil date appears in their derivation at all — which is the point of putting them
 * in their own file next to the machinery that IS day-keyed. `deep/04` case 7 and 15.
 */
import type { SessionRow } from './session.js';

export interface LifetimeTotals {
  readonly lifetimeXp: number;
  readonly gems: number;
  readonly sessions: number;
  /**
   * Score is a monotone function of mastered items, clamped to the course ceiling
   * (`deep/04` §14, DERIVED). The day engine only asserts that it never decreases and
   * never reads a clock; the mastery weighting lives in `path/`.
   */
  readonly score: number;
}

export function lifetimeTotals(
  rows: Iterable<SessionRow>,
  scoreOf: (rows: readonly SessionRow[]) => number = defaultScore,
): LifetimeTotals {
  // Keyed by `session_id`: a replayed commit is the same session, not a second one.
  const bySession = new Map<string, SessionRow>();
  for (const row of rows) if (!bySession.has(row.sessionId)) bySession.set(row.sessionId, row);
  const unique = [...bySession.values()];
  let lifetimeXp = 0;
  let gems = 0;
  for (const row of unique) {
    lifetimeXp += row.earnedXp;
    gems += row.earnedGems;
  }
  return { lifetimeXp, gems, sessions: unique.length, score: scoreOf(unique) };
}

/** A placeholder monotone Score: one point per 100 lifetime XP, ceiling 160. */
function defaultScore(rows: readonly SessionRow[]): number {
  let xp = 0;
  for (const row of rows) xp += row.earnedXp;
  return Math.min(160, Math.floor(xp / 100));
}
