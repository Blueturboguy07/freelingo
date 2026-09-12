import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  COMBO_COPY_POOL,
  MISTAKE_REVIEW_COPY_MANY,
  MISTAKE_REVIEW_COPY_ONE,
  STEP_UP_COPY,
  comboCopyFor,
  emitInterstitials,
  isCanonicalInterstitialOrder,
  isComboMilestone,
} from './interstitials.js';
import { DEFAULT_FLAVOUR_MATRIX, MAX_COMBO_INTERSTITIALS_PER_SESSION } from './flavours.js';
import { comboAfter } from './combo.js';
import type { Answer } from './types.js';

const LESSON = DEFAULT_FLAVOUR_MATRIX.lesson;

function base(over: Partial<Parameters<typeof emitInterstitials>[0]> = {}) {
  return {
    config: LESSON,
    combo: 0,
    motivationalMessages: true,
    usedInterstitialKeys: [] as readonly string[],
    stepUpTripped: false,
    stepUpAlreadyFired: false,
    mistakesPending: 0,
    mainQueueDrained: false,
    ...over,
  };
}

/** Drive a whole session's answers and collect every combo interstitial it rendered. */
function runComboSession(verdicts: readonly ('correct' | 'wrong')[]): {
  copies: string[];
  combos: number[];
} {
  let combo = 0;
  let used: string[] = [];
  const copies: string[] = [];
  const combos: number[] = [];
  for (const verdict of verdicts) {
    const answer: Answer = {
      exerciseIndex: 0,
      slotId: 's',
      itemId: 'i',
      type: 'meaningSelect',
      verdict,
      softCorrected: false,
      wrong: verdict === 'wrong',
      costPaid: 0,
      skipped: false,
      scorable: true,
      queue: 'main',
    };
    combo = comboAfter(combo, answer);
    combos.push(combo);
    const screens = emitInterstitials(base({ combo, usedInterstitialKeys: used }));
    for (const screen of screens) {
      if (screen.producer !== 'combo') continue;
      copies.push(screen.copyKey);
      used = [...used, screen.key];
    }
  }
  return { copies, combos };
}

