/**
 * `packages/core/src/grading` — the three-tier checker and everything that decides a
 * verdict.
 *
 * Owns §2 of `docs/invariants.md`: INV-GRD-01…08 from the first pass and INV-GRD-10…29
 * from the merge pass of 2026-09-11. (INV-GRD-09 is a rendered-input contract and belongs
 * to the player, not to the engine.)
 *
 * Everything exported here is pure and total. The grader holds no state between calls,
 * takes the ACTIVE pack as an argument, and reads every language-varying rule off it —
 * there is no language switch, no registry keyed by a language code and no module-level
 * map, because each of those is a named falsifier (INV-GRD-13).
 */
export * from './accuracy.js';
export * from './alternates.js';
export * from './attempt.js';
export * from './banner.js';
export * from './config.js';
export * from './distance.js';
export * from './grade.js';
export * from './highlight.js';
export * from './ja.js';
export * from './listening.js';
export * from './match.js';
export * from './normalise.js';
export * from './open-response.js';
export * from './register.js';
export * from './tier2.js';
export * from './types.js';
export * from './typo-guards.js';
export * from './wordbank.js';
export * from './packs/index.js';
