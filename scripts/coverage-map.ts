/**
 * pnpm test:coverage-map
 *
 * "An invariant with no owning test is worse than a failing one." (plan §Non-negotiables)
 *
 * Parses every invariant id out of docs/invariants.md, scans every test file for test
 * names carrying an id in brackets (`it('[INV-DAY-01] ...')`), and prints the map.
 *
 * Two languages of test, because the invariants are owned in two. A TypeScript test
 * claims in its name; a Python test claims in the bracketed ids LEADING its docstring
 * (`def test_x(...): """[INV-PACK-40] ..."""`), since a Python function name cannot
 * carry brackets. The content pipeline under `tools/coursekit` owns every `C`-kind
 * invariant in the registry, so before `tools/` was scanned those ids were unownable by
 * construction — INV-PACK-13/15/17/40/51 all sat outside the only gate that can see them.
 *
 * It FAILS when an owned id has no owning test, when a test claims an id that is not in
 * the registry (a typo is otherwise invisible), when an owned id is not in the registry,
 * and when two ownership files claim the same id.
 *
 * **Ownership is a union of files.** `docs/invariants-owned.json` is the phase baseline;
 * every `docs/owned/<task>.json` beside it adds one task's ids. One shared array would
 * make nine parallel P1 tasks rebase against each other all day and would let two of them
 * silently "own" the same invariant — so the id an agent claims goes in its own file, and
 * a collision between two files is an error rather than a merge conflict.
 *
 * Run with Node 24: `node --experimental-strip-types scripts/coverage-map.ts`
 * Self-test the ownership checker: `… scripts/coverage-map.ts --self-test`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Named config: where the registry, the owned list and the test sources live. */
const REGISTRY_PATH = 'docs/invariants.md';
const OWNED_PATH = 'docs/invariants-owned.json';
/** One file per task, unioned with OWNED_PATH. See the header. */
const OWNED_DIR = 'docs/owned';
const TEST_ROOTS = ['packages', 'apps', 'e2e', 'tools'];
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx)$|\.ya?ml$|^test_.*\.py$|_test\.py$/;
/** A test file the Python claim reader handles rather than the JavaScript one. */
const PYTHON_TEST_FILE = /\.py$/;
/**
 * Directory names the walk never enters, wherever they appear.
 *
 * The last four arrived with `tools/`. A coursekit `.venv` carries thousands of installed
 * `test_*.py` files — spaCy's own suite among them — and whether some vendored test
 * mentions an invariant id is not a thing this gate may have an opinion about.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'artifacts',
  '.venv',
  '.ruff_cache',
  '.pytest_cache',
  '__pycache__',
]);
/**
 * The generated native trees (INV-PLAT-02), skipped by PATH rather than by name.
 *
 * The pattern above matches any `.yaml`, because Maestro flows are yaml and carry
 * invariant ids — and `expo prebuild` fills `apps/mobile/ios` with vendored ones.
 * Measured 2026-09-11: a prebuilt checkout made this scan report 27 test files instead of
 * 12, fifteen of them CocoaPods dSYM relocation maps. Nothing in a generated, gitignored
 * tree may decide whether an invariant has an owning test, and the count must not depend
 * on whether somebody has run a build.
 *
 * By path, not by the names `ios`/`android`: those are ordinary words, and a future
 * `packages/core/src/platform/ios/*.test.ts` must not disappear from the map in silence.
 */
const SKIP_PATHS = new Set(['apps/mobile/ios', 'apps/mobile/android']);
const INVARIANT_ID = /INV-[A-Z0-9]+-\d+/g;

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (SKIP_PATHS.has(relative(ROOT, full))) continue;
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (TEST_FILE_PATTERN.test(entry)) out.push(full);
  }
  return out;
}

function addClaim(claims: Map<string, string[]>, id: string, name: string): void {
  const list = claims.get(id) ?? [];
  list.push(name);
  claims.set(id, list);
}

