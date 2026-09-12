import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { execAsyncViolationsIn } from './exec-gate.js';
import { sanitiseUserText, type UserTextField } from './sanitise.js';

/**
 * `pnpm test:falsify` — the committed falsifier input for each invariant this module owns
 * (plan §Verification, §The build workflow step 2).
 *
 * A property says "for all inputs"; a falsifier says "and here is the one that broke it".
 * The cases live in `__falsifiers__/<id>.json` as data, so a reviewer can read what the
 * invariant is protecting against without reading a test, and so the same case can be
 * replayed by hand.
 */
const FALSIFIERS = fileURLToPath(new URL('./__falsifiers__/', import.meta.url));

function load<T>(id: string): T {
  return JSON.parse(readFileSync(`${FALSIFIERS}${id}.json`, 'utf8')) as T;
}

interface Sec01 {
  readonly cases: readonly { why: string; field: UserTextField; raw: string; stored: string }[];
}
interface Sec02 {
  readonly violations: readonly { why: string; source: string; reason: string }[];
  readonly allowed: readonly string[];
}

describe('security falsifiers', () => {
  const sec01 = load<Sec01>('INV-SEC-01');
  const sec02 = load<Sec02>('INV-SEC-02');

  it('[INV-SEC-01] falsifier: the committed file carries a case for every field the invariant names', () => {
    expect(sec01.cases.length).toBeGreaterThanOrEqual(5);
    const fields = new Set(sec01.cases.map((c) => c.field));
    expect([...fields].sort()).toEqual([
      'read-and-respond',
      'report-note',
      'roleplay',
      'tier3-diff',
      'typed-answer',
    ]);
  });

  for (const [index, testCase] of sec01.cases.entries()) {
    it(`[INV-SEC-01] falsifier ${index + 1}: ${testCase.why}`, () => {
      expect(sanitiseUserText(testCase.field, testCase.raw)).toBe(testCase.stored);
    });
  }

  it('[INV-SEC-02] falsifier: every committed violation is reported with its reason', () => {
    expect(sec02.violations.length).toBeGreaterThanOrEqual(5);
    for (const violation of sec02.violations) {
      const found = execAsyncViolationsIn(violation.source);
      expect(found, violation.why).toHaveLength(1);
      expect(found[0]!.reason, violation.why).toContain(violation.reason);
    }
  });

  it('[INV-SEC-02] falsifier: every committed authored literal is left alone', () => {
    for (const source of sec02.allowed) {
      expect(execAsyncViolationsIn(source), source).toEqual([]);
    }
  });
});