describe('mid-lesson interstitials (S047, S049)', () => {
  it('[INV-COM-03] interstitials fire at 5, 10 and every 10 thereafter', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), (combo) => {
        const expected = combo === 5 || (combo >= 10 && combo % 10 === 0);
        expect(isComboMilestone(combo)).toBe(expected);
      }),
      { numRuns: PROPERTY_RUNS },
    );
    expect(isComboMilestone(5)).toBe(true);
    expect(isComboMilestone(6)).toBe(false);
    expect(isComboMilestone(15)).toBe(false);
    expect(isComboMilestone(20)).toBe(true);
  });

  it('[INV-COM-03] copy never repeats within a session and the pool of 7 never falls back to the non-combo pool', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<'correct' | 'wrong'>('correct', 'wrong'), {
          minLength: 0,
          maxLength: 40,
        }),
        (verdicts) => {
          const { copies } = runComboSession(verdicts);
          // Never repeats.
          expect(new Set(copies).size).toBe(copies.length);
          // Never more than the pool.
          expect(copies.length).toBeLessThanOrEqual(MAX_COMBO_INTERSTITIALS_PER_SESSION);
          // Never a non-combo string — no fallback pool, ever.
          for (const copy of copies) {
            expect(COMBO_COPY_POOL).toContain(copy);
            expect(copy).not.toBe(STEP_UP_COPY.production);
            expect(copy).not.toBe(STEP_UP_COPY.audio);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-COM-03] falsifier: a session that passes combo 40 stops firing instead of repeating copy', () => {
    const { copies } = runComboSession(Array.from({ length: 90 }, () => 'correct' as const));
    // Milestones at 5, 10, 20, 30, 40, 50, 60, 70, 80, 90 = ten chances, seven strings.
    expect(copies.length).toBe(MAX_COMBO_INTERSTITIALS_PER_SESSION);
    expect(new Set(copies).size).toBe(MAX_COMBO_INTERSTITIALS_PER_SESSION);
    expect(copies[0]).toBe('combo.5_in_a_row');
    expect(copies[1]).toBe('combo.10_in_a_row');
  });

  it('[INV-COM-03] `5 in a row!` is pinned to combo 5 and can never appear at combo 30', () => {
    expect(comboCopyFor(5, [])).toBe('combo.5_in_a_row');
    expect(comboCopyFor(10, ['combo.5_in_a_row'])).toBe('combo.10_in_a_row');
    expect(comboCopyFor(30, ['combo.5_in_a_row', 'combo.10_in_a_row'])).not.toBe(
      'combo.5_in_a_row',
    );
    expect(comboCopyFor(30, COMBO_COPY_POOL)).toBeNull();
  });

  it('[INV-COM-07] with motivationalMessages false, zero combo interstitials render while combo state advances identically', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 120 }), (combo) => {
        const off = emitInterstitials(base({ combo, motivationalMessages: false }));
        expect(off.filter((s) => s.producer === 'combo')).toEqual([]);
      }),
      { numRuns: PROPERTY_RUNS },
    );
    // …and the combo itself is untouched: combo.ts has no motivationalMessages input.
    const { combos } = runComboSession(['correct', 'correct', 'correct']);
    expect(combos).toEqual([1, 2, 3]);
  });

  it('[INV-COM-07] the difficulty step-up card renders in every run, motivational messages or not', () => {
    for (const motivationalMessages of [true, false]) {
      const screens = emitInterstitials(
        base({ combo: 5, motivationalMessages, stepUpTripped: true }),
      );
      expect(screens.some((s) => s.producer === 'stepUp')).toBe(true);
    }
  });

  it('[INV-COM-08] all producers emit into one queue whose render is a duplicate-free subsequence of combo → step-up → mistake-review', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: 3 }),
        fc.boolean(),
        (
          combo,
          motivationalMessages,
          stepUpTripped,
          stepUpAlreadyFired,
          mistakesPending,
          drained,
        ) => {
          const screens = emitInterstitials(
            base({
              combo,
              motivationalMessages,
              stepUpTripped,
              stepUpAlreadyFired,
              mistakesPending,
              mainQueueDrained: drained,
            }),
          );
          expect(isCanonicalInterstitialOrder(screens)).toBe(true);
          // Never two in one frame from the same producer, and never a producer twice.
          expect(new Set(screens.map((s) => s.producer)).size).toBe(screens.length);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-COM-08] falsifier: one answer that drains the main queue, trips the step-up AND reaches combo 5 renders three screens in order, never mistake-review first', () => {
    const screens = emitInterstitials(
      base({ combo: 5, stepUpTripped: true, mistakesPending: 2, mainQueueDrained: true }),
    );
    expect(screens.map((s) => s.producer)).toEqual(['combo', 'stepUp', 'mistakeReview']);
    expect(screens[2]!.copyKey).toBe(MISTAKE_REVIEW_COPY_MANY);
  });

  it('[INV-COM-09] a soft-correct that crosses a milestone still emits exactly one milestone interstitial', () => {
    // The tier-2 note wins the BANNER headline (machine.ts sets `banner.softCorrect`);
    // the milestone is not lost — it fires as the separate interstitial after CONTINUE.
    const screens = emitInterstitials(base({ combo: 10 }));
    expect(screens.filter((s) => s.producer === 'combo')).toHaveLength(1);
    expect(screens[0]!.comboValue).toBe(10);
  });

  it('[INV-COM-12] at most one step-up escalation per session, and the less-sound copy never appears in a path flavour', () => {
    const first = emitInterstitials(base({ stepUpTripped: true }));
    expect(first.filter((s) => s.producer === 'stepUp')).toHaveLength(1);
    expect(first[0]!.copyKey).toBe(STEP_UP_COPY.production);
    const second = emitInterstitials(base({ stepUpTripped: true, stepUpAlreadyFired: true }));
    expect(second.filter((s) => s.producer === 'stepUp')).toHaveLength(0);
  });

  it('[INV-COM-12] falsifier: a mixed lesson never fires both pills', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), fc.boolean(), (combo, drained) => {
        const screens = emitInterstitials(
          base({ combo, stepUpTripped: true, mainQueueDrained: drained, mistakesPending: 1 }),
        );
        const stepUps = screens.filter((s) => s.producer === 'stepUp');
        expect(stepUps.length).toBeLessThanOrEqual(1);
        for (const s of stepUps) expect(s.copyKey).not.toBe(STEP_UP_COPY.audio);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-MIS-01] the mistake-review interstitial is plural-aware', () => {
    const one = emitInterstitials(base({ mistakesPending: 1, mainQueueDrained: true }));
    expect(one[0]!.copyKey).toBe(MISTAKE_REVIEW_COPY_ONE);
    const many = emitInterstitials(base({ mistakesPending: 3, mainQueueDrained: true }));
    expect(many[0]!.copyKey).toBe(MISTAKE_REVIEW_COPY_MANY);
  });
});
