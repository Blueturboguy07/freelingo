/**
 * INV-GRD-08 (monotone, never a heart, one shape across three paths), INV-GRD-10 (the
 * prompt-copy guard), INV-GRD-21 (the register advisory) and INV-GRD-22 (pack-declared
 * gates that accept every taught inflection).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';

import {
  gradeOpenResponse,
  hasRequiredLexeme,
  isPromptCopy,
  lengthAndKeywordGate,
  openResponseLength,
  type OpenResponsePath,
} from './open-response.js';
import { ES_PACK, ES_UNIT } from './packs/es.js';
import { JA_PACK, JA_UNIT } from './packs/ja.js';
import type { GradableItem } from './types.js';

const PATHS: readonly OpenResponsePath[] = ['llm', 'keyword-length', 'accept-all'];

const ES_ITEM: GradableItem = {
  itemId: 'rr',
  family: 'read-and-respond',
  accepted: [],
  prompt: 'que hace ella en la casa',
  requiredLexemeIds: ['escribir'],
};

const JA_ITEM: GradableItem = {
  itemId: 'ja-rr',
  family: 'read-and-respond',
  accepted: [],
  prompt: 'きのうどこへいきましたか',
  requiredLexemeIds: ['いく'],
};

const NOVEL_TOKENS = ['siempre', 'ayer', 'mucho', 'rapido'] as const;

describe('read and respond', () => {
  it('[INV-GRD-08] the family never costs a heart, never writes a mistake row, on any path', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...NOVEL_TOKENS, 'escribe', 'ella'), { maxLength: 8 }),
        fc.constantFrom(...PATHS),
        (tokens, path) => {
          const verdict = gradeOpenResponse({
            pack: ES_PACK,
            unit: ES_UNIT,
            item: ES_ITEM,
            reply: tokens.join(' '),
            path,
          });
          expect(verdict.heartCost).toBe(0);
          expect(verdict.wrong).toBe(false);
          expect(verdict.comboReset).toBe(false);
          expect(verdict.mistakeLexemeIds).toEqual([]);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-08] grading is MONOTONE in length and required-lexeme presence', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...NOVEL_TOKENS, 'escribe'), { maxLength: 6 }),
        fc.constantFrom(...NOVEL_TOKENS, 'escribe'),
        (tokens, extra) => {
          const shorter = tokens.join(' ');
          const longer = [...tokens, extra].join(' ');
          const before = lengthAndKeywordGate(shorter, ES_PACK, ES_UNIT, ES_ITEM);
          const after = lengthAndKeywordGate(longer, ES_PACK, ES_UNIT, ES_ITEM);
          // Adding a token can only ever help: length grows and the lexeme test is an
          // existential over a fixed set.
          if (before) expect(after, `${shorter} passed but ${longer} did not`).toBe(true);
          expect(openResponseLength(longer, ES_PACK)).toBeGreaterThanOrEqual(
            openResponseLength(shorter, ES_PACK),
          );
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-08] the three paths differ only in the verdict, never in the session shape', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...NOVEL_TOKENS, 'escribe'), { minLength: 1, maxLength: 8 }),
        (tokens) => {
          const reply = tokens.join(' ');
          const verdicts = PATHS.map((path) =>
            gradeOpenResponse({ pack: ES_PACK, unit: ES_UNIT, item: ES_ITEM, reply, path }),
          );
          const shapes = verdicts.map((v) => ({
            heartCost: v.heartCost,
            comboReset: v.comboReset,
            wrong: v.wrong,
            mistakeLexemeIds: v.mistakeLexemeIds,
            advisories: v.advisories,
          }));
          expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1);
          // The fallback is a FALLBACK: it accepts at least what the gate accepted.
          const gate = lengthAndKeywordGate(reply, ES_PACK, ES_UNIT, ES_ITEM);
          if (gate) for (const verdict of verdicts) expect(verdict.tier).toBe(1);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-10] any subsequence of the prompt is refused, whatever its length or coverage', () => {
    const promptTokens = ES_ITEM.prompt!.split(' ');
    fc.assert(
      fc.property(fc.subarray(promptTokens), fc.constantFrom(...PATHS), (subset, path) => {
        if (subset.length === 0) return;
        expect(isPromptCopy(subset.join(' '), ES_ITEM)).toBe(true);
        const verdict = gradeOpenResponse({
          pack: ES_PACK,
          unit: ES_UNIT,
          item: ES_ITEM,
          reply: subset.join(' '),
          path,
        });
        expect(verdict.tier).toBe(0);
        expect(verdict.writesAttemptRow).toBe(false);
        expect(verdict.heartCost).toBe(0);
        expect(verdict.comboReset).toBe(false);
        expect(verdict.mistakeLexemeIds).toEqual([]);
        expect(verdict.notArmedReason).toBe('try it in your own words');
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("[INV-GRD-10] a reply of the learner's own words is not caught by the guard", () => {
    expect(isPromptCopy('ella escribe una carta larga', ES_ITEM)).toBe(false);
  });

  it('[INV-GRD-21] a register slip is exactly ONE advisory on all three paths, and costs nothing', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PATHS), (path) => {
        const verdict = gradeOpenResponse({
          pack: JA_PACK,
          unit: JA_UNIT,
          item: JA_ITEM,
          reply: 'きのうとしょかんへ行く',
          path,
        });
        expect(verdict.advisories).toHaveLength(1);
        expect(verdict.advisories[0]).toBe(JA_PACK.registerSlot!.advisoryNote);
        expect(verdict.wrong).toBe(false);
        expect(verdict.heartCost).toBe(0);
        expect(verdict.mistakeLexemeIds).toEqual([]);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-21] a pack with no register slot never emits one', () => {
    const verdict = gradeOpenResponse({
      pack: ES_PACK,
      unit: ES_UNIT,
      item: ES_ITEM,
      reply: 'ella escribe una carta larga',
      path: 'keyword-length',
    });
    expect(verdict.advisories).toEqual([]);
  });

  it('[INV-GRD-22] every taught inflection satisfies its lexeme gate — 行きました passes a 行く gate', () => {
    for (const surface of JA_UNIT.taughtInflections['いく'] ?? []) {
      expect(
        hasRequiredLexeme(`きのうとしょかんへ${surface}`, JA_UNIT, JA_ITEM, JA_PACK),
        surface,
      ).toBe(true);
    }
    const verdict = gradeOpenResponse({
      pack: JA_PACK,
      unit: JA_UNIT,
      item: JA_ITEM,
      reply: 'きのうとしょかんへ行きました',
      path: 'keyword-length',
    });
    expect(verdict.tier).toBe(1);
  });

  it('[INV-GRD-22] the gates are PACK-declared: ja counts characters, es counts tokens', () => {
    expect(JA_PACK.openResponseLengthUnit).toBe('characters');
    expect(ES_PACK.openResponseLengthUnit).toBe('tokens');
    fc.assert(
      fc.property(fc.array(fc.constantFrom('あ', 'い', 'う'), { maxLength: 12 }), (chars) => {
        const reply = chars.join('');
        expect(openResponseLength(reply, JA_PACK)).toBe(chars.length);
        // The same string is ONE token to a Latin pack — which is why a shared gate would
        // fail every Japanese reply (EC-GRD-33).
        expect(openResponseLength(reply, ES_PACK)).toBe(chars.length === 0 ? 0 : 1);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-22] the keyword test is never a substring test on a Latin pack', () => {
    // `escribe` must match as a token; `describe` contains it and must not satisfy the gate.
    expect(hasRequiredLexeme('ella describe una carta', ES_UNIT, ES_ITEM, ES_PACK)).toBe(false);
    expect(hasRequiredLexeme('ella escribe una carta', ES_UNIT, ES_ITEM, ES_PACK)).toBe(true);
  });
});
