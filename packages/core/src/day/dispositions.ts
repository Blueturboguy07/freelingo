/**
 * What the rollover walk decided about a civil date, and the streak that falls out of it.
 *
 * P0's `streakFromDays` is the same rule over a set where every recorded day is
 * `completed`; this is the whole-day-boundary version, and the two must agree on that
 * input (asserted as a property, because INV-DAY-01 must not regress).
 */
import { addCivilDays, type LocalDay } from './civil.js';

/**
 * One decision per civil date.
 *
 * - `completed` — a session was credited to it. The only kind that INCREMENTS.
 * - `frozen` — missed, covered by a freeze owned before the day began. Preserves the
 *   number, never adds to it (`deep/04` open question 6; EC-FRZ-02). Snowflake cell.
 * - `missed` — lived, uncovered. The chain ends here.
 * - `unlived` — the local clock jumped over the date via a zone change. Not a missed
 *   day, consumes no freeze, transparent to the walk (19 → 20). NEVER a powered-off
 *   device: a date slept through is lived and missed (EC-STK-21, INV-DAY-03).
 * - `recovered` — repainted by a recovery restore. Its own glyph, neither flame nor
 *   snowflake, so the calendar stays truthful (EC-FRZ-19). Preserves, never increments.
 */
export type DayDisposition = 'completed' | 'frozen' | 'missed' | 'unlived' | 'recovered';

/** Dispositions that add one to the streak. */
export const CONTRIBUTING_DISPOSITIONS: readonly DayDisposition[] = ['completed'];
/** Dispositions the walk passes straight through without counting. */
export const PRESERVING_DISPOSITIONS: readonly DayDisposition[] = [
  'frozen',
  'unlived',
  'recovered',
];

export function isContributing(d: DayDisposition | undefined): boolean {
  return d === 'completed';
}

export function isPreserving(d: DayDisposition | undefined): boolean {
  return d === 'frozen' || d === 'unlived' || d === 'recovered';
}

export type DayLedger = ReadonlyMap<LocalDay, DayDisposition>;

/**
 * Streak as of `today`, walking back through the decided days.
 *
 * `allowUnsatisfiedToday` is the "today is not over yet" rule: a streak stands on an
 * undone today if yesterday holds it (INV-DAY-01). Walking back from a day that is
 * already decided — the rollover walk's own cursor — passes `false`, because there the
 * absence of a decision is a hole, not a pending day.
 */
export function streakFromDispositions(
  ledger: DayLedger,
  today: LocalDay,
  allowUnsatisfiedToday = true,
): number {
  let count = 0;
  let cursor: LocalDay = today;
  let first = true;
  for (;;) {
    const disposition = ledger.get(cursor);
    if (isContributing(disposition)) {
      count += 1;
    } else if (isPreserving(disposition)) {
      // no increment, the chain continues
    } else if (first && allowUnsatisfiedToday && disposition === undefined) {
      // Today simply has not happened yet.
    } else {
      break;
    }
    first = false;
    cursor = addCivilDays(cursor, -1);
  }
  return count;
}

/** The lived civil dates: every decided day except the ones the clock jumped over. */
export function livedDays(ledger: DayLedger): Set<LocalDay> {
  const lived = new Set<LocalDay>();
  for (const [day, disposition] of ledger) {
    if (disposition !== 'unlived') lived.add(day);
  }
  return lived;
}
