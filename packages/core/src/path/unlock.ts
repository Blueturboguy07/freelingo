/**
 * Unlock rules, the jump-here overlay, and the serpentine layout.
 *
 * INV-PATH-01 / ruling EC-PTH-21: node unlock is strictly linear within a unit
 * (`unlocked(n) <=> complete(n-1)`), and **unit n+1 unlocks only when the LAST node of
 * unit n is complete** - there is no early unlock on the first level. `deep/03`'s rules
 * table carried both rules; they cannot both hold, and the capture backs this one (every
 * downstream node grey, the chest unclickable for a whole session). The only attested
 * early path is `Jump here?`.
 *
 * INV-PATH-13: a jump-here node exists **iff** its target unit is locked, and the rendered
 * offsets of every node below are byte-identical before and after its removal - which is
 * why the overlay is computed here and never stored, and why `serpentineOffsets` folds
 * over placed nodes only.
 *
 * INV-PATH-23: no placed node points backwards.
 * INV-PATH-26: no unintroduced script unit appears in a served item after a placement or
 * a passed jump-here.
 */
import type { PathModel, PathNode, PathUnit } from './types.js';
import { allUnits, NEVER_PLACED } from './types.js';
import { isComplete } from './nodes.js';
import { specFor } from './registry.js';

/* -------------------------------------------------------------- unit unlocking */

/** Every node of the unit is complete. Drives the section fraction (INV-PATH-20). */
export function unitCompleted(unit: PathUnit): boolean {
  return unit.nodes.length > 0 && unit.nodes.every(isComplete);
}

/**
 * The unit's LAST node is complete, so the next unit may open (ruling EC-PTH-21).
 *
 * Kept separate from `unitCompleted` on purpose (EC-PTH-38): a unit reached by a passed
 * jump-here is advanced past without being completed, and a section that counted those
 * would read 100% with an unearned trophy.
 */
export function unitAdvanced(unit: PathUnit): boolean {
  const last = unit.nodes[unit.nodes.length - 1];
  return last !== undefined && isComplete(last);
}

/** Is unit `index` (absolute, across the course) open to the learner? */
export function unitUnlockedIgnoringScript(model: PathModel, index: number): boolean {
  if (index <= 0) return true;
  if (model.jumpUnlockedUnits.includes(index)) return true;
  const previous = allUnits(model)[index - 1];
  return previous !== undefined && unitAdvanced(previous);
}

/** Public name for the unit gate. Script prerequisites gate nodes, not units. */
export const unitUnlocked = unitUnlockedIgnoringScript;

/* -------------------------------------------------------------- node unlocking */

/**
 * `unlocked(n) <=> complete(n-1)`, with node 0 gated on the unit (INV-PATH-01), and one
 * further gate that no jump can lift: a node whose items need a script unit the learner
 * has not met is not served until the letters prefix is done (INV-PATH-26).
 */
export function nodeUnlocked(model: PathModel, unitIndex: number, nodeIndex: number): boolean {
  const unit = allUnits(model)[unitIndex];
  const node = unit?.nodes[nodeIndex];
  if (node === undefined) return false;
  if (!scriptPrerequisitesMet(model, node)) return false;
  if (!unitUnlockedIgnoringScript(model, unitIndex)) {
    // A letters node forced in front of an unlocked unit is playable even though its own
    // unit is not (EC-PTH-44: an unlocked required prefix at the target unit).
    return node.type === 'letters' && scriptPrefixIds(model).has(node.id);
  }
  if (nodeIndex <= 0) return true;
  const previous = unit?.nodes[nodeIndex - 1];
  return previous !== undefined && isComplete(previous);
}

/** Does the learner know every script unit this node's items require? */
export function scriptPrerequisitesMet(model: PathModel, node: PathNode): boolean {
  if (node.requiresScriptUnits.length === 0) return true;
  const known = scriptUnitsKnown(model);
  return node.requiresScriptUnits.every((s) => known.has(s));
}

/* ----------------------------------------------------------- jump-here overlay */

export type JumpTargetKind = 'unit' | 'section';

export interface JumpHereOverlay {
  readonly targetUnitIndex: number;
  readonly kind: JumpTargetKind;
  /** `Pass this test to jump ahead to Unit {{n}}!` / `... to {{section_name}}!` */
  readonly copy: string;
  /** The launched flavour. A section boundary resolves to `sectionTest` (EC-PTH-35). */
  readonly flavour: 'jumpHere' | 'sectionTest';
}

