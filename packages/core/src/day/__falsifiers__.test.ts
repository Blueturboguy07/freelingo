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
 * `docs/owned/day.json` is the owned list; the integrate task merges it into
 * `docs/invariants-owned.json`, which is what `pnpm test:coverage-map` reads.
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

describe('falsifier fixtures', () => {
  it('every invariant this task owns has a committed falsifier input', () => {
    const missing = owned.filter((id) => !fixtures.has(id));
    expect(missing, 'add packages/core/src/day/__falsifiers__/<id>.json').toEqual([]);
    expect(owned.length).toBeGreaterThanOrEqual(28);
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
