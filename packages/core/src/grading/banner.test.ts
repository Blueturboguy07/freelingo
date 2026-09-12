/**
 * INV-GRD-11 (a non-empty headline for every class × toggle state) and INV-GRD-12 (the
 * three utility slots, no `Discuss`, and the day-scoped snooze).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';

import { bannerFor, isSnoozed, snooze, type SnoozeRow } from './banner.js';
import { BANNER_UTILITY_SLOTS, CONSOLATION_COPY, CORRECT_HEADLINES } from './config.js';
import { gradeTypedAnswer, NO_SURFACES_INTRODUCED } from './grade.js';
import { tier1Normalise } from './normalise.js';
import { ES_PACK, ES_UNIT } from './packs/es.js';
import { JA_PACK, JA_UNIT } from './packs/ja.js';
import type { GradableItem } from './types.js';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

const ES_ITEM: GradableItem = {
  itemId: 'es',
  family: 'typed-translate',
  targetLexemeId: 'gato',
  targetLexemeSurface: 'gato',
  accepted: [{ surface: 'el gato', rank: 1, surfaceId: 's' }],
};

const JA_REGISTER_ITEM: GradableItem = {
  itemId: 'ja',
  family: 'typed-translate',
  targetLexemeId: 'taberu',
  accepted: [{ surface: 'すしを食べます', rank: 1, surfaceId: 's' }],
};

/** One answer per verdict class, so the property covers all five. */
const ANSWERS = ['el gato', 'El gato', 'el ga to', 'perro', 'casa'] as const;

describe('the result banner', () => {
  it('[INV-GRD-11] the correct pool is the EIGHT headlines of S044, and `Nice try!` is not one', () => {
    // `deep/00-PRODUCT-MAP.md:109` (S044) lists exactly these eight, in this order. The
    // ninth that `deep/01` §S13 carried was deleted by that spec's own adversarial review:
    // `deep/01-lesson-state-machine.md:369` (§A7) — "*Correction:* move `Nice try!` to the
    // wrong/consolation pool". `Nice try!` is the S085 failure headline (`Nice try! You
    // earned {{xp}} XP`), and `bannerFor` indexes this pool modulo its length, so a ninth
    // member is a string shown to a learner who answered CORRECTLY.
    expect(CORRECT_HEADLINES).toEqual([
      'Nice!',
      'Nicely done!',
      'Awesome!',
      'Great job!',
      'Excellent!',
      'Correct!',
      'Great!',
      'Amazing!',
    ]);
    expect(CORRECT_HEADLINES).toHaveLength(8);
    expect(CORRECT_HEADLINES).not.toContain('Nice try!');
    // And no index into the pool can reach it, for any index a caller could pass.
    for (let i = -20; i <= 20; i += 1) {
      const banner = bannerFor(
        gradeTypedAnswer({
          pack: ES_PACK,
          unit: ES_UNIT,
          item: ES_ITEM,
          answer: 'el gato',
          learner: NO_SURFACES_INTRODUCED,
        }),
        'el gato',
        'el gato',
        ES_PACK,
        { motivationalMessages: true, headlineIndex: i },
      );
      expect(banner.headline).not.toBe('Nice try!');
      expect(CORRECT_HEADLINES).toContain(banner.headline);
    }
  });

  it('[INV-GRD-11] every verdict class × every toggle state carries a non-empty headline', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ANSWERS),
        fc.boolean(),
        fc.integer({ min: -50, max: 50 }),
        (answer, motivationalMessages, headlineIndex) => {
          const verdict = gradeTypedAnswer({
            pack: ES_PACK,
            unit: ES_UNIT,
            item: ES_ITEM,
            answer,
            learner: NO_SURFACES_INTRODUCED,
          });
          const banner = bannerFor(
            verdict,
            tier1Normalise(answer, ES_PACK),
            tier1Normalise('el gato', ES_PACK),
            ES_PACK,
            { motivationalMessages, headlineIndex },
          );
          expect(banner.headline).not.toBe('');
          expect(banner.headline.length).toBeGreaterThan(0);
          // The toggle gates ENCOURAGEMENT copy, never verdict copy (EC-GRD-20).
          expect(banner.consolation).toBe(
            verdict.wrong && motivationalMessages ? CONSOLATION_COPY : null,
          );
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-11] the register class gets a non-empty headline of its own, in both states', () => {
    for (const motivationalMessages of [true, false]) {
      const verdict = gradeTypedAnswer({
        pack: JA_PACK,
        unit: JA_UNIT,
        item: JA_REGISTER_ITEM,
        answer: 'すしを食べる',
        learner: NO_SURFACES_INTRODUCED,
      });
      const banner = bannerFor(verdict, 'すしを食べる', 'すしを食べます', JA_PACK, {
        motivationalMessages,
        headlineIndex: 0,
      });
      expect(verdict.verdictClass).toBe('register');
      expect(banner.headline).toBe('Use the polite form here.');
      expect(banner.headline).not.toBe('You used the wrong word.');
    }
  });

  it('[INV-GRD-11] the silent soft-correct class falls back to the verdict pool, never to empty', () => {
    const verdict = gradeTypedAnswer({
      pack: ES_PACK,
      unit: ES_UNIT,
      item: ES_ITEM,
      answer: 'El gato',
      learner: NO_SURFACES_INTRODUCED,
    });
    expect(verdict.note).toBeNull();
    const banner = bannerFor(verdict, 'El gato', 'el gato', ES_PACK, {
      motivationalMessages: false,
      headlineIndex: 3,
    });
    expect(CORRECT_HEADLINES).toContain(banner.headline);
  });

  it('[INV-GRD-12] the utility row is exactly snooze, report and Explain My Answer', () => {
    expect(BANNER_UTILITY_SLOTS).toEqual(['snooze', 'report', 'explain-my-answer']);
    expect(BANNER_UTILITY_SLOTS).toHaveLength(3);
  });

  it('[INV-GRD-12] the string `Discuss` appears nowhere in the grading engine', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('banner.test.ts')) {
          // The forum is gone from the 2026 bundle and a local-only clone has no forum, so
          // the icon would be dead on tap (EC-GRD-21).
          if (/\bDiscuss\b/.test(readFileSync(full, 'utf8'))) {
            offenders.push(full.slice(SRC_DIR.length));
          }
        }
      }
    };
    walk(SRC_DIR);
    expect(offenders).toEqual([]);
  });

  it('[INV-GRD-12] snooze is idempotent and scoped to one local day', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('i1', 'i2'),
        fc.constantFrom('2026-09-11', '2026-09-12'),
        fc.integer({ min: 1, max: 5 }),
        (itemId, day, repeats) => {
          let rows: readonly SnoozeRow[] = [];
          for (let i = 0; i < repeats; i += 1) rows = snooze(rows, itemId, day);
          expect(rows).toHaveLength(1);
          expect(isSnoozed(rows, itemId, day)).toBe(true);
          expect(isSnoozed(rows, itemId, '2026-09-13')).toBe(false);
          expect(isSnoozed(rows, 'other-item', day)).toBe(false);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-12] a snooze row carries nothing the scheduler could read as a due date', () => {
    const rows = snooze([], 'i1', '2026-09-11');
    expect(Object.keys(rows[0]!).sort()).toEqual(['day', 'itemId']);
  });
});
