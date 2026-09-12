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
 *
 * ## INTEGRATE-TASK DEPENDENCY — this module is unreachable until one line lands
 *
 * `packages/core/src/index.ts` exports `day/civil`, `day/streak`, `ceremony/commit` and
 * `db/index`, and NOT this file, so nothing outside `packages/core` can import the grader
 * today. It needs:
 *
 *     export * from './grading/index.js';
 *
 * That file is outside this task's file lane (`packages/core/src/grading/**`), so the line
 * is the integrate task's to add; it is recorded here and in the branch's blockers so it
 * cannot be lost between the two. Nothing in this package depends on it — every test here
 * imports by relative path — which is exactly why its absence is invisible to a green run.
 *
 * ## What is deliberately NOT exported: the fixture packs
 *
 * `./packs/index.js` is not re-exported here, and must not be. `packs/index.ts` says it
 * itself: "These are FIXTURES, not content." The es/ja/de word lists, reading tables and
 * unit declarations exist so every pack-parameterised rule can be driven from both sides of
 * its axis before `content/es` and `content/ja` are built. On the public surface of
 * `@freelingo/core` they would be shipped in the app bundle, and — worse than the bytes —
 * they would be importable, which is how a fixture becomes the thing an app reads when the
 * real pack is late. They follow the convention `testing/arbitraries.ts` already sets in
 * this directory: test support is imported by relative path from a `.test.ts` and appears in
 * no barrel. `grade.test.ts` fails if this line comes back.
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