/**
 * The jump-here overlays for a model.
 *
 * Existence rule (INV-PATH-13): one overlay per locked unit that heads a section, or that
 * is the next locked unit after the frontier. EC-PTH-26: the overlay disappears the
 * instant its target unlocks by progression - which falls out of "iff its target unit is
 * locked".
 */
export function jumpHereOverlays(model: PathModel): readonly JumpHereOverlay[] {
  const units = allUnits(model);
  const out: JumpHereOverlay[] = [];
  let absolute = 0;
  for (const section of model.sections) {
    for (let u = 0; u < section.units.length; u += 1) {
      const index = absolute + u;
      if (index === 0) continue;
      if (unitUnlocked(model, index)) continue;
      const isSectionHead = u === 0;
      const unit = units[index];
      if (unit === undefined) continue;
      out.push({
        targetUnitIndex: index,
        kind: isSectionHead ? 'section' : 'unit',
        copy: isSectionHead
          ? `Pass this test to jump ahead to ${section.title}!`
          : `Pass this test to jump ahead to Unit ${index + 1}!`,
        flavour: isSectionHead ? 'sectionTest' : 'jumpHere',
      });
    }
    absolute += section.units.length;
  }
  return out;
}

/* -------------------------------------------------------------------- layout */

/**
 * Serpentine x-offsets in CSS px from the canvas centre, product map S010 (offsets
 * `0, +/-45, +/-70`, pitch ~94). The cycle is a property of the node's index among the
 * unit's **placed** nodes, so adding or removing a jump-here overlay cannot re-flow it.
 */
export const SERPENTINE_OFFSETS: readonly number[] = [0, -45, -70, -45, 0, 45, 70, 45];
export const NODE_PITCH_CSS_PX = 94;

export interface PlacedOffset {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
}

export function serpentineOffsets(nodes: readonly PathNode[]): readonly PlacedOffset[] {
  return nodes.map((node, i) => ({
    nodeId: node.id,
    x: SERPENTINE_OFFSETS[i % SERPENTINE_OFFSETS.length] ?? 0,
    y: i * NODE_PITCH_CSS_PX,
  }));
}

/* --------------------------------------------------------- placement integrity */

export interface PlacementViolation {
  readonly nodeId: string;
  readonly reason: 'backwards' | 'never-placed' | 'not-placeable' | 'cannot-head-unit';
}

/**
 * INV-PATH-23: no placed node points backwards. A node's `unitIndex` must equal the unit
 * that holds it, and no type on the never-placed list (Unit Rewind's would-be slot, the
 * jump-here overlay) may appear as a stored node.
 */
