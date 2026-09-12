/**
 * The due-backlog rule (INV-SCH-04).
 *
 * "When `due_items > k x session_length` on course re-entry, the node popup surfaces a
 * review session first AND THE LESSON NODE'S GENERATED CONTENTS ARE BYTE-IDENTICAL to what
 * they would have been otherwise."
 *
 * The second half is the whole invariant. Offering a review first is a routing decision;
 * the failure it guards against is the routing decision reaching into the node generator
 * and quietly changing the lesson — dropping the items the review is about, re-weighting
 * by due-ness, shortening it. The learner then gets a different lesson depending on how
 * long they were away, the path stops being a fixed curriculum, and nothing on screen says
 * so.
 *
 * It is made true by construction rather than by care: `generateNodeContents` takes the
 * node spec and NOTHING else. It cannot see the backlog, the clock, the FSRS rows or the
 * pool, so there is no channel through which the backlog could reach it. The property then
 * checks the construction held, by serialising the node in both branches and comparing the
 * two strings byte for byte.
 */
import { DUE_BACKLOG_SESSION_MULTIPLIER } from './config.js';
import type { FsrsRow } from './fsrs.js';
import type { ItemId } from './types.js';

/** What a path node declares, as the pack ships it. Fixed content, fixed order. */
export interface NodeSpec {
  readonly nodeId: string;
  /** The node's items in curriculum order. The pack's decision, not the scheduler's. */
  readonly itemIds: readonly ItemId[];
  /** How many exercises this node generates. */
  readonly length: number;
}

export interface NodeContents {
  readonly nodeId: string;
  readonly itemIds: readonly ItemId[];
}

/**
 * The node's generated contents.
 *
 * Deliberately a pure function of the spec alone — no clock, no scheduler state, no
 * randomness. Every argument it does not take is an argument that cannot make the lesson
 * depend on the learner's backlog.
 *
 * Cycling the item list when the node is longer than its item list (rather than sampling)
 * keeps it deterministic and keeps every item of the node represented.
 */
export function generateNodeContents(node: NodeSpec): NodeContents {
  const length = Math.max(0, Math.floor(node.length));
  const source = node.itemIds;
  if (source.length === 0) return { nodeId: node.nodeId, itemIds: [] };
  const itemIds: ItemId[] = [];
  for (let i = 0; i < length; i += 1) itemIds.push(source[i % source.length]!);
  return { nodeId: node.nodeId, itemIds };
}

/** `due_items > k x session_length`. */
export function dueBacklogExceeded(
  dueItems: number,
  sessionLength: number,
  multiplier: number = DUE_BACKLOG_SESSION_MULTIPLIER,
): boolean {
  return dueItems > multiplier * sessionLength;
}

export interface CourseReentryPlan {
  /** Whether the node popup offers a review session before the lesson (S092, S064). */
  readonly surfaceReviewFirst: boolean;
  /** The review slice to offer when it does. Empty otherwise. */
  readonly reviewRows: readonly FsrsRow[];
  /** The lesson the node will run. IDENTICAL in both branches. */
  readonly node: NodeContents;
  readonly dueItems: number;
}

export interface CourseReentryInput {
  readonly node: NodeSpec;
  /** Rows the endgame/pool logic says are servable right now, most overdue first. */
  readonly dueRows: readonly FsrsRow[];
  readonly sessionLength: number;
  readonly multiplier?: number;
}

/**
 * The node popup's plan on course re-entry.
 *
 * `node` is computed FIRST and unconditionally, before anything looks at the backlog, so
 * that the two branches share one call rather than two lookalike ones. Two call sites that
 * happen to agree today is how this invariant breaks in six months.
 */
export function planCourseReentry(input: CourseReentryInput): CourseReentryPlan {
  const node = generateNodeContents(input.node);

  const dueItems = input.dueRows.length;
  const exceeded = dueBacklogExceeded(dueItems, input.sessionLength, input.multiplier);
  const take = Math.max(1, Math.floor(input.sessionLength));
  return {
    surfaceReviewFirst: exceeded,
    reviewRows: exceeded ? input.dueRows.slice(0, take) : [],
    node,
    dueItems,
  };
}
