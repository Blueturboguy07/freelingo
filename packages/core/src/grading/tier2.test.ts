/**
 * INV-GRD-01 (the ladder), INV-GRD-16 (spaceless), INV-GRD-18 (contrastive diacritics)
 * and INV-GRD-29 (unit-declared punctuation).
 *
 * The central property is written against an INDEPENDENT REFERENCE ladder rather than
 * against `classifyTier2`: a property that re-derives the code under test proves nothing.
 * The reference below is transcribed from the invariant's prose and the edge cases, and
 * uses its own edit-distance routine; the assertion is that two implementations written
 * from the same English agree on 10,000 generated pairs, per pack.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';

import { TIER2_CLASS_ORDER, TIER2_NOTE_POOL } from './config.js';
import { classifyTier2, type Tier2Context } from './tier2.js';
import {
  foldAllWhitespace,
  foldCase,
  foldDiacritics,
  foldEquivalentPunctuation,
  tier1Normalise,
  tokenise,
  whitespaceCount,
} from './normalise.js';
import { applyTypoGuards } from './typo-guards.js';
import { ES_UNIT } from './packs/es.js';
import { JA_PACK, JA_QUOTATION_UNIT, JA_UNIT } from './packs/ja.js';
import { GRADING_FIXTURE_PACKS } from './packs/index.js';
import { arbAnyText, arbNearMiss } from './testing/arbitraries.js';
import type { GradingPack, GradingUnit, Tier2Class } from './types.js';

const NO_CONTEXT: Tier2Context = { targetReading: null, targetLexemeSurface: null };

// ---------------------------------------------------------------------------
// An independent reference ladder, written from the invariant text
// ---------------------------------------------------------------------------

/** Plain Levenshtein, capped at two. Deliberately not `distance.ts`'s one-pass version. */
function levenshteinAtMostOne(a: string, b: string): boolean {
  const x = [...a];
  const y = [...b];
  const rows: number[][] = [];
  for (let i = 0; i <= x.length; i += 1) rows.push(new Array<number>(y.length + 1).fill(0));
  for (let i = 0; i <= x.length; i += 1) rows[i]![0] = i;
  for (let j = 0; j <= y.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost,
      );
    }
  }
  return rows[x.length]![y.length]! === 1;
}

function referenceClass(
  answer: string,
  target: string,
  pack: GradingPack,
  unit: GradingUnit,
): Tier2Class | null {
  const caps = (s: string) => foldEquivalentPunctuation(foldCase(s), unit);
  const dia = (s: string) => foldDiacritics(caps(s), pack);

  if (!pack.spaceless && foldAllWhitespace(answer) === foldAllWhitespace(target)) {
    return whitespaceCount(answer) >= whitespaceCount(target)
      ? 'whitespace-insertion'
      : 'whitespace-omission';
  }
  if (caps(answer) === caps(target)) return 'capitalisation';
  if (!pack.diacriticsContrastive && dia(answer) === dia(target)) return 'diacritic';

  const a = tokenise(dia(answer), pack);
  const t = tokenise(dia(target), pack);
  if (a.length === t.length) {
    const differing = t.map((_, i) => i).filter((i) => a[i] !== t[i]);
    if (differing.length === 1) {
      const i = differing[0]!;
      if (levenshteinAtMostOne(a[i]!, t[i]!)) {
        // Guard evaluation is config, not logic: the reference reads the same table.
        let offset = 0;
        for (let k = 0; k < i; k += 1) offset += [...t[k]!].length + (pack.spaceless ? 0 : 1);
        const outcome = applyTypoGuards(
          {
            mistypedWord: a[i]!,
            targetWord: t[i]!,
            targetReading: null,
            answerReading: null,
            editOffsetInTarget: offset,
            targetString: dia(target),
            targetLexemeSurface: null,
            targetLanguageWords: pack.targetLanguageWords,
          },
          pack.typoGuards,
        );
        if (outcome.forgiven) return 'typo';
      }
    }
  }

  if (!pack.spaceless && t.length === a.length + 1) {
    const remaining = [...t];
    let matched = true;
    let cursor = 0;
    const dropped: string[] = [];
    for (const token of remaining) {
      if (cursor < a.length && a[cursor] === token) cursor += 1;
      else dropped.push(token);
    }
    matched = cursor === a.length;
    if (matched && dropped.length === 1 && pack.functionClassTokens.has(dropped[0]!)) {
      return 'dropped-token';
    }
  }
  return null;
}

