/**
 * The schema lane's falsifier corpus.
 *
 * Added at P1 integration alongside the economy one: the `p1-foundation-economy-schema`
 * task shipped both halves' tests and no `__falsifiers__` directory anywhere, so five of
 * the phase's 42 missing falsifying inputs were the schema half's. Each fixture records
 * the database state or the edit that would have caught the bug the rule is about — a
 * `user_version` bumped outside its DDL's transaction, a global display-preference row, a
 * major migration that silently un-completes a node.
 *
 * The journey gate (`packages/core/src/journey/falsifier-corpus.ts`) requires a test in
 * the module that OWNS a corpus to read it, with `falsifier` in a test name so
 * `pnpm test:falsify` selects it. That script names every project holding a corpus, which
 * is why `--project schema` is now in it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FALSIFIER_DIR = join(HERE, '__falsifiers__');

/** The ids this corpus is responsible for: the invariants whose owning tests live here. */
const EXPECTED_IDS: readonly string[] = [
  'INV-PACK-35',
  'INV-PER-03',
  'INV-PER-07',
  'INV-PER-11',
  'INV-ECO-04',
];

interface Fixture {
  readonly invariant?: string;
  readonly why?: string;
  readonly source?: string;
  readonly mustNotBe?: string;
  readonly usedBy?: readonly string[];
}

/** Test files that live beside this corpus. Read once, so a rename is a red build. */
const SIBLING_TESTS: readonly string[] = readdirSync(HERE).filter((f) => f.endsWith('.test.ts'));

const byId = new Map<string, { readonly file: string; readonly body: Fixture }>();
for (const file of readdirSync(FALSIFIER_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()) {
  const body = JSON.parse(readFileSync(join(FALSIFIER_DIR, file), 'utf8')) as Fixture;
  byId.set(file.replace(/\.json$/, ''), { file, body });
}

describe('the schema falsifier corpus', () => {
  it('every invariant this module owns has a committed falsifier input', () => {
    expect([...byId.keys()].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it('every falsifier names its own id, its edge case, and what the result must NOT be', () => {
    const broken: string[] = [];
    for (const [id, { file, body }] of byId) {
      if (body.invariant !== id) broken.push(`${file}: declares ${String(body.invariant)}`);
      if (typeof body.why !== 'string' || body.why.trim().length < 20) {
        broken.push(`${file}: no sentence saying what it falsifies`);
      }
      if (typeof body.source !== 'string' || body.source.length === 0) {
        broken.push(`${file}: no edge case it comes from`);
      }
      if (typeof body.mustNotBe !== 'string' || body.mustNotBe.length < 20) {
        broken.push(`${file}: no statement of what the result must NOT be`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every falsifier names a test file that exists', () => {
    const missing: string[] = [];
    for (const [id, { body }] of byId) {
      for (const named of body.usedBy ?? []) {
        const base = named.split('/').pop() as string;
        if (!SIBLING_TESTS.includes(base)) missing.push(`${id} -> ${named}`);
      }
    }
    expect(missing, 'a falsifier pointing at a test that does not exist is not consumed').toEqual(
      [],
    );
  });
});
