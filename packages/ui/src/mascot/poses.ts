/**
 * The mascot pose registry and the renderer seam.
 *
 * D12 / deep/08 §10: poses are composited behind a `MascotRenderer` interface so a Rive
 * rig can replace the code poses later without touching a call site — and EC-PLAT-09 says
 * no `.riv` file enters this repository until the Rive editor terms are cleared, so v1
 * ships code poses only. Rive React Native drives a rig through `useRiveNumber` /
 * `useRiveTrigger` against a `ViewModelInstance`, so this interface is deliberately
 * *number + trigger* shaped: a future swap is mechanical rather than a rewrite.
 */

import { artPath } from '../assets/paths.js';

/**
 * The five poses the plan names, plus the phoenix.
 *
 * The phoenix is not a sixth mood: S075 (streak milestone, `newStreak ∈ {7, 30, 100, 365,
 * 1000}`) calls for a "phoenix-parrot pose set" and art/README.md lists it beside the five,
 * so it is authored from the same silhouette in the milestone palette. Keeping it in this
 * union means the legibility floor holds it to the same 64 px bar as the rest.
 */
export const MASCOT_POSES = ['idle', 'happy', 'sad', 'cheer', 'sleepy', 'phoenix'] as const;
export type MascotPose = (typeof MASCOT_POSES)[number];

/**
 * The two sizes every illustration must survive (deep/08 §10).
 * 64 px is the widget; 240 px is the ceremony screen.
 */
export const MASCOT_SIZES = [64, 240] as const;
export type MascotSize = (typeof MASCOT_SIZES)[number];

/** Repo-relative source of a pose. */
export function mascotSource(pose: MascotPose): string {
  return `art/mascot/parrot-${pose}.svg`;
}

/** Absolute path of a pose source. Build and test tooling only. */
export function mascotSourcePath(pose: MascotPose): string {
  return artPath(mascotSource(pose));
}

/**
 * The seam the app renders through.
 *
 * `setNumber` and `fire` are the whole surface on purpose (see the file header). A caller
 * never asks for "the sad SVG"; it sets `pose` and fires transitions, which is a contract
 * a Skia compositor and a Rive rig can both satisfy.
 */
export interface MascotRenderer {
  /**
   * Continuous inputs: `pose` (index into `MASCOT_POSES`), `outfit` (index into
   * `MASCOT_OUTFITS`), `blink`, `bounce`.
   */
  setNumber(input: MascotNumberInput, value: number): void;
  /** Discrete inputs: one-shot transitions. */
  fire(trigger: MascotTrigger): void;
}

/**
 * `outfit` is here because EC-ECO-36 / INV-ECO-31 put it here, by name.
 *
 * The edge case: "An outfit is a palette-and-accessory layer on the parrot applied
 * **inside `MascotRenderer`**, so every surface inherits it; it never touches the fixed
 * cast or baked story avatars." That is a statement about *this interface*. If the cosmetic
 * were applied by each caller, the path, the ceremony and the widget snapshot would each
 * have to remember to apply it and one of them would not — which is the bug the edge case
 * describes. One input here is the difference between a cosmetic the product owns and a
 * cosmetic every P3 call site re-implements.
 *
 * What exists now is the seam, not the catalogue: the gem-sink wardrobe is P4 art
 * (`docs/art-and-sound.md` gaps table), so `MASCOT_OUTFITS` currently holds only the
 * neutral parrot. `outfitIndex` is written so an unknown id resolves to neutral rather than
 * throwing, which is INV-ECO-31's own fallback rule ("a missing variant renders the neutral
 * pose") and EC-PLAT-10's "never an empty box".
 */
export const MASCOT_NUMBER_INPUTS = ['pose', 'outfit', 'blink', 'bounce'] as const;
export type MascotNumberInput = (typeof MASCOT_NUMBER_INPUTS)[number];

/**
 * The cosmetic layers a renderer can apply. Index 0 is the un-equipped parrot and is also
 * the fallback for anything not in this list.
 */
export const MASCOT_OUTFITS = ['neutral'] as const;
export type MascotOutfit = (typeof MASCOT_OUTFITS)[number];

/**
 * The index a `MascotRenderer` is given for `setNumber('outfit', …)`.
 *
 * Takes a plain string, not `MascotOutfit`, on purpose: the equipped id comes from the
 * learner's saved account state and from the widget snapshot, so it can name an outfit this
 * build does not have (an older app reading a newer snapshot, a removed cosmetic). That is
 * the case INV-ECO-31 names, and it resolves to neutral here rather than at each call site.
 */
export function outfitIndex(outfit: string): number {
  const index = (MASCOT_OUTFITS as readonly string[]).indexOf(outfit);
  return index < 0 ? 0 : index;
}

export const MASCOT_TRIGGERS = ['celebrate', 'droop', 'wake'] as const;
export type MascotTrigger = (typeof MASCOT_TRIGGERS)[number];

/** The pose index a `MascotRenderer` is given for `setNumber('pose', …)`. */
export function poseIndex(pose: MascotPose): number {
  return MASCOT_POSES.indexOf(pose);
}
