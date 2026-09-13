import type { Answer } from '@freelingo/core/session';
import type { FsrsRow, ReviewResult } from '@freelingo/core/scheduler';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import type { AnswerReceipt } from './SqliteLearningContextStore';
import type { SchedulerTargetEvidence } from './SqliteSchedulerStore';

/** Actual completion-loop evidence, 2026-09-13. Values surround one real applyEncounter
 * call; consumers never reconstruct card snapshots or run a second FSRS update.
 * Order is the immutable session Answer/receipt sequence, then frozen target position.
 * Negative replay exercise indices are identities, never a chronological sort key.
 */
export interface LearningSchedulerTransition {
  readonly courseId: string;
  readonly sessionId: string;
  /** Index in state.core.answers and its matching staged receipt_sequence. */
  readonly answerOrdinal: number;
  /** Exact course_session_answer_target.position inside the parent Answer. */
  readonly targetPosition: number;
  readonly answer: Answer;
  readonly receipt: AnswerReceipt;
  readonly target: SchedulerTargetEvidence;
  readonly runtimeItem: VerifiedRuntimeItem;
  readonly packContentHash: string;
  readonly before: FsrsRow | null;
  readonly after: FsrsRow | null;
  readonly review: ReviewResult | null;
  readonly wroteAttempt: boolean;
}
