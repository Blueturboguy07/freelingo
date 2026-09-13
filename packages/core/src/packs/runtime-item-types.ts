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
  readonly introductions: readonly string[];
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
