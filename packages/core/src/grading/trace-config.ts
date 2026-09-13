/** Freelingo trace policy, 2026-09-13. deep01 S11 mandates count/order/direction/endpoints.
 * These normalized tolerances are implementation choices, not measured Duolingo values.
 * Geometry is supplied by the active pack; no character or language fallback exists. */
export const TRACE_POLICY = Object.freeze({
  samples: 32,
  endpointDiagonalFraction: 0.12,
  meanDiagonalFraction: 0.08,
  maximumDiagonalFraction: 0.2,
  minimumLengthDiagonalFraction: 0.015,
  maximumInputPoints: 4096,
  maximumStrokes: 64,
});
