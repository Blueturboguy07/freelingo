/** Founder ruling, 2026-09-13; deep/01, deep/07 and INV-MOD-01.
 * Account-wide snoozes last at most 60 real minutes. This is product policy,
 * not a sampled A/B visual measurement. */
export const SUSPENSION_MS = 60 * 60 * 1000;

/** 2026-09-13, EC-MOD-20 and EC-MOD-23: three silent attempts / two transient failures.
 * The normalized peak-amplitude floor is conservative implementation policy, not
 * a Duolingo measurement; the native port supplies amplitude in [0,1]. */
export const MODALITY_POLICY = {
  amplitudeFloor: 0.01,
  noAudioBeforeConversion: 3,
  transientBeforeReplacement: 2,
} as const;
