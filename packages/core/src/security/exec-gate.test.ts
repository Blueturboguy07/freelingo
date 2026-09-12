import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '@freelingo/testkit';
import {
  EXEC_GATE_EXTENSIONS,
  EXEC_GATE_MIN_FILES,
  EXEC_GATE_SELF_PATHS,
  EXEC_GATE_SKIP_DIRS,
  EXEC_GATE_SKIP_PATHS,
  execAsyncCallsIn,
  execAsyncViolationsIn,
} from './exec-gate.js';

/**
 * INV-SEC-02 — `execAsync` is never called with interpolated input. Grep gate on the
 * WHOLE codebase.
 *
 * Two things the P0 report says a gate like this gets wrong, both guarded here:
 *
 * - **A scan that finds nothing passes for free.** `filesScanned` is asserted against a
 *   floor and the detector is run against positive controls, so a walk that silently
 *   returns `[]` (moved directory, renamed extension, a `statSync` that threw) is red.
 * - **Generated trees are skipped by PATH, not by the names `ios`/`android`.** Those are
 *   ordinary words; a future `packages/core/src/platform/ios/` must not fall out of the
 *   scan in silence.
 */

const ROOT = repoRoot();

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (EXEC_GATE_SKIP_DIRS.includes(entry)) continue;
    const full = join(dir, entry);
    const rel = relative(ROOT, full).split(sep).join('/');
    if (EXEC_GATE_SKIP_PATHS.includes(rel)) continue;
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (EXEC_GATE_EXTENSIONS.includes(extname(full))) out.push(full);
  }
  return out;
}

const scanned = walk(ROOT)
  .map((file) => ({
    path: relative(ROOT, file).split(sep).join('/'),
    source: readFileSync(file, 'utf8'),
  }))
  .filter((file) => !EXEC_GATE_SELF_PATHS.includes(file.path));

describe('INV-SEC-02 execAsync gate', () => {
  it('[INV-SEC-02] the scan actually reads the repository (a scan that finds nothing passes for free)', () => {
    expect(scanned.length).toBeGreaterThanOrEqual(EXEC_GATE_MIN_FILES);
    // It reached every workspace that can hold SQL, not just the one this test lives in.
    for (const prefix of ['packages/core/src/', 'packages/schema/src/', 'apps/mobile/']) {
      expect(
        scanned.some((file) => file.path.startsWith(prefix)),
        `the walk never reached ${prefix}`,
      ).toBe(true);
    }
  });

  it('[INV-SEC-02] the detector still detects: every positive control is reported', () => {
    // If this test were the only thing standing between a violation and a green build, a
    // detector that had stopped matching would be invisible. These are the shapes.
    const controls: readonly [string, string][] = [
      ['await db.execAsync(`PRAGMA user_version = ${next}`);', 'template literal with an'],
      ["db.execAsync('DELETE FROM x WHERE id = ' + id);", 'string concatenation'],
      ['db.execAsync(statement);', 'non-literal argument'],
      ['await handle.execAsync(buildSql());', 'non-literal argument'],
    ];
    for (const [source, expected] of controls) {
      const violations = execAsyncViolationsIn(source);
      expect(violations, source).toHaveLength(1);
      expect(violations[0]!.reason).toContain(expected);
    }
  });

  it('[INV-SEC-02] the detector does not cry wolf: an authored literal is not a violation', () => {
    const allowed: readonly string[] = [
      "await db.execAsync('PRAGMA journal_mode = WAL');",
      'await db.execAsync(`PRAGMA foreign_keys = ON`);',
      'await db.execAsync("BEGIN EXCLUSIVE");',
    ];
    for (const source of allowed) {
      expect(execAsyncCallsIn(source), source).toHaveLength(1);
      expect(execAsyncViolationsIn(source), source).toEqual([]);
    }
  });

  it('[INV-SEC-02] no execAsync anywhere in the codebase is called with interpolated input', () => {
    const offenders = scanned.flatMap((file) =>
      execAsyncViolationsIn(file.source).map(
        (call) => `${file.path}:${call.line} ${call.reason} -> execAsync(${call.argument.trim()})`,
      ),
    );
    expect(
      offenders,
      'execAsync does not bind parameters (EC-SEC-02): pass a literal, or use run/all/get with params',
    ).toEqual([]);
  });

  it('[INV-SEC-02] the generated native trees are skipped by path, never by the names ios/android', () => {
    for (const path of EXEC_GATE_SKIP_PATHS) {
      expect(path).toContain('/');
      expect(['ios', 'android']).not.toContain(path);
    }
    // A source directory that merely ends in `ios`/`android` is still scanned.
    const decoy = 'packages/core/src/platform/ios/Adapter.ts';
    expect(EXEC_GATE_SKIP_PATHS.some((p) => decoy.startsWith(`${p}/`))).toBe(false);
  });
});
