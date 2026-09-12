/**
 * The economy lane's falsifier corpus, and the gate that makes it load-bearing.
 *
 * Written at P1 integration. The economy/schema lane shipped its tests and no
 * `__falsifiers__` directory — it was the only one of the eight that did not — so 31 of
 * the phase's 42 missing falsifying inputs were its. `docs/P1-REPORT.md` recorded that as
 * the gate's one red clause that was a real gap rather than a bookkeeping fix.
 *
 * Two things make this directory more than decoration, and they are the two halves
 * `packages/core/src/journey/falsifier-corpus.ts` insists on:
 *
 * 1. **This file reads the directory**, and its test names carry `falsifier`, so
 *    `pnpm test:falsify` selects it. A corpus no test loads is a JSON file.
 * 2. **Ten of the 31 fixtures declare the executable `{check, cases}` contract**, so the
 *    journey gate imports the named module, calls the named export with each case's
 *    arguments and compares the result structurally. Before this, zero of 176 committed
 *    fixtures in the whole repo used that contract and the gate's execution clause ran
 *    zero cases — green because there was nothing to run. These are its first users.
 *
 * The remaining 21 are descriptive: they record the input a reviewer reads against the
 * invariant text, in the same shape the `day/` lane chose. Executability is not free —
 * several INV-ECO rules are about grep gates over shipped source, or about Maps and
 * ledgers that no JSON document can express — and a fixture that lied about being
 * executable would be worse than one that is honestly prose.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FALSIFIER_DIR = join(HERE, '__falsifiers__');
const OWNED_PATH = fileURLToPath(new URL('../../../../docs/owned/economy.json', import.meta.url));

interface Fixture {
  readonly invariant?: string;
  readonly why?: string;
  readonly source?: string;
  readonly check?: { readonly module: string; readonly export: string; readonly call?: string };
  readonly cases?: readonly { readonly expect?: unknown; readonly throws?: string }[];
  readonly mustNotBe?: string;
}

const owned: readonly string[] = (
  JSON.parse(readFileSync(OWNED_PATH, 'utf8')) as { owned: string[] }
).owned;

const files = readdirSync(FALSIFIER_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort();
const byId = new Map<string, { readonly file: string; readonly body: Fixture }>();
for (const file of files) {
  const body = JSON.parse(readFileSync(join(FALSIFIER_DIR, file), 'utf8')) as Fixture;
  byId.set(file.replace(/\.json$/, ''), { file, body });
}

describe('the economy falsifier corpus', () => {
  it('every economy invariant this lane owns has a committed falsifier input', () => {
    const missing = owned.filter((id) => !byId.has(id));
    expect(
      missing,
      'an owned invariant with no falsifying input is a rule nobody wrote down the ' +
        'counterexample for. One file per id, named for the id.',
    ).toEqual([]);
  });

  it('every falsifier file names its own id, and says what it falsifies', () => {
    const broken: string[] = [];
    for (const [id, { file, body }] of byId) {
      if (body.invariant !== id) broken.push(`${file}: declares ${String(body.invariant)}`);
      if (typeof body.why !== 'string' || body.why.trim().length < 20) {
        broken.push(`${file}: no sentence saying what it falsifies`);
      }
      if (typeof body.source !== 'string' || !/EC-[A-Z]+-\d+|plan §/.test(body.source)) {
        broken.push(`${file}: no edge-case or ruling it comes from`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every falsifier claims an id that is really in this lane', () => {
    const stray = [...byId.keys()].filter((id) => !owned.includes(id));
    expect(
      stray,
      'a fixture filed under an id this lane does not own reads as coverage and is not',
    ).toEqual([]);
  });

  it('the executable falsifiers name a real export and a real expectation', () => {
    // The structural comparison itself is run by the journey gate
    // (`falsifier-corpus.test.ts`, "every falsifier input that offers the executable
    // contract runs and agrees with its module"). What is checked here is that the
    // contract is filled in rather than gestured at: a `check` with no `cases`, or a case
    // declaring neither an expectation nor a throw, cannot fail and must not ship.
    const executable = [...byId].filter(([, { body }]) => body.check !== undefined);
    expect(
      executable.length,
      'no fixture in this corpus is executable, so the journey gate runs zero cases over it',
    ).toBeGreaterThanOrEqual(10);

    const broken: string[] = [];
    for (const [id, { body }] of executable) {
      const check = body.check as NonNullable<Fixture['check']>;
      if (!check.module.startsWith('../')) broken.push(`${id}: module is not module-relative`);
      if (check.export.length === 0) broken.push(`${id}: no export named`);
      const cases = body.cases ?? [];
      if (cases.length === 0) broken.push(`${id}: an executable check with no cases`);
      for (const [index, c] of cases.entries()) {
        const hasExpect = Object.hasOwn(c, 'expect');
        const hasThrows = Object.hasOwn(c, 'throws');
        if (hasExpect === hasThrows) {
          broken.push(`${id} case ${index}: needs exactly one of expect / throws`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('every descriptive falsifier says what the result must NOT be', () => {
    // The executable ones express that in `expect`/`throws`; a prose one has to write it
    // out, or a reader cannot tell the counterexample from a restatement of the rule.
    const broken = [...byId]
      .filter(([, { body }]) => body.check === undefined)
      .filter(([, { body }]) => typeof body.mustNotBe !== 'string' || body.mustNotBe.length < 20)
      .map(([id]) => id);
    expect(broken).toEqual([]);
  });
});
