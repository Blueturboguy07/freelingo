/**
 * `packages/core/src/scheduler` — FSRS and the review pools.
 *
 * Plan §Engine: "the one subsystem where a silent fault causes lasting harm rather than a
 * missed reward". Every rule here is owned by an id in `docs/invariants.md` §5 Scheduler,
 * and every id has a property test in this directory with committed falsifier inputs under
 * `__falsifiers__/`.
 *
 * | id          | owned by            |
 * |-------------|---------------------|
 * | INV-SCH-01  | `fsrs.ts`           | the 0.6x early-review guard
 * | INV-SCH-02  | `elapsed.ts`        | the two-sided elapsed clamp + anomaly rows
 * | INV-SCH-03  | `attempts.ts`       | append-only attempts, idempotent commit replay
 * | INV-SCH-04  | `backlog.ts`        | review-first routing, byte-identical node contents
 * | INV-SCH-05  | `pool.ts`           | one pool, two surfaces, one spent-marker
 * | INV-SCH-06  | `endgame.ts`        | S066's generator and `Come back later...`
 * | INV-SCH-07  | `holds.ts`          | a reported item accrues nothing for 7 local days
 * | INV-SCH-08  | `holds.ts`          | a disabled modality accrues nothing
 * | INV-SCH-09  | `score.ts`          | Score over an ever-mastered high-water set
 * | INV-SCH-10  | `introduction.ts`   | the daily new-item budget, the production delay
 * | INV-SCH-11  | `fsrs.ts`           | rows keyed `(item, surface)`, introduction beats
 * | INV-SCH-12  | `fsrs.ts`           | ruby-on encounters credit the lexeme, not the glyph
 *
 * `engine.ts` composes them and owns the ORDER, which several of the ids are really about.
 *
 * Not re-exported from `packages/core/src/index.ts`: that barrel is outside this task's
 * file lane, so consumers import `@freelingo/core/src/scheduler/index.js` (or the paths
 * directly) until the integration task wires it up, exactly as `economy/` does.
 */
export * from './types.js';
export * from './config.js';
export * from './elapsed.js';
export * from './holds.js';
export * from './fsrs.js';
export * from './attempts.js';
export * from './pool.js';
export * from './endgame.js';
export * from './backlog.js';
export * from './introduction.js';
export * from './score.js';
export * from './engine.js';
