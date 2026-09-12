/**
 * `pnpm test:falsify` — the falsifier corpus gate.
 *
 * The script is `vitest run --project core -t falsifier`, so every test in this file is
 * named to match that filter. What the gate proves, in the order the failures matter:
 *
 *   1. the corpus was actually found and is not empty;
 *   2. every committed input parses, names its own invariant, and says what it falsifies;
 *   3. every corpus directory is READ by a test, and that test's names carry the filter
 *      term — which is what makes `pnpm test:falsify` execute the corpus instead of
 *      selecting nothing and exiting green;
 *   4. every input that offers the executable contract is imported and run here;
 *   5. every invariant id this phase owns has at least one committed input.
 *
 * (5) is the P1 gate clause ("committed falsifier inputs per invariant"). (3) and (4) are
 * what stop (5) from being satisfied by a directory of JSON nobody runs, and (1) is the
 * failure `docs/ci.md` names in two other places: *a scan that finds nothing passes for
 * free*.
 *
 * The gate's own failure paths are executed below against fixtures, because a gate whose
 * red path has never run is a gate nobody has checked.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  consumersFor,
  corpusDirectories,
  coveredInvariants,
  deepEqual,
  readCorpus,
  runCorpus,
  runCorpusEntry,
  testNamesIn,
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
 * executes a corpus of committed JSON. `stryker.config.json` does not mutate `journey/**`,
 * so running these under every mutant measures nothing and costs the whole scan each time.
 * `STRYKER_MUTATOR_WORKER` is set by @stryker-mutator/core in the forked test-runner
 * process (child-process-proxy.js), so this skips there and only there.
 */
const UNDER_STRYKER = process.env['STRYKER_MUTATOR_WORKER'] !== undefined;

const root = repoRoot();
const corpus = readCorpus(root);
const owned = unionOwnership(ownershipFiles(root)).owned;

