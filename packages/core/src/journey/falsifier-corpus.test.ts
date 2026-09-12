/**
 * `pnpm test:falsify` — the falsifier corpus gate.
 *
 * The script is `vitest run --project core -t falsifier`, so every test in this file is
 * named to match that filter. What the gate proves, in the order the failures matter:
 *
 *   1. the corpus was actually found and is not empty;
 *   2. every committed input parses, names its own invariant, and says what it falsifies;
 *   3. every corpus directory is READ by a test IN THE MODULE THAT OWNS IT, and that
 *      test's names carry the filter term — which is what makes `pnpm test:falsify`
 *      execute the corpus instead of selecting nothing and exiting green. This file is
 *      excluded from counting as a reader: it mentions the directory name and matches the
 *      filter, so counting it made every corpus in the package read by the checker itself;
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
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

    /*
     * And it ran something.
     *
     * `docs/P1-REPORT.md` recorded this clause as "GREEN because there is nothing to
     * run": zero of 176 committed fixtures declared `{check, cases}`, so `runCorpus`
     * returned an empty array and `expect([]).toEqual([])` passed forever. That is the
     * exact shape `docs/ci.md` names — a scan that finds nothing passes for free — sitting
     * inside the gate written to catch it.
     *
     * At P1 integration the economy and ceremony lanes became the contract's first users,
     * so a floor now exists. It is deliberately a floor and not the exact number: a lane
     * adding a case must not have to edit this file, but a change that takes the corpus
     * back to "executed by nobody" has to.
     */
    expect(
      results.length,
      'no committed falsifier declares the executable {check, cases} contract, so this ' +
        'clause is green over zero cases. Give at least one fixture a `check`.',
    ).toBeGreaterThanOrEqual(40);
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

  it('the falsify script still routes to this gate, and to every project holding a corpus', () => {
    expect(script, 'test:falsify must filter by test name').toMatch(/-t\s+\S+/);

    /*
     * `expect(script).toContain('--project core')` was the assertion here until P1
     * integration, and it went stale the moment the corpus stopped living only in
     * `packages/core`: the schema lane's five fixtures and the platform gates' two sit in
     * `packages/schema` and `packages/testkit`, and a script pinned to one project selects
     * none of them. The consumption check would still have passed — it reads test NAMES,
     * and those carry the filter term — so `pnpm test:falsify` would have reported green
     * over seven inputs it never ran. That is this file's own failure mode, one level up.
     *
     * So the projects are DERIVED from where the corpus actually is. Vitest project names
     * are package directory names (`vitest.config.ts`: root `./packages/${name}`), so a
     * corpus at `packages/schema/src/__falsifiers__` requires project `schema`. A script
     * with no `--project` pin at all runs every project and is fine.
     */
    const pinned = [...script.matchAll(/--project\s+(\S+)/g)].map((m) => m[1] as string);
    if (pinned.length > 0) {
      /*
       * Only the corpora vitest can run. `tools/coursekit/tests/falsifiers` is a pytest
       * corpus: it is executed by `uv run pytest` in pack-ci.yml, and `--project coursekit`
       * is not a thing that exists. Deriving a vitest project name from it would demand a
       * pin that cannot be satisfied, so the derivation is scoped to the packages the
       * vitest workspace actually defines. The Python corpus is still held by the two
       * clauses above (it parses and names its invariant; it is read by a test in its own
       * module whose name a `-k falsifier` run selects).
       */
      const needed = [
        ...new Set(
          corpusDirectories(corpus)
            .filter((dir) => dir.startsWith('packages/'))
            .map((dir) => dir.split('/')[1] as string),
        ),
      ].sort();
      const unreachable = needed.filter((project) => !pinned.includes(project));
      expect(
        unreachable,
        `these packages hold falsifier corpora that \`pnpm test:falsify\` does not select ` +
          `(it pins --project ${pinned.join(', ')}). Add them, or drop the pin.`,
      ).toEqual([]);
    }

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

  it('a falsifier filter term counts only in a test NAME, never in a comment', () => {
    // `testNamesIn` alone. The consumption check it feeds is driven, end to end, by the
    // fixture-tree describe below — asserting this helper was never evidence for that.
    const names = testNamesIn("describe('reads __falsifiers__', () => { it('loads', () => {}) })");
    expect(names).toEqual(['reads __falsifiers__', 'loads']);
    expect(names.some((n) => n.includes('falsifier'))).toBe(true);
    expect(testNamesIn('// falsifier in a comment')).toEqual([]);
  });
});

/* ------------------------------------- the consumption check, against a fixture tree */

