import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  COMBO_AT_SESSION_START,
  COMBO_GOLD_THRESHOLD,
  COMBO_LABEL_THRESHOLD,
  barIsGold,
  comboAfter,
  comboFromAnswers,
  comboLabelVisible,
  comboView,
} from './combo.js';
import type { Answer, VerdictKind } from './types.js';
import { SESSION_FLAVOURS } from './types.js';
import { freshSession } from './session-fixture.js';

/** A graded answer. The generator is tight: only the fields combo can possibly read. */
const answerArb = fc
  .record({
    verdict: fc.constantFrom<VerdictKind>(
      'correct',
      'softCorrect',
      'wrong',
      'accepted',
      'noVerdict',
    ),
    skipped: fc.boolean(),
    queue: fc.constantFrom<'main' | 'mistakes'>('main', 'mistakes'),
  })
  .map(({ verdict, skipped, queue }): Answer => ({
    exerciseIndex: 0,
    slotId: 's',
    itemId: 'i',
    type: 'meaningSelect',
    verdict,
    softCorrected: verdict === 'softCorrect',
    wrong: verdict === 'wrong',
    costPaid: verdict === 'wrong' ? 1 : 0,
    skipped,
    scorable: true,
    queue,
  }));

describe('combo and the gold bar (S030, S031)', () => {
  it('[INV-COM-01] combo increments by exactly 1 per exercise, never per pair, gap or stroke', () => {
    fc.assert(
      fc.property(fc.array(answerArb, { minLength: 1, maxLength: 24 }), (answers) => {
        let combo = COMBO_AT_SESSION_START;
        for (const answer of answers) {
          const next = comboAfter(combo, answer);
          const delta = next - combo;
          // Either +1 (one exercise), or a reset to 0, or unchanged. Never +5 for a
          // five-pair match, never +8 for eight strokes.
          expect(delta === 1 || next === 0 || delta === 0).toBe(true);
          expect(delta).toBeLessThanOrEqual(1);
          combo = next;
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-COM-01] falsifier: a clean five-pair match from combo 2 moves the combo to 3, not to 7', () => {
    const match: Answer = {
      exerciseIndex: 3,
      slotId: 's',
      itemId: 'i',
      type: 'matchPairs',
      verdict: 'correct',
      softCorrected: false,
      wrong: false,
      costPaid: 0,
      skipped: false,
      scorable: true,
      queue: 'main',
    };
    expect(comboAfter(2, match)).toBe(3);
    // The per-stroke variant: eight strokes of one character are ONE exercise.
    const trace: Answer = { ...match, type: 'characterTrace' };
    expect(comboAfter(2, trace)).toBe(3);
  });

  it('[INV-COM-02] combo is 0 at every session start, for every flavour, and lives in the session row', () => {
    for (const flavour of SESSION_FLAVOURS) {
      const session = freshSession({ flavour });
      expect(session.core.combo).toBe(COMBO_AT_SESSION_START);
      expect(session.core.combo).toBe(0);
      // It is in `core` — the session row — and nowhere in the account region: the
      // session type has no account handle at all, which is what makes this checkable.
      expect(Object.keys(session.core)).toContain('combo');
    }
    expect(comboFromAnswers([])).toBe(0);
  });

  it('[INV-COM-04] barGold ⟺ combo ≥ 6 and the label is visible ⟺ combo ≥ 2, as pure functions', () => {
    expect(COMBO_GOLD_THRESHOLD).toBe(6);
    expect(COMBO_LABEL_THRESHOLD).toBe(2);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 80 }), (combo) => {
        expect(barIsGold(combo)).toBe(combo >= 6);
        expect(comboLabelVisible(combo)).toBe(combo >= 2);
        const view = comboView(combo);
        expect(view.gold).toBe(combo >= 6);
        expect(view.labelCount).toBe(combo >= 2 ? combo : null);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-COM-04] falsifier: combo 5 is green, combo 6 is gold, and a break at 7 reverts to green with no label until 2', () => {
    expect(barIsGold(5)).toBe(false);
    expect(barIsGold(6)).toBe(true);
    expect(barIsGold(0)).toBe(false);
    expect(comboLabelVisible(1)).toBe(false);
    expect(comboLabelVisible(2)).toBe(true);
  });

  it('[INV-COM-11] combo depends only on the ordered sequence of graded answers — not on the queue an answer came from', () => {
    fc.assert(
      fc.property(fc.array(answerArb, { maxLength: 24 }), (answers) => {
        const asGiven = comboFromAnswers(answers);
        // Flipping every answer from the main queue to the mistakes queue — i.e. crossing
        // the main→mistakes boundary — must not change the combo by one.
        const allMistakes = answers.map((a) => ({ ...a, queue: 'mistakes' as const }));
        expect(comboFromAnswers(allMistakes)).toBe(asGiven);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-COM-11] falsifier: an interstitial between two correct answers does not reset, freeze or skip the increment', () => {
    const correct: Answer = {
      exerciseIndex: 0,
      slotId: 's',
      itemId: 'i',
      type: 'meaningSelect',
      verdict: 'correct',
      softCorrected: false,
      wrong: false,
      costPaid: 0,
      skipped: false,
      scorable: true,
      queue: 'main',
    };
    // combo.ts has no interstitial input at all — the only way it could be affected is a
    // caller skipping the increment, which the sequence below pins.
    expect(comboFromAnswers([correct, correct, correct, correct, correct])).toBe(5);
    const replay = { ...correct, queue: 'mistakes' as const };
    expect(comboFromAnswers([correct, correct, correct, correct, correct, replay])).toBe(6);
  });

  it('[INV-COM-09] a soft-correct never breaks the combo and still crosses the milestone', () => {
    const base: Answer = {
      exerciseIndex: 0,
      slotId: 's',
      itemId: 'i',
      type: 'typedTranslate',
      verdict: 'correct',
      softCorrected: false,
      wrong: false,
      costPaid: 0,
      skipped: false,
      scorable: true,
      queue: 'main',
    };
    const soft: Answer = { ...base, verdict: 'softCorrect', softCorrected: true };
    const nine = Array.from({ length: 9 }, () => base);
    expect(comboFromAnswers([...nine, soft])).toBe(10);
  });

  it('[INV-COM-10] a modality skip leaves the combo untouched — no heart, no break, no error signal', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), (combo) => {
        const skip: Answer = {
          exerciseIndex: 0,
          slotId: 's',
          itemId: 'i',
          type: 'speakSentence',
          verdict: 'noVerdict',
          softCorrected: false,
          wrong: false,
          costPaid: 0,
          skipped: true,
          scorable: false,
          queue: 'main',
        };
        expect(comboAfter(combo, skip)).toBe(combo);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
