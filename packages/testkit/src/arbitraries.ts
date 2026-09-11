import fc from 'fast-check';
import { addCivilDays, toLocalDay, type LocalDay } from '@freelingo/core';

/** Named config: the window every generated civil date falls in. */
export const ARBITRARY_DAY_EPOCH = '2024-01-01';
export const ARBITRARY_DAY_SPAN_DAYS = 1_200;

export function arbLocalDay(): fc.Arbitrary<LocalDay> {
  const epoch = toLocalDay(ARBITRARY_DAY_EPOCH);
  return fc
    .integer({ min: 0, max: ARBITRARY_DAY_SPAN_DAYS })
    .map((offset) => addCivilDays(epoch, offset));
}

export function arbZoneId(zones: readonly { id: string }[]): fc.Arbitrary<string> {
  return fc.constantFrom(...zones.map((z) => z.id));
}

/** Named config: the instant window every generated `Date` falls in. */
export const ARBITRARY_INSTANT_MIN = '2024-01-01T00:00:00Z';
export const ARBITRARY_INSTANT_MAX = '2027-12-31T23:59:59Z';

/**
 * A UTC instant inside the window. Day properties derive a `local_day` from one of these
 * in each zone of `ZONES`, so DST transitions and the date line are hit by construction.
 */
export function arbInstant(): fc.Arbitrary<Date> {
  return fc.date({
    min: new Date(ARBITRARY_INSTANT_MIN),
    max: new Date(ARBITRARY_INSTANT_MAX),
    noInvalidDate: true,
  });
}
