import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root, found by walking up to pnpm-workspace.yaml. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('repo root not found: no pnpm-workspace.yaml above this file');
}

export function readRepoFile(relative: string): string {
  return readFileSync(join(repoRoot(), relative), 'utf8');
}

export function readRepoJson<T = unknown>(relative: string): T {
  return JSON.parse(readRepoFile(relative)) as T;
}