/**
 * The half of the gate that is load-bearing and was, in the first version of this file,
 * asserted only through `testNamesIn` — a string helper. `consumersFor` itself was never
 * driven, and it was wrong: it scanned the whole package (`packages/core/src`), where this
 * very file mentions `__falsifiers__` and carries the filter term in its test names, so
 * **every** corpus directory in the package was reported read and selectable no matter who
 * read it. A refuter proved it by dropping a fixture into an unread `db/__falsifiers__`
 * and getting the same 33 consumers / 31 selectable as every real corpus.
 *
 * So the four outcomes now run against a fixture tree on disk, one directory per outcome:
 * read-and-selectable, read-but-not-selectable, **read by nobody**, and read only by this
 * gate (which must not count).
 */
describe.skipIf(UNDER_STRYKER)('falsifier consumption check, on a fixture tree', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'freelingo-falsifier-'));
  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const src = join(fixtureRoot, 'packages', 'core', 'src');
  const dirName = '__falsifiers__'; // built, not written, so this file's own literals do not matter
  const write = (relativePath: string, contents: string): void => {
    const absolute = join(src, relativePath);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents);
  };
  const fixture = (id: string): string => `{"invariant":"${id}","why":"a sentence long enough"}`;
  const reader = (module: string, testName: string): string =>
    `import { readdirSync } from 'node:fs';\n` +
    `const dir = '${module}/${dirName}';\n` +
    `describe('${module}', () => { it('${testName}', () => { readdirSync(dir); }); });\n`;

  // 1. read by its own module, by a test the filter selects.
  write(`day/${dirName}/INV-DAY-01.json`, fixture('INV-DAY-01'));
  write('day/falsifiers.test.ts', reader('day', 'every committed falsifier input holds'));
  // 2. read by its own module, by a test the filter does NOT select.
  write(`economy/${dirName}/INV-ECO-01.json`, fixture('INV-ECO-01'));
  write('economy/config.test.ts', reader('economy', 'the goal ladder is one table'));
  // 3. read by nobody at all — the refuter's probe.
  write(`db/${dirName}/INV-PER-06.json`, fixture('INV-PER-06'));
  // 4. read only by this gate's own test file, which must not count as a consumer.
  write(`journey/${dirName}/INV-DAY-09.json`, fixture('INV-DAY-09'));
  write('journey/falsifier-corpus.test.ts', reader('journey', 'the falsifier corpus is read'));

  const directories = [
    `packages/core/src/day/${dirName}`,
    `packages/core/src/economy/${dirName}`,
    `packages/core/src/db/${dirName}`,
    `packages/core/src/journey/${dirName}`,
  ];
  const reports = consumersFor(directories, 'falsifier', fixtureRoot);
  const byDirectory = new Map(reports.map((report) => [report.directory, report]));
  const report = (module: string) => byDirectory.get(`packages/core/src/${module}/${dirName}`)!;

  it('a falsifier corpus read by its own module, by a selected test, is read and selectable', () => {
    expect(report('day').consumers).toEqual(['packages/core/src/day/falsifiers.test.ts']);
    expect(report('day').selectable).toEqual(['packages/core/src/day/falsifiers.test.ts']);
  });

  it('a falsifier corpus read by a test with no matching test name is read but NOT selectable', () => {
    expect(report('economy').consumers).toEqual(['packages/core/src/economy/config.test.ts']);
    expect(report('economy').selectable).toEqual([]);
  });

  it('a falsifier corpus no test reads is reported UNREAD (the check discriminates)', () => {
    expect(report('db').consumers).toEqual([]);
    expect(report('db').selectable).toEqual([]);
  });

  it("a falsifier corpus read only by this gate's own test file is reported UNREAD", () => {
    expect(report('journey').consumers).toEqual([]);
  });

  it('a falsifier consumer in a SIBLING module never counts (the scan is module-scoped)', () => {
    // day/falsifiers.test.ts mentions the directory name and is selected by the filter;
    // it is one directory away from db/ and must still leave db/ unread. This is the
    // property the package-wide scan did not have.
    const everyConsumer = reports.flatMap((entry) => entry.consumers);
    expect(everyConsumer).toEqual([
      'packages/core/src/day/falsifiers.test.ts',
      'packages/core/src/economy/config.test.ts',
    ]);
  });
});

describe.skipIf(UNDER_STRYKER)('falsifier gate structural equality', () => {
  it('a falsifier comparison of JSON-shaped values is structural', () => {
    expect(deepEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(deepEqual(new Map([['a', 1]]), {})).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});
