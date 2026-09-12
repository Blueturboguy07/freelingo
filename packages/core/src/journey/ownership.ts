/**
 * The phase coverage gate, as data.
 *
 * `pnpm test:coverage-map` already asks "does every id somebody claimed have a test?".
 * That is necessary and it is not the phase gate, because it is answered by claiming
 * nothing. The P1 gate is the other direction: *"Every id in §1–§10, §13, §14 (engine
 * parts), SEC-01/02 green"* — an id nobody claimed is the failure this file exists to
 * catch, and it is invisible to a union of whatever the tasks happened to write down.
 *
 * So the roster is **derived from the registry**, not typed out:
 *
 *   required = every id in the P1 invariant families (SESS GRD COM MIS SCH DAY FRZ REC
 *              ECO CER PATH PER DAT) + INV-SEC-01/02
 *   expected = required + P0's six + the PACK/AUD engine-part ids declared in
 *              docs/owned/journey.json − the ids that file explicitly defers, with a reason
 *
 * and the gate asserts `union(every ownership file) === expected`, exactly. Derived
 * means a merge pass that adds INV-SESS-28 to the registry adds it to the roster on the
 * same commit: the gate goes red until somebody owns it, which is the point. A
 * hand-written list of 217 ids would have gone stale the first time the registry moved
 * and nothing would have said so.
 *
 * The two directions of a wrong claim are separate failures here:
 *   - MISSING: in the roster, in nobody's ownership file. The phase is not done.
 *   - UNDECLARED: claimed by a file, outside the roster and not declared as an engine
 *     part. Either the id belongs to a later phase, or the roster is wrong; both need a
 *     human, neither may pass.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoRoot } from './repo-paths.js';

/* --------------------------------------------------------------- named config */

export const REGISTRY_PATH = 'docs/invariants.md';
export const BASELINE_OWNED_PATH = 'docs/invariants-owned.json';
export const OWNED_DIR = 'docs/owned';
export const JOURNEY_OWNED_PATH = 'docs/owned/journey.json';

/**
 * The invariant families P1 owns whole, from the plan's engine table (§Architecture,
 * "Engine (packages/core) and invariant coverage") crossed with the P1 gate row.
 *
 * `day/` owns DAY + FRZ/REC; `session/` owns SESS + COM + MIS; `grading/` GRD;
 * `scheduler/` SCH; `economy/` ECO; `ceremony/` CER; `path/` PATH; `packs/migrations`
 * the §13 PER/DAT half. MOD is P3, HUB/NOT/CRS are P4, STO is P6, WID is P5, and the
 * A11Y/TYP/I18N/SND families are UI-side — none of them appear here.
 */
export const P1_FAMILIES: readonly string[] = [
  'SESS',
  'GRD',
  'COM',
  'MIS',
  'SCH',
  'DAY',
  'FRZ',
  'REC',
  'ECO',
  'CER',
  'PATH',
  'PER',
  'DAT',
];

/** Ids P1 owns that are not a whole family: the two engine-side §19 ids. */
export const P1_EXTRA_IDS: readonly string[] = ['INV-SEC-01', 'INV-SEC-02'];

/** Test roots the owning-test scan walks. */
const TEST_ROOTS = ['packages', 'apps', 'e2e'];
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx)$|\.ya?ml$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'artifacts', '.stryker-tmp']);
/**
 * Generated native trees, skipped by PATH and not by the names `ios`/`android`.
 * `expo prebuild` fills them with vendored `.yaml`, and a gitignored generated tree must
 * never decide whether an invariant has an owning test (see docs/P0-REPORT.md, round 4).
 */
const SKIP_PATHS = new Set(['apps/mobile/ios', 'apps/mobile/android']);

const ANY_INVARIANT_ID = /INV-[A-Z0-9]+-\d+/g;

/* ------------------------------------------------------------------- registry */

/** Every invariant id in docs/invariants.md. */
export function readRegistry(root = repoRoot()): Set<string> {
  const text = readFileSync(join(root, REGISTRY_PATH), 'utf8');
  const ids = text.match(ANY_INVARIANT_ID) ?? [];
  return new Set(ids);
}

/** `INV-SESS-07` -> `SESS`. */
export function familyOf(id: string): string {
  return id.slice('INV-'.length, id.lastIndexOf('-'));
}

function numberOf(id: string): number {
  return Number(id.slice(id.lastIndexOf('-') + 1));
}

/** Registry order: family alphabetically, then id number — so messages read stably. */
export function sortIds(ids: Iterable<string>): string[] {
  return [...ids].sort((a, b) => {
    const family = familyOf(a).localeCompare(familyOf(b));
    return family !== 0 ? family : numberOf(a) - numberOf(b);
  });
}

/* ------------------------------------------------------------------ ownership */

export interface OwnershipFile {
  readonly path: string;
  readonly ids: readonly string[];
}

