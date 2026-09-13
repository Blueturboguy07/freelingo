/** Tooling entry point. Runtime callers use model/composite, which import no Node APIs. */
import { artPath } from '../assets/paths.js';
import { mascotSource } from './model.js';
import type { MascotPose } from './model.js';
export * from './model.js';
export function mascotSourcePath(pose: MascotPose): string {
  return artPath(mascotSource(pose));
}