export function placementViolations(model: PathModel): readonly PlacementViolation[] {
  const out: PlacementViolation[] = [];
  const units = allUnits(model);
  for (let u = 0; u < units.length; u += 1) {
    const unit = units[u];
    if (unit === undefined) continue;
    for (const node of unit.nodes) {
      if (node.unitIndex !== u) out.push({ nodeId: node.id, reason: 'backwards' });
      if (NEVER_PLACED.includes(node.type)) out.push({ nodeId: node.id, reason: 'never-placed' });
      else if (!specFor(node.type).placeable)
        out.push({ nodeId: node.id, reason: 'not-placeable' });
      if (node === unit.nodes[0] && !specFor(node.type).canHeadUnit) {
        out.push({ nodeId: node.id, reason: 'cannot-head-unit' });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------ script prerequisites */

/**
 * Script units the learner has actually met: those introduced by a **completed** letters
 * node, plus anything an import seeded. Never anything a jump "granted" - spoken ability
 * is orthogonal to reading, and the self-report ladder asks only about speaking
 * (EC-PTH-44).
 */
export function scriptUnitsKnown(model: PathModel): ReadonlySet<string> {
  const known = new Set(model.introducedScriptUnits);
  for (const unit of allUnits(model)) {
    for (const node of unit.nodes) {
      if (node.type !== 'letters') continue;
      if (!isComplete(node)) continue;
      for (const s of node.introducesScriptUnits) known.add(s);
    }
  }
  return known;
}

/**
 * The letters nodes that must be prepended, unlocked and required, in front of
 * `targetUnitIndex`: every letters node at or before the target that introduces a script
 * unit the target's own items need and the learner has not met.
 */
export function scriptPrefixFor(model: PathModel, targetUnitIndex: number): readonly PathNode[] {
  const known = scriptUnitsKnown(model);
  const units = allUnits(model);
  const needed = new Set<string>();
  for (let u = 0; u <= targetUnitIndex && u < units.length; u += 1) {
    for (const node of units[u]?.nodes ?? []) {
      for (const s of node.requiresScriptUnits) if (!known.has(s)) needed.add(s);
    }
  }
  if (needed.size === 0) return [];
  const out: PathNode[] = [];
  for (let u = 0; u <= targetUnitIndex && u < units.length; u += 1) {
    for (const node of units[u]?.nodes ?? []) {
      if (node.type !== 'letters' || isComplete(node)) continue;
      if (node.introducesScriptUnits.some((s) => needed.has(s))) out.push(node);
    }
  }
  return out;
}

/**
 * Node ids of every letters node forced in front of an unlocked unit right now.
 *
 * Memoised per model: `nodeUnlocked` is called once per node and this is O(units x nodes),
 * which turns a 10,000-case property into a cubic one. Models are immutable, so a WeakMap
 * keyed by the model is sound and collects itself.
 */
const PREFIX_CACHE = new WeakMap<PathModel, ReadonlySet<string>>();

function scriptPrefixIds(model: PathModel): ReadonlySet<string> {
  const cached = PREFIX_CACHE.get(model);
  if (cached !== undefined) return cached;
  const ids = new Set<string>();
  const units = allUnits(model);
  for (let u = 0; u < units.length; u += 1) {
    if (!unitUnlockedIgnoringScript(model, u)) continue;
    for (const node of scriptPrefixFor(model, u)) ids.add(node.id);
  }
  PREFIX_CACHE.set(model, ids);
  return ids;
}

/**
 * The nodes the learner can play right now. INV-PATH-26 asks what these *serve*: after
 * any placement or passed jump-here the set of unintroduced script units appearing in a
 * served item must be empty.
 */
export function servedNodes(model: PathModel): readonly PathNode[] {
  const units = allUnits(model);
  const out: PathNode[] = [];
  for (let u = 0; u < units.length; u += 1) {
    for (let n = 0; n < (units[u]?.nodes.length ?? 0); n += 1) {
      const node = units[u]?.nodes[n];
      if (node === undefined) continue;
      if (nodeUnlocked(model, u, n)) out.push(node);
    }
  }
  return out;
}

/** Script units a currently-served item needs that the learner has not met. */
export function unintroducedScriptUnitsInServedItems(model: PathModel): readonly string[] {
  const known = scriptUnitsKnown(model);
  const missing = new Set<string>();
  for (const node of servedNodes(model)) {
    for (const s of node.requiresScriptUnits) if (!known.has(s)) missing.add(s);
  }
  return [...missing].sort();
}

/**
 * Every incomplete letters node can still be reached by playing forward.
 *
 * "Reachable" is checked against the model in which every node strictly before it is
 * complete: that is what linear progression delivers. A letters node that is still locked
 * there is **stranded** - the only way to produce one is content that requires a script
 * unit before the node that introduces it, which is a `coursekit` G3b error, or an unlock
 * rule that lets a jump bypass the prefix, which is the bug INV-PATH-26 is about.
 */
export function lettersNodesReachable(model: PathModel): boolean {
  const units = allUnits(model);
  const order: { u: number; n: number; node: PathNode }[] = [];
  for (let u = 0; u < units.length; u += 1) {
    const unit = units[u];
    if (unit === undefined) continue;
    for (let n = 0; n < unit.nodes.length; n += 1) {
      const node = unit.nodes[n];
      if (node !== undefined) order.push({ u, n, node });
    }
  }
  for (let i = 0; i < order.length; i += 1) {
    const here = order[i];
    if (here === undefined || here.node.type !== 'letters' || isComplete(here.node)) continue;
    const completedBefore: PathModel = {
      ...model,
      sections: model.sections.map((section) => ({
        ...section,
        units: section.units.map((unit) => ({
          ...unit,
          nodes: unit.nodes.map((node) => {
            const at = order.findIndex((o) => o.node.id === node.id);
            return at >= 0 && at < i ? { ...node, subLessonsDone: node.subLessonsTotal } : node;
          }),
        })),
      })),
    };
    if (!nodeUnlocked(completedBefore, here.u, here.n)) return false;
  }
  return true;
}

/**
 * Apply a passed jump-here (or placement): the target unit unlocks and **nothing else
 * changes**. The script prefix is not "granted" - it stays required, and `nodeUnlocked`
 * keeps the target's items unserved until the prefix is done.
 */
export function applyJump(model: PathModel, targetUnitIndex: number): PathModel {
  if (model.jumpUnlockedUnits.includes(targetUnitIndex)) return model;
  return {
    ...model,
    jumpUnlockedUnits: [...model.jumpUnlockedUnits, targetUnitIndex].sort((a, b) => a - b),
  };
}
