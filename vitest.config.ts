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

export default defineConfig({
  test: {
    projects: PROJECTS.map((name) => ({
      test: {
        name,
        root: `./packages/${name}`,
        environment: 'node' as const,
        include: ['src/**/*.test.ts'],
        testTimeout: TEST_TIMEOUT_MS,
      },
    })),
  },
});
