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
