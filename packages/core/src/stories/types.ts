/** P6 wire version. JSON lives in story.lines_json; no React or device handles cross it. */
export interface Span {
  readonly start: number;
  readonly end: number;
}
export interface Hint extends Span {
  readonly gloss: string;
}
export interface Ruby extends Span {
  readonly reading: string;
}
export interface Keypoint extends Span {
  readonly atMs: number;
}
export interface StoryAudioAsset {
  readonly uri: string;
  /** Exact spoken text and cast version are bound by the content pipeline. */
  readonly text: string;
  readonly voiceVersion: string;
  readonly durationMs: number;
  readonly keypoints: readonly Keypoint[];
}
export interface StoryText {
  readonly text: string;
  readonly hints: readonly Hint[];
  readonly ruby: readonly Ruby[];
  readonly audio?: StoryAudioAsset;
}
export interface Choice {
  readonly id: string;
  readonly text: string;
}
export interface MatchPair {
  readonly id: string;
  readonly left: string;
  readonly right: string;
  readonly itemIds: readonly string[];
}
interface ElementBase {
  readonly id: string;
  readonly lineIndex: number;
}
interface ChallengeBase extends ElementBase {
  readonly prompt: string;
  readonly itemIds: readonly string[];
}
export type StoryElement =
  | (ElementBase & { readonly type: 'HEADER'; readonly content: StoryText })
  | (ElementBase & {
      readonly type: 'LINE';
      readonly kind: 'CHARACTER' | 'PROSE' | 'TITLE';
      readonly characterId?: string;
      readonly content: StoryText;
      readonly hidden?: readonly Span[];
      readonly receptiveOnly?: boolean;
    })
  | (ChallengeBase & {
      readonly type: 'SELECT_PHRASE';
      readonly challengeType: 'selectPhrase' | 'continuation';
      readonly options: readonly Choice[];
      readonly correctOptionId: string;
    })
  | (ChallengeBase & {
      readonly type: 'MULTIPLE_CHOICE';
      readonly options: readonly Choice[];
      readonly correctOptionId: string;
    })
  | (ChallengeBase & {
      readonly type: 'POINT_TO_PHRASE';
      readonly ranges: readonly (Span & { readonly id: string })[];
      readonly correctRangeId: string;
    })
  | (ChallengeBase & {
      readonly type: 'ARRANGE';
      readonly tiles: readonly Choice[];
      readonly correctTileIds: readonly string[];
      readonly acceptedTileOrders?: readonly (readonly string[])[];
    })
  | (ElementBase & { readonly type: 'MATCH'; readonly pairs: readonly MatchPair[] })
  | (ElementBase & { readonly type: 'ERROR'; readonly message: string });
export type StoryChallenge = Exclude<StoryElement, { readonly type: 'HEADER' | 'LINE' | 'ERROR' }>;
export type StoryMode = 'normal' | 'legendary' | 'listening';
export interface StoryDocument {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: string;
  readonly language: string;
  readonly unitIndex: number;
  readonly title: string;
  readonly targetTitle: string;
  readonly narratorRegister: string;
  readonly covers: { readonly active: string; readonly locked: string; readonly gilded: string };
  readonly elements: readonly StoryElement[];
  readonly bakedAudioComplete: boolean;
  readonly stitchedAudio?: {
    readonly uri: string;
    readonly durationMs: number;
    readonly parts: readonly {
      readonly partId: string;
      readonly startMs: number;
      readonly endMs: number;
    }[];
  };
}
export interface StoryPart {
  readonly id: string;
  readonly elements: readonly StoryElement[];
}
/** Stable tile ids, never display positions or labels, are the grading input. */
export type NarrativeAnswer =
  | { readonly kind: 'option'; readonly optionId: string }
  | { readonly kind: 'tiles'; readonly tileIds: readonly string[] }
  | { readonly kind: 'range'; readonly rangeId: string }
  | {
      readonly kind: 'matches';
      readonly pairs: readonly { readonly leftId: string; readonly rightId: string }[];
    };
export interface NarrativeAttempt {
  readonly questionId: string;
  readonly correct: boolean;
  readonly answer: NarrativeAnswer;
  /** One attempt, potentially multiple scheduler targets; never manufactured attempts per token. */
  readonly itemIds: readonly string[];
}
export interface NarrativeCompletion {
  readonly canCommit: boolean;
  readonly rewardTier: 'plainReplay' | 'completed';
  readonly answers: readonly NarrativeAttempt[];
}
export interface StoryState {
  readonly storyId: string;
  readonly revision: string;
  readonly runId: string;
  readonly mode: StoryMode;
  readonly partIndex: number;
  readonly foreground: boolean;
  readonly answers: readonly NarrativeAttempt[];
  readonly skippedIds: readonly string[];
  /** High-water progress is persisted, so foreground/background changes cannot regress it. */
  readonly progress: number;
}
export type ResolvedStoryAudio =
  | { readonly kind: 'baked'; readonly uri: string; readonly voiceVersion: string }
  | { readonly kind: 'tts'; readonly voiceId: string }
  | { readonly kind: 'unavailable'; readonly reason: string };
