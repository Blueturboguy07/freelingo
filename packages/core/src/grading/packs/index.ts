/**
 * Grading fixture packs.
 *
 * These are FIXTURES, not content. They exist so every pack-parameterised rule can be
 * driven against a real configuration from both sides of the interesting axis — Latin
 * versus spaceless, contrastive versus not, with and without an equivalence table — long
 * before `content/es` and `content/ja` exist.
 *
 * `GRADING_FIXTURE_PACKS` is what the property tests iterate. Adding a pack here adds it
 * to every property, which is the intended cost: a rule that only holds for Spanish should
 * fail the moment a second pack is in the list.
 */
import { DE_PACK, DE_UNIT } from './de.js';
import { ES_PACK, ES_UNIT } from './es.js';
import { JA_PACK, JA_QUOTATION_UNIT, JA_UNIT } from './ja.js';
import type { GradingPack, GradingUnit } from '../types.js';

export * from './de.js';
export * from './es.js';
export * from './ja.js';

/** One pack with the unit a property should use when it does not care which. */
export interface FixturePack {
  readonly pack: GradingPack;
  readonly unit: GradingUnit;
}

/** Every fixture pack. Properties run against all of them unless they say otherwise. */
export const GRADING_FIXTURE_PACKS: readonly FixturePack[] = Object.freeze([
  { pack: ES_PACK, unit: ES_UNIT },
  { pack: JA_PACK, unit: JA_UNIT },
  { pack: DE_PACK, unit: DE_UNIT },
]);

/** The two the brief names, for properties that must be driven against exactly those. */
export const ES_AND_JA: readonly FixturePack[] = Object.freeze([
  { pack: ES_PACK, unit: ES_UNIT },
  { pack: JA_PACK, unit: JA_UNIT },
]);

/** The quotation-teaching unit, for INV-GRD-29's falsifier. */
export const JA_QUOTATION: FixturePack = Object.freeze({
  pack: JA_PACK,
  unit: JA_QUOTATION_UNIT,
});
