import { describe, expect, it } from 'vitest';
import { BUTTON, COLOR, REFERENCE_VIEWPORT, TYPE } from './index.js';

describe('tokens', () => {
  it('keeps the measured 4 px lip and the label-button role', () => {
    expect(BUTTON.lipHeightPx).toBe(4);
    expect(TYPE.labelButton).toEqual({ fontSizePx: 15, fontWeight: 700, letterSpacingPx: 0.8 });
  });

  it('keeps the brand green and its lip', () => {
    expect(COLOR.owl).toBe('#58CC02');
    expect(COLOR.owlLip).toBe('#58A700');
  });

  it('pins the reference viewport used by every curated parity frame', () => {
    expect(REFERENCE_VIEWPORT).toEqual({ widthCssPx: 614, heightCssPx: 811, dpr: 2 });
  });
});
