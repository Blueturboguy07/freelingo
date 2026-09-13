import type { UiPreferences } from '@freelingo/ui';
import type { PackState } from '@freelingo/core/packs';
import type { GoalTierKey } from '@freelingo/core/economy';

export type DownloadPresentation =
  | { readonly kind: 'idle' }
  | { readonly kind: 'queued' }
  | { readonly kind: 'downloading'; readonly progress: number }
  | { readonly kind: 'paused'; readonly progress: number }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'insufficient-disk';
      readonly requiredMb: number;
      readonly availableMb: number;
    };

/** Facts from the verified catalogue/install boundary. No percentages are inferred by UI. */
export interface OnboardingCourse {
  readonly id: string;
  readonly languageName: string;
  readonly language: string;
  readonly packState: PackState;
  readonly sizeMb: number;
  readonly itemCount: number;
  readonly alignment: 'cefr' | 'frequency';
  readonly levelLabel: string;
  readonly machineAuthoredPercent: number | null;
  readonly wrongItemPercent: number | null;
  readonly nativeReview: 'paid' | 'provisional' | 'unreviewed';
  readonly beta: boolean;
  readonly download: DownloadPresentation;
  readonly sample?: {
    readonly text: string;
    readonly translation: string;
    readonly playing: boolean;
  };
  readonly validatorSummary: string;
}
export type SelfReportLevel = 'new' | 'words' | 'basic' | 'topics' | 'detailed';
export type PlacementChoice = 'scratch' | 'test';
export type RestorePresentation =
  | { readonly kind: 'offered' }
  | { readonly kind: 'picking-file' }
  | { readonly kind: 'validating' }
  | { readonly kind: 'version-mismatch'; readonly message: string }
  | {
      readonly kind: 'confirm-replace';
      readonly currentLastDay: string | null;
      readonly importedLastDay: string | null;
      readonly sessionsSinceInstall: number;
    }
  | { readonly kind: 'importing' }
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly message: string };
export type OnboardingState =
  | {
      readonly screen: 'courses';
      readonly courses: readonly OnboardingCourse[];
      readonly selectedCourseId: string | null;
    }
  | { readonly screen: 'pack-detail'; readonly course: OnboardingCourse }
  | { readonly screen: 'restore'; readonly restore: RestorePresentation }
  | {
      readonly screen: 'placement-choice';
      readonly languageName: string;
      readonly choice: PlacementChoice | null;
    }
  | {
      readonly screen: 'self-report';
      readonly languageName: string;
      readonly level: SelfReportLevel | null;
    }
  | { readonly screen: 'placement-result'; readonly section: number }
  | { readonly screen: 'goal'; readonly selected: GoalTierKey }
  | {
      readonly screen: 'notifications';
      readonly permission: 'never-asked' | 'requesting' | 'granted' | 'denied' | 'blocked';
    }
  | { readonly screen: 'entering' };
export type OnboardingEvent =
  | {
      readonly type: 'selectCourse' | 'showPack' | 'download' | 'pauseDownload' | 'playSample';
      readonly courseId: string;
    }
  | {
      readonly type:
        | 'restore'
        | 'pickRestore'
        | 'confirmRestore'
        | 'cancelRestore'
        | 'startPlacement'
        | 'requestNotifications'
        | 'openNotificationSettings'
        | 'continue'
        | 'back';
    }
  | { readonly type: 'choosePlacement'; readonly choice: PlacementChoice }
  | { readonly type: 'chooseLevel'; readonly level: SelfReportLevel }
  | { readonly type: 'chooseGoal'; readonly goal: GoalTierKey };
export interface OnboardingScreenProps extends UiPreferences {
  readonly state: OnboardingState;
  /** The host persists choices and handles network, import, native permission and navigation. */
  readonly onEvent: (event: OnboardingEvent) => void;
}