/** The term `pnpm test:falsify` filters test names by, read from package.json. */
const script =
  (
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts['test:falsify'] ?? '';
const FILTER_TERM = /-t\s+(\S+)/.exec(script)?.[1] ?? 'falsifier';

describe.skipIf(UNDER_STRYKER)('falsifier corpus', () => {
  it('falsifier inputs exist at all (a scan that finds nothing passes for free)', () => {
    expect(
      corpus.length,
      'no __falsifiers__/*.json anywhere under packages/. The P1 gate requires a committed ' +
        'falsifying input per owned invariant; see packages/core/src/journey/README.md.',
    ).toBeGreaterThan(0);
  });

  it('every committed falsifier input parses, names its invariant and says what it falsifies', () => {
    const broken = corpus
      .filter((entry) => entry.parsed === null)
      .map((entry) => `${entry.path}: ${entry.errors.join('; ')}`);
    expect(broken).toEqual([]);
  });

  it('every falsifier directory is read by a test that `pnpm test:falsify` selects', () => {
    const reports = consumersFor(corpusDirectories(corpus), FILTER_TERM, root);
    const unread = reports.filter((r) => r.consumers.length === 0).map((r) => r.directory);
    expect(
      unread,
      'nothing in the tree reads these directories, so the inputs in them are never ' +
        'executed. A fixture no test loads is a JSON file, not a falsifier.',
    ).toEqual([]);

    const unselectable = reports
      .filter((r) => r.selectable.length === 0)
      .map((r) => `${r.directory} (read by ${r.consumers.join(', ')})`);
    expect(
      unselectable,
      `these directories are read, but by tests whose names do not contain "${FILTER_TERM}" — ` +
        `so \`pnpm test:falsify\` selects none of them and the corpus is executed only by ` +
        `accident under \`pnpm test\`. Put "${FILTER_TERM}" in the describe or it names.`,
    ).toEqual([]);
  });

  it('every falsifier input that offers the executable contract runs and agrees with its module', async () => {
    const results = await runCorpus(corpus);
    const failed = results
      .filter((r) => !r.ok)
      .map((r) => `${r.file} [${r.invariant}] ${r.case}: ${r.detail}`);
    expect(failed).toEqual([]);
  });

  it('every owned invariant id has a committed falsifier input', () => {
    const covered = coveredInvariants(corpus);
    const missing = sortIds(owned.filter((id) => !covered.has(id)));
    const example = missing[0] ?? 'INV-DAY-02';
    expect(
      missing,
      [
        'these owned invariants have no committed falsifying input (P1 gate: "committed',
        'falsifier inputs per invariant"). One file per id, beside the module that owns it:',
        '',
        `  packages/core/src/<module>/__falsifiers__/${example}.json`,
        '  {',
        `    "invariant": "${example}",`,
        '    "falsifier": "the one input that would have caught the bug this rule is about",',
        '    "source": "<the EC id it comes from>",',
        '    "input": { … }',
        '  }',
        '',
        "The payload shape is the lane's own; what this gate requires is the id, the",
        'sentence, and a test that reads the directory. Format: packages/core/src/journey/README.md.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('the falsify script still routes to this gate', () => {
    expect(script).toContain('--project core');
    expect(script, 'test:falsify must filter by test name').toMatch(/-t\s+\S+/);
    const self = readFileSync(new URL(import.meta.url), 'utf8');
    expect(
      testNamesIn(self).filter((name) => name.includes(FILTER_TERM)).length,
      `no test in this file matches the filter ${FILTER_TERM}, so \`pnpm test:falsify\` selects nothing`,
    ).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------ the gate's own failure paths */

/** A validated entry pointing at a fake module, used to drive the executor. */
function entryFor(file: Record<string, unknown>): CorpusEntry {
  const fileId = String(file['invariant'] ?? file['id']);
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
  const executable = {
    invariant: 'INV-DAY-01',
    why: 'the streak must be a function of the day SET, not the order',
    check: { module: './streak.js', export: 'streakLength' },
    cases: [{ name: 'two days', args: [['2026-09-10', '2026-09-11']], expect: 2 }],
  };

  it('a falsifier case whose module disagrees is reported as failed, not skipped', async () => {
    const results = await runCorpusEntry(
      entryFor(executable),
      loaderFor({ streakLength: () => 1 }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toContain('returned 1, expected 2');
  });

  it('a falsifier case that agrees with its module passes', async () => {
    const results = await runCorpusEntry(
      entryFor(executable),
      loaderFor({ streakLength: () => 2 }),
    );
    expect(results.map((r) => r.ok)).toEqual([true]);
  });

  it('a falsifier whose named export was renamed away fails at the export', async () => {
    const results = await runCorpusEntry(
      entryFor(executable),
      loaderFor({ somethingElse: () => 2 }),
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toContain('no exported function streakLength');
  });

  it('a falsifier whose module cannot be imported fails at the import', async () => {
    const results = await runCorpusEntry(entryFor(executable), async () => {
      throw new Error('ERR_MODULE_NOT_FOUND');
    });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toContain('cannot import');
  });

  it('a falsifier expecting a throw fails when the module returns instead', async () => {
    const throwing = {
      ...executable,
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

  it('a falsifier accepts any lane payload, but never a missing id or a missing reason', () => {
    // The three shapes the P1 lanes actually committed. All three are legal.
    expect(
      validateFalsifierFile(
        {
          id: 'INV-DAY-03',
          falsifier: 'a three-date powered-off gap that returns unlived and preserves the streak',
          source: 'EC-STK-21',
          input: { poweredOff: {} },
          usedBy: ['day/boundary.test.ts'],
        },
        'INV-DAY-03',
      ).errors,
    ).toEqual([]);
    expect(
      validateFalsifierFile(
        { id: 'INV-SESS-01', case: 'killed at every instant of a six-item session', input: {} },
        'INV-SESS-01',
      ).errors,
    ).toEqual([]);
    expect(
      validateFalsifierFile(
        { invariant: 'INV-PATH-01', why: 'unit n+1 unlocks only on the last node of unit n' },
        'INV-PATH-01',
      ).errors,
    ).toEqual([]);

    // And the two things no payload may omit.
    expect(validateFalsifierFile({ why: 'a sentence long enough' }, 'INV-DAY-01').errors).toContain(
      'no id: give it "invariant" (or "id") naming what it falsifies',
    );
    expect(
      validateFalsifierFile({ id: 'INV-DAY-01', why: 'short' }, 'INV-DAY-01').errors.some((e) =>
        e.includes('no reason'),
      ),
    ).toBe(true);
    expect(
      validateFalsifierFile(
        { invariant: 'INV-DAY-01', why: 'a sentence long enough' },
        'INV-DAY-02',
      ).errors.some((e) => e.includes('file name says')),
    ).toBe(true);
  });

  it('a falsifier with an executable check and no case, or a case with no expectation, is rejected', () => {
    expect(validateFalsifierFile({ ...executable, cases: [] }, 'INV-DAY-01').errors).toContain(
      '"cases" must be a non-empty array when "check" is declared',
    );
    expect(
      validateFalsifierFile(
        { ...executable, cases: [{ name: 'n', args: [] }] },
        'INV-DAY-01',
      ).errors.some((e) => e.includes('exactly one of')),
    ).toBe(true);
  });

  it('a falsifier corpus read by a test with no matching test name is reported', () => {
    // The consumption check, against this repository rather than a fixture: the term must
    // be one that appears in a test NAME, not merely in a file name or a comment.
    const names = testNamesIn("describe('reads __falsifiers__', () => { it('loads', () => {}) })");
    expect(names).toEqual(['reads __falsifiers__', 'loads']);
    expect(names.some((n) => n.includes('falsifier'))).toBe(true);
    expect(testNamesIn('// falsifier in a comment')).toEqual([]);
  });

  it('a falsifier comparison is structural, and refuses a value JSON cannot express', () => {
    expect(deepEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(deepEqual(new Map([['a', 1]]), {})).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});
