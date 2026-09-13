import { describe, expect, it } from 'vitest';
import {
  isSessionModalityState,
  emptySessionModality,
  acceptsSpeechAmplitude,
  MODALITY_POLICY,
} from './index.js';
describe('durable modality observations', () => {
  it.each(['observations', 'blockedFamilies', 'unavailableSlotIds'])(
    '[INV-SESS-01] rejects a sparse %s array at the shared unknown-value boundary',
    (key) => {
      expect(isSessionModalityState({ ...emptySessionModality(), [key]: Array(1) })).toBe(false);
    },
  );
  it('[INV-SESS-01] rejects malformed present records and duplicate observation IDs', () => {
    const base = emptySessionModality();
    expect(isSessionModalityState(base)).toBe(true);
    const observation = {
      id: 'request-1',
      slotId: 'slot-1',
      itemId: 'item-1',
      family: 'speaking',
      reviewKind: 'no_audio',
    };
    const valid = { ...base, observations: [observation] };
    expect(isSessionModalityState(valid)).toBe(true);
    for (const value of [
      null,
      {},
      { ...base, blockedFamilies: ['camera'] },
      { ...valid, observations: [observation, observation] },
      { ...valid, observations: [{ ...observation, reviewKind: 'wrong' }] },
      { ...base, unavailableSlotIds: [9] },
      { ...base, ignored: true },
    ])
      expect(isSessionModalityState(value)).toBe(false);
  });
  it('[INV-MOD-09] amplitude floor has exact inclusive boundary and nonfinite/out-of-range values are silent', () => {
    expect(acceptsSpeechAmplitude(MODALITY_POLICY.amplitudeFloor)).toBe(true);
    expect(acceptsSpeechAmplitude(MODALITY_POLICY.amplitudeFloor - Number.EPSILON)).toBe(false);
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.01])
      expect(acceptsSpeechAmplitude(value)).toBe(false);
    expect(acceptsSpeechAmplitude(1)).toBe(true);
  });
});
