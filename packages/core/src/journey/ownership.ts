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

/**
 * Test roots the owning-test scan walks.
 *
 * `tools` joined the list at P2. The content pipeline is Python, its tests are the only
 * thing that can hold INV-PACK-15 and INV-AUD-08 (both are properties of a produced pack,
 * not of the engine), and while this array said `['packages', 'apps', 'e2e']` a lane could
 * own those ids, write real tests for them, and be told by two separate gates that the ids
 * had no owning test at all.
 */
const TEST_ROOTS = ['packages', 'apps', 'e2e', 'tools'];
/** Vitest (`*.test.ts`), Maestro (`*.yaml`) and pytest (`test_*.py`) files. */
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx)$|\.ya?ml$|^test_[A-Za-z0-9_]+\.py$/;
/**
 * Directory names the walk never enters, wherever they appear.
 *
 * The four Python entries are not cosmetic now that `tools` is walked: `tools/coursekit/
 * .venv` contains thousands of installed `test_*.py` files, so without `.venv` this scan
 * would take minutes and a third-party wheel's test suite could supply "coverage" for an
 * id this repo never tested.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  'artifacts',
  '.stryker-tmp',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
]);
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

/**
 * The phase an ownership file belongs to.
 *
 * Declared by the file itself (`"phase": "P2"`), which is a field the P2 lanes were
 * already writing before anything read it. Absent means `P1`: every file that existed
 * when this roster was written is a P1 file, and defaulting the other way would have
 * emptied the P1 gate on the commit that introduced the field.
 */
export const DEFAULT_PHASE = 'P1';

export interface OwnershipFile {
  readonly path: string;
  readonly ids: readonly string[];
  /** `P0`, `P1`, `P2`, … — see `DEFAULT_PHASE`. */
  readonly phase: string;
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
  const read = (relativePath: string): OwnershipFile => {
    const raw = JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as {
      owned?: string[];
      phase?: string;
    };
    return { path: relativePath, ids: raw.owned ?? [], phase: raw.phase ?? DEFAULT_PHASE };
  };
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

/**
 * The ownership files belonging to one phase.
 *
 * The P1 roster is an equality — `union(P1 ownership files) === expected` — and an
 * equality over "every file on disk" stops being a P1 statement the moment P2 lands its
 * first claim. It went red exactly that way: `docs/owned/p2-g8.json` owns INV-PACK-15 and
 * INV-AUD-08, both P2 pack gates by the plan's coverage table, and three P1 assertions
 * called them UNDECLARED. The fix is not to drop the claim (rule 4: an invariant owned by
 * nobody is worse than a failing one) and not to widen the roster to swallow PACK/AUD
 * wholesale; it is to compare the P1 gate against the P1 files. The checks that are not
 * about the roster — no duplicates, every id in the registry, every id has an owning test
 * — still run over every file, whatever phase wrote it.
 */
export function filesInPhases(
  files: readonly OwnershipFile[],
  phases: readonly string[],
): readonly OwnershipFile[] {
  const wanted = new Set(phases);
  return files.filter((file) => wanted.has(file.phase));
}

/**
 * The phases whose ownership files the P1 roster equality is judged over.
 *
 * Two, not one: `roster.expected` is `required + the P0 BASELINE + engine parts −
 * deferrals`, and `docs/invariants-owned.json` declares `"phase": "P0"` while holding the
 * five ids P0 landed (INV-DAY-01/05, INV-PER-06, INV-PLAT-01/02). Scoping to `P1` alone
 * put those five on the wrong side of the comparison and made the gate red in the
 * opposite direction — measured, not reasoned about.
 */
export const ROSTER_PHASES: readonly string[] = ['P0', 'P1'];

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
 * The claim form a **pytest** test name uses: `def test_inv_aud_08_…`.
 *
 * A Python function name cannot contain `[`, `-` or an uppercase-preserving separator, so
 * `it('[INV-AUD-08] …')` has no Python spelling. The lowercase snake form is the one thing
 * that IS a name — pytest prints `test_inv_aud_08_the_rebake_key_includes_the_engine` in
 * its node id and `pytest -k inv_aud_08` selects it — and the digits are read verbatim, so
 * `inv_aud_08` is `INV-AUD-08` and never `INV-AUD-8`.
 *
 * Anchored on `_` or start-of-name, NOT on `\b`: the character before `inv` in
 * `test_inv_aud_08_…` is an underscore, which is itself a word character, so `\binv_`
 * matches nothing at all. The first version of this scanner used `\b` and reported both
 * ids as unowned while looking exactly right.
 *
 * A docstring will not do, and that is the point of doing this at all: a docstring-only id
 * is invisible to every gate in this repo, so two invariants can look owned in review and
 * be owned by nobody according to the arbiter.
 */
export const PYTHON_CLAIM = /(?:^|_)inv_([a-z0-9]+)_(\d+)(?=_|$)/g;

/** `inv_aud_08` -> `INV-AUD-08`. */
export function idFromPythonName(family: string, number: string): string {
  return `INV-${family.toUpperCase()}-${number}`;
}

/**
 * id -> the test names that carry it.
 *
 * TypeScript: bracketed, on purpose. `it('[INV-DAY-01] …')` is a claim, and a test that
 * merely mentions an id in prose is not. `docs/README.md` §Adding coverage states the
 * bracket form, and this is what makes it the contract rather than a suggestion.
 *
 * Python: the snake form above, in the `def test_…` identifier, for the reason `PYTHON_CLAIM`
 * gives. Both are the NAME the runner prints; neither is a comment or a docstring.
 */
export function owningTests(root = repoRoot()): Map<string, string[]> {
  const files = TEST_ROOTS.flatMap((r) => walkTests(join(root, r), root, []));
  const owners = new Map<string, string[]>();
  const testName = /\b(?:it|test)(?:\.\w+)*\s*\(\s*(['"`])([\s\S]*?)\1/g;
  const pythonDef = /^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]*)\s*\(/gm;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const record = (id: string, name: string): void => {
      const where = owners.get(id) ?? [];
      where.push(`${relative(root, file)} :: ${name}`);
      owners.set(id, where);
    };

    if (file.endsWith('.py')) {
      pythonDef.lastIndex = 0;
      let pyMatch: RegExpExecArray | null;
      while ((pyMatch = pythonDef.exec(source)) !== null) {
        const name = pyMatch[1] ?? '';
        for (const claim of name.matchAll(PYTHON_CLAIM)) {
          record(idFromPythonName(claim[1]!, claim[2]!), name);
        }
      }
      continue;
    }

    testName.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = testName.exec(source)) !== null) {
      const name = match[2] ?? '';
      for (const bracketed of name.matchAll(/\[(INV-[A-Z0-9]+-\d+)\]/g)) {
        record(bracketed[1]!, name);
      }
    }
  }
  return owners;
}

/** Test files the scan walked — used to fail a scan that found nothing. */
export function testFileCount(root = repoRoot()): number {
  return TEST_ROOTS.flatMap((r) => walkTests(join(root, r), root, [])).length;
}
