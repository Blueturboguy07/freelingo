/**
 * The P1 coverage gate: the union of the ownership files is exactly the phase roster.
 *
 * `pnpm test:coverage-map` answers "does every claimed id have a test?". This answers
 * the question that one cannot: **is everything this phase owes actually claimed?** A
 * phase can pass the coverage map by claiming nothing at all, so the roster is derived
 * from `docs/invariants.md` (see `ownership.ts`) and compared both ways:
 *
 *   - an id in the roster that no file claims is MISSING — the phase is not done;
 *   - an id a file claims that is outside the roster is UNDECLARED — it belongs to
 *     another phase, or the roster is wrong, and either way a human decides;
 *   - an id claimed by two files is a DUPLICATE, which lets one of them delete its test
 *     and stay green;
 *   - an id claimed but absent from the registry is a TYPO reading as coverage.
 *
 * Deferrals are legal and visible: `docs/owned/journey.json` lists each one with the
 * reason, and `docs/P1-REPORT.md` carries the same list. What is not legal is a gap
 * nobody wrote down.
 */
import { describe, expect, it } from 'vitest';
import {
  familyOf,
  filesInPhases,
  ownershipFiles,
  owningTests,
  p1Roster,
  readJourneyOwnership,
  readRegistry,
  sortIds,
  testFileCount,
  unionOwnership,
  BASELINE_OWNED_PATH,
  P1_EXTRA_IDS,
  P1_FAMILIES,
  ROSTER_PHASES,
} from './ownership.js';
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
const registry = readRegistry(root);
const files = ownershipFiles(root);
const baseline = files.find((f) => f.path === BASELINE_OWNED_PATH)!.ids;
const journey = readJourneyOwnership(root);
const roster = p1Roster(registry, baseline, journey);
/** Every claim on disk — what "no duplicates, in the registry, has a test" is judged over. */
const union = unionOwnership(files);
/**
 * The P0+P1 claims alone — what the roster EQUALITY is judged over.
 *
 * See `ROSTER_PHASES`: an ownership file declares its phase, and a P2 lane's file is not
 * evidence about whether P1 is finished in either direction.
 */
const p1Files = filesInPhases(files, ROSTER_PHASES);
const p1Union = unionOwnership(p1Files);
const laterFiles = files.filter((file) => !p1Files.includes(file));
const owners = owningTests(root);

