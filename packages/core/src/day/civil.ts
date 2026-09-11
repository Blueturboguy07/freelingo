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

/** The civil date of an instant in an IANA zone. Uses the calendar, not 86,400 s. */
export function localDayOf(instant: Date, timeZone: string): LocalDay {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  return toLocalDay(parts);
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
