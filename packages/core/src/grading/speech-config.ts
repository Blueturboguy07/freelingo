/** Freelingo policy, 2026-09-13; deep/01 S10 + founder EC-MOD-27.
 * The 0.7 threshold is not a measured Duolingo constant. Punctuation/fillers remain
 * explicit course data; this config supplies neither lexical forms nor readings.
 */
export const SPEECH_GRADING_CONFIG = Object.freeze({
  schemaVersion: 1,
  algorithm: 'stored-unit-f1-v1',
  threshold: 0.7,
  fallback: 'normalized-levenshtein-v1',
  fallbackThreshold: 0.7,
} as const);
