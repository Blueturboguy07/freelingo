/**
 * Score, the score floor and the per-section clamp: INV-PATH-06, INV-PATH-22.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  applyJumpScore,
  bandIndexOf,
  bandOfScore,
  bandRange,
  cefrChipBand,
  chipDisagreementBands,
  displayedScore,
  frontierSection,
  raiseFloor,
  scoreCeilingOf,
  sectionScore,
} from './score.js';
import { applyJump } from './unlock.js';
import { CEFR_BANDS } from './types.js';
import type { CefrBand, PathModel, PathSection } from './types.js';
import {
  model as makeModel,
  node,
  section,
  unit,
  FULL_MANIFEST,
} from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

/** An eight-section course, one unit each, so every band is reachable. */
function eightSectionModel(overrides: Partial<PathModel> = {}): PathModel {
  const sections: PathSection[] = CEFR_BANDS.map((band, i) => ({
    ...section(i, [unit(i, [node(`u${i}n0`, 'lesson', i), node(`u${i}n1`, 'unitReview', i)])]),
    band,
  }));
  return makeModel(sections, { manifest: { ...FULL_MANIFEST, scoreCeiling: 129 }, ...overrides });
}

describe('the score floor', () => {
  it('[INV-PATH-06] falsifier: a jump to early B1 with Score 0 raises the floor and keeps the chips in step', () => {
    const input = falsifier('INV-PATH-06');
    const target = CEFR_BANDS.indexOf(input.jumpToSectionBand as CefrBand);
    const base = eightSectionModel({ scoreEarned: input.scoreEarned as number });
    const jumped = applyJump(base, target);
    const targetSection = jumped.sections[target];
    expect(targetSection).toBeDefined();
    const { model, markUnseen } = applyJumpScore(
      jumped,
      targetSection!,
      input.skippedItemIds as string[],
    );
    const expected = input.expect as Record<string, number>;
    expect(model.scoreFloor).toBe(expected.scoreFloor);
    expect(displayedScore(model)).toBe(expected.displayedScore);
    expect(chipDisagreementBands(model)).toBe(expected.chipDisagreementBands);
    // Skipped items are UNSEEN, never mastered - the scheduler keys on item exposure.
    expect(markUnseen).toHaveLength(expected.markUnseen!);
  });

  it('[INV-PATH-06] displayed_score = max(earned, floor), and the floor never decreases', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 160 }),
        fc.array(fc.nat({ max: CEFR_BANDS.length - 1 }), { maxLength: 6 }),
        (earned, jumps) => {
          let model = eightSectionModel({ scoreEarned: earned });
          let floor = model.scoreFloor;
          for (const target of jumps) {
            model = applyJump(model, target);
            const s = model.sections[target];
            if (s === undefined) continue;
            const next = raiseFloor(model.scoreFloor, s);
            expect(next).toBeGreaterThanOrEqual(floor);
            floor = next;
            model = { ...model, scoreFloor: next };
          }
          const frontier = frontierSection(model);
          const range = bandRange(frontier.band);
          const ceiling = Math.min(range.max, model.manifest.scoreCeiling);
          const clampedFloor = Math.min(Math.max(model.scoreFloor, range.min), ceiling);
          expect(displayedScore(model)).toBe(
            Math.min(Math.max(model.scoreEarned, clampedFloor), ceiling),
          );
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-06] the CEFR chip and the Score chip never disagree by more than one band', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 200 }),
        fc.nat({ max: 200 }),
        fc.array(fc.nat({ max: CEFR_BANDS.length - 1 }), { maxLength: 6 }),
        (earned, seedFloor, jumps) => {
          let model = eightSectionModel({ scoreEarned: earned, scoreFloor: seedFloor });
          for (const target of jumps) {
            model = applyJump(model, target);
            const s = model.sections[target];
            if (s !== undefined) model = { ...model, scoreFloor: raiseFloor(model.scoreFloor, s) };
          }
          expect(chipDisagreementBands(model)).toBeLessThanOrEqual(1);
          expect(cefrChipBand(model)).toBe(bandOfScore(displayedScore(model)));
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-06] without the floor, a Section-5 jump disagrees by four bands', () => {
    // The bug this invariant exists to stop, spelled out.
    const jumped = applyJump(eightSectionModel({ scoreEarned: 0 }), 4);
    const naiveBand = bandOfScore(jumped.scoreEarned);
    const sectionBand = frontierSection(jumped).band;
    expect(Math.abs(bandIndexOf(naiveBand) - bandIndexOf(sectionBand))).toBe(4);
  });
});

describe('per-section score', () => {
  it('[INV-PATH-22] falsifier: adding 400 items to a section cannot lower its number', () => {
    const input = falsifier('INV-PATH-22');
    const band = input.sectionBand as CefrBand;
    const target: PathSection = { ...section(3, []), band };
    const expected = input.expect as Record<string, number>;
    expect(sectionScore(input.courseScoreBefore as number, target)).toBe(
      expected.sectionScoreBefore,
    );
    // sectionScore takes the course Score and the band. There is nowhere to put an item
    // count, which is the point: no second Score model exists.
    expect(sectionScore(input.courseScoreAfter as number, target)).toBe(expected.sectionScoreAfter);
    expect(sectionScore.length).toBe(2);
  });

  it('[INV-PATH-22] the section number is a clamp of the course Score and is non-decreasing', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 200 }),
        fc.nat({ max: 200 }),
        fc.nat({ max: CEFR_BANDS.length - 1 }),
        (a, b, bandIndex) => {
          const band = CEFR_BANDS[bandIndex] ?? 'A2';
          const target: PathSection = { ...section(bandIndex, []), band };
          const range = bandRange(band);
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          expect(sectionScore(lo, target)).toBeLessThanOrEqual(sectionScore(hi, target));
          expect(sectionScore(a, target)).toBeGreaterThanOrEqual(range.min);
          expect(sectionScore(a, target)).toBeLessThanOrEqual(range.max);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-56] the Score ceiling is a function of the manifest', () => {
    expect(scoreCeilingOf(FULL_MANIFEST)).toBe(129);
    expect(scoreCeilingOf({ ...FULL_MANIFEST, scoreCeiling: 29 })).toBe(29);
    const beta = eightSectionModel({
      manifest: { ...FULL_MANIFEST, scoreCeiling: 29 },
      scoreEarned: 500,
    });
    expect(displayedScore(beta)).toBeLessThanOrEqual(29);
  });
});
