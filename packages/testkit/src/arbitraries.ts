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

/**
 * Named config for `arbDayOffsets`: how far back a generated goal-met history reaches,
 * and how far past today it is allowed to stray (a clock that ran ahead, an imported
 * dump). Both are small ON PURPOSE.
 *
 * A history is generated as day offsets from today rather than as free-floating dates
 * because a streak only exists where days are ADJACENT. Sampling 40 dates out of a
 * four-year span puts a run anchored at today-or-yesterday in ~3% of cases, so a
 * property over that generator spends 97% of its budget asserting that zero equals
 * zero. Offsets in a ~33-day window make the interesting case the common case, and cost
 * far less per case besides. `arbitraries.test.ts` holds that floor.
 */
export const ARBITRARY_HISTORY_PAST_DAYS = 30;
export const ARBITRARY_HISTORY_FUTURE_DAYS = 2;

/** Offsets of a contiguous run of `length` days ending at `anchor`. */
function runEndingAt(anchor: number, length: number): number[] {
  const days: number[] = [];
  for (let i = 0; i < length; i += 1) days.push(anchor - i);
  return days;
}

/**
 * Distinct day offsets relative to today, drawn from three shapes so that the cases a
 * streak rule can actually get wrong are the cases the property spends its budget on:
 *
 * - **structural** — a run of a chosen length ending at today, yesterday or two days
 *   ago (the anchor rule), a gap, an older block that must NOT count, and days after
 *   today. This is where long streaks and "the gap truncates it" come from.
 * - **dense** — every day of the window in or out with probability 1/2: short runs and
 *   ragged gaps nobody would think to write by hand.
 * - **sparse** — the naive shape (a handful of days scattered over the window), kept at
 *   low weight so the mostly-empty history is still covered.
 *
 * Offsets are distinct because a streak is a function of the SET; the
 * duplicate-insensitivity property builds its own duplicates rather than hoping the
 * generator makes them.
 */
export function arbDayOffsets(): fc.Arbitrary<number[]> {
  const past = ARBITRARY_HISTORY_PAST_DAYS;
  const future = ARBITRARY_HISTORY_FUTURE_DAYS;
  const span = past + future + 1;
  const anyDay = fc.integer({ min: -past, max: future });

  const sparse = fc.uniqueArray(anyDay, { maxLength: span });

  const dense = fc
    .array(fc.boolean(), { minLength: span, maxLength: span })
    .map((keep) => keep.flatMap((included, i) => (included ? [i - past] : [])));

  const structural = fc
    .record({
      anchor: fc.constantFrom(0, -1, -2),
      runLength: fc.integer({ min: 0, max: past }),
      gap: fc.integer({ min: 1, max: 4 }),
      olderLength: fc.integer({ min: 0, max: 6 }),
      futureLength: fc.integer({ min: 0, max: future + 1 }),
    })
    .map(({ anchor, runLength, gap, olderLength, futureLength }) => {
      const run = runEndingAt(anchor, runLength);
      const olderAnchor = anchor - runLength - gap;
      const older = runEndingAt(olderAnchor, olderLength);
      const ahead = runEndingAt(future, futureLength);
      return [...new Set([...run, ...older, ...ahead])];
    });

  return fc.oneof(
    { arbitrary: structural, weight: 3 },
    { arbitrary: dense, weight: 2 },
    { arbitrary: sparse, weight: 1 },
  );
}

/** The goal-met days those offsets name, by civil-date arithmetic from `today`. */
export function daysFromOffsets(today: LocalDay, offsets: readonly number[]): LocalDay[] {
  return offsets.map((offset) => addCivilDays(today, offset));
}
