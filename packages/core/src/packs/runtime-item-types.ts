/** Frozen revision-1 production carrier, 2026-09-13; no decoder fallback or data. */
import type { GradableItem } from '../grading/types.js';
import type { LessonChallenge } from '../presentation/index.js';
import type {
  ExerciseGradingContext,
  GradingPackIdentity,
  LoadedGradingMetadata,
} from './grading.js';
import type { PackReader } from './loader.js';

export interface RuntimeItemProof {
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly approvalId: string;
  readonly approvalSha256: string;
  readonly draftSha256: string;
}
/** A reviewed exact full surface eligible only on the named actual display event.
 * Approval/loading is not exposure. Consumers retain only the target course language;
 * prompt language may differ from response language (including reverse translation).
 */
export interface RuntimeIntroduction {
  readonly surfaceId: string;
  readonly surface: string;
  readonly language: string;
  readonly when: 'prompt' | 'wrong-feedback';
}
export interface VerifiedRuntimeItem {
  readonly schemaVersion: 1;
  readonly exerciseId: string;
  readonly itemId: string;
  readonly unitId: string;
  readonly lessonIndex: number;
  readonly profileId: string;
  readonly responseLanguage: string;
  readonly proof: RuntimeItemProof;
  readonly gradable: GradableItem;
  readonly presentation: LessonChallenge;
  readonly introductions: readonly RuntimeIntroduction[];
  readonly explanation: string;
  readonly grading: ExerciseGradingContext;
}

/** A caller may reuse metadata decoded from the same immutable active pack reader. */
export type RuntimeItemReader = (
  reader: PackReader,
  meta: GradingPackIdentity,
  exerciseId: string,
  grading?: LoadedGradingMetadata,
) => VerifiedRuntimeItem;
