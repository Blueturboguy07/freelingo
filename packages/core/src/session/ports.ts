/**
 * The session runtime's ports.
 *
 * The runtime owns the session; it owns neither the checker nor the scheduler. Verdicts
 * come from `packages/core/src/grading` through `GradingPort` and scheduler writes go
 * through `SchedulerPort` — both are other P1 lanes, so this file declares the interfaces
 * and `test-doubles.ts` supplies fakes. Nothing here reimplements a checker.
 */
import type {
  Answer,
  ExerciseType,
  ItemFamily,
  MistakeRow,
  QueuedItem,
  SessionFlavour,
  Verdict,
  WeakItemRow,
} from './types.js';

/* ==================================================================== 1. grading */

export interface GradeRequest {
  readonly item: QueuedItem;
  readonly raw: string;
  /** Opaque per-challenge state (tapped tiles, matched pairs, strokes). */
  readonly partialState: Readonly<Record<string, unknown>>;
  /** Presentation flag only. Grading is identical (deep/01 §S15). */
  readonly hardMode: boolean;
}

/** Implemented by `packages/core/src/grading`. */
export interface GradingPort {
  grade(request: GradeRequest): Verdict;
}

/* ================================================================== 2. scheduler */

export interface SchedulerCommit {
  readonly sessionId: string;
  readonly courseId: string;
  readonly attempts: readonly Answer[];
  readonly mistakes: readonly MistakeRow[];
  readonly weakItems: readonly WeakItemRow[];
}

/** Implemented by `packages/core/src/scheduler`. Writes are idempotent (INV-SCH-03). */
export interface SchedulerPort {
  commit(commit: SchedulerCommit): void;
  /** Items FSRS considers due, most-due first. Used to pad a short queue. */
  duePool(courseId: string): readonly QueuedItem[];
  /** Has this item ever been served to this learner? (INV-SCH-06, INV-SESS-03) */
  isSeen(courseId: string, itemId: string): boolean;
  /** Live mistake rows, for the resume re-filter (INV-SESS-18). */
  openMistakes(courseId: string): readonly MistakeRow[];
}

/* ================================================ 3. the device the queue must fit */

/**
 * Audio availability, resolved AT GENERATION (INV-AUD-01). A render-time resolution is
 * exactly the bug: the queue length would then depend on what the device could play.
 */
export interface AudioAvailabilityPort {
  /** Can a clip (baked or TTS) be produced for this item right now? */
  canProduce(itemId: string): boolean;
}

/** The installed pack. INV-SESS-21 offers RESUME only if every id still resolves. */
export interface PackResolverPort {
  resolves(itemId: string): boolean;
  /** The node this item currently belongs to; a re-cut pack moves it. */
  nodeRefOf(itemId: string): string | null;
  /** Is the asset this item needs present? A miss degrades ONE item (INV-PACK-05). */
  assetPresent(itemId: string): boolean;
}

/** Families the learner has switched off or the OS has suspended (INV-SESS-16). */
export interface ModalityPort {
  gatedFamilies(): readonly ItemFamily[];
}

/**
 * Monotonic time. INV-SESS-02/10: session age is NEVER wall-clock-derived, so the runtime
 * is handed a counter that a clock change cannot move. A backwards reading clamps to 0.
 */
export interface MonotonicClock {
  /** Milliseconds since an arbitrary fixed origin. Never decreases in reality. */
  nowMs(): number;
}

/* ======================================================= 4. the foreground chain */

/** INV-SESS-27: rollover → FSRS recompute → snapshot+reload → notification re-arm. */
export interface BootPort {
  rolloverTo(): Promise<void>;
  recomputeFsrs(): Promise<void>;
  publishSnapshotAndReload(): Promise<void>;
  rearmNotifications(): Promise<void>;
}

/* ================================================================= 5. generation */

export interface GenerationRequest {
  readonly sessionId: string;
  readonly courseId: string;
  readonly nodeRef: string;
  readonly flavour: SessionFlavour;
  /** Authored candidates for this node, in authoring order. */
  readonly candidates: readonly QueuedItem[];
  readonly audio: AudioAvailabilityPort;
  readonly pack: PackResolverPort;
  readonly modality: ModalityPort;
  readonly scheduler: SchedulerPort;
  /** Deterministic seed; the same request always produces the same queue. */
  readonly seed: number;
}

export interface GeneratedSession {
  readonly offered: boolean;
  /** `nothingDue` when the floor is not reached (INV-SESS-26). */
  readonly reason: 'ok' | 'nothingDue';
  readonly queue: readonly QueuedItem[];
  /** Per-item option seed, realised at generation so a resume can replay it verbatim. */
  readonly optionSeeds: Readonly<Record<string, number>>;
  /** Items dropped because their family is gated or their audio cannot be produced. */
  readonly droppedForGate: readonly string[];
  readonly droppedForAudio: readonly string[];
  /** Items kept but degraded — never a reason to abort (INV-PACK-05). */
  readonly degraded: readonly string[];
}

export type ExerciseTypeOf = (item: QueuedItem) => ExerciseType;
