import type { ExpectedResumeCandidate, ResumeInspection } from './learningResume';
import type { Db } from '@freelingo/schema';
import type { ZoneStamp } from '@freelingo/core/day';
import type { HubInput, HubDailyState } from '@freelingo/core/hub';
import type { ModalityClock } from '@freelingo/core/modality';
import type { SessionState, SessionEvent } from '@freelingo/core/session';
import type { LessonChallenge, LessonExposure } from '@freelingo/core/presentation';
import type { SchedulerState } from '@freelingo/core/scheduler';
import type { InstalledPackRepository } from '../packs/installedPackPorts';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import type { LessonLaunch, SessionOffer, SessionOfferDecision } from '../app/ports';
import type { CeremonyPresentation, CeremonyAdvance } from '../loop/contracts';
import type { PersistedDayState } from './SqliteDayStore';

export interface LearningClock {
  readonly utcMs: number;
  readonly monotonicMs: number;
  readonly zone: ZoneStamp;
}
/** Synchronous device facts, queried after the factory's awaited pack/native preparation.
 * Neither a capability check nor runtime construction may request permission. */
export interface LearningRuntimePorts {
  readonly packs: Pick<InstalledPackRepository, 'get'>;
  readonly clock: () => LearningClock;
  readonly modalityClock: () => ModalityClock | null;
  readonly newSessionId: () => string;
  readonly canPlayAudio: (courseId: string, item: VerifiedRuntimeItem) => boolean;
  readonly canRecognizeSpeech: (courseId: string, item: VerifiedRuntimeItem) => boolean;
  readonly hasTargetScriptInput: (language: string) => boolean;
  readonly reduceMotion: () => boolean;
  readonly screenReaderActive: () => boolean;
}
export type LearningExposure = LessonExposure;
export interface LearningSessionView {
  readonly exerciseId: string;
  readonly state: SessionState;
  readonly challenge: LessonChallenge | null;
}
/** One instance over the factory's one open database. Mutations serialize and resolve only
 * after durable success. All grading/reward/day/path decisions belong to this implementation.
 * The repository is refreshed BEFORE launch by the owner; answer transactions are synchronous.
 * The factory owns startup/course selection, publication, native rearm and the App navigation. */
export interface LearningRuntime {
  start(courseId: string, request: LessonLaunch): Promise<void>;
  resolveOffer(decision: SessionOfferDecision): Promise<void>;
  dispatch(event: SessionEvent): Promise<void>;
  complete(): Promise<void>;
  /** The UI reports a displayed role; the runtime resolves all source/surface IDs. */
  recordExposure(request: LearningExposure): Promise<void>;
  readSession(): LearningSessionView | null;
  readCeremony(): CeremonyPresentation | null;
  readOffer(): SessionOffer | null;
  readResumableCourse(courseId: string): ResumeInspection;
  prepareResumeOffer(courseId: string, expected: ExpectedResumeCandidate): Promise<void>;
  readScheduler(courseId: string): SchedulerState;
  readDay(): PersistedDayState;
  readHub(courseId: string): HubInput;
  saveHubDaily(state: HubDailyState): Promise<void>;
  advanceCeremony(request: CeremonyAdvance): Promise<void>;
  foreground(): Promise<void>;
  background(): Promise<void>;
}
export type LearningRuntimeConstructor = new (
  db: Db,
  ports: LearningRuntimePorts,
) => LearningRuntime;
