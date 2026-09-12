/**
 * Civil-date arithmetic (INV-DAY-05 seed).
 *
 * Day boundaries are derived by civil-date arithmetic in the learner's zone, never by
 * adding 86,400 s: 23-hour and 25-hour days must both count as exactly one day.
 * P1 replaces/extends this with the full zone rule, `unlived`, grace and the freeze walk.
 */

/** A civil date in the learner's zone, `YYYY-MM-DD`. Never an instant. */
export type LocalDay = string & { readonly __brand: 'LocalDay' };

const LOCAL_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDay(value: string): value is LocalDay {
  if (!LOCAL_DAY_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d >= 1 && d <= daysInMonth;
}

export function toLocalDay(value: string): LocalDay {
  if (!isLocalDay(value)) throw new RangeError(`not a civil date: ${value}`);
  return value;
}

/**
 * One `Intl.DateTimeFormat` per zone, reused across instants: constructing one is the
 * expensive part and it does not depend on the instant. Without this cache the four-zone
 * properties spend most of their budget inside ICU rather than on the rule under test.
 */
const DAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = DAY_FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    DAY_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/** The civil date of an instant in an IANA zone. Uses the calendar, not 86,400 s. */
export function localDayOf(instant: Date, timeZone: string): LocalDay {
  return toLocalDay(dayFormatter(timeZone).format(instant));
}

/** Civil-date addition: `addCivilDays(day, 1)` is the next calendar date, DST or not. */
export function addCivilDays(day: LocalDay, delta: number): LocalDay {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + delta));
  return toLocalDay(shifted.toISOString().slice(0, 10));
}

/** Signed count of civil dates from `a` to `b`. */
export function civilDaysBetween(a: LocalDay, b: LocalDay): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** `YYYY-MM` of a civil date. The key monthly settlements are counted by (INV-DAY-16). */
export function monthKeyOf(day: LocalDay): string {
  return day.slice(0, 7);
}

/** The first civil date of the month after `day`'s. Walks months, never 30 days. */
export function firstDayOfNextMonth(day: LocalDay): LocalDay {
  const [y, m] = day.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
  return toLocalDay(shifted.toISOString().slice(0, 10));
}

/**
 * The civil date of an instant at a fixed UTC offset, in minutes east of UTC.
 *
 * This — not `localDayOf` — is how a session row's `local_day` is derived, because
 * EC-STK-26 rules that the platform's `tz_id` is accepted and never parsed: the day
 * comes from `completed_at_utc` plus the `utc_offset_minutes` captured at completion.
 * Two zone identifiers sharing one offset therefore cannot disagree (INV-DAY-17).
 */
export function localDayFromOffset(instant: Date, utcOffsetMinutes: number): LocalDay {
  const shifted = new Date(instant.getTime() + utcOffsetMinutes * 60_000);
  return toLocalDay(shifted.toISOString().slice(0, 10));
}

/** The UTC instant (ms) of local midnight opening `day` at `utcOffsetMinutes`. */
export function localMidnightUtcMs(day: LocalDay, utcOffsetMinutes: number): number {
  return Date.parse(`${day}T00:00:00Z`) - utcOffsetMinutes * 60_000;
}

/** Seconds since local midnight at a fixed offset. Never negative, never ≥ 86,400. */
export function secondsPastLocalMidnight(instant: Date, utcOffsetMinutes: number): number {
  const day = localDayFromOffset(instant, utcOffsetMinutes);
  return Math.floor((instant.getTime() - localMidnightUtcMs(day, utcOffsetMinutes)) / 1000);
}

/** Day of the week of a civil date: 0 = Sunday … 6 = Saturday. Pure calendar arithmetic. */
export function weekdayOf(day: LocalDay): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/**
 * The Monday of `day`'s week, as the key a weekly predicate groups by (INV-DAY-13,
 * Perfect Streak). Monday-start so the weekend (Sat, Sun) falls inside one key —
 * a Sunday-start week splits Weekend Warrior across two keys.
 */
export function weekKeyOf(day: LocalDay): LocalDay {
  const weekday = weekdayOf(day);
  return addCivilDays(day, -((weekday + 6) % 7));
}
