import { addCivilDays, localDayOf, toLocalDay } from '../day/civil.js';

const boundaryCache = new Map<string, number>();
const hourFormatters = new Map<string, Intl.DateTimeFormat>();

/** Binary-search a CIVIL boundary in the current device zone, including DST and
 * half-hour shifts. Never use the old snapshot's UTC offset or add 24 hours.
 */
export function startOfLocalDay(day: string, zone: string): number {
  const key = `${zone}:${day}`;
  const cached = boundaryCache.get(key);
  if (cached !== undefined) return cached;
  const midnight = Date.parse(`${toLocalDay(day)}T00:00:00Z`);
  let low = midnight - 18 * 3_600_000;
  let high = midnight + 36 * 3_600_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDayOf(new Date(middle), zone) < day) low = middle;
    else high = middle;
  }
  boundaryCache.set(key, high);
  return high;
}

export function nextBoundary(nowMs: number, zone: string): number {
  return startOfLocalDay(addCivilDays(localDayOf(new Date(nowMs), zone), 1), zone);
}

export function localHour(nowMs: number, zone: string): number {
  let formatter = hourFormatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: 'numeric',
      hourCycle: 'h23',
    });
    hourFormatters.set(zone, formatter);
  }
  return Number(formatter.format(new Date(nowMs)));
}

/** First instant at/after a local hour. Binary search handles skipped civil hours. */
export function localHourBoundary(day: string, hour: number, zone: string): number {
  let low = startOfLocalDay(day, zone);
  let high = startOfLocalDay(addCivilDays(toLocalDay(day), 1), zone);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localHour(middle, zone) < hour) low = middle;
    else high = middle;
  }
  return high;
}
