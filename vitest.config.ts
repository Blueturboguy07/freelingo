import { defineConfig } from 'vitest/config';

/**
 * Vitest workspace for the Freelingo monorepo.
 *
 * Every package is a named project so `vitest run --project core` works and so
 * the coverage-map script can attribute an invariant id to the package that owns it.
 * Node tests use Node 24's built-in `node:sqlite`; there is no native build in CI.
 */

/** Named config: the packages that hold tests. One project each, same settings. */
const PROJECTS = ['core', 'schema', 'ui', 'testkit'] as const;

/**
 * How long one test may take.
 *
 * Vitest's default is 5,000 ms, which is a default and not a decision anybody made about
 * this suite. The P0 gate is "DAY-01/05 at 10,000 cases in four zones" — 40,000 cases per
 * property — and that is the invariant; the wall clock is not. Measured 2026-09-11: those
 * two properties take ~3.5 s on this Mac and blew the 5 s default on the ubuntu-latest
 * runner, where the whole suite runs about 2.5x slower (run 34634498780,
 * `Error: Test timed out in 5000ms ❯ src/day/streak.test.ts:68:3` and `:173:3`).
 *
 * 60 s is roughly seven times the slowest measured case, so a runner having a bad day does
 * not turn a correct property into a red build — and it is still short enough that a real
 * hang is reported as a failure rather than eating the job's timeout.
 *
 * It is set PER PROJECT on purpose. A `testTimeout` at the top level of this file is
 * silently ignored by inline `projects`: probed 2026-09-11 with a test that sleeps 6 s,
 * which still failed with "Test timed out in 5000ms". A CI fix that lives in the ignored
 * place looks exactly like a CI fix that works.
 *
 * If a property does not fit: tighten its generator. Never lower PROPERTY_RUNS, and never
 * raise this to paper over one that got slower for a reason nobody looked into.
 */
const TEST_TIMEOUT_MS = 60_000;

/**
 * The same tests, under Stryker, get a bigger clock — and only under Stryker.
 *
 * Measured at P1 integration (mutation run 34672747773, ubuntu-latest, the first
 * whole-engine attempt on a green tree): the dry run died after 1 m 48 s with
 *
 *   ERROR DryRunExecutor One or more tests failed in the initial test run:
 *     recovery [INV-REC-01] repairs are ≤ one per calendar month and never stack with a freeze
 *       Test timed out in 60000ms.
 *
 * and Stryker refuses to score a tree whose initial run is red, so **no number was
 * produced at all**. That test takes 14.7 s under `pnpm test` on this Mac. It is not a
 * property that got slower: Stryker's `perTest` coverage analysis instruments every
 * mutant inline and records which test covers which mutant, which is a different
 * execution mode from running the suite.
 *
 * So the budget is raised for that mode and left alone everywhere else. `pnpm test` and
 * CI keep the 60 s limit, where a real hang is still a failure rather than something that
 * eats the job's timeout — which is the thing the paragraph above this one exists to
 * protect. `STRYKER_MUTATOR_WORKER` is set by @stryker-mutator/core in the forked
 * test-runner process, so this applies there and only there.
 *
 * This is NOT the escape hatch for a property that got slower for a reason nobody looked
 * into. The rule in that case is unchanged: tighten the generator, never lower
 * PROPERTY_RUNS, and never raise the number above.
 */
const STRYKER_TIMEOUT_FACTOR = 5;
const UNDER_STRYKER = process.env['STRYKER_MUTATOR_WORKER'] !== undefined;
const EFFECTIVE_TEST_TIMEOUT_MS = UNDER_STRYKER
  ? TEST_TIMEOUT_MS * STRYKER_TIMEOUT_FACTOR
  : TEST_TIMEOUT_MS;

export default defineConfig({
  test: {
    projects: PROJECTS.map((name) => ({
      test: {
        name,
        root: `./packages/${name}`,
        environment: 'node' as const,
        include: ['src/**/*.test.ts'],
        testTimeout: EFFECTIVE_TEST_TIMEOUT_MS,
      },
    })),
  },
});
