/**
 * "Can this learner extend their streak right now?"
 *
 * INV-PATH-15 / EC-PTH-33: from every reachable path state and every goal tier, a
 * streak-extending session no longer than that tier's exercise budget is reachable in
 * <= 2 taps, or the blocking node exposes a defer control. The named falsifier is a
 * Casual learner whose only unplayed node is a 15-exercise Unit Review.
 *
 * Two taps is the real budget: tap the node, tap the button in its popup.
 *
 * NOTE ON OWNERSHIP: the authoritative goal-tier table is `packages/core/economy`, owned
 * by the P1 economy task. The numbers below are that ruling (EC-ECO-01: 10/20/30/50 XP for
 * Casual/Regular/Serious/Intense) expressed as the *exercise* budget the reachability
 * property needs, and must be replaced by an import at integration.
 */
import type { LaunchFlavour, PathModel, PathNode } from './types.js';
import { allUnits } from './types.js';
import { isComplete } from './nodes.js';
import { nodeUnlocked } from './unlock.js';
import { specFor } from './registry.js';

export const GOAL_TIERS = ['casual', 'regular', 'serious', 'intense'] as const;
export type GoalTier = (typeof GOAL_TIERS)[number];

/** XP goal per tier (ruling EC-ECO-01). */
export const GOAL_XP: Readonly<Record<GoalTier, number>> = {
  casual: 10,
  regular: 20,
  serious: 30,
  intense: 50,
};

/**
 * Exercises a learner on this tier has signed up for in one sitting. A ~13 XP lesson of
 * 9-14 exercises clears the Casual goal, so Casual's budget is one lesson.
 */
export const EXERCISE_BUDGET: Readonly<Record<GoalTier, number>> = {
  casual: 14,
  regular: 28,
  serious: 42,
  intense: 70,
};

/** Longest a Unit Review may be before it is sized down (`deep/01` S063 says 15). */
export const UNIT_REVIEW_MAX_EXERCISES = 15;
/** Node practice, S058: 11 exercises. */
export const PRACTICE_MAX_EXERCISES = 11;

/**
 * Session length for a flavour at a tier. Unit Review and practice are **sized from the
 * stored daily goal**, not flat - that is the fix EC-PTH-33 asks for.
 */
export function sessionLength(
  flavour: LaunchFlavour,
  tier: GoalTier,
  contentLength: number,
): number {
  const budget = EXERCISE_BUDGET[tier];
  switch (flavour) {
    case 'unitReview':
      return Math.min(UNIT_REVIEW_MAX_EXERCISES, budget);
    case 'practice':
    case 'dailyRefresh':
    case 'endgame':
      return Math.min(PRACTICE_MAX_EXERCISES, budget);
    default:
      return contentLength;
  }
}

/** Flavours that satisfy the day. A failed test flavour does not (EC-PTH-32). */
export const STREAK_EXTENDING: readonly LaunchFlavour[] = [
  'lesson',
  'practice',
  'legendary',
  'placement',
  'unitReview',
  'dailyRefresh',
  'recovery',
  'endgame',
  'story',
  'radio',
  'speaking',
  'roleplay',
  'letters',
];

export interface Route {
  readonly nodeId: string;
  readonly flavour: LaunchFlavour;
  readonly taps: number;
  readonly exercises: number;
  readonly streakExtending: boolean;
}

/** Every node the learner can start right now, with the sessions it can launch. */
export function routesFrom(model: PathModel, tier: GoalTier, contentLength = 12): readonly Route[] {
  const out: Route[] = [];
  const units = allUnits(model);
  for (let u = 0; u < units.length; u += 1) {
    const unit = units[u];
    if (unit === undefined) continue;
    for (let n = 0; n < unit.nodes.length; n += 1) {
      const node = unit.nodes[n];
      if (node === undefined) continue;
      if (!nodeUnlocked(model, u, n)) continue;
      const spec = specFor(node.type);
      const flavours = isComplete(node)
        ? spec.completedButtons.map((b) => b.flavour)
        : spec.launchable.slice(0, 1);
      for (const flavour of flavours) {
        out.push({
          nodeId: node.id,
          flavour,
          taps: 2,
          exercises: sessionLength(flavour, tier, contentLength),
          streakExtending: STREAK_EXTENDING.includes(flavour),
        });
      }
    }
  }
  return out;
}

/** A node that blocks the frontier must say so; the defer control is its escape hatch. */
export function exposesDeferControl(node: PathNode): boolean {
  // Unit Review is the one node type a learner can be parked in front of with nothing
  // shorter left, so it always carries `LATER` (EC-PTH-33).
  return node.type === 'unitReview';
}

export interface ReachabilityVerdict {
  readonly ok: boolean;
  readonly route: Route | null;
  readonly blockingNodeId: string | null;
}

/** The invariant, as a function: is a short streak-extending session two taps away? */
export function shortRouteFor(
  model: PathModel,
  tier: GoalTier,
  contentLength = 12,
): ReachabilityVerdict {
  const routes = routesFrom(model, tier, contentLength);
  const budget = EXERCISE_BUDGET[tier];
  const fitting = routes.find((r) => r.streakExtending && r.taps <= 2 && r.exercises <= budget);
  if (fitting !== undefined) return { ok: true, route: fitting, blockingNodeId: null };
  const units = allUnits(model);
  for (let u = 0; u < units.length; u += 1) {
    const unit = units[u];
    if (unit === undefined) continue;
    for (let n = 0; n < unit.nodes.length; n += 1) {
      const node = unit.nodes[n];
      if (node === undefined || !nodeUnlocked(model, u, n) || isComplete(node)) continue;
      return { ok: exposesDeferControl(node), route: null, blockingNodeId: node.id };
    }
  }
  return { ok: false, route: null, blockingNodeId: null };
}
