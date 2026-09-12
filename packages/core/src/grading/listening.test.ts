/**
 * INV-GRD-26 — listening in a `no_word_delimiter` pack is graded on baked readings, with
 * no runtime NLP, and a build gate rejects two same-reading taught lexemes in one unit.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';

import { gradeListening, unitReadingCollisions, type TaughtLexeme } from './listening.js';
import { NO_SURFACES_INTRODUCED } from './grade.js';
import { ES_PACK, ES_UNIT } from './packs/es.js';
import { JA_PACK, JA_UNIT } from './packs/ja.js';
import type { GradableItem } from './types.js';

const ITEM: GradableItem = {
  itemId: 'hashi',
  family: 'listening',
  targetLexemeId: 'hashi',
  readingSurfaceNote: '正しい漢字は「橋」です。',
  accepted: [{ surface: '橋を渡る', rank: 1, surfaceId: 's', reading: 'はしをわたる' }],
  sameReadingSurfaces: ['箸を渡る'],
};

describe('listening in a no_word_delimiter pack', () => {
  it('[INV-GRD-26] the three outcomes: intended kanji, another real kanji, reading mismatch', () => {
    const intended = gradeListening({
      pack: JA_PACK,
      unit: JA_UNIT,
      item: ITEM,
      answer: '橋を渡る',
      learner: NO_SURFACES_INTRODUCED,
    });
    expect(intended.tier).toBe(1);
    expect(intended.wrong).toBe(false);

    const homophone = gradeListening({
      pack: JA_PACK,
      unit: JA_UNIT,
      item: ITEM,
      answer: '箸を渡る',
      learner: NO_SURFACES_INTRODUCED,
    });
    expect(homophone.tier).toBe(2);
    expect(homophone.channel).toBe('reading-surface');
    expect(homophone.note).toBe(ITEM.readingSurfaceNote);
    expect(homophone.wrong).toBe(false);
    expect(homophone.heartCost).toBe(0);
    expect(homophone.mistakeLexemeIds).toEqual([]);

    const mismatch = gradeListening({
      pack: JA_PACK,
      unit: JA_UNIT,
      item: ITEM,
      answer: 'はしをわたるよ',
      learner: NO_SURFACES_INTRODUCED,
    });
    expect(mismatch.tier).toBe(3);
    expect(mismatch.wrong).toBe(true);
  });

  it('[INV-GRD-26] the same-reading set is BAKED: an unlisted surface never reaches tier 2', () => {
    fc.assert(
      fc.property(fc.constantFrom('端を渡る', '走る', '橋をわたるよ', 'はし'), (answer) => {
        const verdict = gradeListening({
          pack: JA_PACK,
          unit: JA_UNIT,
          item: ITEM,
          answer,
          learner: NO_SURFACES_INTRODUCED,
        });
        expect(verdict.channel).not.toBe('reading-surface');
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-26] a pack WITHOUT no_word_delimiter takes the ordinary three-tier path', () => {
    const esItem: GradableItem = {
      itemId: 'es-listen',
      family: 'listening',
      targetLexemeId: 'gato',
      targetLexemeSurface: 'gato',
      accepted: [{ surface: 'el gato', rank: 1, surfaceId: 's' }],
    };
    const verdict = gradeListening({
      pack: ES_PACK,
      unit: ES_UNIT,
      item: esItem,
      answer: 'El gato',
      learner: NO_SURFACES_INTRODUCED,
    });
    expect(verdict.tier).toBe(2);
    expect(verdict.channel).toBe('capitalisation');
  });

  it('[INV-GRD-26] the build gate finds every same-reading collision in a unit', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('はし', 'ねこ', 'がっこう'), { minLength: 1, maxLength: 8 }),
        (readings) => {
          const taught: TaughtLexeme[] = readings.map((reading, i) => ({
            lexemeId: `l${i}`,
            surface: `s${i}`,
            reading,
          }));
          const collisions = unitReadingCollisions(taught);
          const counts = new Map<string, number>();
          for (const reading of readings) counts.set(reading, (counts.get(reading) ?? 0) + 1);
          const expected = [...counts.values()].filter((n) => n > 1).length;
          expect(collisions).toHaveLength(expected);
          for (const collision of collisions) {
            expect(collision.lexemeIds.length).toBeGreaterThan(1);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-26] no runtime NLP: readings come from the pack table and nowhere else', () => {
    // Removing the baked entry removes the ability to grade the homophone at tier 2. If
    // anything derived a reading at runtime, this would still pass.
    const strippedPack = { ...JA_PACK, readingsBySurface: new Map<string, string>() };
    const verdict = gradeListening({
      pack: strippedPack,
      unit: JA_UNIT,
      item: { ...ITEM, sameReadingSurfaces: [] },
      answer: '箸を渡る',
      learner: NO_SURFACES_INTRODUCED,
    });
    expect(verdict.tier).toBe(3);
  });
});
