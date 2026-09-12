/**
 * INV-GRD-19 — `ja` tier-1 normalisation is ONE pure, documented, idempotent function.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';

import { JA_CHOONPU, JA_CHOONPU_CONFUSABLES, JA_KANJI_ONE } from './config.js';
import { moraCount, normaliseJa } from './ja.js';
import { classifyTier2 } from './tier2.js';
import { JA_PACK, JA_UNIT } from './packs/ja.js';
import { arbAnyText } from './testing/arbitraries.js';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

describe('ja tier-1 normalisation', () => {
  it('[INV-GRD-19] halfwidth, U+2015 and a hyphen all collapse onto コーヒー; 珈琲 does not', () => {
    const forms = ['ｺｰﾋｰ', 'コ―ヒ―', 'コ-ヒ-', 'コ−ヒ−', 'コーヒー'];
    const normalised = forms.map((f) => normaliseJa(f));
    expect(new Set(normalised).size).toBe(1);
    expect(normalised[0]).toBe('コーヒー');
    // A different orthography is pack content, not a normalisation rule (EC-GRD-30).
    expect(normaliseJa('珈琲')).toBe('珈琲');
    expect(normalised).not.toContain('珈琲');
  });

  it('[INV-GRD-19] every member of the named dash-fold set folds to the chōonpu', () => {
    for (const dash of JA_CHOONPU_CONFUSABLES) {
      expect(normaliseJa(`コ${dash}ヒ${dash}`), dash).toBe(`コ${JA_CHOONPU}ヒ${JA_CHOONPU}`);
    }
    expect(JA_CHOONPU_CONFUSABLES).toContain('―');
    expect(JA_CHOONPU_CONFUSABLES).toContain('－');
    expect(JA_CHOONPU_CONFUSABLES).not.toContain(JA_KANJI_ONE);
  });

  it('[INV-GRD-19] 一 folds ONLY between katakana, so the numeral survives everywhere else', () => {
    expect(normaliseJa('コ一ヒー')).toBe('コーヒー');
    expect(normaliseJa('一人')).toBe('一人');
    expect(normaliseJa('第一')).toBe('第一');
  });

  it('[INV-GRD-19] the function is idempotent over arbitrary text', () => {
    fc.assert(
      fc.property(arbAnyText(), (text) => {
        const once = normaliseJa(text);
        expect(normaliseJa(once)).toBe(once);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-19] it never deletes a length-bearing character, so no length loss reaches tier 2', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('が', 'っ', 'こ', 'う', 'ー', 'ゃ', 'コ', 'ヒ'), {
          minLength: 1,
          maxLength: 10,
        }),
        (chars) => {
          const text = chars.join('');
          // Normalisation may REPLACE a character (a dash becomes a chōonpu) but never
          // removes one, so a mora can only be lost by the learner, never by the fold.
          expect(moraCount(normaliseJa(text))).toBe(moraCount(text));
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-19] a missing chōonpu is tier 3: vowel length is contrastive', () => {
    expect(
      classifyTier2('コヒー', 'コーヒー', JA_PACK, JA_UNIT, {
        targetReading: null,
        targetLexemeSurface: null,
      }),
    ).toBeNull();
  });

  it('[INV-GRD-19] mora counts the sokuon and not the small ya/yu/yo', () => {
    expect(moraCount('がっこう')).toBe(4);
    expect(moraCount('きょう')).toBe(2);
    expect(moraCount('コーヒー')).toBe(4);
    expect(moraCount('')).toBe(0);
  });

  it('[INV-GRD-19] ONE function: nothing else in the package normalises Japanese', () => {
    // Comments are stripped first: this gate is about a second NFKC call, not about a
    // sentence that mentions one.
    const executable = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('/ja.ts')) {
          if (/NFKC/.test(executable(readFileSync(full, 'utf8')))) {
            offenders.push(full.slice(SRC_DIR.length));
          }
        }
      }
    };
    walk(SRC_DIR);
    expect(offenders, 'NFKC outside ja.ts is a second ja normalisation').toEqual([]);
  });
});
