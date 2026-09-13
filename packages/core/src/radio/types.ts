import type { Choice, MatchPair, NarrativeAnswer, NarrativeAttempt } from '../stories/types.js';
export type { NarrativeAnswer, NarrativeAttempt };
export interface RadioTile {
  readonly id: string;
  readonly text: string;
  readonly tokenId: string;
  readonly contentToken: boolean;
  readonly itemIds: readonly string[];
}
interface QuestionBase {
  readonly id: string;
  readonly atMs: number;
  readonly prompt: string;
}
export type RadioQuestion =
  | (QuestionBase & {
      readonly kind: 'comprehension';
      readonly options: readonly Choice[];
      readonly correctOptionId: string;
      readonly itemIds: readonly string[];
    })
  | (QuestionBase & {
      readonly kind: 'listenSelect';
      readonly count: number;
      readonly tiles: readonly RadioTile[];
      readonly correctTileIds: readonly string[];
    })
  | (QuestionBase & {
      readonly kind: 'matching';
      readonly pairs: readonly (MatchPair & { readonly audioUri: string })[];
    });
export interface RadioSegment {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly characterId: string;
  readonly text: string;
  readonly language: string;
}
/** Stored in radio_episode.transcript_json; anchors_json mirrors questions. */
export interface RadioEpisode {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: string;
  readonly title: string;
  readonly language: string;
  readonly unitIndex: number;
  readonly show: {
    readonly id: string;
    readonly title: string;
    readonly hostCharacterId: string;
    readonly introAsset: string;
    readonly outroAsset: string;
  };
  readonly l1Ratio: number;
  readonly targetDurationMs: number;
  readonly audio: { readonly uri: string; readonly durationMs: number };
  readonly bakedAudioComplete: boolean;
  readonly segments: readonly RadioSegment[];
  readonly questions: readonly RadioQuestion[];
}
export interface RadioState {
  readonly episodeId: string;
  readonly revision: string;
  readonly runId: string;
  readonly positionMs: number;
  readonly playing: boolean;
  readonly foreground: boolean;
  readonly activeQuestionId: string | null;
  /** Includes skipped anchors: audio never fires them again, foreground review is explicit. */
  readonly consumedIds: readonly string[];
  readonly skippedIds: readonly string[];
  readonly answers: readonly NarrativeAttempt[];
}
