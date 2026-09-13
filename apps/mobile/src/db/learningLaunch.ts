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
  if (request.kind !== 'path')
    throw new LearningUnavailableError('This entry needs its declared learning source plan.');
  const preview = previewPathLaunch(db, ports, clock, courseId, request, startOver);
  const { pack, node, flavour, sourceByExercise } = preview;
  const config = DEFAULT_FLAVOUR_MATRIX[flavour];
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
    preview.day,
    String(preview.selectionSeed),
    preview.dueSources.map((s) => asItemId(s.item.itemId)),
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
  const generated = generatePathQueue(preview, sessionId);
  if (!generated.offered)
    throw new LearningUnavailableError(
      'There are not enough eligible authored exercises available right now.',
    );
  const boosts = readLearningBoosts(db, clock);
  persistLearningBoosts(db, boosts);
  const preferences = new SqlitePreferences(db, ports.modalityClock).readCourse(
    courseId,
  ).preferences;
  const state: SessionState = {
    sessionId,
    courseId,
    sessionKind: 'graded',
    nodeRef: node.id,
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
    nodeRef: node.id,
    start: {
      sessionId,
      startedAtUtcMs: clock.utcMs,
      startedAtMonotonicMs: clock.monotonicMs,
      startZone: clock.zone,
    },
    economyFlavour: flavour,
    practiceItemRatio:
      flavour === 'nodePractice' ? Math.min(1, generated.queue.length / config.targetLength) : 1,
    longFormEntry: null,
    boostAtStart: boosts.active,
    packContentHash: pack.contentHash,
    origin: { kind: 'path' },
    targetNodeId: node.id,
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
