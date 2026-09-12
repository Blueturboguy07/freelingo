/**
 * The day engine: the civil-date boundary, freezes, and both recovery mechanics.
 *
 * `packages/core/src/index.ts` is owned by another P1 task; when it re-exports this
 * barrel the whole engine is reachable as `@freelingo/core`. Until then every consumer
 * imports `./day/index.js` directly.
 */
export * from './civil.js';
export * from './config.js';
export * from './dispositions.js';
export * from './freeze.js';
export * from './predicates.js';
export * from './recovery.js';
export * from './rollover.js';
export * from './session.js';
export * from './state.js';
export * from './streak.js';
export * from './totals.js';
export * from './unlived.js';
export * from './zone.js';
