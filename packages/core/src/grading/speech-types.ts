/** Speaking carrier proposal frozen 2026-09-13 under INV-MOD-13 / EC-MOD-27.
 * Expected units are produced by coursekit. No runtime tokenizer or analyser.
 */
import type { GradingPack } from './types.js';

export interface SpeechSegment {
  readonly segment: string;
  readonly startTimeMillis: number;
  readonly endTimeMillis: number;
}
export interface SpeechExpectedToken {
  /** Exact entry from ledger.speaking_tokens, preserving duplicates and order. */
  readonly unit: string;
  readonly surface: string;
  /** Unicode code-point offsets into the exact reference text. */
  readonly start: number;
  readonly end: number;
  /** Exact contextual reading, only from the paired Japanese script evidence. */
  readonly reading?: string;
}
export interface SpeechReference {
  readonly surfaceId: string;
  readonly text: string;
  readonly tokens: readonly SpeechExpectedToken[];
  /** Whole contextual reading, not the dictionary-linked lemma reading. */
  readonly reading?: string;
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly analysisSha256: string;
  readonly adapterFingerprint: string;
  readonly japaneseScriptSha256?: string;
}
export interface SpeechPolicy {
  readonly algorithm: 'stored-unit-f1-v1';
  readonly threshold: 0.7;
  readonly fallback: 'normalized-levenshtein-v1';
  readonly fallbackThreshold: 0.7;
  /** Explicit course policy, never a global language dictionary. */
  readonly ignoredPunctuation: readonly string[];
  readonly fillers: readonly string[];
}
export interface SpeechEvidence {
  readonly schemaVersion: 1;
  readonly language: string;
  readonly ledgerUnit: 'lemma' | 'morpheme_mode_a';
  readonly policy: SpeechPolicy;
  readonly references: readonly SpeechReference[];
}
export interface SpeechGradeRequest {
  readonly item: SpeechEvidence;
  readonly pack: GradingPack;
  readonly transcript: string;
  /** The recognizer's actual segments, never segments created from the transcript. */
  readonly segments?: readonly SpeechSegment[];
}
export interface SpeechGradeResult {
  readonly outcome: 'graded' | 'no-audio';
  readonly accepted: boolean;
  readonly score: number;
  readonly method: 'token-f1' | 'character-fallback' | 'no-audio';
  /** Only an accepted reference yields a matched surface for scheduler mapping. */
  readonly matchedSurfaceId: string | null;
  readonly referenceSurfaceId: string | null;
  readonly heartCost: 0;
}
export type SpeechGrader = (request: SpeechGradeRequest) => SpeechGradeResult;
