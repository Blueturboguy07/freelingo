/**
 * Mistake recycling — S049.
 *
 * Owns INV-MIS-01 … INV-MIS-08 and the re-filter half of INV-SESS-18.
 *
 * TERMINATION (INV-MIS-02) is the hard part, and it is a proof, not a spot check. "A
 * wrong answer during the replay re-queues the item" plus "the queue drains to empty in
 * finite steps for ANY answer sequence" are only compatible if re-queueing is bounded. So
 * every mistake carries `servesRemaining`, decremented on EVERY serve whatever the
 * verdict; the measure Σ servesRemaining strictly decreases on each step and is bounded
 * below by 0, so the drain terminates for an always-wrong learner too. The item is then
 * DEFERRED — its durable mistake row stands and the Practice Hub owns it — and the
 * session is no longer "complete with a pending mistake": there is nothing pending.
 */
import type { ExerciseType, MistakeRow, QueuedItem, QueuedMistake, WeakItemRow } from './types.js';
import { EXERCISE_REGISTRY, NEVER_A_RECYCLE_TARGET, exerciseSpec } from './registry.js';
import type { SessionFlavourConfig } from './flavours.js';

/* ================================================================ 1. constants */

/** S049 / INV-MIS-01: once mid-lesson, once at the end. */
export const SCHEDULED_RECYCLES_PER_MISTAKE = 2;

/** EC-MIS-02: a wrong replay re-queues — this bounds it so the drain terminates. */
export const MAX_EXTRA_REQUEUES_PER_MISTAKE = 2;

export const MAX_SERVES_PER_MISTAKE =
  SCHEDULED_RECYCLES_PER_MISTAKE + MAX_EXTRA_REQUEUES_PER_MISTAKE;

/** EC-MIS-09: two correct encounters in sessions OTHER than the creating one. */
export const REVIEW_STREAK_TO_RETIRE = 2;

/** EC-MIS-13: a stroke needing this many rejections makes the grapheme a weak item. */
export const STROKE_REJECTIONS_FOR_WEAK_ITEM = 2;

/* ========================================================== 2. queueing a mistake */

export interface QueueMistakeRequest {
  readonly config: SessionFlavourConfig;
  readonly item: QueuedItem;
  readonly queue: readonly QueuedMistake[];
  /** Main-queue answers recorded INCLUDING this miss — the mid-lesson gap counts from it. */
  readonly mainAnswersAtMiss: number;
}

/**
 * INV-MIS-03: the three test flavours produce ZERO recycles and ZERO queue entries —
 * `config.recyclesMistakes` is the only thing consulted, so a new test flavour inherits
 * the rule by configuration.
 *
 * INV-MIS-05: one wrong answer creates at most one entry, keyed by `itemId`.
 * Non-punitive types (speak, trace, read-and-respond) never queue at all.
 */
export function queueMistake(request: QueueMistakeRequest): readonly QueuedMistake[] {
  const { config, item, queue } = request;
  if (!config.recyclesMistakes) return queue;
  const spec = exerciseSpec(item.type);
  if (!spec.punitive) return queue;
  if (queue.some((m) => m.itemId === item.itemId)) return queue;
  return [
    ...queue,
    {
      itemId: item.itemId,
      slotId: item.id,
      originalType: item.type,
      servesRemaining: MAX_SERVES_PER_MISTAKE,
      recyclesServed: 0,
      queuedAtMainAnswers: request.mainAnswersAtMiss,
    },
  ];
}

/* ================================================ 2b. WHEN the mid-lesson recycle runs */

/**
 * The mistake whose MID-LESSON recycle is due, or `null`.
 *
 * This is the half a refuter proved missing: a `phase` computed as
 * `recyclesServed === 0 ? 'midLesson' : 'end'` names a FORMAT, not a POSITION, and every
 * replay was in fact served after the whole main queue had drained. Position is now a
 * predicate over the main-answer counter: the first recycle of a miss becomes due once
 * `gap` further MAIN-queue answers have been recorded, and the machine serves it right
 * there, with main-queue items still to come.
 *
 * `deep/01` §S16 / product-map S049: "recycled twice — mid-lesson in a different format
 * (best-effort), end-of-lesson in the original".
 */
export function midLessonRecycleDue(
  queue: readonly QueuedMistake[],
  mainAnswers: number,
  gap: number,
): QueuedMistake | null {
  return (
    queue.find(
      (m) =>
        m.recyclesServed === 0 &&
        m.servesRemaining > 0 &&
        mainAnswers - m.queuedAtMainAnswers >= gap,
    ) ?? null
  );
}

/* ======================================================== 3. the recycle ladder */

export type RecyclePhase = 'midLesson' | 'end';

/**
 * INV-MIS-07: the recycle target comes from the type's DECLARED map and preserves the
 * missed item's id for FSRS. Trace is never a target.
 * INV-MIS-06: the ladder is total — for every runtime eligibility state it terminates
 * with a SERVED item, falling back to the original form rather than skipping the recycle.
 */
export interface RecycleTargetResult {
  readonly type: ExerciseType;
  /** True when no declared alternative was eligible and the original was replayed. */
  readonly degraded: boolean;
}

