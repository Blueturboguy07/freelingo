/**
 * Named config for the property gates (plan §Verification, §Phases P0).
 *
 * The P0 exit criterion is "DAY-01/05 + CER-01 at 10,000 cases in four zones", and
 * §Verification says ">= 10,000 cases per property". So the case count is a named
 * constant here rather than a literal repeated in every test file, and
 * `property-gates.test.ts` fails if any property in the repo runs below it.
 *
 * The count is never lowered to buy wall-clock. A property that is too slow at
 * `PROPERTY_RUNS` has a loose generator, not too many runs: tighten the generator so
 * every case is a case that could falsify the invariant. (The first draft of the
 * four-zone streak property generated days from instants spread over four years, so
 * 2,429 of every 2,500 cases asserted 0 === 0 — it was fast because it tested nothing.)
 */

/** Cases every property that owns an invariant runs at. */
export const PROPERTY_RUNS = 10_000;

/**
 * A property that loops over `ZONES` runs `PROPERTY_RUNS` cases *in each zone*, not
 * `PROPERTY_RUNS` split across them: "10,000 cases in four zones" is the gate, and a
 * quarter of the cases per zone would be 2,500.
 */
export const PROPERTY_RUNS_PER_ZONE = PROPERTY_RUNS;
