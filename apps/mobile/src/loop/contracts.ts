import type { CeremonyResult, CeremonyState } from '@freelingo/core/ceremony';
import type { CourseActionPlan, PreferenceChange, PreferenceKey } from '@freelingo/core/course';
import type { GoalTierKey } from '@freelingo/core/economy';
import type { HubDailyState, HubOffer } from '@freelingo/core/hub';

export type LoopRoute =
  | 'settings'
  | 'preferences'
  | 'notifications'
  | 'goal'
  | 'courses'
  | 'data'
  | 'reports'
  | 'about'
  | 'words'
  | 'profile'
  | 'quests'
  | 'shop'
  | 'integrity'
  | 'credits'
  | 'path'
  | 'addCourse';
export type SettingsRoute = 'settings' | 'preferences' | 'goal' | 'courses';
export interface CourseSummary {
  readonly courseId: string;
  readonly name: string;
  readonly progressLabel: string;
  readonly audioBytes: number;
}
export interface SettingsSnapshot {
  readonly courseId: string;
  readonly nowUtc: string;
  readonly importedAtUtc: string | null;
  readonly preferences: Readonly<Record<PreferenceKey, boolean>>;
  readonly suspensions: { readonly listening: string | null; readonly speaking: string | null };
  readonly appearance: 'light' | 'dark' | 'system';
  readonly goalTier: GoalTierKey;
  readonly courses: readonly CourseSummary[];
  readonly appVersion: string;
}
export interface CeremonyFacts {
  readonly courseName: string;
  readonly combo: number;
  readonly accuracy: number | null;
  readonly xpExplanation: string;
  readonly unitIndex: number;
  readonly unitName: string;
  readonly sectionName: string;
  readonly score: number;
}
/** The committed variant may be supplied only after the exclusive reward transaction succeeds. */
export type CeremonyPresentation =
  | { readonly status: 'saving' }
  | { readonly status: 'failed'; readonly message: string }
  | {
      readonly status: 'committed';
      readonly state: CeremonyState;
      readonly result: CeremonyResult;
      readonly index: number;
      readonly facts: CeremonyFacts;
      readonly animations: boolean;
      readonly reduceMotion: boolean;
    };
export interface CeremonyAdvance {
  readonly sessionId: string;
  readonly expectedIndex: number;
  readonly nextIndex: number;
  readonly goalChoice:
    { readonly kind: 'choose'; readonly days: number } | { readonly kind: 'defer' } | null;
}
/** Root implements these against SQLite/native services. Completion means durable success.
 * Snapshot props must then refresh from storage; components never fabricate counters.
 * launchHub revalidates via prepareHubLaunch and reserves the shared pool in the same
 * transaction that creates the session. advanceCeremony is CAS on expectedIndex, not a reward write.
 */
export interface LoopPorts {
  navigate(route: LoopRoute): void;
  launchHub(offer: HubOffer): Promise<void>;
  saveHubDaily(state: HubDailyState): Promise<void>;
  switchCourse(courseId: string): Promise<void>;
  setPreference(courseId: string, change: PreferenceChange): Promise<void>;
  setAppearance(appearance: SettingsSnapshot['appearance']): Promise<void>;
  setGoal(key: GoalTierKey): Promise<void>;
  applyCourseAction(plan: CourseActionPlan): Promise<void>;
  advanceCeremony(request: CeremonyAdvance): Promise<void>;
  retryCommit(): Promise<void>;
  launchLegendary(sessionId: string): Promise<void>;
  shareCard(sessionId: string): Promise<void>;
  playWord(courseId: string, itemId: string, audioRef: string | null): Promise<void>;
}