describe('tier 2 — the soft-correct ladder', () => {
  it('[INV-GRD-01] the note pool holds SIX classes, one note each, in the invariant order', () => {
    expect(TIER2_CLASS_ORDER).toEqual([
      'whitespace-insertion',
      'whitespace-omission',
      'capitalisation',
      'diacritic',
      'typo',
      'dropped-token',
    ]);
    expect(Object.keys(TIER2_NOTE_POOL).sort()).toEqual([...TIER2_CLASS_ORDER].sort());
    expect(Object.keys(TIER2_NOTE_POOL)).toHaveLength(6);
    // Five speak, one is silent by ruling — and every spoken note is distinct, so no two
    // classes can be told apart by their consequence but not by their copy.
    const spoken = Object.values(TIER2_NOTE_POOL).filter((n): n is string => n !== null);
    expect(new Set(spoken).size).toBe(spoken.length);
    expect(spoken).toEqual([
      'You have an extra space.',
      'You missed a space.',
      'Pay attention to the accents.',
      'You have a typo.',
      'You missed a word.',
    ]);
  });

  it('[INV-GRD-01] classification is TOTAL: any two strings yield a pool member or null', () => {
    for (const { pack, unit } of GRADING_FIXTURE_PACKS) {
      fc.assert(
        fc.property(arbAnyText(), arbAnyText(), (answer, target) => {
          const result = classifyTier2(answer, target, pack, unit, NO_CONTEXT);
          if (result === null) return;
          expect(TIER2_CLASS_ORDER, pack.label).toContain(result.tier2Class);
          expect(result.note).toBe(TIER2_NOTE_POOL[result.tier2Class]);
        }),
        { numRuns: PROPERTY_RUNS },
      );
    }
  });

  it('[INV-GRD-01] classification is ORDERED: it agrees with an independent reference ladder', () => {
    for (const { pack, unit } of GRADING_FIXTURE_PACKS) {
      fc.assert(
        fc.property(arbNearMiss(pack), ({ target, answer }) => {
          const a = tier1Normalise(answer, pack);
          const t = tier1Normalise(target, pack);
          if (a === t) return; // tier 1; the ladder is not consulted
          const actual = classifyTier2(a, t, pack, unit, NO_CONTEXT);
          const expected = referenceClass(a, t, pack, unit);
          expect(actual?.tier2Class ?? null, `${pack.label}: ${a} / ${t}`).toBe(expected);
        }),
        { numRuns: PROPERTY_RUNS },
      );
    }
  });

  it('[INV-GRD-16] a spaceless pack can never reach either whitespace class', () => {
    fc.assert(
      fc.property(arbAnyText(), arbAnyText(), (answer, target) => {
        const result = classifyTier2(answer, target, JA_PACK, JA_UNIT, NO_CONTEXT);
        expect(result?.tier2Class).not.toBe('whitespace-insertion');
        expect(result?.tier2Class).not.toBe('whitespace-omission');
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-16] any whitespace inserted into an accepted form is tier 1 with no note', () => {
    fc.assert(
      fc.property(
        arbNearMiss(JA_PACK),
        fc.array(fc.constantFrom(' ', '　', '\t'), { maxLength: 4 }),
        fc.nat({ max: 16 }),
        ({ target }, spaces, seed) => {
          const chars = [...target];
          const at = chars.length === 0 ? 0 : seed % chars.length;
          const spaced = [...chars.slice(0, at), ...spaces, ...chars.slice(at)].join('');
          expect(tier1Normalise(spaced, JA_PACK)).toBe(tier1Normalise(target, JA_PACK));
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-18] the diacritic class is unreachable for a pack with contrastive diacritics', () => {
    fc.assert(
      fc.property(arbAnyText(), arbAnyText(), (answer, target) => {
        const result = classifyTier2(answer, target, JA_PACK, JA_UNIT, NO_CONTEXT);
        expect(result?.tier2Class).not.toBe('diacritic');
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-18] and it stays unreachable through the NFD path that would decompose が', () => {
    // NFD('が') is 'か' + U+3099. A fold that dropped combining marks unconditionally would
    // make the two equal and forgive a contrastive difference in silence (EC-GRD-29).
    expect('が'.normalize('NFD')).not.toBe('が');
    expect(foldDiacritics('が', JA_PACK)).toBe('が');
    expect(classifyTier2('かっこう', 'がっこう', JA_PACK, JA_UNIT, NO_CONTEXT)).toBeNull();
  });

  it('[INV-GRD-29] graded punctuation never folds, and the same characters fold one unit over', () => {
    const plain = classifyTier2(
      'はいと言いました',
      '「はい」と言いました',
      JA_PACK,
      JA_UNIT,
      NO_CONTEXT,
    );
    expect(plain?.tier2Class).toBe('capitalisation');
    expect(
      classifyTier2(
        'はいと言いました',
        '「はい」と言いました',
        JA_PACK,
        JA_QUOTATION_UNIT,
        NO_CONTEXT,
      ),
    ).toBeNull();
  });

  it('[INV-GRD-29] the punctuation class is a unit declaration: nothing global folds a mark', () => {
    fc.assert(
      fc.property(arbAnyText(), (text) => {
        // A unit with an empty class folds nothing at all — impossible if any global regex
        // were doing the work.
        const empty: GradingUnit = {
          ...ES_UNIT,
          punctuationEquivalenceClass: [],
          gradedPunctuation: [],
        };
        expect(foldEquivalentPunctuation(text, empty)).toBe(text);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-29] every character a unit grades survives the fold in that unit', () => {
    for (const graded of JA_QUOTATION_UNIT.gradedPunctuation) {
      expect(foldEquivalentPunctuation(`x${graded}y`, JA_QUOTATION_UNIT)).toContain(graded);
      expect(foldEquivalentPunctuation(`x${graded}y`, JA_UNIT)).not.toContain(graded);
    }
    expect(foldEquivalentPunctuation('casa.', ES_UNIT)).toBe('casa');
  });
});
