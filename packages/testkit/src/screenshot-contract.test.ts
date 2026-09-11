import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile, repoRoot } from './repo.js';

/**
 * The screenshot contract, held to what Maestro actually does.
 *
 * `native-e2e` fails a device job that collected no `.png`, so this contract is the only
 * thing standing between a passing flow and a red job — and the first version of it was
 * wrong in two ways at once, both measured on Maestro 2.10.0 / emulator-5554 on
 * 2026-09-11:
 *
 *   1. `takeScreenshot: ${ARTIFACT_DIR}/name` does not write to `$ARTIFACT_DIR/name.png`.
 *      Maestro resolves EVERY screenshot path inside its own run directory, as
 *      `<run-dir>/<flow>/takeScreenshot/<the given path>.png`. A flow cannot put a file
 *      in `e2e/artifacts/` however the path is spelled.
 *   2. `maestro test -e ARTIFACT_DIR=…` does not override a flow-level `env:` default.
 *      The flow's own value wins, so every run on every sha wrote the same literal
 *      `e2e/artifacts/local/p0-db-path.png` — inside the run directory, at that.
 *
 * Both mistakes are invisible from a green flow: the run passes and the job either
 * collects the wrong thing or nothing. So the shape of the fix is asserted here rather
 * than trusted to the comments explaining it.
 *
 * No invariant id: the registry has none for CI mechanics. It is an integration gate.
 */

const FLOW_DIR = 'e2e/flows';
const WORKFLOW = '.github/workflows/native-e2e.yml';

function flowFiles(): string[] {
  return readdirSync(join(repoRoot(), FLOW_DIR))
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => `${FLOW_DIR}/${f}`)
    .filter((f) => /^appId:/m.test(readRepoFile(f)));
}

describe('flows name their screenshots and let CI place them', () => {
  it('there is at least one flow to check, so this gate is not vacuous', () => {
    expect(flowFiles().length).toBeGreaterThan(0);
  });

  it('every flow ends in a takeScreenshot, so no green run is an empty one', () => {
    for (const file of flowFiles()) {
      expect(readRepoFile(file), `${file} takes no screenshot`).toMatch(/^- takeScreenshot:/m);
    }
  });

  it('no flow spells out a destination, because it cannot honour one', () => {
    for (const file of flowFiles()) {
      const src = readRepoFile(file);
      for (const line of src.split('\n')) {
        const shot = /^- takeScreenshot:\s*(.+)$/.exec(line);
        if (!shot) continue;
        const target = shot[1]!.trim();
        expect(target, `${file}: a screenshot target must be a bare name`).not.toContain('/');
        expect(target, `${file}: \${...} in a screenshot target is a no-op`).not.toContain('$');
      }
      // A flow-level `env:` default beats the -e CI passes, so a flow must not carry one
      // for ARTIFACT_DIR: it would silently win and point every run at the same path.
      expect(src, `${file}: must not default ARTIFACT_DIR`).not.toMatch(/^\s+ARTIFACT_DIR:/m);
    }
  });
});

describe('native-e2e places and collects them', () => {
  /**
   * Workflow lines with whole-line `#` comments removed.
   *
   * Every assertion below is about what the job RUNS. The comments in that file quote the
   * superseded spellings in order to warn people off them, so a plain substring search
   * finds the warning and calls it a usage — which is how the first draft of this gate
   * failed on `--flatten-debug-output` while the workflow never passed it.
   */
  const wf = () =>
    readRepoFile(WORKFLOW)
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

  it('aims the Maestro run directory into ARTIFACT_DIR on both platforms', () => {
    const aims = [...wf().matchAll(/--test-output-dir "\$ARTIFACT_DIR\/maestro"/g)];
    expect(aims.length, 'both device jobs must aim the run directory').toBe(2);
    // The superseded spelling: it looked right, placed nothing, and read as a contract.
    expect(wf()).not.toContain('-e ARTIFACT_DIR=');
  });

  it('never passes --flatten-debug-output, which writes to $HOME on 2.10.0', () => {
    // Measured: the flow passes, --test-output-dir is never created, and the run drops
    // maestro.log in the home directory. A job would then fail on "collected none" with
    // no hint as to why.
    expect(wf()).not.toContain('--flatten-debug-output');
  });

  it('collects the frames out of the run directory and fails a job that collected none', () => {
    const collects = [...wf().matchAll(/screenshots collected: \$COUNT/g)];
    expect(collects.length, 'both device jobs must collect').toBe(2);
    // Matched on the message, not on `if [ "$COUNT" -eq 0 ]`: `flows-present` counts into
    // a variable of the same name, so the bare shell test appears three times and the
    // count would be satisfied by two device jobs that check nothing.
    const guards = [...wf().matchAll(/::error::no screenshot came out of/g)];
    expect(guards.length, 'both device jobs must fail on zero frames').toBe(2);
  });

  it('pins the iOS toolchain below the Swift release that cannot build expo-modules-jsi', () => {
    // Xcode 26.2 / Swift 6.2.3 rejects expo-modules-jsi@57.1.0's RuntimeScheduler.h with
    // SWIFT_RETURNS_RETAINED on a non-SWIFT_SHARED_REFERENCE type: 2 errors, exit 65,
    // reproduced on this repo 2026-09-11. Unpinning is how that comes back silently.
    expect(wf()).toMatch(/^\s+XCODE_APP: '\/Applications\/Xcode_\d+(\.\d+)*\.app'$/m);
    expect(wf()).toContain('DEVELOPER_DIR=$XCODE_APP/Contents/Developer');
  });
});
