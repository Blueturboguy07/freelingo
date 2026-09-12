/**
 * The DB-path gate's falsifier corpus.
 *
 * INV-PER-06 is a P0 id that shipped with a test and no corpus. Its falsifier is a path:
 * the progress database opened under a cache directory the OS may reclaim, which loses a
 * streak with no error anywhere.
 *
 * This directory is also the one `docs/P1-REPORT.md` records a refuter using as a probe —
 * a fixture dropped into `packages/core/src/db/__falsifiers__`, which no test read, was
 * reported as consumed by a broken consumption check and, after the fix, correctly
 * reported UNREAD. It is read now, by this file, for a real fixture.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FALSIFIER_DIR = join(HERE, '__falsifiers__');

/** The ids this corpus is responsible for: the invariants whose owning tests live here. */
const EXPECTED_IDS: readonly string[] = ['INV-PER-06'];

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

describe('the persistence falsifier corpus', () => {
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
