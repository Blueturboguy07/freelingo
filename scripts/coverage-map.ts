/**
 * pnpm test:coverage-map
 *
 * "An invariant with no owning test is worse than a failing one." (plan §Non-negotiables)
 *
 * Parses every invariant id out of docs/invariants.md, scans every test file for test
 * names carrying an id in brackets (`it('[INV-DAY-01] ...')`), and prints the map.
 *
 * It FAILS when an id listed in docs/invariants-owned.json has no owning test, and when
 * a test claims an id that is not in the registry (a typo is otherwise invisible).
 * Ids not yet owned are reported as pending, one line per phase to add them.
 *
 * Run with Node 24: `node --experimental-strip-types scripts/coverage-map.ts`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Named config: where the registry, the owned list and the test sources live. */
const REGISTRY_PATH = 'docs/invariants.md';
const OWNED_PATH = 'docs/invariants-owned.json';
const TEST_ROOTS = ['packages', 'apps', 'e2e'];
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx)$|\.ya?ml$/;
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
    if (entry === 'node_modules' || entry === 'dist' || entry === 'artifacts') continue;
    const full = join(dir, entry);
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

const registry = new Set(
  (readFileSync(join(ROOT, REGISTRY_PATH), 'utf8').match(INVARIANT_ID) ?? []).sort(),
);
if (registry.size === 0) {
  console.error(`coverage-map: no invariant ids found in ${REGISTRY_PATH}`);
  process.exit(1);
}

const owned: string[] = (
  JSON.parse(readFileSync(join(ROOT, OWNED_PATH), 'utf8')) as { owned: string[] }
).owned;

const testFiles = TEST_ROOTS.flatMap((r) => walk(join(ROOT, r)));
const ownerOf = new Map<string, string[]>();
for (const file of testFiles) {
  const source = readFileSync(file, 'utf8');
  for (const [id, names] of claimedIdsIn(source)) {
    const where = ownerOf.get(id) ?? [];
    for (const name of names) where.push(`${relative(ROOT, file)} :: ${name}`);
    ownerOf.set(id, where);
  }
}

const unknownClaims = [...ownerOf.keys()].filter((id) => !registry.has(id)).sort();
const missing = owned.filter((id) => !ownerOf.has(id)).sort();
const notInRegistry = owned.filter((id) => !registry.has(id)).sort();
const pending = [...registry].filter((id) => !ownerOf.has(id)).length;

console.log(`coverage-map`);
console.log(`  registry      ${registry.size} ids in ${REGISTRY_PATH}`);
console.log(`  test files    ${testFiles.length}`);
console.log(`  owned now     ${owned.length} (${OWNED_PATH})`);
console.log(`  with a test   ${ownerOf.size}`);
console.log(`  pending       ${pending} ids have no owning test yet`);
for (const id of owned) {
  const where = ownerOf.get(id);
  console.log(`  ${where ? 'OK  ' : 'MISS'} ${id}${where ? ` <- ${where.length} test(s)` : ''}`);
}

let failed = false;
if (notInRegistry.length > 0) {
  console.error(
    `\ncoverage-map: owned id not present in the registry: ${notInRegistry.join(', ')}`,
  );
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
