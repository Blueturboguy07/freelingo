/**
 * INV-GRD-23 (word-bank grading is a function of tapped tile ids) and INV-GRD-24 (the
 * multi-character select is order-sensitive and CHECK-gated).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';

import {
  EMPTY_SELECT_STATE,
  gradeCharacterSelect,
  gradeWordBank,
  tapCharacter,
  untapCharacter,
  wordBankAnswer,
} from './wordbank.js';
import { ES_PACK, ES_UNIT } from './packs/es.js';
import { JA_PACK, JA_UNIT } from './packs/ja.js';
import { NO_SURFACES_INTRODUCED } from './grade.js';
import type { GradableItem, Tile } from './types.js';

const JA_TILES: readonly Tile[] = [
  { tileId: 't1', text: 'まいにち' },
  { tileId: 't2', text: 'コーヒー' },
  { tileId: 't3', text: 'を' },
  { tileId: 't4', text: 'のみます' },
];

const JA_BANK: GradableItem = {
  itemId: 'bank',
  family: 'word-bank',
  targetLexemeId: 'nomu',
  accepted: [{ surface: 'まいにちコーヒーをのみます', rank: 1, surfaceId: 's' }],
  tiles: JA_TILES,
};

const SELECT: GradableItem = {
  itemId: 'kyo',
  family: 'character-select',
  targetLexemeId: 'kyo',
  accepted: [],
  orderedTileIds: ['ki', 'small-yo'],
  tiles: [
    { tileId: 'ki', text: 'き' },
    { tileId: 'small-yo', text: 'ょ' },
    { tileId: 'ko', text: 'こ' },
    { tileId: 'yo', text: 'よ' },
  ],
};

describe('word bank', () => {
  it('[INV-GRD-23] the verdict depends on tapped ids alone — shuffling the tile table changes nothing', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(
          JA_TILES.map((t) => t.tileId),
          { minLength: 1 },
        ),
        fc.shuffledSubarray([...JA_TILES], { minLength: 4, maxLength: 4 }),
        (tapped, shuffledTiles) => {
          const declared = gradeWordBank({
            pack: JA_PACK,
            unit: JA_UNIT,
            item: JA_BANK,
            learner: NO_SURFACES_INTRODUCED,
            tappedTileIds: tapped,
          });
          const reordered = gradeWordBank({
            pack: JA_PACK,
            unit: JA_UNIT,
            item: { ...JA_BANK, tiles: shuffledTiles },
            learner: NO_SURFACES_INTRODUCED,
            tappedTileIds: tapped,
          });
          expect(reordered).toEqual(declared);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-23] U+0020 never enters a ja answer string, whatever is tapped', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('t1', 't2', 't3', 't4'), { maxLength: 8 }), (tapped) => {
        const answer = wordBankAnswer(JA_BANK, tapped, JA_PACK);
        expect(answer.includes(' ')).toBe(false);
        expect(answer.includes('　')).toBe(false);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("[INV-GRD-23] the delimiter is the pack's: es joins with a space, ja with nothing", () => {
    expect(JA_PACK.wordBankJoinDelimiter).toBe('');
    expect(ES_PACK.wordBankJoinDelimiter).toBe(' ');
    const esBank: GradableItem = {
      itemId: 'es-bank',
      family: 'word-bank',
      accepted: [{ surface: 'el gato', rank: 1, surfaceId: 's' }],
      tiles: [
        { tileId: 'a', text: 'el' },
        { tileId: 'b', text: 'gato' },
      ],
    };
    expect(wordBankAnswer(esBank, ['a', 'b'], ES_PACK)).toBe('el gato');
    expect(wordBankAnswer(JA_BANK, ['t1', 't2'], JA_PACK)).toBe('まいにちコーヒー');
    expect(
      gradeWordBank({
        pack: ES_PACK,
        unit: ES_UNIT,
        item: esBank,
        learner: NO_SURFACES_INTRODUCED,
        tappedTileIds: ['a', 'b'],
      }).tier,
    ).toBe(1);
  });

  it('[INV-GRD-23] tap ORDER decides, and the correct order is tier 1', () => {
    expect(
      gradeWordBank({
        pack: JA_PACK,
        unit: JA_UNIT,
        item: JA_BANK,
        learner: NO_SURFACES_INTRODUCED,
        tappedTileIds: ['t1', 't2', 't3', 't4'],
      }).tier,
    ).toBe(1);
    expect(
      gradeWordBank({
        pack: JA_PACK,
        unit: JA_UNIT,
        item: JA_BANK,
        learner: NO_SURFACES_INTRODUCED,
        tappedTileIds: ['t2', 't1', 't3', 't4'],
      }).wrong,
    ).toBe(true);
  });
});

describe('the multi-character select', () => {
  it('[INV-GRD-24] no tap ever costs a heart, and CHECK is armed by the FIRST tap, not the Nth', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('ki', 'small-yo', 'ko', 'yo'), { maxLength: 6 }),
        (taps) => {
          let state = EMPTY_SELECT_STATE;
          expect(state.armed).toBe(false);
          taps.forEach((tile, index) => {
            state = tapCharacter(state, tile);
            expect(state.heartsSpentOnTaps).toBe(0);
            // Armed from the first tap onwards: a CHECK that lights up at N taps tells the
            // learner how long the answer is (EC-GRD-35).
            expect(state.armed).toBe(true);
            expect(state.taps).toHaveLength(index + 1);
          });
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-24] grading at CHECK costs at most one heart and one mistake row', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('ki', 'small-yo', 'ko', 'yo'), { maxLength: 6 }),
        (taps) => {
          let state = EMPTY_SELECT_STATE;
          for (const tile of taps) state = tapCharacter(state, tile);
          const verdict = gradeCharacterSelect(SELECT, state);
          expect(verdict.heartCost).toBeLessThanOrEqual(1);
          expect(verdict.mistakeLexemeIds.length).toBeLessThanOrEqual(1);
          const correct = taps.length === 2 && taps[0] === 'ki' && taps[1] === 'small-yo';
          expect(verdict.wrong).toBe(!correct);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-GRD-24] it is ORDER-sensitive: the right characters in the wrong order are wrong', () => {
    let right = EMPTY_SELECT_STATE;
    right = tapCharacter(tapCharacter(right, 'ki'), 'small-yo');
    let wrong = EMPTY_SELECT_STATE;
    wrong = tapCharacter(tapCharacter(wrong, 'small-yo'), 'ki');
    expect(gradeCharacterSelect(SELECT, right).wrong).toBe(false);
    expect(gradeCharacterSelect(SELECT, wrong).wrong).toBe(true);
  });

  it('[INV-GRD-24] taps come off in reverse order, and the strip can empty back to disarmed', () => {
    let state = EMPTY_SELECT_STATE;
    state = tapCharacter(tapCharacter(state, 'ki'), 'ko');
    state = untapCharacter(state);
    expect(state.taps).toEqual(['ki']);
    expect(state.armed).toBe(true);
    state = untapCharacter(state);
    expect(state.taps).toEqual([]);
    expect(state.armed).toBe(false);
  });
});
