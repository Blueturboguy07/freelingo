/**
 * The path chest, S016.
 *
 * `Chest` (str:1575) with action `Open chest` (str:1573); states `locked`, `unlocked`,
 * `opening`, `opened`; contents are a reward **bundle** (gems | freeze | boost), never gems
 * alone - which is why the bundle itself lives in `ceremony/bundle.ts` and this module only
 * says *that* a bundle is owed.
 *
 * Why this file exists at all: the chest is a node in the linear chain. `deep/03` §S5
 * records the 2026-09-10 capture in which the chest below the current node was unclickable
 * for the whole session, and the captured Unit 1 shape is star, star, star, **chest**,
 * star, trophy. A chest with no completion path therefore deadlocks every node after it and
 * the next unit never opens (INV-PATH-19). One tap is the completion path.
 *
 * Do **not** conflate this with the daily-goal chest, which is a ceremony card
 * (`deep/03` §S5) and has no node.
 */
import type { PathNode } from './types.js';
import { isComplete } from './nodes.js';

/** Product-map S016 states, verbatim. */
export type ChestState = 'locked' | 'unlocked' | 'opening' | 'opened';

/** `Chest` (str:1575). */
export const CHEST_LABEL = 'Chest';
/** `Open chest` (str:1573). */
export const CHEST_ACTION = 'Open chest';

/**
 * The rendered state of a chest node. `opening` is the transient animation state the
 * caller passes in; everything else is a pure function of the node and its lock state,
 * exactly like every other node's visual (INV-PATH-02).
 */
export function chestState(node: PathNode, unlocked: boolean, opening = false): ChestState {
  if (isComplete(node)) return 'opened';
  if (!unlocked) return 'locked';
  return opening ? 'opening' : 'unlocked';
}

export interface ChestOpen {
  /** The node with the chest opened. Complete, so the chain advances. */
  readonly node: PathNode;
  readonly state: ChestState;
  /**
   * A reward bundle is owed. The amount is the economy's business and the screen is
   * `ceremony/bundle.ts`'s; the path only records that opening happened.
   */
  readonly awardsBundle: boolean;
}

/**
 * Open a chest: one tap, no exercises, no failure mode. Opening an already-open chest is
 * the identity and owes nothing - a chest pays once (the same shape as every other
 * once-only affordance in this engine).
 */
export function openChest(node: PathNode): ChestOpen {
  if (node.type !== 'chest') {
    throw new Error(`openChest called on a ${node.type} node`);
  }
  if (isComplete(node)) return { node, state: 'opened', awardsBundle: false };
  return {
    node: { ...node, subLessonsDone: node.subLessonsTotal },
    state: 'opened',
    awardsBundle: true,
  };
}
