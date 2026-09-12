/**
 * Where the repository root is, found without importing the testkit.
 *
 * `@freelingo/testkit` exports `repoRoot()`, but it is a devDependency of
 * `packages/core` and the files in this directory are plain sources (Stryker sees them,
 * the purity test walks them). Duplicating eight lines is cheaper than making the pure
 * engine package depend on a test package, so this is the one copy that exists.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root, found by walking up to pnpm-workspace.yaml. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('repo root not found: no pnpm-workspace.yaml above this file');
}
