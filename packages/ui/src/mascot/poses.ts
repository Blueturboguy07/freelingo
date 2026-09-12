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
  /** Continuous inputs: `pose` (index into `MASCOT_POSES`), `blink`, `bounce`. */
  setNumber(input: MascotNumberInput, value: number): void;
  /** Discrete inputs: one-shot transitions. */
  fire(trigger: MascotTrigger): void;
}

export const MASCOT_NUMBER_INPUTS = ['pose', 'blink', 'bounce'] as const;
export type MascotNumberInput = (typeof MASCOT_NUMBER_INPUTS)[number];

export const MASCOT_TRIGGERS = ['celebrate', 'droop', 'wake'] as const;
export type MascotTrigger = (typeof MASCOT_TRIGGERS)[number];

/** The pose index a `MascotRenderer` is given for `setNumber('pose', …)`. */
export function poseIndex(pose: MascotPose): number {
  return MASCOT_POSES.indexOf(pose);
}
