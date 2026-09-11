import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { readRepoFile, repoRoot } from './repo.js';

/**
 * The diagnostics surface, and the trap that `native-e2e` walked into on 2026-09-11.
 *
 * `DevDiagnostics` is the only way the INV-PER-06 device gate can read the values the app
 * actually resolved. It was gated on `__DEV__`. `native-e2e` builds **Release** on both
 * platforms (Release embeds the JS bundle, which is what makes `--no-bundler` honest), and
 * `__DEV__` is false there — so the flow long-pressed the title and got nothing:
 * `Assertion is false: id: dev-diagnostics is visible`, emulator-5554, 32s.
 *
 * Two branches each did the right thing on their own and the pair did not work. These
 * tests hold the three halves of the fix together, because nothing else does: the rule,
 * the app's use of it, and the workflow steps that set the flag. Remove any one and the
 * device gate goes quiet rather than red.
 *
 * No invariant id: the registry has none for this. It is an integration gate.
 */

const MODULE = 'apps/mobile/src/dev/diagnosticsEnabled.ts';

interface DiagnosticsModule {
  readonly E2E_FLAG_NAME: string;
  readonly E2E_FLAG_ON: string;
  readonly isDiagnosticsEnabled: (isDev: boolean, flag: string | undefined) => boolean;
}

describe('the diagnostics surface is reachable exactly where it should be', () => {
  let mod: DiagnosticsModule;

  beforeAll(async () => {
    // `__DEV__` is a bundler global, not a Node one. Pinned false here so the module's
    // own `DIAGNOSTICS_ENABLED` is evaluated the way a Release build evaluates it.
    (globalThis as Record<string, unknown>).__DEV__ = false;
    mod = (await import(pathToFileURL(join(repoRoot(), MODULE)).href)) as DiagnosticsModule;
  });

  it('is open in a dev build, and in a release build only with the flag set to 1', () => {
    const { isDiagnosticsEnabled: enabled, E2E_FLAG_ON: on } = mod;
    expect(enabled(true, undefined)).toBe(true);
    expect(enabled(true, on)).toBe(true);
    expect(enabled(false, on)).toBe(true);
    // A store build: release, no flag. This is the one that must stay false.
    expect(enabled(false, undefined)).toBe(false);
    // Near-misses that a truthiness check would wave through.
    expect(enabled(false, '')).toBe(false);
    expect(enabled(false, '0')).toBe(false);
    expect(enabled(false, 'true')).toBe(false);
  });

  it('reads the flag as a literal process.env.EXPO_PUBLIC_ member, so Metro can inline it', () => {
    const src = readRepoFile(MODULE);
    // A computed lookup (`process.env[NAME]`) is not substituted by Metro: in a release
    // bundle it yields undefined, the screen vanishes, and nothing reports an error.
    expect(src).toContain('process.env.EXPO_PUBLIC_FREELINGO_E2E');
    expect(src).not.toMatch(/process\.env\[/);
    expect(src).toContain("export const E2E_FLAG_NAME = 'EXPO_PUBLIC_FREELINGO_E2E'");
  });

  it('App.tsx opens the screen through that rule and never unconditionally', () => {
    const app = readRepoFile('apps/mobile/App.tsx');
    expect(app).toContain('DIAGNOSTICS_ENABLED');
    // `__DEV__` alone is what broke; it must not be the gate on this surface any more.
    expect(app).not.toMatch(/__DEV__\s*\?/);
    // Every render path into DevDiagnostics passes the rule.
    for (const line of app.split('\n')) {
      if (line.includes('<DevDiagnostics')) {
        expect(app).toContain('diagnosticsOpen && DIAGNOSTICS_ENABLED');
      }
    }
  });

  it('native-e2e sets the flag for the iOS build, the Android build and the flow runs', () => {
    const wf = readRepoFile('.github/workflows/native-e2e.yml');
    const { E2E_FLAG_NAME: name, E2E_FLAG_ON: on } = mod;
    const settings = [...wf.matchAll(new RegExp(`^\\s*${name}:\\s*'?([^'\\n]+)'?`, 'gm'))].map(
      (m) => m[1]?.trim(),
    );
    expect(settings.length, `${name} is not set anywhere in native-e2e.yml`).toBeGreaterThan(0);
    for (const value of settings) {
      expect(value).toBe(on);
    }
    // It must sit in the WORKFLOW-level env block, above `jobs:`, so every job inherits
    // it — including the Android one, whose build and flow run inside a third-party
    // action's `script:` and so never sees a step-level env of ours.
    const beforeJobs = wf.slice(0, wf.indexOf('\njobs:'));
    expect(beforeJobs, `${name} must be workflow-level, not per-step`).toContain(
      `${name}: '${on}'`,
    );
    // Release is deliberate; if someone switches to Debug the flag stops being needed and
    // this whole gate should be revisited rather than silently kept.
    expect(wf).toContain('--configuration Release');
    expect(wf).toContain('--variant release');
  });
});
