/** Frozen revision-1 production carrier, 2026-09-13; no decoder fallback or data. */
import type { GradableItem } from '../grading/types.js';
import type { SpeechEvidence } from '../grading/speech-types.js';
import type { ItemKind } from '../scheduler/types.js';
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
interface RuntimeIntroductionSurface {
  readonly surfaceId: string;
  readonly surface: string;
  readonly language: string;
}
/** Ordinary prompt/feedback witnesses remain unchanged. A picture NEW WORD option
 * is eligible only on the existing prompt display event after options render. */
export type RuntimeIntroduction = RuntimeIntroductionSurface &
  (
    | {
        readonly when: 'prompt' | 'wrong-feedback';
        readonly location?: never;
        readonly optionId?: never;
      }
    | { readonly when: 'prompt'; readonly location: 'option'; readonly optionId: string }
  );

/** Exact reviewed target-language spelling scheduled for the real item/semantic ID.
 * One canonical per target; matching accepted Spanish alternatives retain their own ID.
 * Wrong/open-response attempts use canonical; English responses never replace it.
 */
export interface RuntimeSchedulerSurface {
  readonly itemId: string;
  /** Independently declared source objective, joined to actual exercise tags. */
  readonly kind: ItemKind;
  readonly itemRef: string;
  readonly surfaceId: string;
  readonly surface: string;
  readonly language: string;
  readonly canonical: boolean;
}
/** Independently authored lexical meaning, using the unchanged semantic item hash.
 * This is not the enclosing exercise prompt and has no language/placement hash salt. */
export interface RuntimeLexicalSemantic {
  readonly prompt: string;
  readonly preferredSurface: string;
  readonly register: string;
  readonly lexemes: readonly string[];
  readonly grammarConcepts: readonly string[];
  readonly graphemes: readonly string[];
}
/** Exact reviewed word-counter identity for one actual scheduler surface.
 * Scheduling keeps schedulerItemId. Only actual exposure/review can contribute the
 * distinct wordItemId to counters; declaration/loading never introduces a word. */
export interface RuntimeLexicalBinding {
  readonly schedulerItemId: string;
  readonly surfaceId: string;
  readonly surface: string;
  readonly language: string;
  readonly lexemeId: string;
  readonly lemma: string;
  readonly pos: string;
  readonly wordItemId: string;
  readonly semantic: RuntimeLexicalSemantic;
  readonly countable: boolean;
  /** countable:true is allowed only for word; exclusions explicitly carry false. */
  readonly classification: 'word' | 'particle' | 'bound-morpheme' | 'character';
  readonly proof: {
    readonly sourceId: string;
    readonly sourceSha256: string;
    readonly declarationSha256: string;
    readonly bindingSha256: string;
  };
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
  readonly schedulerSurfaces: readonly RuntimeSchedulerSurface[];
  readonly introductions: readonly RuntimeIntroduction[];
  /** Complete explicit lexical scheduler-surface bindings; grammar has none. */
  readonly lexicalBindings: readonly RuntimeLexicalBinding[];
  /** Required for speaking; absent for other grading families. */
  readonly speech?: SpeechEvidence;
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
