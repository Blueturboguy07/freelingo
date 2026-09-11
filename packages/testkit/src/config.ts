/**
 * Named config for the property gates (plan §Verification, §Phases P0).
 *
 * The P0 exit criterion is "DAY-01/05 + CER-01 at 10,000 cases in four zones", so the
 * case count is a named constant here rather than a literal repeated in every test file.
 */

/** Cases every P0 gate property runs at. */
export const PROPERTY_RUNS = 10_000;

/**
 * Cases for a property that itself loops over `ZONES`; the effective case count is
 * `PROPERTY_RUNS_PER_ZONE * ZONES.length`, which must be >= `PROPERTY_RUNS`.
 */
export const PROPERTY_RUNS_PER_ZONE = 2_500;
