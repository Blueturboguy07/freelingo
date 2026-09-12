/**
 * The gate on the falsifiers.
 *
 * Plan §The build workflow, step 2: "test first from the invariant's falsifier input", and
 * this task's brief: "commit falsifier inputs per invariant under
 * `packages/core/src/scheduler/__falsifiers__/`". A committed falsifier is the difference
 * between a test that asserts the rule and a test that asserts the CASE the rule exists
 * for — and a directory of JSON nobody reads is decoration, so the files are load-bearing:
 *
 * - every id this task owns (`docs/owned/scheduler.json`) has a file;
 * - every file names an id this task owns, matching its own filename;
 * - every file names a test that actually exists in this directory;
 * - every file says what was MEASURED, so a reader can tell a recorded observation from a
 *   plausible-sounding sentence.
 *
 * This is the same shape of gate as `testkit/property-gates.test.ts` and for the same
 * reason: the failure mode is invisible in a green suite.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FALSIFIER_DIR = join(HERE, '__falsifiers__');
const OWNED_PATH = fileURLToPath(new URL('../../../../docs/owned/scheduler.json', import.meta.url));

interface Falsifier {
  invariant: string;
  test: string;
  covers: string;
  what: string;
  measured: string;
}

const owned: string[] = (JSON.parse(readFileSync(OWNED_PATH, 'utf8')) as { owned: string[] }).owned;

const files = readdirSync(FALSIFIER_DIR).filter((f) => f.endsWith('.json'));
const byId = new Map<string, { file: string; body: Falsifier }>();
for (const file of files) {
  const body = JSON.parse(readFileSync(join(FALSIFIER_DIR, file), 'utf8')) as Falsifier;
  byId.set(body.invariant, { file, body });
}

/** Every test NAME declared in this directory, from the sources rather than the runner. */
function testNamesInThisDirectory(): Set<string> {
  const names = new Set<string>();
  const pattern = /\b(?:it|test)(?:\.\w+)*\s*\(\s*(['"`])([\s\S]*?)\1/g;
  for (const file of readdirSync(HERE).filter((f) => f.endsWith('.test.ts'))) {
    const source = readFileSync(join(HERE, file), 'utf8');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) names.add(match[2] ?? '');
  }
  return names;
}

describe('scheduler falsifiers', () => {
  it('the scan found the owned list and the falsifier files (a scan that finds nothing passes for free)', () => {
    expect(owned.length).toBe(12);
    expect(files.length).toBeGreaterThanOrEqual(owned.length);
  });

  it('every owned invariant has a committed falsifier input', () => {
    const missing = owned.filter((id) => !byId.has(id));
    expect(missing, 'add packages/core/src/scheduler/__falsifiers__/<id>.json').toEqual([]);
  });

  it('every falsifier file names an owned id, matching its own filename', () => {
    const wrong: string[] = [];
    for (const [id, { file }] of byId) {
      if (!owned.includes(id)) wrong.push(`${file}: ${id} is not owned by this task`);
      const expectedName = `${id.toLowerCase()}.json`;
      if (file !== expectedName) wrong.push(`${file}: should be named ${expectedName}`);
    }
    expect(wrong).toEqual([]);
  });

  it('every falsifier names a test that exists, and records what was measured', () => {
    const names = testNamesInThisDirectory();
    const problems: string[] = [];
    for (const [id, { file, body }] of byId) {
      if (!names.has(body.test))
        problems.push(`${file}: no test named ${JSON.stringify(body.test)}`);
      if (!body.test.includes(id)) problems.push(`${file}: the named test does not carry ${id}`);
      // `covers` points at the catalogue entry the rule came from, so it must be an
      // edge-case id and not a sentence about one.
      if (!/\bEC-[A-Z]+-\d+\b/.test(body.covers ?? '')) {
        problems.push(`${file}: \`covers\` names no EC- id from the catalogue`);
      }
      for (const field of ['what', 'measured'] as const) {
        if (typeof body[field] !== 'string' || body[field].length < 80) {
          problems.push(`${file}: \`${field}\` is missing or too short to be a record`);
        }
      }
      if (!/\d{4}-\d{2}-\d{2}/.test(body.measured)) {
        problems.push(
          `${file}: \`measured\` carries no date, so it is a claim and not an observation`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});
