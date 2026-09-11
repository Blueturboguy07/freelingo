import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readRepoFile, readRepoJson, repoRoot } from './repo.js';
import { EXPO_PINNED_MODULES, FORBIDDEN_DEPENDENCIES, GENERATED_NATIVE_DIRS } from './platform.js';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const mobilePkg = readRepoJson<PackageJson>('apps/mobile/package.json');
const mobileDeps: Record<string, string> = {
  ...(mobilePkg.dependencies ?? {}),
  ...(mobilePkg.devDependencies ?? {}),
};

const BUNDLED_NATIVE_MODULES = 'apps/mobile/node_modules/expo/bundledNativeModules.json';

describe('build gates', () => {
  it('[INV-PLAT-01] every pinned dependency matches the SDK bundled version (`npx expo install`, never `npm install`)', () => {
    const bundled = readRepoJson<Record<string, string>>(BUNDLED_NATIVE_MODULES);
    const mismatches: string[] = [];
    for (const name of EXPO_PINNED_MODULES) {
      const expected = bundled[name];
      const actual = mobileDeps[name];
      if (expected === undefined) {
        mismatches.push(`${name}: not in the SDK bundled list`);
      } else if (actual !== expected) {
        mismatches.push(`${name}: package.json ${actual ?? '(absent)'} != SDK ${expected}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('[INV-PLAT-01] the Reanimated/worklets pair in the lockfile is the pair the SDK bundles', () => {
    const bundled = readRepoJson<Record<string, string>>(BUNDLED_NATIVE_MODULES);
    const lock = readRepoFile('pnpm-lock.yaml');
    for (const name of ['react-native-reanimated', 'react-native-worklets'] as const) {
      const exact = bundled[name];
      expect(exact, `${name} missing from the SDK bundled list`).toBeDefined();
      // These two are pinned exactly (no range) by the SDK, so exactly one version of
      // each may appear in the lockfile's package list, and it must be that version.
      expect(exact).toMatch(/^\d+\.\d+\.\d+$/);
      const entries = [
        ...lock.matchAll(new RegExp(`^ {2}${name}@(\\d+\\.\\d+\\.\\d+)[:(]`, 'gm')),
      ].map((m) => m[1]);
      expect([...new Set(entries)], `${name} versions resolved in pnpm-lock.yaml`).toEqual([exact]);
    }
  });

  it('[INV-PLAT-01] no forbidden dependency is installed (expo-av is dead; Detox is capped at RN 0.84)', () => {
    for (const name of FORBIDDEN_DEPENDENCIES) {
      expect(mobileDeps[name], `${name} must not be a dependency`).toBeUndefined();
    }
  });

  it('[INV-PLAT-02] no hand-edited native tree is committed; ios/ and android/ are generated and ignored', () => {
    const root = repoRoot();
    const tracked = execFileSync('git', ['ls-files', '--', ...GENERATED_NATIVE_DIRS], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    expect(tracked, 'a generated native file is committed').toBe('');

    for (const dir of GENERATED_NATIVE_DIRS) {
      if (!existsSync(join(root, dir))) continue;
      const ignored = execFileSync('git', ['check-ignore', dir], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      expect(ignored).not.toBe('');
    }
  });
});
