import { defineConfig } from 'vitest/config';

/**
 * Vitest workspace for the Freelingo monorepo.
 *
 * Every package is a named project so `vitest run --project core` works and so
 * the coverage-map script can attribute an invariant id to the package that owns it.
 * Node tests use Node 24's built-in `node:sqlite`; there is no native build in CI.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: './packages/core',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'schema',
          root: './packages/schema',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'ui',
          root: './packages/ui',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'testkit',
          root: './packages/testkit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
    ],
  },
});
