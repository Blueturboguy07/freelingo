/**
 * Zone stamps: what a row records about the clock it was written under.
 *
 * EC-STK-26's ruling, and the reason this file exists at all: **accept the platform's
 * `tz_id` and never parse it**. `Set Automatically` off, or an ICU build that resolves
 * the zone to `Etc/GMT-5`, produces an identifier no amount of string matching
 * understands. So a row stores three things — the identifier verbatim, the offset in
 * minutes measured at that instant, and a `tz_source` flag — and every civil date is
 * derived from the OFFSET. Two identifiers sharing one offset then cannot disagree
 * about `local_day` (INV-DAY-17), and an hour- or weekday-keyed predicate stays
 * auditable years later (INV-DAY-10).
 *
 * A stored `local_day` is never retro-recomputed (EC-STK-26).
 */
import { localDayFromOffset, type LocalDay } from './civil.js';

/**
 * Where the zone came from, recorded so a predicate can say why it believes an hour.
 * - `iana` — a real region/city identifier the platform resolved.
 * - `fixed_offset` — `UTC`, `GMT`, `Etc/GMT±n`, or a bare `+05:30`: a number wearing a
 *   name, with no DST rules behind it.
 * - `unknown` — the platform gave an identifier this device cannot resolve; the offset
 *   is the caller's fallback and nothing about future boundaries can be inferred.
 */
export type TzSource = 'iana' | 'fixed_offset' | 'unknown';

export interface ZoneStamp {
  /** The platform's identifier, verbatim and unparsed. */
  readonly tzId: string;
  /** Minutes east of UTC at the stamped instant. The only input to `local_day`. */
  readonly utcOffsetMinutes: number;
  readonly tzSource: TzSource;
}

/** Identifiers that are an offset wearing a name. Matched only to set `tz_source`. */
const FIXED_OFFSET_ID =
  /^(UTC|GMT|Z|Etc\/(UTC|GMT|GMT[+-]\d{1,2}|Zulu|Universal|Greenwich)|[+-]\d{2}:?\d{2})$/;

const OFFSET_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * One `Intl.DateTimeFormat` per zone, reused across instants.
 *
 * Constructing a formatter is the expensive part and it does not depend on the instant.
 * Measured 2026-09-11: the four-zone day properties build tens of millions of them
 * otherwise, and the suite's wall clock is dominated by ICU setup rather than by the rule
 * under test — which is the failure mode that makes somebody lower PROPERTY_RUNS.
 */
function offsetFormatter(tzId: string): Intl.DateTimeFormat {
  let formatter = OFFSET_FORMATTERS.get(tzId);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tzId,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    OFFSET_FORMATTERS.set(tzId, formatter);
  }
  return formatter;
}

/**
 * Minutes east of UTC in `tzId` at `instant`, measured through the calendar rather than
 * read off a name: format the instant in the zone, read the wall-clock fields back as if
 * they were UTC, and take the difference. Throws for an identifier ICU cannot resolve.
 */
export function offsetMinutesOf(instant: Date, tzId: string): number {
  const parts = offsetFormatter(tzId).formatToParts(instant);
  const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  // `asUtc` carries whole seconds, so the instant's milliseconds are removed before the
  // subtraction; otherwise every offset is off by up to a millisecond and rounds wrong
  // for the half-hour zones (Lord Howe is +10:30, and +11 in DST).
  const wholeSeconds = instant.getTime() - instant.getUTCMilliseconds();
  return Math.round((asUtc - wholeSeconds) / 60_000);
}

/**
 * Stamp the zone as of `instant`.
 *
 * `fallbackOffsetMinutes` is used only when ICU cannot resolve the identifier — the
 * `unknown` case, where the platform's raw offset is the only thing left to trust.
 */
export function resolveZone(instant: Date, tzId: string, fallbackOffsetMinutes = 0): ZoneStamp {
  let utcOffsetMinutes: number;
  let tzSource: TzSource;
  try {
    utcOffsetMinutes = offsetMinutesOf(instant, tzId);
    tzSource = FIXED_OFFSET_ID.test(tzId) ? 'fixed_offset' : 'iana';
  } catch {
    return { tzId, utcOffsetMinutes: fallbackOffsetMinutes, tzSource: 'unknown' };
  }
  if (!Number.isFinite(utcOffsetMinutes)) {
    return { tzId, utcOffsetMinutes: fallbackOffsetMinutes, tzSource: 'unknown' };
  }
  return { tzId, utcOffsetMinutes, tzSource };
}

/** A stamp for a bare offset, for a platform that reports no identifier at all. */
export function fixedOffsetZone(utcOffsetMinutes: number): ZoneStamp {
  const sign = utcOffsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(utcOffsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return { tzId: `${sign}${hh}:${mm}`, utcOffsetMinutes, tzSource: 'fixed_offset' };
}

/** The civil date of `instant` under `stamp`. Offset only — the identifier is not read. */
export function localDayOfStamp(instant: Date, stamp: ZoneStamp): LocalDay {
  return localDayFromOffset(instant, stamp.utcOffsetMinutes);
}

/** Two stamps are the same zone iff the identifier AND the offset both match. */
export function sameZone(a: ZoneStamp, b: ZoneStamp): boolean {
  return a.tzId === b.tzId && a.utcOffsetMinutes === b.utcOffsetMinutes;
}
