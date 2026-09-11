/**
 * Streak as a pure function of a SET of civil dates (INV-DAY-01 seed).
 *
 * The streak is never incremented imperatively: it is the size of the maximal
 * contiguous run of distinct `local_day` values ending at today-or-yesterday.
 * Freezes, `unlived` days, grace and the recovery challenge land in P1.
 */
import { addCivilDays, type LocalDay } from './civil.js';

export function streakFromDays(goalMetDays: Iterable<LocalDay>, today: LocalDay): number {
  const days = new Set<LocalDay>(goalMetDays);
  let anchor: LocalDay;
  if (days.has(today)) {
    anchor = today;
  } else {
    const yesterday = addCivilDays(today, -1);
    if (!days.has(yesterday)) return 0;
    anchor = yesterday;
  }
  let length = 0;
  let cursor = anchor;
  while (days.has(cursor)) {
    length += 1;
    cursor = addCivilDays(cursor, -1);
  }
  return length;
}
