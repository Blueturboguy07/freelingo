import type { UiPreferences } from '@freelingo/ui';
import type { NotificationSettingsSnapshot } from '@freelingo/core/notifications';
import type { AppRuntime } from '../app/ports';
import type { OpenedProgressDb } from '../db/ExpoDb';
import type { PersistenceStatus } from '../db/startPersistence';
import type {
  LearningRuntimeConstructor,
  LearningRuntimePorts,
  LearningSessionView,
} from '../db/learningRuntimePorts';
import type { InstalledPackRepository } from '../packs/installedPackPorts';
import type { OnboardingFlowPorts } from './onboarding';

/** Required real platform bindings. This boundary has no fixture/default providers.
 * The native owner creates all resources against this one retained open database,
 * and cleans any partially-created resources if construction rejects. */
export interface FactoryResources {
  readonly packs: InstalledPackRepository;
  readonly media: AppRuntime['media'];
  readonly learning: Omit<LearningRuntimePorts, 'packs'>;
  readonly catalogue: OnboardingFlowPorts['catalogue'];
  readonly restore: OnboardingFlowPorts['restore'];
  readonly notifications: AppRuntime['notifications'] & {
    read(): NotificationSettingsSnapshot;
  };
  readonly actions: Pick<AppRuntime, 'reportItem' | 'snoozeItem' | 'readSurface'> &
    Pick<AppRuntime['loop'], 'applyCourseAction' | 'launchLegendary' | 'shareCard' | 'playWord'>;
  /** OS appearance/accessibility facts; saved appearance overrides only the theme. */
  readUi(): UiPreferences;
  /** Observed installed bytes, never expected manifest total. Null means unavailable. */
  audioBytesPresent(courseId: string): number | null;
  /** Prepare native facts without prompting. Publication reconciles widget/reminders
   * only after the durable day/session chain has finished. Neither writes rewards. */
  prepareForeground(): Promise<void>;
  /** Reconcile the exact saved session/slot/pack variant before its next snapshot.
   * Native owner deduplicates identical media bindings; null disarms hidden/background
   * lessons without starting playback, recording or a permission request. */
  activateLessonMedia(view: LearningSessionView | null): Promise<void>;
  publishAndRearm(): Promise<void>;
  background(): Promise<void>;
  subscribe(invalidate: () => void): () => void;
  /** Releases media/native subscriptions. Repository and database remain factory-owned. */
  close(): Promise<void>;
}
export interface FactoryBindings {
  readonly appVersion: string;
  /** Local random seed, generated only for a fresh account; stored seed wins on reopen. */
  newSelectionSeed(): number;
  openPersistence(): Promise<{
    readonly opened: OpenedProgressDb;
    readonly status: PersistenceStatus;
  }>;
  createResources(opened: OpenedProgressDb): Promise<FactoryResources>;
  readonly LearningRuntime: LearningRuntimeConstructor;
}
