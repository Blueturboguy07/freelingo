/**
 * INV-GRD-28 — highlights for a `no_word_boundaries` pack, and the tokenizer grep gate.
 *
 * > "For `no_word_boundaries` packs, no highlight range partially overlaps a ruby span and
 * > the wrong-word headline is unreachable. Grep gate: no Japanese tokenizer is linked
 * > into the app."
 *
 * The grep gate is the half that cannot be tested any other way. `deep/10` §S9 forbids
 * shipping a runtime tokenizer while `deep/01`'s diff assumes one, and the resolution
 * (EC-GRD-40) is a character-range diff snapped to BAKED ruby spans. A tokenizer added
 * later would make every other test in this file pass and the invariant false, so the
 * dependency tree and the sources are scanned for one by name.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';

import { WRONG_WORD_HEADLINE } from './config.js';
import { highlightRanges, snapToRubySpans } from './highlight.js';
import { isWrongWordCase, wrongHeadline } from './grade.js';
import { ES_PACK } from './packs/es.js';
import { JA_PACK } from './packs/ja.js';
import { arbAnyText } from './testing/arbitraries.js';
import type { RubySpan } from './types.js';

const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * Japanese morphological analysers, by the names they ship under on npm.
 *
 * Every one of these would make `You used the wrong word.` implementable for `ja` — which
 * is exactly why the invariant forbids them rather than the headline.
 */
const JAPANESE_TOKENIZERS = [
  'kuromoji',
  'sudachi',
  'mecab',
  'tiny-segmenter',
  'tinysegmenter',
  'budoux',
  'juman',
  'kagome',
  'lindera',
  'nagisa',
  'fugashi',
  'janome',
  'intl.segmenter',
  'Intl.Segmenter',
];

const arbSpans = (): fc.Arbitrary<RubySpan[]> =>
  fc
    .array(fc.tuple(fc.nat({ max: 10 }), fc.integer({ min: 1, max: 4 })), { maxLength: 3 })
    .map((pairs) => pairs.map(([start, width]) => ({ start, end: start + width })));

describe('highlights for a pack with no word boundaries', () => {
  it('[INV-GRD-28] no highlight range partially overlaps a ruby span', () => {
    fc.assert(
      fc.property(arbAnyText(), arbAnyText(), arbSpans(), (answer, target, spans) => {
        for (const range of highlightRanges(answer, target, JA_PACK, spans)) {
          for (const span of spans) {
            expect(range.start > span.start && range.start < span.end).toBe(false);
            expect(range.end > span.start && range.end < span.end).toBe(false);
          }
          expect(range.end).toBeGreaterThan(range.start);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-28] snapping only ever widens: the differing run is never hidden', () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.nat({ max: 10 }), fc.integer({ min: 1, max: 6 })),
        arbSpans(),
        ([start, width], spans) => {
          const range = { start, end: start + width };
          const snapped = snapToRubySpans(range, spans);
          expect(snapped.start).toBeLessThanOrEqual(range.start);
          expect(snapped.end).toBeGreaterThanOrEqual(range.end);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-28] the wrong-word headline is unreachable for a no_word_boundaries pack', () => {
    fc.assert(
      fc.property(arbAnyText(), arbAnyText(), (answer, target) => {
        expect(isWrongWordCase(answer, target, JA_PACK)).toBe(false);
        expect(wrongHeadline(answer, target, JA_PACK)).not.toBe(WRONG_WORD_HEADLINE);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-28] and it IS reachable for a pack that has word boundaries', () => {
    // Otherwise the previous test would pass on a grader that never renders the headline
    // at all, which is a different bug wearing the same green tick.
    expect(wrongHeadline('el perro', 'el gato', ES_PACK)).toBe(WRONG_WORD_HEADLINE);
    expect(wrongHeadline('el zzzz', 'el gato', ES_PACK)).toBe('Correct solution:');
  });

  it('[INV-GRD-28] grep gate: no Japanese tokenizer is linked into the app', () => {
    const manifest = readFileSync(PACKAGE_JSON, 'utf8');
    for (const tokenizer of JAPANESE_TOKENIZERS) {
      expect(manifest.toLowerCase(), `${tokenizer} in packages/core/package.json`).not.toContain(
        tokenizer.toLowerCase(),
      );
    }
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('highlight.test.ts')) {
          const text = readFileSync(full, 'utf8').toLowerCase();
          for (const tokenizer of JAPANESE_TOKENIZERS) {
            if (text.includes(tokenizer.toLowerCase())) {
              offenders.push(`${full.slice(SRC_DIR.length)}: ${tokenizer}`);
            }
          }
        }
      }
    };
    walk(SRC_DIR);
    expect(offenders).toEqual([]);
  });

  it('[INV-GRD-28] a worked example: the run snaps outward to the ruby boundary', () => {
    expect(
      highlightRanges('わたしはがくせいです', 'わたしはがくせいでした', JA_PACK, [
        { start: 4, end: 8 },
      ]),
    ).toEqual([{ start: 9, end: 10 }]);
    expect(
      highlightRanges('わたしはがくせいです', 'わたしはがくせいでした', JA_PACK, [
        { start: 8, end: 11 },
      ]),
    ).toEqual([{ start: 8, end: 11 }]);
  });
});
