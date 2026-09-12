/**
 * The normalisation folds: purity and idempotence.
 *
 * `normalise.ts`'s header claims that "every function here is pure and idempotent:
 * `f(f(x)) === f(x)` for every input". This file is the assertion behind that sentence —
 * it did not exist when the claim was first written, and writing it found a real defect:
 * `trivialNormalise` composed to NFC BEFORE stripping format characters, so
 * `a` + U+200D + U+0301 normalised once to the decomposed `a` + U+0301 and twice to the
 * precomposed `á`. See the fold's own comment for why the order is now the other way round.
 *
 * Why idempotence and not some richer property: tier 1 is "exact after normalisation", and
 * the engine normalises an answer wherever it needs to compare it — in `tier1Normalise`, in
 * a tier-2 fold, in the word-bank join, in the listening comparison. If a fold is not
 * idempotent, whether two answers match depends on how many times each of them happened to
 * pass through it, which is not a property any test of the grader would state out loud.
 *
 * Purity is asserted the only way it can be from outside: the same input twice gives the
 * same output, and the input is not mutated (strings are immutable in JS, so what is really
 * being checked is that no fold reads module state that a previous call could have changed).
 *
 * The ja fold carries INV-GRD-19 — "the ja tier-1 normalisation is ONE pure idempotent
 * function" — and is the only fold whose idempotence the invariant registry names.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';

import {
  applyOrthographicEquivalences,
  foldAllWhitespace,
  foldCase,
  foldDiacritics,
  foldEquivalentPunctuation,
  tier1Normalise,
  tokenise,
  trivialNormalise,
  whitespaceCount,
} from './normalise.js';
import { normaliseJa } from './ja.js';
import { arbAnyText } from './testing/arbitraries.js';
import { GRADING_FIXTURE_PACKS, JA_QUOTATION } from './packs/index.js';

/**
 * Text that reaches the shapes the folds are about.
 *
 * `arbAnyText()` alone draws the interesting characters only through its constant pool, so
 * this adds the three shapes the idempotence bugs live in: a format character wedged between
 * a base and a combining mark (the defect this file found), stacked combining marks, and the
 * ja confusables the dash/iteration rules rewrite.
 */
const arbFoldInput = fc.oneof(
  arbAnyText(),
  fc
    .array(
      fc.constantFrom(
        'a',
        'n',
        '́', // combining acute
        '̃', // combining tilde
        '‍', // ZWJ
        '​', // ZWSP
        '﻿',
        ' ',
        '　',
        'ア',
        'ー',
        '-',
        '－',
        '一',
        '々',
        'ゝ',
        'ヾ',
        'さ',
        'が',
        '木',
        'ｺ',
        '。',
        '「',
        '」',
        '“',
        '’',
      ),
      { maxLength: 10 },
    )
    .map((a) => a.join('')),
);

/** Every fold, as a one-argument function, bound to a pack and a unit where it needs one. */
function foldsFor(index: number): { name: string; f: (t: string) => string }[] {
  const { pack, unit } = GRADING_FIXTURE_PACKS[index]!;
  return [
    { name: 'trivialNormalise', f: trivialNormalise },
    {
      name: 'applyOrthographicEquivalences',
      f: (t) => applyOrthographicEquivalences(t, pack.orthographicEquivalences),
    },
    { name: 'foldAllWhitespace', f: foldAllWhitespace },
    { name: 'foldCase', f: foldCase },
    { name: 'foldEquivalentPunctuation', f: (t) => foldEquivalentPunctuation(t, unit) },
    { name: 'foldDiacritics', f: (t) => foldDiacritics(t, pack) },
    { name: 'tier1Normalise', f: (t) => tier1Normalise(t, pack) },
  ];
}

describe('the normalisation folds', () => {
  for (let index = 0; index < GRADING_FIXTURE_PACKS.length; index += 1) {
    const label = GRADING_FIXTURE_PACKS[index]!.pack.packId;
    for (const { name, f } of foldsFor(index)) {
      it(`${name} is idempotent for the ${label} pack`, () => {
        fc.assert(
          fc.property(arbFoldInput, (text) => {
            const once = f(text);
            expect(f(once)).toBe(once);
          }),
          { numRuns: PROPERTY_RUNS },
        );
      });

      it(`${name} is pure for the ${label} pack: same input, same output`, () => {
        fc.assert(
          fc.property(arbFoldInput, (text) => {
            expect(f(text)).toBe(f(text));
          }),
          { numRuns: PROPERTY_RUNS },
        );
      });
    }
  }

  it('[INV-GRD-19] the ja tier-1 normalisation is one pure idempotent function', () => {
    fc.assert(
      fc.property(arbFoldInput, (text) => {
        const once = normaliseJa(text);
        expect(normaliseJa(once)).toBe(once);
        expect(normaliseJa(text)).toBe(once);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-29] the unit-scoped punctuation fold is idempotent in the quotation unit too', () => {
    fc.assert(
      fc.property(arbFoldInput, (text) => {
        const once = foldEquivalentPunctuation(text, JA_QUOTATION.unit);
        expect(foldEquivalentPunctuation(once, JA_QUOTATION.unit)).toBe(once);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('the regression that motivated this file: a format character between a base and a mark', () => {
    // `a` + ZERO WIDTH JOINER + COMBINING ACUTE. Composing before the strip left the two
    // code points `á`; a second pass composed them to `á`.
    const pasted = 'a‍́';
    const once = trivialNormalise(pasted);
    expect(once).toBe('á');
    expect(trivialNormalise(once)).toBe(once);
  });

  it('whitespaceCount and tokenise are stable under their own fold', () => {
    fc.assert(
      fc.property(arbFoldInput, (text) => {
        expect(whitespaceCount(foldAllWhitespace(text))).toBe(0);
        for (const { pack } of GRADING_FIXTURE_PACKS) {
          const tokens = tokenise(tier1Normalise(text, pack), pack);
          expect(tokens.every((t) => t.length > 0)).toBe(true);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