/** The journey file carries the phase declarations the roster needs. */
export interface JourneyOwnership {
  readonly owned: readonly string[];
  /**
   * §14 PACK/AUD ids a P1 lane genuinely owns ("the engine parts"). The plan does not
   * enumerate them — the packs lane decides which of the 56 PACK ids are engine and
   * which wait for a real pack at P2 — so each one is written down here as it lands.
   */
  readonly engineParts?: readonly { readonly id: string; readonly why: string }[];
  /** Roster ids deliberately NOT owned at P1, each with the reason it moved. */
  readonly deferred?: readonly { readonly id: string; readonly why: string }[];
}

/** Every ownership file: the phase baseline plus one file per task. */
export function ownershipFiles(root = repoRoot()): OwnershipFile[] {
  const read = (relativePath: string): OwnershipFile => ({
    path: relativePath,
    ids:
      (JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as { owned?: string[] }).owned ??
      [],
  });
  const files = [read(BASELINE_OWNED_PATH)];
  let entries: string[] = [];
  try {
    entries = readdirSync(join(root, OWNED_DIR))
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    entries = [];
  }
  for (const entry of entries) files.push(read(`${OWNED_DIR}/${entry}`));
  return files;
}

export function readJourneyOwnership(root = repoRoot()): JourneyOwnership {
  return JSON.parse(readFileSync(join(root, JOURNEY_OWNED_PATH), 'utf8')) as JourneyOwnership;
}

export interface Union {
  /** Every id claimed by any ownership file, sorted. */
  readonly owned: string[];
  /** id -> the files claiming it, for ids claimed more than once. */
  readonly duplicates: Map<string, string[]>;
}

export function unionOwnership(files: readonly OwnershipFile[]): Union {
  const claims = new Map<string, string[]>();
  for (const file of files) {
    for (const id of file.ids) {
      const where = claims.get(id) ?? [];
      where.push(file.path);
      claims.set(id, where);
    }
  }
  return {
    owned: sortIds(claims.keys()),
    duplicates: new Map([...claims].filter(([, where]) => where.length > 1)),
  };
}

/* --------------------------------------------------------------- the roster */

export interface Roster {
  /** Ids derived from the P1 families plus the two SEC ids, minus nothing. */
  readonly required: string[];
  /** required + P0's baseline ids + declared engine parts − declared deferrals. */
  readonly expected: string[];
  readonly deferred: string[];
  readonly engineParts: string[];
}

export function p1Roster(
  registry: ReadonlySet<string>,
  baseline: readonly string[],
  journey: JourneyOwnership,
): Roster {
  const families = new Set(P1_FAMILIES);
  const required = sortIds(
    [...registry].filter((id) => families.has(familyOf(id)) || P1_EXTRA_IDS.includes(id)),
  );
  const engineParts = (journey.engineParts ?? []).map((entry) => entry.id);
  const deferred = new Set((journey.deferred ?? []).map((entry) => entry.id));
  const expected = sortIds(
    new Set([...required, ...baseline, ...engineParts].filter((id) => !deferred.has(id))),
  );
  return { required, expected, deferred: sortIds(deferred), engineParts: sortIds(engineParts) };
}

/* ------------------------------------------------------- owning-test scanning */

function walkTests(dir: string, root: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (SKIP_PATHS.has(relative(root, full))) continue;
    if (statSync(full).isDirectory()) walkTests(full, root, out);
    else if (TEST_FILE_PATTERN.test(entry)) out.push(full);
  }
  return out;
}

/**
 * id -> the test names that carry it in brackets.
 *
 * Bracketed on purpose: `it('[INV-DAY-01] …')` is a claim, and a test that merely
 * mentions an id in prose is not. `docs/README.md` §Adding coverage states the bracket
 * form, and this is what makes it the contract rather than a suggestion.
 */
export function owningTests(root = repoRoot()): Map<string, string[]> {
  const files = TEST_ROOTS.flatMap((r) => walkTests(join(root, r), root, []));
  const owners = new Map<string, string[]>();
  const testName = /\b(?:it|test)(?:\.\w+)*\s*\(\s*(['"`])([\s\S]*?)\1/g;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    testName.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = testName.exec(source)) !== null) {
      const name = match[2] ?? '';
      for (const bracketed of name.matchAll(/\[(INV-[A-Z0-9]+-\d+)\]/g)) {
        const id = bracketed[1]!;
        const where = owners.get(id) ?? [];
        where.push(`${relative(root, file)} :: ${name}`);
        owners.set(id, where);
      }
    }
  }
  return owners;
}

/** Test files the scan walked — used to fail a scan that found nothing. */
export function testFileCount(root = repoRoot()): number {
  return TEST_ROOTS.flatMap((r) => walkTests(join(root, r), root, [])).length;
}
