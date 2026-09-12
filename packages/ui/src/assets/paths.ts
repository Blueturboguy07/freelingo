/**
 * Where `art/` is, for the build and test tooling in this package.
 *
 * `@freelingo/testkit` already has a `repoRoot()`, and this is deliberately not that one:
 * `packages/ui` does not depend on testkit, and adding a dependency is the deps task's
 * job for the phase (plan §The build workflow, step 1), not this lane's. Ten lines of
 * upward walk is the cheaper honest answer than a lockfile change filed as a request.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function repoRoot(): string {
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('repo root not found: no pnpm-workspace.yaml above this file');
}

/** Absolute path of a repo-relative art path such as `art/mascot/parrot-idle.svg`. */
export function artPath(relative: string): string {
  return join(repoRoot(), relative);
}

/**
 * Where rasterised previews go.
 *
 * Not committed: the repository's `.gitignore` ignores any directory called `build/`, so
 * `art/build/` is derived output by construction. That is the right answer rather than an
 * accident — a committed PNG of a pose is a second source of truth that drifts from the
 * SVG the moment somebody edits one and not the other. The floor that actually protects
 * the art is `legibility.test.ts`, which re-renders from the SVG on every run; the PNGs
 * exist so a human can look at what the numbers are describing.
 */
export const RASTER_OUT_DIR = 'art/build';
