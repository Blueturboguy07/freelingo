/**
 * The demotion offer (S026) - the humane counterpart to jump-here.
 *
 * INV-PATH-07: it triggers on a defined failure signal and moves the learner without
 * destroying progress.
 * INV-PATH-14 / EC-PTH-29: at most once per node and at most once per 7 local days.
 * Without the cap, ordinary variance prompts a heavy learner weekly - three sessions on
 * one node below 60% inside an hour is a normal bad afternoon, not a signal.
 */
import type { PathModel } from './types.js';

/** Named config for the demotion signal. Every number here is a decision, not a capture. */
export const DEMOTION = {
  /** Consecutive sessions on the SAME node below the accuracy floor. */
  consecutiveFailures: 3,
  /** Accuracy at or below which a session counts as a failure. */
  accuracyFloor: 0.6,
  /** Minimum local days between two offers, whatever the node. */
  cooldownDays: 7,
} as const;

export interface SessionResult {
  readonly nodeId: string;
  readonly accuracy: number;
  readonly localDay: number;
}

export interface DemotionLedger {
  /** Local day of the last offer, or null if none has ever fired. */
  readonly lastOfferedLocalDay: number | null;
  /** Node ids that have already produced an offer. Never a second one. */
  readonly offeredNodeIds: readonly string[];
  /** Node ids whose offer the learner declined; remembered, never re-asked. */
  readonly declinedNodeIds: readonly string[];
}

export const EMPTY_DEMOTION_LEDGER: DemotionLedger = {
  lastOfferedLocalDay: null,
  offeredNodeIds: [],
  declinedNodeIds: [],
};

export interface DemotionOffer {
  readonly nodeId: string;
  readonly headline: string;
  readonly body: string;
  readonly acceptLabel: string;
}

/** `Is this lesson too hard?` / `We can jump to another lesson...` (str:2462-2464). */
function offerFor(nodeId: string): DemotionOffer {
  return {
    nodeId,
    headline: 'Is this lesson too hard?',
    body: "We can jump to another lesson that's closer to your level",
    acceptLabel: 'TRY EASIER LESSON',
  };
}

/**
 * Does this session history fire the offer? `history` is the session results for the
 * current course, oldest first; only the tail matters.
 */
export function evaluateDemotion(
  history: readonly SessionResult[],
  ledger: DemotionLedger,
  localDay: number,
): DemotionOffer | null {
  const tail = history.slice(-DEMOTION.consecutiveFailures);
  if (tail.length < DEMOTION.consecutiveFailures) return null;
  const first = tail[0];
  if (first === undefined) return null;
  const nodeId = first.nodeId;
  if (!tail.every((s) => s.nodeId === nodeId)) return null;
  if (!tail.every((s) => s.accuracy < DEMOTION.accuracyFloor)) return null;
  if (ledger.offeredNodeIds.includes(nodeId)) return null;
  if (ledger.declinedNodeIds.includes(nodeId)) return null;
  if (
    ledger.lastOfferedLocalDay !== null &&
    localDay - ledger.lastOfferedLocalDay < DEMOTION.cooldownDays
  ) {
    return null;
  }
  return offerFor(nodeId);
}

export function recordOffered(
  ledger: DemotionLedger,
  nodeId: string,
  localDay: number,
): DemotionLedger {
  return {
    lastOfferedLocalDay: localDay,
    offeredNodeIds: ledger.offeredNodeIds.includes(nodeId)
      ? ledger.offeredNodeIds
      : [...ledger.offeredNodeIds, nodeId],
    declinedNodeIds: ledger.declinedNodeIds,
  };
}

export function recordDeclined(ledger: DemotionLedger, nodeId: string): DemotionLedger {
  return {
    ...ledger,
    declinedNodeIds: ledger.declinedNodeIds.includes(nodeId)
      ? ledger.declinedNodeIds
      : [...ledger.declinedNodeIds, nodeId],
  };
}

/**
 * Accepting moves the viewport to an easier section. It destroys no progress: every node's
 * completion, every legendary flag and the score floor are carried verbatim.
 */
export function acceptDemotion(model: PathModel, targetSection: number): PathModel {
  const clamped = Math.min(Math.max(0, targetSection), model.sections.length - 1);
  return { ...model, viewingSection: clamped };
}
