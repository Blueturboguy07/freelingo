/**
 * The ceremony Score slot: INV-CER-08, INV-CER-11, INV-CER-17.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { advanceScore, scoreSlotEntries, type ScoreState } from './score.js';
import { runCeremony } from './queue.js';
import { ceremonyState } from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

/** Score->CEFR band index, the same ladder `path/score.ts` uses. */
const BAND_EDGES = [9, 19, 29, 59, 79, 99, 114, 129];
function bandIndexOf(score: number): number {
  for (let i = 0; i < BAND_EDGES.length; i += 1) if (score <= (BAND_EDGES[i] ?? 0)) return i;
  return BAND_EDGES.length - 1;
}

function fresh(ceiling: number): ScoreState {
  return {
    exposureFraction: 0,
    masteryScore: 0,
    ceiling,
    ceilingBeatShown: false,
    unlocked: false,
  };
}

describe('the Score ceiling beat', () => {
  it('[INV-CER-08] falsifier: 200 sessions produce exactly one maxed beat and then no progress screen', () => {
    const input = falsifier('INV-CER-08');
    const expected = input.expect as Record<string, number>;
    let state = fresh(input.ceiling as number);
    let maxed = 0;
    let progressAfterBeat = 0;
    let beatSeen = false;
    for (let i = 0; i < (input.sessions as number); i += 1) {
      const advance = advanceScore(
        state,
        {
          gradedItems: 12,
          exposureDelta: 0.001,
          masteryDelta: input.masteryDeltaPerSession as number,
        },
        bandIndexOf,
      );
      const entries = scoreSlotEntries(advance, beatSeen);
      for (const entry of entries) {
        if (entry.slot === 'S070_scoreMaxed') {
          maxed += 1;
          beatSeen = true;
        } else if (entry.slot === 'S069_scoreProgress' && beatSeen) {
          progressAfterBeat += 1;
        }
      }
      state = advance.state;
    }
    expect(maxed).toBe(expected.maxedBeats);
    expect(progressAfterBeat).toBe(expected.progressScreensAfterBeat);
  });

  it('[INV-CER-08] the beat can never fire twice, whatever the session sequence', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 40 }), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 129 }),
        (deltas, ceiling) => {
          let state = fresh(ceiling);
          let beats = 0;
          for (const masteryDelta of deltas) {
            const advance = advanceScore(
              state,
              { gradedItems: 5, exposureDelta: 0.01, masteryDelta },
              bandIndexOf,
            );
            if (advance.ceilingReachedThisSession) beats += 1;
            state = advance.state;
          }
          expect(beats).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('exposure and mastery', () => {
  it('[INV-CER-11] falsifier: a 30-session run with zero mastery still fires the Score screen every time', () => {
    const input = falsifier('INV-CER-11');
    let state = fresh(129);
    let screens = 0;
    for (let i = 0; i < (input.sessions as number); i += 1) {
      const advance = advanceScore(
        state,
        {
          gradedItems: input.gradedItemsPerSession as number,
          exposureDelta: 0.001,
          masteryDelta: input.masteryDeltaPerSession as number,
        },
        bandIndexOf,
      );
      // Any entry at the Score slot counts: the first session unlocks the Score (S068),
      // every later one moves the fraction (S069). EC-CER-18's falsifier is the Score
      // screen firing on FEWER than 90% of sessions.
      if (scoreSlotEntries(advance, false).length > 0) screens += 1;
      expect(advance.state.masteryScore).toBe(state.masteryScore);
      state = advance.state;
    }
    expect(screens / (input.sessions as number)).toBe(
      (input.expect as { scoreScreenFraction: number }).scoreScreenFraction,
    );
  });

  it('[INV-CER-11] exposure strictly increases with graded items; mastery never decreases', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            gradedItems: fc.nat({ max: 20 }),
            exposureDelta: fc.float({
              min: Math.fround(-0.5),
              max: Math.fround(0.05),
              noNaN: true,
            }),
            masteryDelta: fc.integer({ min: -10, max: 10 }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        (inputs) => {
          let state = fresh(129);
          for (const input of inputs) {
            const advance = advanceScore(state, input, bandIndexOf);
            if (input.gradedItems > 0 && state.exposureFraction < 1) {
              expect(advance.state.exposureFraction).toBeGreaterThan(state.exposureFraction);
            } else if (input.gradedItems === 0) {
              expect(advance.state.exposureFraction).toBe(state.exposureFraction);
            }
            expect(advance.state.masteryScore).toBeGreaterThanOrEqual(state.masteryScore);
            expect(advance.state.masteryScore).toBeLessThanOrEqual(129);
            state = advance.state;
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('the Score slot', () => {
  it('[INV-CER-17] falsifier: a tick-over that is also a band crossing contributes ONE entry', () => {
    const input = falsifier('INV-CER-17');
    const expected = input.expect as Record<string, number>;
    const before = input.before as number;
    const after = input.after as number;
    const state: ScoreState = {
      exposureFraction: 0.5,
      masteryScore: before,
      ceiling: 129,
      ceilingBeatShown: false,
      unlocked: true,
    };
    const advance = advanceScore(
      state,
      { gradedItems: 10, exposureDelta: 0.01, masteryDelta: after - before },
      bandIndexOf,
    );
    const entries = scoreSlotEntries(advance, false);
    expect(entries).toHaveLength(expected.scoreSlotEntries!);
    expect(entries[0]?.bandBeats).toBe(expected.bandBeats);
    // 29 -> 30 is the high-A1 -> A2 boundary.
    expect(bandIndexOf(before)).toBe(2);
    expect(bandIndexOf(after)).toBe(3);
  });

  it('[INV-CER-17] the Score slot contributes at most one entry, and the chain at most one screen', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 129 }),
        fc.nat({ max: 60 }),
        fc.boolean(),
        fc.boolean(),
        (start, delta, unlocked, beatShown) => {
          const state: ScoreState = {
            exposureFraction: 0.3,
            masteryScore: start,
            ceiling: 129,
            ceilingBeatShown: beatShown,
            unlocked,
          };
          const advance = advanceScore(
            state,
            { gradedItems: 8, exposureDelta: 0.01, masteryDelta: delta },
            bandIndexOf,
          );
          const entries = scoreSlotEntries(advance, beatShown);
          expect(entries.length).toBeLessThanOrEqual(1);
          const chain = runCeremony(ceremonyState({}, { scoreEntries: entries })).chain;
          const scoreScreens = chain.filter(
            (s) => s.startsWith('S068') || s.startsWith('S069') || s.startsWith('S070'),
          );
          expect(scoreScreens.length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-CER-17] band beats summed over a sequence equal the band boundaries crossed', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 25 }), { minLength: 1, maxLength: 20 }), (deltas) => {
        let state = fresh(129);
        state = { ...state, unlocked: true };
        let beats = 0;
        const start = bandIndexOf(state.masteryScore);
        for (const masteryDelta of deltas) {
          const advance = advanceScore(
            state,
            { gradedItems: 6, exposureDelta: 0.01, masteryDelta },
            bandIndexOf,
          );
          for (const entry of scoreSlotEntries(advance, false)) beats += entry.bandBeats;
          state = advance.state;
        }
        expect(beats).toBe(bandIndexOf(state.masteryScore) - start);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
