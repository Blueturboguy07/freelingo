import type { HubInput, HubOffer } from '@freelingo/core/hub';
import type { NotificationSettingsSnapshot } from '@freelingo/core/notifications';
import type { SessionEvent, SessionState } from '@freelingo/core/session';
import type { LessonChallenge } from '@freelingo/core/presentation';
import type { UiPreferences } from '@freelingo/ui';
import type { OpenedProgressDb } from '../db/ExpoDb';
import type { PersistenceStatus } from '../db/startPersistence';
import type { LessonMediaPort } from '../lesson/ports';
import type { OnboardingEvent, OnboardingState } from '../onboarding/ports';
import type { PathLaunch, PathScreenProps } from '../path/ports';
import type { CeremonyPresentation, LoopPorts, SettingsSnapshot } from '../loop/contracts';
import type { NotificationSettingsPorts } from '../loop/NotificationsScreen';

export type AppTab = 'path' | 'practice' | 'quests' | 'shop' | 'profile';
export type LessonLaunch =
  | { readonly kind: 'path'; readonly request: PathLaunch }
  | { readonly kind: 'hub'; readonly offer: HubOffer }
  | { readonly kind: 'placement' };
/** S051/S052 decisions are produced from durable session state by the runtime. */
export type SessionOffer =
  | { readonly kind: 'resume'; readonly sessionId: string; readonly lessonLabel: string }
  | {
      readonly kind: 'collision';
      readonly sessionId: string;
      readonly lessonLabel: string;
      readonly exerciseIndex: number;
      readonly exerciseCount: number;
    };
export type SessionOfferDecision = 'resume' | 'start-over' | 'end-and-start-new' | 'cancel';
export type AppSurfaceRequest =
  | { readonly kind: 'route'; readonly route: 'about' | 'credits' | 'integrity' }
  | { readonly kind: 'guidebook'; readonly unitIndex: number }
  | { readonly kind: 'sections' }
  | { readonly kind: 'credits'; readonly itemId: string }
  | { readonly kind: 'explain'; readonly itemId: string; readonly submittedAnswer: string };
/** Local, source-backed text surfaces. Interactive feature screens retain their own typed models. */
export interface AppDocument {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly rows: readonly { readonly id: string; readonly label: string; readonly value: string }[];
}
export interface AppSnapshot {
  readonly activeCourseId: string | null;
  readonly ui: UiPreferences;
  readonly onboarding: OnboardingState | null;
  readonly path: Pick<
    PathScreenProps,
    'model' | 'status' | 'advertisedXpByNode' | 'unavailableNodeIds' | 'summary'
  >;
  readonly hub: HubInput | null;
  readonly settings: SettingsSnapshot | null;
  readonly notifications: NotificationSettingsSnapshot | null;
  readonly lesson: {
    readonly state: SessionState;
    readonly challenge: LessonChallenge | null;
  } | null;
  readonly ceremony: CeremonyPresentation | null;
  readonly sessionOffer: SessionOffer | null;
}
/** One opened runtime is retained until close. No render opens another SQLite connection.
 * Mutations resolve after their exclusive durable transaction, then readSnapshot refreshes UI.
 * dispatchLesson commits step writes + checkpoint + optional global suspendFamily atomically.
 * foreground awaits rollover -> FSRS -> snapshot/reload -> notification rearm before resolving.
 * A missing pack/model is an explicit error; implementations must never substitute fixture data.
 */
export interface AppRuntime {
  readonly opened: OpenedProgressDb;
  readonly persistence: PersistenceStatus;
  readonly media: LessonMediaPort;
  readonly loop: Omit<LoopPorts, 'navigate' | 'launchHub'>;
  readonly notifications: Omit<NotificationSettingsPorts, 'continueOnboarding' | 'done'>;
  readSnapshot(): Promise<AppSnapshot>;
  handleOnboarding(event: OnboardingEvent): Promise<void>;
  launchLesson(request: LessonLaunch): Promise<void>;
  resolveSessionOffer(decision: SessionOfferDecision): Promise<void>;
  dispatchLesson(event: SessionEvent): Promise<void>;
  /** Idempotently consumes the already-generated completion writes; never computes a second reward.
   * Presentation may enter saving/failed/committed. dispatch + onComplete cannot double-commit. */
  completeLesson(): Promise<void>;
  reportItem(itemId: string, reason: string): Promise<void>;
  snoozeItem(itemId: string): Promise<void>;
  repairPack(): Promise<void>;
  readSurface(request: AppSurfaceRequest): Promise<AppDocument>;
  /** Invalidation may come from native permissions/downloads; never carries an intermediate snapshot. */
  subscribe(invalidate: () => void): () => void;
  foreground(): Promise<void>;
  background(): Promise<void>;
  close(): Promise<void>;
}
export interface FreelingoServices {
  /** Open/migrate SQLite once, initialize native adapters, and await the ordered foreground chain. */
  open(): Promise<AppRuntime>;
}
