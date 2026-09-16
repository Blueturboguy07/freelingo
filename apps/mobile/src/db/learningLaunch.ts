import type { Db } from '@freelingo/schema';
import {
  DEFAULT_FLAVOUR_MATRIX,
  EMPTY_IN_FLIGHT,
  COMBO_AT_SESSION_START,
  initialProgress,
  type StartOverPlan,
  type SessionState,
} from '@freelingo/core/session';
import { emptySessionModality } from '@freelingo/core/modality';
import { asItemId, type SchedulerState } from '@freelingo/core/scheduler';
import type { LessonLaunch } from '../app/ports';
import type { LearningRuntimePorts, LearningClock } from './learningRuntimePorts';
import { SqlitePreferences } from './SqlitePreferences';
import { SqlitePoolStore } from './SqlitePoolStore';
import { SqliteSchedulerStore, LearningDataError } from './SqliteSchedulerStore';
import type { LearningLaunch, LessonSlotBinding } from './SqliteLearningContextStore';
import { LearningUnavailableError, sourceBinding, registerSources } from './learningSources';
import { previewPathLaunch, generatePathQueue } from './learningLaunchPreview';
import { previewHubLaunch } from './learningHubLaunch';
import { readLearningBoosts, persistLearningBoosts } from './learningBoosts';
export interface PreparedLearningLaunch {
  readonly state: SessionState;
  readonly launch: LearningLaunch;
  readonly slots: readonly LessonSlotBinding[];
  readonly scheduler: SchedulerState;
}
/** Caller provides its exclusive transaction. No registration is an introduction event. */
export function prepareLearningLaunch(
  db: Db,
  ports: LearningRuntimePorts,
  clock: LearningClock,
  courseId: string,
  request: LessonLaunch,
  startOver?: StartOverPlan,
): PreparedLearningLaunch {
  if (request.kind === 'placement')
    throw new LearningUnavailableError('This entry needs its declared learning source plan.');
  const path =
    request.kind === 'path'
      ? previewPathLaunch(db, ports, clock, courseId, request, startOver)
      : null;
  const hub =
    request.kind === 'hub'
      ? previewHubLaunch(db, ports, clock, courseId, request.offer, startOver)
      : null;
  const preview = path ?? hub!;
  const { pack, sourceByExercise } = preview;
  const flavour = path?.flavour ?? hub!.policy.engineFlavour;
  const config = hub?.policy.config ?? DEFAULT_FLAVOUR_MATRIX[flavour];
  const nodeRef = path?.node.id ?? hub!.offer.id;
  const day = path?.day ?? hub!.input.localDay;
  const seed = path ? String(path.selectionSeed) : hub!.input.seed;
  const scheduler = registerSources(
    db,
    courseId,
    preview.scheduler,
    preview.registrationSources,
    clock,
  );
  new SqliteSchedulerStore(db).save(courseId, scheduler);
  new SqlitePoolStore(db).open(
    courseId,
    day,
    seed,
    path ? path.dueSources.map((s) => asItemId(s.item.itemId)) : hub!.poolItemIds,
    clock.utcMs,
  );
  const sessionId = ports.newSessionId();
  if (
    !sessionId.trim() ||
    db.get('SELECT session_id FROM committed_session WHERE session_id=?', [sessionId]) ||
    db.get('SELECT session_id FROM course_attempt WHERE session_id=?', [sessionId]) ||
    db.get('SELECT session_id FROM course_session_context WHERE session_id=?', [sessionId])
  )
    throw new LearningDataError('A fresh session identity is required.');
  const generated = path ? generatePathQueue(path, sessionId) : hub!.generate(sessionId);
  if (!generated.offered)
    throw new LearningUnavailableError(
      'There are not enough eligible authored exercises available right now.',
    );
  if (hub?.offer.reserveSharedReview) {
    const reserved = new SqlitePoolStore(db).reserve(
      courseId,
      day,
      'todaysReview',
      hub.offer.itemIds.map(asItemId),
    );
    if (reserved.served.length !== generated.queue.length)
      throw new LearningUnavailableError('The shared review pool changed.');
  }
  const boosts = readLearningBoosts(db, clock);
  persistLearningBoosts(db, boosts);
  const preferences = new SqlitePreferences(db, ports.modalityClock).readCourse(
    courseId,
  ).preferences;
  const state: SessionState = {
    sessionId,
    courseId,
    sessionKind: 'graded',
    nodeRef,
    flavour,
    core: {
      queue: generated.queue,
      index: 0,
      answers: [],
      hearts:
        config.mistakeAllowance === null
          ? { kind: 'infinite' }
          : { kind: 'pips', total: config.mistakeAllowance, remaining: config.mistakeAllowance },
      combo: COMBO_AT_SESSION_START,
      usedInterstitialKeys: [],
      inputMode: 'bank',
      hardMode: false,
      optionSeeds: generated.optionSeeds,
    },
    shellState: 'loading',
    inFlight: EMPTY_IN_FLIGHT,
    modality: emptySessionModality(),
    mistakes: [],
    progress: initialProgress(generated.queue.length),
    checkpointMonotonicMs: clock.monotonicMs,
    startedMonotonicMs: clock.monotonicMs,
    pendingInterstitialKeys: [],
    stepUpFired: false,
    motivationalMessages: preferences.motivationalMessages,
    mistakeReviewCopyKey: null,
    endReviewIntroShown: false,
    lastVerdict: null,
    currentReplay: null,
    inputModeExplicit: false,
    mistakeRows: [],
    weakItemRows: [],
    packNonLatinScript: pack.pack.meta.lang === 'ja',
    exited: null,
  };
  const launch: LearningLaunch = {
    courseId,
    sessionKind: 'graded',
    nodeRef,
    start: {
      sessionId,
      startedAtUtcMs: clock.utcMs,
      startedAtMonotonicMs: clock.monotonicMs,
      startZone: clock.zone,
    },
    economyFlavour: hub?.offer.flavour ?? flavour,
    practiceItemRatio:
      hub?.offer.practiceItemRatio ??
      (flavour === 'nodePractice' ? Math.min(1, generated.queue.length / config.targetLength) : 1),
    longFormEntry: null,
    boostAtStart: boosts.active,
    packContentHash: pack.contentHash,
    origin: hub
      ? { kind: 'hub', offerId: hub.offer.id, localDay: hub.offer.localDay }
      : { kind: 'path' },
    targetNodeId: path?.node.id ?? null,
  };
  const slots = generated.queue.map((q) => {
    const source = [...sourceByExercise.values()].find(
      (s) => `exercise:${s.item.exerciseId}` === q.id,
    );
    if (!source) throw new LearningDataError('Generated source receipt is missing.');
    return sourceBinding(source.item, q.id);
  });
  return { state, launch, slots, scheduler };
}
