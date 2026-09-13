import type { ModalityFamily } from './suspension.js';
import { MODALITY_POLICY } from './config.js';
export const MODALITY_REVIEW_KINDS = [
  'no_audio',
  'transient',
  'interrupted',
  'permission_denied',
  'skipped',
  'speech_received',
  'pronunciation_failure',
  'speech_ungraded',
] as const;
export type ModalityReviewKind = (typeof MODALITY_REVIEW_KINDS)[number];
export interface ModalityObservation {
  readonly id: string;
  readonly slotId: string;
  readonly itemId: string;
  readonly family: ModalityFamily;
  readonly reviewKind: ModalityReviewKind;
}
/** Session-wide observations are separate from completed answers and per-item input.
 * They survive item changes and process kills without changing scoring or progress. */
export interface SessionModalityState {
  readonly observations: readonly ModalityObservation[];
  readonly blockedFamilies: readonly ModalityFamily[];
  readonly unavailableSlotIds: readonly string[];
}
export function emptySessionModality(): SessionModalityState {
  return { observations: [], blockedFamilies: [], unavailableSlotIds: [] };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return (
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
  );
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function family(value: unknown): value is ModalityFamily {
  return value === 'listening' || value === 'speaking';
}
function observation(value: unknown): value is ModalityObservation {
  return (
    record(value) &&
    keys(value, ['id', 'slotId', 'itemId', 'family', 'reviewKind']) &&
    text(value['id']) &&
    text(value['slotId']) &&
    text(value['itemId']) &&
    family(value['family']) &&
    MODALITY_REVIEW_KINDS.some((kind) => kind === value['reviewKind']) &&
    (value['family'] === 'speaking' || value['reviewKind'] === 'skipped')
  );
}
/** Strict present-value boundary. Only the host codec may migrate an absent legacy field. */
export function isSessionModalityState(value: unknown): value is SessionModalityState {
  if (!record(value) || !keys(value, ['observations', 'blockedFamilies', 'unavailableSlotIds']))
    return false;
  const observations = value['observations'],
    families = value['blockedFamilies'],
    slots = value['unavailableSlotIds'];
  return (
    Array.isArray(observations) &&
    Array.from(observations).every(observation) &&
    new Set(observations.map((row) => row.id)).size === observations.length &&
    Array.isArray(families) &&
    Array.from(families).every(family) &&
    new Set(families).size === families.length &&
    Array.isArray(slots) &&
    Array.from(slots).every(text) &&
    new Set(slots).size === slots.length
  );
}
export function acceptsSpeechAmplitude(amplitude: number): boolean {
  return (
    Number.isFinite(amplitude) && amplitude >= MODALITY_POLICY.amplitudeFloor && amplitude <= 1
  );
}
