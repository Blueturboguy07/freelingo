import type { SpeechSegment } from '@freelingo/core/grading';
import type { LessonChallenge } from '@freelingo/core/presentation';
import type { SessionEvent, SessionState } from '@freelingo/core/session';
import type { UiPreferences } from '@freelingo/ui';

export interface SpeechCaptureResult {
  readonly transcript: string;
  readonly amplitude: number;
  readonly segments?: readonly SpeechSegment[];
}
export type MediaError = 'route' | 'interrupted' | 'unavailable' | 'permission-denied';
export interface LessonMediaCapabilities {
  readonly canPlay: boolean;
  readonly canRecognize: boolean;
  readonly recognizerLocale: string | null;
  readonly microphonePermission: 'granted' | 'denied' | 'undetermined';
  readonly screenReaderActive: boolean;
  readonly announcementInFlight: boolean;
}
/** Root owns native implementation. No method implicitly requests permission. */
export interface LessonMediaPort {
  readonly capabilities: LessonMediaCapabilities;
  play(
    request: {
      readonly itemId: string;
      readonly assetRef?: string;
      readonly text: string;
      readonly locale: string;
      readonly slow: boolean;
    },
    callbacks: {
      readonly onComplete: () => void;
      readonly onInterrupted: () => void;
      readonly onError: (error: MediaError) => void;
    },
  ): () => void;
  recognize(
    request: { readonly itemId: string; readonly locale: string },
    callbacks: {
      readonly onResult: (result: SpeechCaptureResult) => void;
      readonly onError: (error: MediaError) => void;
    },
  ): () => void;
  /** Explicit S054/S055 action opens Settings or a preference control; not a lesson permission dialog. */
  remediate(
    cause:
      'preference-off' | 'suspended' | 'mic-denied' | 'no-content' | 'no-recogniser-for-locale',
  ): void;
  announce(text: string): void;
}
export interface LessonPlayerProps extends UiPreferences {
  readonly state: SessionState;
  readonly challenge: LessonChallenge | null;
  readonly onEvent: (event: SessionEvent) => void;
  readonly media: LessonMediaPort;
  readonly onSnooze?: (itemId: string) => void;
  readonly onCredits?: (itemId: string) => void;
  readonly onReport: (itemId: string, reason: string) => void;
  readonly onExplain: (request: {
    readonly itemId: string;
    readonly submittedAnswer: string;
  }) => void;
  readonly onComplete: () => void;
}
