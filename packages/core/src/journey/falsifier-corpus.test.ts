/**
 * `pnpm test:falsify` — the falsifier corpus gate.
 *
 * The script is `vitest run --project core -t falsifier`, so every test in this file is
 * named to match that filter; nothing else in the tree is. What the gate proves, in the
 * order the failures matter:
 *
 *   1. the corpus was actually found and is not empty;
 *   2. every committed input has a legal shape;
 *   3. every committed input was EXECUTED against the real module it names, and the
 *      module returned the committed answer;
 *   4. every invariant id this phase owns has at least one committed input.
 *
 * (4) is the P1 gate clause ("committed falsifier inputs per invariant"). (3) is what
 * stops (4) from being satisfied by a directory of JSON nobody runs, and (1) is the
 * failure `docs/ci.md` names in two other places: *a scan that finds nothing passes for
 * free*.
 *
 * The gate's own failure paths are executed below against fixtures, because a gate
 * whose red path has never run is a gate nobody has checked.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coveredInvariants,
  deepEqual,
  readCorpus,
  runCorpus,
  runCorpusEntry,
  validateFalsifierFile,
  type CorpusEntry,
  type ModuleLoader,
} from './falsifier-corpus.js';
import { ownershipFiles, sortIds, unionOwnership } from './ownership.js';
import { repoRoot } from './repo-paths.js';

/**
 * Skipped inside a Stryker worker.
 *
 * This is a REPO gate, not an engine unit test: it reads docs/, walks every test file and
 * executes a corpus of committed JSON. `stryker.config.json` does not mutate
 * `journey/**`, so running these under every mutant measures nothing and costs the whole
 * scan each time. `STRYKER_MUTATOR_WORKER` is set by @stryker-mutator/core in the forked
 * test-runner process (child-process-proxy.js), so this skips there and only there.
 */
const UNDER_STRYKER = process.env['STRYKER_MUTATOR_WORKER'] !== undefined;

const root = repoRoot();
const corpus = readCorpus(root);
const owned = unionOwnership(ownershipFiles(root)).owned;

