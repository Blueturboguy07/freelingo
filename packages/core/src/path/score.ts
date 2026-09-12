/**
 * Duolingo Score, the score floor, and CEFR bands.
 *
 * INV-PATH-06 / EC-PTH-09: a passed jump-here marks skipped items **unseen** in FSRS and
 * raises `score_floor` to the bottom of the target section's band, so the Score chip and
 * the CEFR chip cannot disagree by five bands. `displayed = max(earned, floor)`, the floor
 * never decreases.
 *
 * The *upper* half of "never disagree by more than one band" needs the symmetric rule:
 * the Score is a function of content the learner has reached, so it is also clamped to the
 * ceiling of the furthest section entered. Without it a learner sitting in Section 1 could
 * display an A2 chip beside a `very early A1` section chip.
 *
 * INV-PATH-22 / EC-PTH-40: **no second Score model exists.** Any per-section number is a
 * pure clamp of the single course Score into that band, and is non-decreasing - otherwise
 * a pack update that adds items lowers a section's displayed number.
 */
import type { CefrBand, PackManifest, PathModel, PathSection } from './types.js';
import { CEFR_BAND_RANGES } from './types.js';
import { allUnits } from './types.js';
import { unitUnlocked } from './unlock.js';

export interface ScoreBand {
  readonly band: CefrBand;
  readonly min: number;
  readonly max: number;
}

export function bandIndexOf(band: CefrBand): number {
  return CEFR_BAND_RANGES.findIndex((r) => r.band === band);
}

export function bandRange(band: CefrBand): ScoreBand {
  const found = CEFR_BAND_RANGES.find((r) => r.band === band);
  /* c8 ignore next */
  if (!found) throw new Error(`unknown CEFR band ${band}`);
  return found;
}

/** The band a raw Score sits in. Above the last band's max it stays in the last band. */
export function bandOfScore(score: number): CefrBand {
  const last = CEFR_BAND_RANGES[CEFR_BAND_RANGES.length - 1];
  /* c8 ignore next */
  if (!last) throw new Error('no CEFR bands');
  for (const r of CEFR_BAND_RANGES) if (score <= r.max) return r.band;
  return last.band;
}

/** The furthest section the learner has entered; the frontier the chips describe. */
export function frontierSection(model: PathModel): PathSection {
  const units = allUnits(model);
  let furthest = 0;
  for (let u = 0; u < units.length; u += 1) if (unitUnlocked(model, u)) furthest = u;
  let seen = 0;
  for (const section of model.sections) {
    if (furthest < seen + section.units.length) return section;
    seen += section.units.length;
  }
  const last = model.sections[model.sections.length - 1];
  /* c8 ignore next */
  if (!last) throw new Error('a path model has at least one section');
  return last;
}

/** `score_floor` after entering a section - non-decreasing, by construction. */
export function raiseFloor(currentFloor: number, section: PathSection): number {
  return Math.max(currentFloor, bandRange(section.band).min);
}

/**
 * What the Score chip renders. Clamped into the frontier section's band and to the pack's
 * declared ceiling (INV-PACK-56: a three-section beta cannot show `129 / 160`).
 */
export function displayedScore(model: PathModel): number {
  const section = frontierSection(model);
  const range = bandRange(section.band);
  const ceiling = Math.min(range.max, model.manifest.scoreCeiling);
  const floor = Math.min(Math.max(model.scoreFloor, range.min), ceiling);
  return Math.min(Math.max(model.scoreEarned, floor), ceiling);
}

/** The CEFR chip beside the Score chip. Both read the same number (EC-PTH-40). */
export function cefrChipBand(model: PathModel): CefrBand {
  return bandOfScore(displayedScore(model));
}

/** How many bands the Score chip and the frontier section's CEFR chip disagree by. */
export function chipDisagreementBands(model: PathModel): number {
  return Math.abs(bandIndexOf(cefrChipBand(model)) - bandIndexOf(frontierSection(model).band));
}

/**
 * INV-PATH-22: a section card's number is a pure clamp of the course Score into that
 * section's band. It reads no item counts, so a pack update cannot lower it.
 */
export function sectionScore(courseScore: number, section: PathSection): number {
  const range = bandRange(section.band);
  return Math.min(Math.max(courseScore, range.min), range.max);
}

/** Applying a passed jump: raise the floor, and report the items to mark unseen. */
export interface JumpScoreResult {
  readonly model: PathModel;
  /** Item ids the jump skipped. FSRS must treat these as UNSEEN, never as mastered. */
  readonly markUnseen: readonly string[];
}

export function applyJumpScore(
  model: PathModel,
  targetSection: PathSection,
  skippedItemIds: readonly string[],
): JumpScoreResult {
  return {
    model: { ...model, scoreFloor: raiseFloor(model.scoreFloor, targetSection) },
    markUnseen: [...skippedItemIds],
  };
}

/** The Score ceiling is a function of the manifest, never a constant (INV-PACK-56). */
export function scoreCeilingOf(manifest: PackManifest): number {
  return manifest.scoreCeiling;
}
