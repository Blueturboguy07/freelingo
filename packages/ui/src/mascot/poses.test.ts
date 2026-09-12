/**
 * The `MascotRenderer` seam.
 *
 * This file owns no invariant id — `docs/owned/art.json` says why — but the seam it tests
 * is named by an edge case that belongs to another lane, and naming it here is the point:
 * EC-ECO-36 (→ INV-ECO-31) says a cosmetic outfit is "a palette-and-accessory layer on the
 * parrot applied **inside `MascotRenderer`**, so every surface inherits it". The economy
 * lane owns whether an outfit is equipped; this lane owns whether the renderer interface
 * can express one at all. It could not, until the `outfit` input was added — the seam
 * shipped with `pose`, `blink` and `bounce` only, so every P3 call site would have had to
 * apply the cosmetic itself, which is exactly the bug the edge case describes.
 *
 * No `[INV-ECO-31]` in a test name here on purpose: the id is the economy lane's to own
 * with a property over equip/unequip and the widget snapshot, and claiming it from an
 * interface-shape test would report it as covered when the behaviour is not written yet.
 */

import { describe, expect, it } from 'vitest';
import {
  MASCOT_NUMBER_INPUTS,
  MASCOT_OUTFITS,
  MASCOT_POSES,
  MASCOT_SIZES,
  MASCOT_TRIGGERS,
  outfitIndex,
  poseIndex,
} from './poses.js';

describe('the mascot renderer seam', () => {
  it('can express a cosmetic outfit (EC-ECO-36)', () => {
    expect(MASCOT_NUMBER_INPUTS).toContain('outfit');
  });

  it('resolves an unknown outfit to the neutral layer rather than throwing (EC-ECO-36)', () => {
    // The equipped id arrives from saved account state and from the widget snapshot, so it
    // can name a cosmetic this build does not have. EC-ECO-36: "a missing variant falls
    // back to the neutral pose (EC-PLAT-10), never an empty box".
    expect(MASCOT_OUTFITS[0]).toBe('neutral');
    expect(outfitIndex('neutral')).toBe(0);
    expect(outfitIndex('a-cosmetic-from-a-newer-build')).toBe(0);
    expect(outfitIndex('')).toBe(0);
  });

  it('gives every pose a stable index, and the phoenix is one of them', () => {
    // The index is what a renderer is set to, so it has to be total and it has to be
    // derived from the list rather than written down twice.
    for (const [i, pose] of MASCOT_POSES.entries()) expect(poseIndex(pose)).toBe(i);
    expect(MASCOT_POSES).toContain('phoenix');
  });

  it('keeps the input surface number-and-trigger shaped', () => {
    // deep/08 §10 / D12: a Rive rig is driven through useRiveNumber / useRiveTrigger, so a
    // later swap is only mechanical if nothing here is a bitmap, a path or a colour.
    for (const input of MASCOT_NUMBER_INPUTS) expect(typeof input).toBe('string');
    for (const trigger of MASCOT_TRIGGERS) expect(typeof trigger).toBe('string');
    expect(new Set(MASCOT_NUMBER_INPUTS).size).toBe(MASCOT_NUMBER_INPUTS.length);
    expect(new Set(MASCOT_TRIGGERS).size).toBe(MASCOT_TRIGGERS.length);
  });

  it('states both sizes deep/08 §10 requires', () => {
    expect([...MASCOT_SIZES]).toEqual([64, 240]);
  });
});