describe.skipIf(UNDER_STRYKER)('falsifier corpus', () => {
  it('falsifier inputs exist at all (a scan that finds nothing passes for free)', () => {
    expect(
      corpus.length,
      `no ${'__falsifiers__'}/*.json anywhere under packages/. The P1 gate requires a committed ` +
        `falsifying input per owned invariant; see packages/core/src/journey/falsifier-corpus.ts ` +
        `for the file format.`,
    ).toBeGreaterThan(0);
  });

  it('every committed falsifier input has a legal shape', () => {
    const broken = corpus
      .filter((entry) => entry.parsed === null)
      .map((entry) => `${entry.path}: ${entry.errors.join('; ')}`);
    expect(broken).toEqual([]);
  });

  it('every committed falsifier input runs against its real module and agrees with it', async () => {
    const results = await runCorpus(corpus);
    const failed = results
      .filter((r) => !r.ok)
      .map((r) => `${r.file} [${r.invariant}] ${r.case}: ${r.detail}`);
    expect(failed).toEqual([]);
    // Executed, not merely loaded: one result per case, and there is at least one case.
    expect(results.length).toBeGreaterThanOrEqual(corpus.length);
  });

  it('every owned invariant id has a committed falsifier input', () => {
    const covered = coveredInvariants(corpus);
    const missing = sortIds(owned.filter((id) => !covered.has(id)));
    expect(
      missing,
      `these owned invariants have no committed falsifying input. Add ` +
        `packages/<pkg>/src/<module>/__falsifiers__/<id>.json next to the module that owns it.`,
    ).toEqual([]);
  });

  it('the falsify script still routes to this gate', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts['test:falsify'] ?? '';
    // The filter term must be one this file's test names carry, or `pnpm test:falsify`
    // runs nothing and exits however vitest feels about an empty selection.
    expect(script).toContain('--project core');
    const term = /-t\s+(\S+)/.exec(script)?.[1];
    expect(term, 'test:falsify must filter by test name').toBeDefined();
    const self = readFileSync(new URL(import.meta.url), 'utf8');
    const namesInThisFile = [...self.matchAll(/\bit\(\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(
      namesInThisFile.filter((name) => name.includes(term!)).length,
      `no test in this file matches the filter ${term}, so \`pnpm test:falsify\` selects nothing`,
    ).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------ the gate's own failure paths */

/** A validated entry pointing at a fake module, used to drive the executor. */
function entryFor(file: Record<string, unknown>): CorpusEntry {
  const fileId = String(file['invariant']);
  const { file: parsed, errors } = validateFalsifierFile(file, fileId);
  return {
    path: `fixture/${fileId}.json`,
    absolutePath: join(root, 'packages/core/src/journey/__fixture__', `${fileId}.json`),
    fileId,
    parsed,
    errors,
  };
}

const loaderFor =
  (exports: Record<string, unknown>): ModuleLoader =>
  async () =>
    exports;

describe.skipIf(UNDER_STRYKER)('falsifier gate self-test', () => {
  const legal = {
    invariant: 'INV-DAY-01',
    why: 'the streak must be a function of the day SET, not the order',
    check: { module: './streak.js', export: 'streakLength' },
    cases: [{ name: 'two days', args: [['2026-09-10', '2026-09-11']], expect: 2 }],
  };

  it('a falsifier case whose module disagrees is reported as failed, not skipped', async () => {
    const results = await runCorpusEntry(entryFor(legal), loaderFor({ streakLength: () => 1 }));
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toContain('returned 1, expected 2');
  });

  it('a falsifier case that agrees with its module passes', async () => {
    const results = await runCorpusEntry(entryFor(legal), loaderFor({ streakLength: () => 2 }));
    expect(results.map((r) => r.ok)).toEqual([true]);
  });

  it('a falsifier whose named export was renamed away fails at the export', async () => {
    const results = await runCorpusEntry(entryFor(legal), loaderFor({ somethingElse: () => 2 }));
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toContain('no exported function streakLength');
  });

  it('a falsifier whose module cannot be imported fails at the import', async () => {
    const results = await runCorpusEntry(entryFor(legal), async () => {
      throw new Error('ERR_MODULE_NOT_FOUND');
    });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toContain('cannot import');
  });

  it('a falsifier expecting a throw fails when the module returns instead', async () => {
    const throwing = {
      ...legal,
      cases: [{ name: 'tamper', args: [[]], throws: 'monotonic' }],
    };
    const returned = await runCorpusEntry(entryFor(throwing), loaderFor({ streakLength: () => 0 }));
    expect(returned[0]!.ok).toBe(false);
    expect(returned[0]!.detail).toContain('expected a throw');

    const threw = await runCorpusEntry(
      entryFor(throwing),
      loaderFor({
        streakLength: () => {
          throw new Error('clock is not monotonic');
        },
      }),
    );
    expect(threw[0]!.ok).toBe(true);
  });

  it('a falsifier file with no case, a wrong id or no expectation is rejected', () => {
    expect(validateFalsifierFile({ ...legal, cases: [] }, 'INV-DAY-01').errors).toContain(
      '"cases" must be a non-empty array: a file with no case executes nothing',
    );
    expect(
      validateFalsifierFile(legal, 'INV-DAY-02').errors.some((e) => e.includes('file name says')),
    ).toBe(true);
    expect(
      validateFalsifierFile(
        { ...legal, cases: [{ name: 'n', args: [] }] },
        'INV-DAY-01',
      ).errors.some((e) => e.includes('exactly one of')),
    ).toBe(true);
    expect(
      validateFalsifierFile({ ...legal, why: 'short' }, 'INV-DAY-01').errors.some((e) =>
        e.includes('"why"'),
      ),
    ).toBe(true);
  });

  it('a falsifier comparison is structural, and refuses a value JSON cannot express', () => {
    expect(deepEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(deepEqual(new Map([['a', 1]]), {})).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});
