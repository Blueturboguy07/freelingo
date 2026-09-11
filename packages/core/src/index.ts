/**
 * @freelingo/core — the pure learning engine.
 *
 * Rule: this package never imports React, React Native or Expo. The app renders
 * engine output and forwards taps; it never computes a rule.
 * Enforced by eslint (`no-restricted-imports`) and by `src/purity.test.ts`.
 */
export * from './day/civil.js';
export * from './day/streak.js';
export * from './ceremony/commit.js';
