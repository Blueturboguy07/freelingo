/**
 * The gate on the falsifiers.
 *
 * The plan's definition of done for an engine task is "invariant ids green + **committed
 * falsifier inputs per invariant**". A fixture that no test reads is a JSON file, not a
 * falsifier, and a fixture whose case has quietly drifted away from the invariant it names
 * is worse — it reads as coverage. So every id this task owns must have a fixture file
 * that names itself, carries the falsifier sentence and its source, and is actually LOADED
 * by the test file it points at.
 *
 * `docs/owned/day.json` is this task's owned list. `pnpm test:coverage-map` reads
 * `docs/invariants-owned.json` and nothing else, and that file is NOT in this task's file
 * lane — so until the integrate task merges every `docs/owned/*.json` into it, the 28 ids
 * below are unowned as far as CI is concerned. That is precisely the failure mode
 * `docs/README.md` documents ("a short registry silently shrinks test:coverage-map"), so
 * the local half of the gate lives here instead of waiting for the merge: every id in
 * `docs/owned/day.json` must be a real registry id AND must be carried by a test name in
 * this task's own source tree. If the merge never happens the ids are still guarded; if it
 * does, the two gates agree.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { repoRoot } from '@freelingo/testkit';

const FIXTURE_DIR = fileURLToPath(new URL('./__falsifiers__/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));

interface Fixture {
  readonly id: string;
  readonly falsifier: string;
  readonly source: string;
  readonly input: Record<string, unknown>;
  readonly mustNotBe: string;
  readonly usedBy: readonly string[];
}

const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'));
const fixtures = new Map<string, Fixture>(
  files.map((file) => {
    const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as Fixture;
    return [file.replace(/\.json$/, ''), fixture];
  }),
);

const owned: string[] = (
  JSON.parse(readFileSync(join(repoRoot(), 'docs/owned/day.json'), 'utf8')) as { owned: string[] }
).owned;

/** Every invariant id the registry actually defines. A typo cannot hide as coverage. */
const REGISTRY_IDS = new Set(
  readFileSync(join(repoRoot(), 'docs/invariants.md'), 'utf8').match(/INV-[A-Z0-9]+-\d+/g) ?? [],
);

/** Test names in this task's own tree — `day/` and `streak/`, the whole file lane. */
function testNamesInLane(): string {
  const roots = [join(SRC_DIR, 'day'), join(SRC_DIR, 'streak')];
  let text = '';
  for (const root of roots) {
    for (const entry of readdirSync(root)) {
      if (entry.endsWith('.test.ts')) text += readFileSync(join(root, entry), 'utf8');
    }
  }
  return text;
}

describe('falsifier fixtures', () => {
  it('every invariant this task owns has a committed falsifier input', () => {
    const missing = owned.filter((id) => !fixtures.has(id));
    expect(missing, 'add packages/core/src/day/__falsifiers__/<id>.json').toEqual([]);
    expect(owned.length).toBeGreaterThanOrEqual(28);
  });

  it('every id this task owns is a real registry id with a test that carries it', () => {
    const tests = testNamesInLane();
    const notInRegistry = owned.filter((id) => !REGISTRY_IDS.has(id));
    expect(notInRegistry, 'docs/owned/day.json names an id docs/invariants.md does not').toEqual(
      [],
    );
    const unowned = owned.filter((id) => !tests.includes(`[${id}]`));
    expect(
      unowned,
      "add a test whose name carries the id, e.g. it('[INV-DAY-02] …')",
    ).toEqual([]);
  });

  it('every fixture names its own invariant and records the case it came from', () => {
    for (const [name, fixture] of fixtures) {
      expect(fixture.id, `${name}.json`).toBe(name);
      expect(fixture.falsifier.length, `${name}.falsifier`).toBeGreaterThan(20);
      expect(fixture.source.length, `${name}.source`).toBeGreaterThan(10);
      expect(fixture.mustNotBe.length, `${name}.mustNotBe`).toBeGreaterThan(10);
      expect(Object.keys(fixture.input).length, `${name}.input`).toBeGreaterThan(0);
      expect(fixture.usedBy.length, `${name}.usedBy`).toBeGreaterThan(0);
    }
  });

  it('every fixture is actually loaded by the test file it names', () => {
    for (const [name, fixture] of fixtures) {
      for (const relative of fixture.usedBy) {
        const source = readFileSync(join(SRC_DIR, relative), 'utf8');
        // Loaded, not merely mentioned: a fixture nobody reads proves nothing.
        expect(source, `${relative} must load ${name}`).toContain(`falsifier('${name}')`);
        expect(source, `${relative} must carry the id in a test name`).toContain(`[${name}]`);
      }
    }
  });
});
