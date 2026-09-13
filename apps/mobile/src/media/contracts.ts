import type {
  NarrativeAttempt,
  NarrativeCompletion,
  ResolvedStoryAudio,
  StoryDocument,
  StoryState,
} from '@freelingo/core/stories';
import type { RadioEpisode, RadioState } from '@freelingo/core/radio';

export interface NarrativePorts<State> {
  /** Persist checkpoints; the App adapter owns SQLite and content-revision checks. */
  readonly onSave: (state: State) => void | Promise<void>;
  /** One event per answered question, keyed by run id + question id in the parent. */
  readonly onAttempt: (attempt: NarrativeAttempt, state: State) => void;
  /** Commit rewards atomically once per runId; never trust a screen mount as completion. */
  readonly onComplete: (completion: NarrativeCompletion, state: State) => void | Promise<void>;
  readonly onClose: () => void;
  readonly onRepair: () => void;
}
export interface StoryPlayerProps extends NarrativePorts<StoryState> {
  readonly story: StoryDocument;
  readonly initialState: StoryState;
  /** Resolved at entry, before rendering; explicit unavailable reasons remain visible. */
  readonly audioByElementId: Readonly<Record<string, ResolvedStoryAudio>>;
  readonly characterNames: Readonly<Record<string, string>>;
  readonly rubyEnabled?: boolean;
  readonly foreground?: boolean;
}
export interface RadioPlayerProps extends NarrativePorts<RadioState> {
  readonly episode: RadioEpisode;
  readonly initialState: RadioState;
  readonly audioAvailable: boolean;
  readonly foreground?: boolean;
}
export interface RadioPlayerHandle {
  /** Must be awaited before a graded session activates its audio profile. */
  interruptForGradedSession(): Promise<void>;
}