describe.skipIf(UNDER_STRYKER)('P1 phase roster', () => {
  it('the registry and the ownership files were actually read', () => {
    // The three inputs this gate is computed from. Any of them coming back empty makes
    // every assertion below vacuously true, which is the failure mode of every scan here.
    expect(registry.size).toBeGreaterThanOrEqual(424);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(testFileCount(root)).toBeGreaterThan(10);
  });

  it('the roster is derived from the registry, not typed out', () => {
    const families = new Set(P1_FAMILIES);
    // Every required id is in the registry and in a P1 family (or is one of the two SEC ids).
    for (const id of roster.required) {
      expect(registry.has(id)).toBe(true);
      expect(families.has(familyOf(id)) || P1_EXTRA_IDS.includes(id)).toBe(true);
    }
    // And nothing in a P1 family is left out of the roster.
    const inFamilies = sortIds([...registry].filter((id) => families.has(familyOf(id))));
    expect(roster.required).toEqual(sortIds([...inFamilies, ...P1_EXTRA_IDS]));
  });

  it('this task owns no invariant of its own (a gate that owns invariants passes itself)', () => {
    expect(journey.owned).toEqual([]);
  });

  it('every ownership file declares a phase the roster understands', () => {
    // A typo'd phase ("p2", "P2 ") would silently move a file's ids OUT of the P1 equality
    // and into nothing at all, which is the one way this scoping could hide a real gap.
    const bad = files
      .filter((file) => !/^P\d$/.test(file.phase))
      .map((f) => `${f.path}: ${f.phase}`);
    expect(bad).toEqual([]);
    expect(
      p1Files.length,
      'no P0/P1 ownership file was found; the roster equality would be vacuous',
    ).toBeGreaterThan(1);
    // The baseline is one of them. It declares P0 and it carries five roster ids.
    expect(p1Files.map((f) => f.path)).toContain(BASELINE_OWNED_PATH);
  });

  it('every id the phase roster requires is claimed by exactly one ownership file', () => {
    const claimed = new Set(p1Union.owned);
    const missing = sortIds(roster.expected.filter((id) => !claimed.has(id)));
    expect(
      missing,
      'no ownership file claims these. Either a lane owes them a test, or ' +
        'docs/owned/journey.json must defer them with a reason.',
    ).toEqual([]);

    const duplicates = [...union.duplicates].map(([id, where]) => `${id}: ${where.join(', ')}`);
    expect(duplicates).toEqual([]);
  });

  it('no P1 ownership file claims an id outside the phase roster', () => {
    const expected = new Set(roster.expected);
    const undeclared = sortIds(p1Union.owned.filter((id) => !expected.has(id)));
    expect(
      undeclared,
      'claimed but not in the P1 roster. A §14 PACK/AUD engine part belongs in ' +
        'docs/owned/journey.json `engineParts` with its reason; anything else is another ' +
        'phase and its file must say so (`"phase": "P2"`).',
    ).toEqual([]);
  });

  it('no later-phase ownership file takes an id the P1 roster owes', () => {
    // The escape hatch the scoping above opens, closed. Stamping `"phase": "P2"` on a file
    // must not be a way to move a P1 obligation out of the P1 gate: an id in the roster is
    // P1's whatever a later file says, and claiming it there would make the roster
    // equality pass while nobody at P1 owns it.
    const expected = new Set(roster.expected);
    const stolen = laterFiles.flatMap((file) =>
      file.ids.filter((id) => expected.has(id)).map((id) => `${id} (${file.path}, ${file.phase})`),
    );
    expect(stolen).toEqual([]);
  });

  it('no ownership file claims an id that is absent from docs/invariants.md', () => {
    expect(sortIds(union.owned.filter((id) => !registry.has(id)))).toEqual([]);
  });

  it('every owned id has an owning test whose name carries the id in brackets', () => {
    const missing = sortIds(union.owned.filter((id) => !owners.has(id)));
    expect(missing, "add a test named it('[<id>] …') — docs/README.md §Adding coverage").toEqual(
      [],
    );
  });

  it('the owning-test scan reads a pytest name as well as a vitest one', () => {
    /*
     * The scan walks two languages and the Python half shipped broken once: `\binv_`
     * matches nothing in `test_inv_aud_08_…`, because the `_` in front of `inv` is itself
     * a word character. The scanner walked all seven pytest files, found zero claims, and
     * the gate reported the ids unowned — which is exactly what it reports when nobody
     * wrote the test. So the two forms are asserted against the tree, not assumed.
     */
    const bracketed = [...owners.keys()].filter((id) =>
      (owners.get(id) ?? []).some((where) => where.endsWith('.ts') || where.includes('.ts ::')),
    );
    expect(bracketed.length, 'no TypeScript test claims any id').toBeGreaterThan(50);

    const fromPython = [...owners].filter(([, where]) =>
      where.some((entry) => entry.includes('.py ::')),
    );
    const pythonIds = fromPython.map(([id]) => id).sort();
    expect(
      pythonIds,
      'the pytest scan found no claims. tools/coursekit/tests carries INV-PACK-15 and ' +
        'INV-AUD-08 in its `def test_inv_…` names; if this is empty the scanner is broken, ' +
        'not the tests.',
    ).toEqual(expect.arrayContaining(['INV-AUD-08', 'INV-PACK-15']));

    /*
     * Both Python claim conventions, each pinned to a file that uses ONLY that one.
     *
     * This was an exact-equality assertion on ['INV-AUD-08', 'INV-PACK-15'] when the bake
     * lane was the only Python lane in the tree. Eight lanes later, five of them claim by
     * the bracketed ids leading a test docstring and one by the `def test_inv_…` name, and
     * an exact list would have to be edited by every lane that adds a pytest claim — which
     * is how a list stops being read. What must not regress is that BOTH readers work, so
     * that is what is asserted: drop either one and one of these two goes missing.
     */
    const whereFor = (id: string): string[] => owners.get(id) ?? [];
    expect(
      whereFor('INV-AUD-08').some((entry) => /test_inv_aud_08/.test(entry)),
      'the `def test_inv_…` name reader found nothing (tools/coursekit/tests/test_cast.py)',
    ).toBe(true);
    expect(
      whereFor('INV-PACK-13').some((entry) => entry.includes('.py ::')),
      'the leading-docstring reader found nothing (tools/coursekit/tests/test_licences.py ' +
        'claims INV-PACK-13 as `"""[INV-PACK-13] …"""` and never in an identifier)',
    ).toBe(true);

    // And the id it built is the registry's spelling, zero-padding included.
    for (const [id] of fromPython) expect(registry.has(id)).toBe(true);
  });

  it('no test claims an invariant id that is not in the registry', () => {
    const unknown = sortIds([...owners.keys()].filter((id) => !registry.has(id)));
    expect(unknown).toEqual([]);
  });

  it('every deferral and every engine part is written down with a reason', () => {
    for (const entry of journey.deferred ?? []) {
      expect(registry.has(entry.id), `${entry.id} is not in the registry`).toBe(true);
      expect(entry.why.length, `${entry.id} needs a reason`).toBeGreaterThan(20);
    }
    for (const entry of journey.engineParts ?? []) {
      expect(registry.has(entry.id), `${entry.id} is not in the registry`).toBe(true);
      expect(['PACK', 'AUD']).toContain(familyOf(entry.id));
      expect(entry.why.length, `${entry.id} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('the phase owns what the plan says it owns (P1 + P0, counted)', () => {
    // The count is printed by docs/P1-REPORT.md; asserting it here keeps the report and
    // the tree from drifting apart. `expected` is roster + P0 baseline + engine parts
    // − deferrals, so this is one number a reader can check against the plan's P1 row.
    const p0Only = baseline.filter((id) => !roster.required.includes(id));
    expect(sortIds(p0Only)).toEqual(['INV-PLAT-01', 'INV-PLAT-02']);
    // P1 files only: the count is a statement about P1, and it must not move when a P2
    // lane lands a claim of its own. See `ROSTER_PHASES`.
    expect(p1Union.owned.length).toBe(roster.expected.length);
    expect(sortIds(p1Union.owned)).toEqual(roster.expected);
  });
});
