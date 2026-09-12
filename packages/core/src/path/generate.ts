/**
 * Path generation from a pack template, against the generating device's capabilities.
 *
 * INV-PATH-19 / EC-PTH-37: **every generated node has a completion path on the device
 * that generated it.** A Roleplay node on a device with no on-device model and no BYOK key
 * is a dead end in a strictly linear chain, so Roleplay generation is gated on a runtime
 * capability probe at pack-install time and the slot is rebalanced - exactly as a cut
 * Video Call slot is. The node count per unit is unchanged by the rebalance.
 *
 * INV-PACK-03 / EC-PTH-17, EC-PTH-20: the node-type registry is pack-driven. A pack
 * declaring no stories produces a path with no book nodes, section progress with no
 * stories counter, and no empty states anywhere.
 */
import type { NodeType, PackManifest, PathNode } from './types.js';
import type { DeviceCapabilities } from './registry.js';
import { canComplete, nodeTypesFor, specFor } from './registry.js';

/** One slot of a pack's unit template, before capability resolution. */
export interface NodeTemplate {
  readonly id: string;
  readonly type: NodeType;
  readonly subLessonsTotal: number;
  readonly introducesScriptUnits?: readonly string[];
  readonly requiresScriptUnits?: readonly string[];
}

/**
 * Where a cut slot goes. Ordered: the first type the pack declares AND the device can
 * complete wins. `lesson` is last because it always qualifies, so the fallback is total.
 */
const REBALANCE_ORDER: readonly NodeType[] = ['speaking', 'story', 'practice', 'lesson'];

export interface GenerationResult {
  readonly nodes: readonly PathNode[];
  /** Slots whose declared type could not be completed here, and what replaced them. */
  readonly rebalanced: readonly {
    readonly id: string;
    readonly from: NodeType;
    readonly to: NodeType;
  }[];
}

/**
 * The type this slot actually becomes, or null when nothing the pack declares can be
 * finished here.
 *
 * `canComplete` now refuses a type that declares no launchable flavour as well as one the
 * device cannot serve, so **a declared type with an empty `launchable` is never placed** -
 * it is rebalanced into something the learner can finish, exactly like a Roleplay slot on a
 * device with no model. That is the second half of INV-PATH-19: a node with no completion
 * path is as fatal to a linear chain as a node the device cannot run.
 */
function resolveType(
  type: NodeType,
  manifest: PackManifest,
  caps: DeviceCapabilities,
): NodeType | null {
  const declared = nodeTypesFor(manifest);
  if (declared.includes(type) && canComplete(type, caps) && specFor(type).placeable) return type;
  for (const candidate of REBALANCE_ORDER) {
    if (!declared.includes(candidate)) continue;
    if (!specFor(candidate).placeable) continue;
    if (canComplete(candidate, caps)) return candidate;
  }
  return null;
}

/**
 * Resolve a unit template into placed nodes. The slot count never changes: a slot that
 * cannot be resolved at all (a pack that declares nothing this device can run) is
 * reported rather than silently dropped, because a shorter unit is a content change.
 */
export function generateUnitNodes(
  template: readonly NodeTemplate[],
  unitIndex: number,
  manifest: PackManifest,
  caps: DeviceCapabilities,
): GenerationResult {
  const nodes: PathNode[] = [];
  const rebalanced: { id: string; from: NodeType; to: NodeType }[] = [];
  for (const slot of template) {
    const resolved = resolveType(slot.type, manifest, caps);
    if (resolved === null) continue;
    if (resolved !== slot.type) rebalanced.push({ id: slot.id, from: slot.type, to: resolved });
    nodes.push({
      id: slot.id,
      type: resolved,
      unitIndex,
      subLessonsDone: 0,
      subLessonsTotal: Math.max(1, slot.subLessonsTotal),
      legendary: false,
      introducesScriptUnits: slot.introducesScriptUnits ?? [],
      requiresScriptUnits: slot.requiresScriptUnits ?? [],
    });
  }
  return { nodes, rebalanced };
}

/**
 * Node ids with no completion path here: the device lacks the capability, **or** the type
 * declares no launchable flavour. INV-PATH-19 asserts this is always empty.
 */
export function uncompletableNodes(
  nodes: readonly PathNode[],
  caps: DeviceCapabilities,
): readonly string[] {
  return nodes.filter((n) => !canComplete(n.type, caps)).map((n) => n.id);
}
