/**
 * Node visual state and the node popup.
 *
 * INV-PATH-02: visual state is a pure function of `(sub_lessons_done, sub_lessons_total,
 * legendary)` - no timer, no decay, no server input. That is why `nodeVisual` takes
 * exactly one argument and this whole directory is forbidden a clock
 * (`purity-path.test.ts` greps for it).
 *
 * INV-PATH-03: a complete node's popup exposes Practice and (if eligible) Legendary, and
 * never a sub-lesson counter or START.
 * INV-PATH-18: every node type declares a completed-popup shape whose buttons map only to
 * flavours that node can launch.
 */
import type { NodeType, PathNode } from './types.js';
import type { PopupButton } from './registry.js';
import { specFor } from './registry.js';

/** The three progress states of a node, plus the gold legendary state. */
export type NodeVisualState = 'not-started' | 'in-progress' | 'complete' | 'legendary';

export interface NodeProgress {
  readonly subLessonsDone: number;
  readonly subLessonsTotal: number;
  readonly legendary: boolean;
}

export interface NodeVisual {
  readonly state: NodeVisualState;
  /** Ring fill, 0..1. The ring shows sub-lessons *within this node* (`deep/03` §S1.4). */
  readonly ringFraction: number;
  /** A complete node loses its ring entirely (`screens/deep/083`). */
  readonly showsRing: boolean;
  /** Solid green + white check (EC-PTH-02). */
  readonly showsCheck: boolean;
  /** Gold is the legendary state, never the complete state (`Legendary is now Gold!`). */
  readonly gold: boolean;
}

export function nodeVisual(progress: NodeProgress): NodeVisual {
  const total = Math.max(1, Math.trunc(progress.subLessonsTotal));
  const done = Math.min(total, Math.max(0, Math.trunc(progress.subLessonsDone)));
  const complete = done >= total;
  const state: NodeVisualState = progress.legendary
    ? 'legendary'
    : complete
      ? 'complete'
      : done === 0
        ? 'not-started'
        : 'in-progress';
  return {
    state,
    ringFraction: complete ? 1 : done / total,
    showsRing: !complete,
    showsCheck: complete,
    gold: progress.legendary,
  };
}

export function progressOf(node: PathNode): NodeProgress {
  return {
    subLessonsDone: node.subLessonsDone,
    subLessonsTotal: node.subLessonsTotal,
    legendary: node.legendary,
  };
}

export function isComplete(node: PathNode): boolean {
  const state = nodeVisual(progressOf(node)).state;
  return state === 'complete' || state === 'legendary';
}

/* ---------------------------------------------------------------------- popups */

export type PopupKind = 'locked' | 'incomplete' | 'complete';

export interface NodePopup {
  readonly kind: PopupKind;
  readonly nodeType: NodeType;
  readonly title: string;
  readonly subtitle: string | null;
  readonly buttons: readonly PopupButton[];
  /**
   * `Lesson {{i}} of {{n}}`. Present ONLY on the incomplete popup: a complete node's
   * popup never carries a counter (INV-PATH-03).
   */
  readonly subLessonCounter: string | null;
  /** The bouncing START pill. Never on a complete popup (INV-PATH-03). */
  readonly hasStart: boolean;
}

export interface PopupContext {
  /** Unit title - the popup borrows it; levels are unlabeled (`deep/03` §S3). */
  readonly unitTitle: string;
  /** Title for content nodes that have their own (a story's learner-language title). */
  readonly contentTitle?: string;
  /** The pack marks this node legendary-capable. */
  readonly legendaryAvailable: boolean;
  /** XP advertised on the offer; a field of the offer, never a hardcoded number (A9). */
  readonly advertisedXp: Readonly<Partial<Record<string, number>>>;
}

/**
 * The popup for a node in a given state. Total: every node type in every state renders
 * one, including locked (INV-PATH-01 - Duolingo showed nothing; that is the anomaly).
 */
export function popupFor(node: PathNode, unlocked: boolean, ctx: PopupContext): NodePopup {
  const spec = specFor(node.type);
  const title = ctx.contentTitle ?? ctx.unitTitle;
  if (!unlocked) {
    return {
      kind: 'locked',
      nodeType: node.type,
      title,
      subtitle: spec.lockedCopy,
      buttons: [],
      subLessonCounter: null,
      hasStart: false,
    };
  }
  if (!isComplete(node)) {
    const launch = spec.launchable[0];
    return {
      kind: 'incomplete',
      nodeType: node.type,
      title,
      subtitle: null,
      buttons:
        launch === undefined ? [] : [{ label: spec.startLabel, flavour: launch, gold: false }],
      // A chest has one tap, not sub-lessons; `Lesson 1 of 3` on a chest is a counter for a
      // quantity that does not exist (S016).
      subLessonCounter: spec.showsSubLessonCounter
        ? `Lesson ${node.subLessonsDone + 1} of ${node.subLessonsTotal}`
        : null,
      hasStart: launch !== undefined,
    };
  }
  // Complete. EC-PTH-04: once legendary, the LEGENDARY button drops to a state chip and
  // only the practice-shaped button remains.
  const buttons = spec.completedButtons.filter((b) => {
    if (b.flavour !== 'legendary') return true;
    return spec.offersLegendary && ctx.legendaryAvailable && !node.legendary;
  });
  return {
    kind: 'complete',
    nodeType: node.type,
    title,
    subtitle: spec.completedSubtitle,
    buttons,
    subLessonCounter: null,
    hasStart: false,
  };
}
