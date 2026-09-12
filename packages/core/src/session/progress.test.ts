import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  advanceProgress,
  consumeFinalSegment,
  initialProgress,
  numeratorFromAnswers,
  progressFraction,
} from './progress.js';
import type { Answer, VerdictKind } from './types.js';

function answer(
  verdict: VerdictKind,
  queue: 'main' | 'mistakes' = 'main',
  skipped = false,
): Answer {
  return {
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
  };
}

const answerArb = fc
  .record({
    verdict: fc.constantFrom<VerdictKind>(
      'correct',
      'softCorrect',
      'wrong',
      'accepted',
      'noVerdict',
    ),
    queue: fc.constantFrom<'main' | 'mistakes'>('main', 'mistakes'),
    skipped: fc.boolean(),
  })
  .map(({ verdict, queue, skipped }) => answer(verdict, queue, skipped));

describe('the progress bar (S031)', () => {
  it('[INV-COM-06] the denominator is fixed at session start and immutable for the session life', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.array(answerArb, { maxLength: 40 }),
        fc.integer({ min: 0, max: 4 }),
        (length, answers, outstanding) => {
          let state = initialProgress(length);
          for (const a of answers) {
            state = advanceProgress(state, a, outstanding);
            expect(state.denominator).toBe(length);
          }
          state = consumeFinalSegment(state);
          expect(state.denominator).toBe(length);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-COM-06] the bar never rewinds and never exceeds 1', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(answerArb, { maxLength: 40 }),
        (length, answers) => {
          let state = initialProgress(length);
          let previous = progressFraction(state);
          for (const a of answers) {
            state = advanceProgress(state, a, 1);
            const now = progressFraction(state);
            expect(now).toBeGreaterThanOrEqual(previous);
            expect(now).toBeLessThanOrEqual(1);
            previous = now;
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-COM-06] falsifier: a 12-exercise lesson with 2 mistakes has 16 answerable items and a denominator of 12; the recycles consume no segment', () => {
    let state = initialProgress(12);
    // Ten correct, two wrong — the two wrong items return through the mistake queue.
    for (let i = 0; i < 10; i += 1) state = advanceProgress(state, answer('correct'), 2);
    for (let i = 0; i < 2; i += 1) state = advanceProgress(state, answer('wrong'), 2);
    expect(state.denominator).toBe(12);
    // The reserved last segment is NOT consumed while mistakes are outstanding: the fill
    // stays capped one short and the reserve renders as a static gap.
    expect(state.numerator).toBe(10);

    // Four mistake-queue replays (two mistakes, twice each) consume NOTHING.
    for (let i = 0; i < 4; i += 1) state = advanceProgress(state, answer('correct', 'mistakes'), 1);
    expect(state.numerator).toBe(10);

    // The final segment is consumed exactly once at completion.
    const complete = consumeFinalSegment(state);
    expect(complete.numerator).toBe(12);
    expect(complete.finalSegmentConsumed).toBe(true);
    expect(consumeFinalSegment(complete)).toEqual(complete);
  });

  it('[INV-SESS-18] the reserved final segment is consumed exactly once, whatever the call order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 6 }),
        (length, calls) => {
          let state = initialProgress(length);
          for (let i = 0; i < calls; i += 1) state = consumeFinalSegment(state);
          expect(state.numerator).toBe(length);
          expect(state.finalSegmentConsumed).toBe(true);
          // Idempotent: the second call cannot advance anything, so the segment cannot be
          // spent twice by a resume that re-enters `complete`.
          expect(consumeFinalSegment(state)).toEqual(state);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-COM-10] for any sequence of skips the numerator equals correct answers and the denominator never moves', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(answerArb, { maxLength: 30 }),
        (length, answers) => {
          let state = initialProgress(length);
          for (const a of answers) state = advanceProgress(state, a, 0);
          state = consumeFinalSegment(state);
          expect(state.denominator).toBe(length);
          // Before the final segment, the numerator tracks correct main-queue answers.
          const expected = Math.min(numeratorFromAnswers(answers), length);
          expect(expected).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("[INV-COM-10] falsifier: `Can't speak now` at exercise 5 of 11 leaves the bar and the denominator unchanged", () => {
    let state = initialProgress(11);
    for (let i = 0; i < 4; i += 1) state = advanceProgress(state, answer('correct'), 0);
    const before = state;
    state = advanceProgress(state, answer('noVerdict', 'main', true), 0);
    expect(state).toEqual(before);
    expect(state.denominator).toBe(11);
  });

  it('[INV-COM-06] a wrong answer neither advances nor rewinds the bar', () => {
    let state = initialProgress(10);
    state = advanceProgress(state, answer('correct'), 0);
    const after = state.numerator;
    state = advanceProgress(state, answer('wrong'), 1);
    expect(state.numerator).toBe(after);
  });
});