export function recycleTarget(
  mistake: QueuedMistake,
  phase: RecyclePhase,
  isEligible: (type: ExerciseType) => boolean,
): RecycleTargetResult {
  // S049: the END replay is always in the ORIGINAL format, with the PREVIOUS MISTAKE pill.
  if (phase === 'end') return { type: mistake.originalType, degraded: false };

  const spec = EXERCISE_REGISTRY[mistake.originalType];
  const declared = spec === undefined ? [] : spec.recycleTargets;
  for (const candidate of declared) {
    if (NEVER_A_RECYCLE_TARGET.includes(candidate)) continue;
    if (candidate === mistake.originalType) continue;
    if (!isEligible(candidate)) continue;
    return { type: candidate, degraded: false };
  }
  // EC-MIS-11: never skip the recycle and never end the session unresolved — replay the
  // original mid-lesson and mark the recycle degraded.
  return { type: mistake.originalType, degraded: true };
}

/* ================================================================= 4. the drain */

export interface ServeResult {
  readonly served: QueuedMistake;
  readonly rest: readonly QueuedMistake[];
}

/**
 * Take the first queued mistake matching `pick` and spend one serve.
 *
 * The measure Σ `servesRemaining` strictly decreases here whatever `pick` selects, which
 * is what keeps INV-MIS-02's termination proof independent of the serving ORDER — the
 * mid-lesson serve jumps the FIFO by design.
 */
export function serveMistake(
  queue: readonly QueuedMistake[],
  pick: (m: QueuedMistake) => boolean = () => true,
): ServeResult | null {
  const head = queue.find((m) => m.servesRemaining > 0 && pick(m));
  if (head === undefined) return null;
  const rest = queue.filter((m) => m !== head);
  return { served: { ...head, servesRemaining: head.servesRemaining - 1 }, rest };
}

/** Take the head of the FIFO and spend one serve. `null` when nothing is pending. */
export function serveNextMistake(queue: readonly QueuedMistake[]): ServeResult | null {
  return serveMistake(queue);
}

/**
 * Put a served mistake back, or retire it from the session queue.
 *
 * Correct → done for this session (the DURABLE row still needs two correct encounters in
 * OTHER sessions, INV-MIS-04). Wrong → re-queued while budget remains; budget exhausted →
 * deferred, which is what makes the drain finite.
 */
export function afterMistakeReplay(
  served: QueuedMistake,
  rest: readonly QueuedMistake[],
  correct: boolean,
): readonly QueuedMistake[] {
  const advanced: QueuedMistake = { ...served, recyclesServed: served.recyclesServed + 1 };
  if (correct && advanced.recyclesServed >= SCHEDULED_RECYCLES_PER_MISTAKE) return rest;
  if (correct)
    return [
      ...rest,
      {
        ...advanced,
        servesRemaining: Math.min(
          advanced.servesRemaining,
          SCHEDULED_RECYCLES_PER_MISTAKE - advanced.recyclesServed,
        ),
      },
    ];
  if (advanced.servesRemaining <= 0) return rest; // deferred to the hub
  return [...rest, advanced];
}

/** The termination measure. Strictly decreases on every serve; bounded below by 0. */
export function pendingServes(queue: readonly QueuedMistake[]): number {
  return queue.reduce((sum, m) => sum + Math.max(0, m.servesRemaining), 0);
}

/** INV-MIS-01/06: the session may not reach `complete` while this is true. */
export function hasPendingMistake(queue: readonly QueuedMistake[]): boolean {
  return queue.some((m) => m.servesRemaining > 0);
}

/* ============================================== 5. the durable row and retirement */

export interface RetirementInput {
  readonly row: MistakeRow;
  /** The session the answer was given in. */
  readonly sessionId: string;
  readonly correct: boolean;
}

/**
 * INV-MIS-04.
 *
 * - `review_streak` increments on a correct answer in a session OTHER than the one that
 *   created the miss — an in-lesson replay is not evidence of retention;
 * - any wrong answer anywhere resets it to 0;
 * - two such encounters retire the row.
 */
export function applyEncounter(input: RetirementInput): { row: MistakeRow; retired: boolean } {
  const { row, sessionId, correct } = input;
  if (!correct) return { row: { ...row, reviewStreak: 0 }, retired: false };
  if (sessionId === row.createdInSessionId) return { row, retired: false };
  const reviewStreak = row.reviewStreak + 1;
  return { row: { ...row, reviewStreak }, retired: reviewStreak >= REVIEW_STREAK_TO_RETIRE };
}

/**
 * INV-SESS-18: on resume the queue is re-filtered against LIVE mistake rows. An item the
 * hub retired while the session was parked is dropped; if the queue empties the session
 * goes straight to `complete`, consuming the reserved final segment exactly once.
 * Accuracy still counts the original misses — this filters the REPLAY, not the history.
 */
export function refilterAgainstLiveRows(
  queue: readonly QueuedMistake[],
  liveRows: readonly MistakeRow[],
): readonly QueuedMistake[] {
  const live = new Set(liveRows.map((r) => r.itemId));
  return queue.filter((m) => live.has(m.itemId));
}

/* =============================================================== 6. weak items */

/**
 * INV-MIS-08: a trace that needed repeated rejections writes a WEAK-ITEM row, never a
 * mistake row — no in-lesson replay, no pill, accuracy and `Perfect lesson!` untouched —
 * and still reaches the hub as a recognition item.
 */
export function weakItemFor(
  item: QueuedItem,
  courseId: string,
  rejections: number,
): WeakItemRow | null {
  if (rejections < STROKE_REJECTIONS_FOR_WEAK_ITEM) return null;
  return { itemId: item.itemId, courseId, rejections };
}

/** What the hub serves a weak item as. Never the trace it failed at. */
export const WEAK_ITEM_HUB_TYPE: ExerciseType = 'characterSelect';