/** Ids as they appear in a test NAME, e.g. `it('[INV-DAY-01] ...')`. */
export function claimedIdsInTypeScript(source: string): Map<string, string[]> {
  const claims = new Map<string, string[]>();
  const testName = /\b(?:it|test)(?:\.\w+)*\s*\(\s*(['"`])([\s\S]*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = testName.exec(source)) !== null) {
    const name = match[2] ?? '';
    for (const id of name.match(INVARIANT_ID) ?? []) addClaim(claims, id, name);
  }
  return claims;
}

/** A `def test_…` and the string literal that immediately follows it, if any. */
const PYTHON_TEST_DEF =
  /^[ \t]*(?:async[ \t]+)?def[ \t]+(test_\w+)[ \t]*\([\s\S]*?\)[ \t]*(?:->[^:\n]*)?:[ \t]*\r?\n[ \t]*[rRuUbB]{0,2}("""|'{3}|"|')([\s\S]*?)\2/gm;
/** Bracketed ids at the very START of a docstring: `[INV-A]`, `[INV-A][INV-B]`. */
const LEADING_CLAIM = /^[ \t]*\[(INV-[A-Z0-9]+-\d+)\]/;

/**
 * Ids a Python test claims: the bracketed ids LEADING its docstring.
 *
 * A Python function name cannot carry brackets, so the docstring is the only place the
 * convention can live — `def test_x(...): """[INV-PACK-40] …"""` is the direct analogue of
 * `it('[INV-DAY-01] …')`.
 *
 * **Leading only, and that is the whole design.** Scanning the docstring for ids anywhere
 * would make prose into coverage: `tools/coursekit/tests/test_ledger_unit.py` has a test
 * whose docstring reads `"""[INV-PACK-40] INV-MOD-13 stores speaking tokens …"""`, which
 * cites INV-MOD-13 to explain why the test exists and does not test it. A whole-docstring
 * scan would report INV-MOD-13 as having an owning test — silently, in a green run, which
 * is the exact failure this gate exists to prevent. Module docstrings and assertion
 * messages are outside a `def` and are never read at all, for the same reason.
 */
export function claimedIdsInPython(source: string): Map<string, string[]> {
  const claims = new Map<string, string[]>();
  let match: RegExpExecArray | null;
  PYTHON_TEST_DEF.lastIndex = 0;
  while ((match = PYTHON_TEST_DEF.exec(source)) !== null) {
    const name = match[1] ?? '';
    let rest = match[3] ?? '';
    let leading: RegExpExecArray | null;
    while ((leading = LEADING_CLAIM.exec(rest)) !== null) {
      addClaim(claims, leading[1]!, `${name} :: ${rest.split('\n')[0]!.trim()}`);
      rest = rest.slice(leading[0].length);
    }
  }
  return claims;
}

function claimedIdsIn(source: string, file: string): Map<string, string[]> {
  return PYTHON_TEST_FILE.test(file)
    ? claimedIdsInPython(source)
    : claimedIdsInTypeScript(source);
}

const registry = new Set(
  (readFileSync(join(ROOT, REGISTRY_PATH), 'utf8').match(INVARIANT_ID) ?? []).sort(),
);
if (registry.size === 0) {
  console.error(`coverage-map: no invariant ids found in ${REGISTRY_PATH}`);
  process.exit(1);
}

/* ------------------------------------------------------------- ownership union */

export interface OwnershipFile {
  /** Path as printed in an error message. */
  readonly path: string;
  readonly ids: readonly string[];
}

export interface OwnershipResult {
  readonly owned: string[];
  /** id -> the files that claim it, for every id claimed more than once. */
  readonly duplicates: Map<string, string[]>;
  readonly errors: string[];
}

/**
 * Union the ownership files, refusing a duplicate claim and an id the registry lacks.
 *
 * Pure, and exported, so `--self-test` can hand it inputs that must fail. A gate whose
 * failure path has never been executed is a gate nobody has checked.
 */
export function unionOwnership(
  files: readonly OwnershipFile[],
  registry: ReadonlySet<string>,
): OwnershipResult {
  const claims = new Map<string, string[]>();
  for (const file of files) {
    for (const id of file.ids) {
      const claimants = claims.get(id) ?? [];
      claimants.push(file.path);
      claims.set(id, claimants);
    }
  }
  const duplicates = new Map([...claims].filter(([, where]) => where.length > 1));
  const errors: string[] = [];
  for (const [id, where] of duplicates) {
    errors.push(`ownership: ${id} is claimed by ${where.length} files: ${where.join(', ')}`);
  }
  const owned = [...claims.keys()].sort();
  for (const id of owned) {
    if (!registry.has(id)) {
      errors.push(`ownership: ${id} (${claims.get(id)!.join(', ')}) is not in ${REGISTRY_PATH}`);
    }
  }
  return { owned, duplicates, errors };
}

/** Every ownership file on disk: the phase baseline plus one file per task. */
function ownershipFiles(): OwnershipFile[] {
  const read = (relativePath: string): OwnershipFile => ({
    path: relativePath,
    ids: (JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8')) as { owned: string[] }).owned,
  });
  const files = [read(OWNED_PATH)];
  let entries: string[] = [];
  try {
    entries = readdirSync(join(ROOT, OWNED_DIR))
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    entries = []; // no per-task files yet
  }
  for (const entry of entries) files.push(read(`${OWNED_DIR}/${entry}`));
  return files;
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

const ownershipSources = ownershipFiles();
const ownership = unionOwnership(ownershipSources, registry);
const owned = ownership.owned;

const testFiles = TEST_ROOTS.flatMap((r) => walk(join(ROOT, r)));
const ownerOf = new Map<string, string[]>();
for (const file of testFiles) {
  const source = readFileSync(file, 'utf8');
  for (const [id, names] of claimedIdsIn(source, file)) {
    const where = ownerOf.get(id) ?? [];
    for (const name of names) where.push(`${relative(ROOT, file)} :: ${name}`);
    ownerOf.set(id, where);
  }
}

const unknownClaims = [...ownerOf.keys()].filter((id) => !registry.has(id)).sort();
const missing = owned.filter((id) => !ownerOf.has(id)).sort();
const pending = [...registry].filter((id) => !ownerOf.has(id)).length;

console.log(`coverage-map`);
console.log(`  registry      ${registry.size} ids in ${REGISTRY_PATH}`);
console.log(`  test files    ${testFiles.length}`);
console.log(`  owned now     ${owned.length} across ${ownershipSources.length} ownership file(s)`);
for (const file of ownershipSources) console.log(`    ${file.ids.length}  ${file.path}`);
console.log(`  with a test   ${ownerOf.size}`);
console.log(`  pending       ${pending} ids have no owning test yet`);
for (const id of owned) {
  const where = ownerOf.get(id);
  console.log(`  ${where ? 'OK  ' : 'MISS'} ${id}${where ? ` <- ${where.length} test(s)` : ''}`);
}

let failed = false;
if (ownership.errors.length > 0) {
  console.error(`\n${ownership.errors.join('\n')}`);
  failed = true;
}
if (missing.length > 0) {
  console.error(`\ncoverage-map: no owning test for: ${missing.join(', ')}`);
  console.error(`  add a test whose name contains the id, e.g. it('[${missing[0]}] ...')`);
  failed = true;
}
if (unknownClaims.length > 0) {
  console.error(
    `\ncoverage-map: test claims an id that is not in the registry: ${unknownClaims.join(', ')}`,
  );
  failed = true;
}
process.exit(failed ? 1 : 0);

/* ------------------------------------------------------------------- self-test */

/**
 * The two failures this gate exists for, executed against the checker itself.
 *
 * Both were possible before the union existed and neither is visible in a green run:
 * two task files owning the same id (so one of them can delete its test and stay green),
 * and a file owning an id the registry does not carry (a typo that reads as coverage).
 */
function selfTest(): void {
  const registryFixture = new Set(['INV-ECO-01', 'INV-ECO-02', 'INV-DAY-01']);
  const failures: string[] = [];

  const clean = unionOwnership(
    [
      { path: 'a.json', ids: ['INV-ECO-01'] },
      { path: 'b.json', ids: ['INV-ECO-02', 'INV-DAY-01'] },
    ],
    registryFixture,
  );
  if (clean.errors.length !== 0) failures.push(`disjoint files must pass: ${clean.errors}`);
  if (clean.owned.join(',') !== 'INV-DAY-01,INV-ECO-01,INV-ECO-02') {
    failures.push(`union must be sorted and complete, got ${clean.owned.join(',')}`);
  }

  const duplicated = unionOwnership(
    [
      { path: 'a.json', ids: ['INV-ECO-01'] },
      { path: 'b.json', ids: ['INV-ECO-01'] },
    ],
    registryFixture,
  );
  if (!duplicated.errors.some((e) => e.includes('claimed by 2 files'))) {
    failures.push('a duplicate id across two files must fail');
  }

  const unknown = unionOwnership([{ path: 'a.json', ids: ['INV-ECO-99'] }], registryFixture);
  if (!unknown.errors.some((e) => e.includes('is not in'))) {
    failures.push('an id absent from the registry must fail');
  }

  // The Python reader. Its failure mode is the opposite of the ownership gate's: it
  // over-reports, turning a citation in prose into coverage — and an over-reporting
  // coverage gate is green and useless. Built line by line rather than as a template
  // literal so the fixture can contain Python triple quotes.
  const q3 = '"'.repeat(3);
  const python = [
    'import pytest',
    '',
    `${q3}[INV-ECO-99] a MODULE docstring is not a test.${q3}`,
    '',
    '',
    'def helper_not_a_test() -> None:',
    `    ${q3}[INV-ECO-99] not a test function.${q3}`,
    '',
    '',
    'def test_one(tmp_path: Path) -> None:',
    `    ${q3}[INV-ECO-01] the committed table is the one that ships.`,
    '',
    '    Prose citing INV-ECO-99 to explain why this test exists.',
    `    ${q3}`,
    '    assert "INV-ECO-99" not in message',
    '',
    '',
    'def test_two() -> None:',
    "    '''[INV-ECO-02][INV-DAY-01] two ids, both claimed.'''",
    '',
    '',
    'def test_three() -> None:',
    '    assert True  # no docstring, claims nothing',
    '',
  ].join('\n');
  const claimed = claimedIdsInPython(python);
  const gotPython = [...claimed.keys()].sort().join(',');
  if (gotPython !== 'INV-DAY-01,INV-ECO-01,INV-ECO-02') {
    failures.push(
      `python claims must be the LEADING bracketed ids of a test docstring, got ${gotPython}`,
    );
  }
  if (claimedIdsInTypeScript(python).size !== 0) {
    failures.push('the JavaScript reader must find nothing in a Python file');
  }
  const typescript = claimedIdsInTypeScript(`it('[INV-DAY-01] streak', () => {});`);
  if ([...typescript.keys()].join(',') !== 'INV-DAY-01') {
    failures.push('the JavaScript reader regressed');
  }

  if (failures.length > 0) {
    console.error(`coverage-map --self-test FAILED\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('coverage-map --self-test: ownership union, duplicate/unknown-id gates, and the TypeScript + Python claim readers OK');
}
