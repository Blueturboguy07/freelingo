/**
 * Level legendary, and the unit trophy.
 *
 * INV-PATH-05: the unit trophy is legendary iff **every level in the unit** is legendary.
 * INV-PATH-16 / EC-PTH-34: "every level" folds only over node types that declare a
 * LEGENDARY offer, against a **pack-declared** denominator - chest, story, radio and Unit
 * Review are excluded, and a unit with no qualifying node never awards the trophy (rather
 * than awarding it vacuously).
 * INV-PATH-25 / EC-PTH-43: the offer never fires on a script node and letters levels are
 * ignored by the denominator, or the Japanese trophy is unearnable.
 */
import type { PackManifest, PathNode, PathUnit } from './types.js';
import { specFor } from './registry.js';

/** Nodes that count toward this unit's trophy under this pack's declaration. */
export function legendaryDenominator(unit: PathUnit, manifest: PackManifest): readonly PathNode[] {
  return unit.nodes.filter((node) => {
    const spec = specFor(node.type);
    if (!spec.offersLegendary) return false; // letters, chest, radio, unitReview, ...
    return manifest.legendaryDenominator.includes(node.type);
  });
}

/** May the LEGENDARY offer fire on this node at all? Never on a script node. */
export function offersLegendary(node: PathNode): boolean {
  return specFor(node.type).offersLegendary;
}

/**
 * The unit trophy's legendary state. `false` for an empty denominator: a unit whose only
 * legendary-capable content the pack excluded must not hand out a free trophy.
 */
export function unitTrophyLegendary(unit: PathUnit, manifest: PackManifest): boolean {
  const denominator = legendaryDenominator(unit, manifest);
  if (denominator.length === 0) return false;
  return denominator.every((node) => node.legendary);
}

/** The trophy is gold applied to the existing Unit Review node, never a seventh node. */
export function trophyNodeOf(unit: PathUnit): PathNode | null {
  return unit.nodes.find((n) => n.type === 'unitReview') ?? null;
}
