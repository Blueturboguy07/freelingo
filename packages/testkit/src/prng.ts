/**
 * The seeded deterministic PRNG, shared with the engine.
 *
 * Re-exported from `packages/core` rather than re-implemented. INV-ECO-11 says the day's
 * quests are a pure function of `(local_day, seed)`; a test that checked that against a
 * SECOND implementation of the same generator would be checking that two coincidences
 * agree. One PRNG, one spelling.
 *
 * The relative path is deliberate: the core barrel does not re-export `economy/` yet (it
 * is outside this task's file lane), and one line of barrel wiring makes this a package
 * import later.
 */
export { seededPrng, hashSeed, type SeededPrng } from '../../core/src/economy/prng.js';
