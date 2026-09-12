/**
 * pnpm test:coverage-map
 *
 * "An invariant with no owning test is worse than a failing one." (plan §Non-negotiables)
 *
 * Parses every invariant id out of docs/invariants.md, scans every test file for test
 * names carrying an id in brackets (`it('[INV-DAY-01] ...')`), and prints the map.
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
/**
 * Roots the test scan walks.
 *
 * `tools` is here because the content pipeline is Python and two invariants live only
 * there: INV-PACK-15 and INV-AUD-08 are properties of a produced audio bank, so their
 * owning tests are pytest tests under `tools/coursekit/tests/`. While this array was
 * TypeScript-only, a lane could write those tests, own the ids, and be told by this gate
 * that they had no owning test — which is how P2's first coursekit claim turned the gate
 * red on a branch whose tests were all green.
 */
const TEST_ROOTS = ['packages', 'apps', 'e2e', 'tools'];
/** Vitest (`*.test.ts`), Maestro (`*.yaml`) and pytest (`test_*.py`) files. */
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx)$|\.ya?ml$|^test_[A-Za-z0-9_]+\.py$/;
/**
 * Directory names the walk never enters, wherever they appear.
 *
 * `.venv` is load-bearing, not tidiness: `tools/coursekit/.venv` holds thousands of
 * installed `test_*.py` files, and a wheel's own suite must never be able to supply
 * coverage for an id this repo never tested.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'artifacts',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
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

/** Ids as they appear in a test NAME, e.g. `it('[INV-DAY-01] ...')`. */
function claimedIdsIn(source: string): Map<string, string[]> {
  const claims = new Map<string, string[]>();
  const testName = /\b(?:it|test)(?:\.\w+)*\s*\(\s*(['"`])([\s\S]*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = testName.exec(source)) !== null) {
    const name = match[2] ?? '';
    for (const id of name.match(INVARIANT_ID) ?? []) {
      const list = claims.get(id) ?? [];
      list.push(name);
      claims.set(id, list);
    }
  }
  return claims;
}

/**
 * `test_inv_aud_08_…` -> the pair `('aud', '08')`.
 *
 * Anchored on `_` or start-of-name rather than on `\b`: in `test_inv_aud_08_…` the
 * character before `inv` is an underscore, which IS a word character, so `\binv_` matches
 * nothing at all. The first version of this scanner used `\b`, walked all seven Python
 * files, found zero claims and reported both invariants unowned — a gate that looks right
 * and answers "no" to everything. `--self-test` pins it.
 */
const PYTHON_CLAIM = /(?:^|_)inv_([a-z0-9]+)_(\d+)(?=_|$)/g;

/**
 * Ids as they appear in a **pytest** test NAME, e.g. `def test_inv_aud_08_…`.
 *
 * A Python identifier cannot hold `[`, `-` or mixed case that survives a linter, so
 * `INV-AUD-08` has no literal spelling in a `def`. The lowercase snake form is the one
 * that is genuinely a NAME: pytest prints
 * `tests/test_cast.py::test_inv_aud_08_the_rebake_key_includes_the_engine` and
 * `pytest -k inv_aud_08` selects it.
 *
 * The digits are read verbatim, so `inv_aud_08` is `INV-AUD-08`, never `INV-AUD-8` — a
 * zero dropped here would become an id the registry does not carry, which this gate
 * reports as a typo rather than as coverage.
 *
 * A docstring is NOT a claim, here or anywhere. `docs/README.md` §Adding coverage is the
 * contract and this function is what makes it one for Python.
 */
function claimedIdsInPython(source: string): Map<string, string[]> {
  const claims = new Map<string, string[]>();
  const pythonDef = /^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]*)\s*\(/gm;
  let match: RegExpExecArray | null;
  while ((match = pythonDef.exec(source)) !== null) {
    const name = match[1] ?? '';
    for (const claim of name.matchAll(PYTHON_CLAIM)) {
      const id = `INV-${claim[1]!.toUpperCase()}-${claim[2]!}`;
      const list = claims.get(id) ?? [];
      list.push(name);
      claims.set(id, list);
    }
  }
  return claims;
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
  const claims = file.endsWith('.py') ? claimedIdsInPython(source) : claimedIdsIn(source);
  for (const [id, names] of claims) {
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

  /*
   * The Python scanner, against the exact failure it shipped with once.
   *
   * `\binv_` matches nothing in `test_inv_aud_08_…` (the preceding `_` is a word
   * character), so the scan walked every pytest file and returned an empty map — and an
   * empty map is indistinguishable, in the printed report, from "nobody wrote the test".
   * These four lines are the difference between a scanner that works and one that agrees
   * with itself.
   */
  const pythonSource = [
    'def test_inv_aud_08_the_rebake_key_includes_the_engine() -> None:',
    '    """[INV-PACK-15] a docstring is prose, not a claim."""',
    'async def test_inv_a11y_04_every_type_answers_in_the_tree():',
    '    pass',
    '# def test_inv_day_01_commented_out():',
    'def helper_inv_sch_09_not_a_test():',
  ].join('\n');
  const pythonClaims = claimedIdsInPython(pythonSource);
  const pythonIds = [...pythonClaims.keys()].sort().join(',');
  if (pythonIds !== 'INV-A11Y-04,INV-AUD-08') {
    failures.push(`python claim scan: expected INV-A11Y-04,INV-AUD-08, got "${pythonIds}"`);
  }
  if (claimedIdsInPython('"""[INV-DAY-01] in a docstring only."""').size !== 0) {
    failures.push('a docstring must not count as a Python claim');
  }

  if (failures.length > 0) {
    console.error(`coverage-map --self-test FAILED\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('coverage-map --self-test: ownership union, duplicate and unknown-id gates OK');
}
