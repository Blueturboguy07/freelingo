import type { Db } from '@freelingo/schema';
import { allUnits, nodeUnlocked, isComplete, specFor } from '@freelingo/core/path';
import {
  generateSession,
  seedFor,
  DEFAULT_FLAVOUR_MATRIX,
  SESSION_FLAVOURS,
  EMPTY_IN_FLIGHT,
  COMBO_AT_SESSION_START,
  initialProgress,
  type SessionState,
  type SessionFlavour,
} from '@freelingo/core/session';
import { emptySessionModality } from '@freelingo/core/modality';
import {
  asItemId,
  planIntroductions,
  roleOfExerciseType,
  rowAt,
  isHeldAt,
  roleAllowedAt,
  type SchedulerState,
} from '@freelingo/core/scheduler';
import { localDayOfStamp } from '@freelingo/core/day';
import { activeBoostFrom, type PersistedBoost } from '@freelingo/core/economy';
import type { ActiveBoost } from '@freelingo/core/types';
import type { LessonLaunch } from '../app/ports';
import type { LearningRuntimePorts, LearningClock } from './learningRuntimePorts';
import { readPathModel } from '../services/readPathModel';
import { SqlitePreferences } from './SqlitePreferences';
import { SqlitePoolStore } from './SqlitePoolStore';
import { SqliteSchedulerStore, LearningDataError } from './SqliteSchedulerStore';
import type { LearningLaunch, LessonSlotBinding } from './SqliteLearningContextStore';
import {
  LearningUnavailableError,
  declaredNodeSources,
  queuedSource,
  sourceBinding,
  registerSources,
  sourceDeviceAllowed,
  sourceIsKnownAndEligible,
  sourceUnlockedAt,
  type RuntimeSource,
} from './learningSources';
export interface PreparedLearningLaunch {
  readonly state: SessionState;
  readonly launch: LearningLaunch;
  readonly slots: readonly LessonSlotBinding[];
  readonly scheduler: SchedulerState;
}
function boostAtStart(db: Db, clock: LearningClock): ActiveBoost | null {
  const rows = db.all('SELECT * FROM account_boost WHERE activated_at_utc IS NOT NULL');
  let active: ActiveBoost | null = null;
  for (const r of rows) {
    if (
      typeof r.grant_id !== 'string' ||
      !['xpBoost', 'timerBoost', 'happyHour', 'earlyBird'].includes(String(r.kind)) ||
      typeof r.activated_at_utc !== 'string' ||
      !Number.isFinite(Date.parse(r.activated_at_utc)) ||
      typeof r.tamper_high_water_utc !== 'string' ||
      !Number.isFinite(Date.parse(r.tamper_high_water_utc)) ||
      typeof r.multiplier !== 'number' ||
      !Number.isSafeInteger(r.multiplier) ||
      r.multiplier < 1 ||
      typeof r.activation_sequence_ms !== 'number' ||
      !Number.isFinite(r.activation_sequence_ms) ||
      r.activation_sequence_ms < 0 ||
      typeof r.duration_seconds !== 'number' ||
      !Number.isSafeInteger(r.duration_seconds) ||
      r.duration_seconds <= 0 ||
      typeof r.expires_at !== 'string' ||
      !Number.isFinite(Date.parse(r.expires_at))
    )
      throw new LearningDataError('Saved boost provenance is unavailable.');
    const persisted: PersistedBoost = {
      kind: r.kind as PersistedBoost['kind'],
      multiplier: r.multiplier,
      activatedAtUtc: r.activated_at_utc,
      activationSequenceMs: r.activation_sequence_ms,
      durationSeconds: r.duration_seconds,
      tamperHighWaterUtc: r.tamper_high_water_utc,
    };
    const result = activeBoostFrom(persisted, {
      nowUtc: new Date(clock.utcMs).toISOString(),
      sequenceMs: clock.monotonicMs,
    });
    // An observed expiry is durable. A reset sequence or restored wall clock cannot
    // revive that grant, and a previously shortened deadline can only shrink further.
    const expiry = Math.min(
      Date.parse(r.expires_at),
      result.active === null ? clock.utcMs : Date.parse(result.active.expiresAtUtc),
    );
    const running =
      result.active !== null && expiry > clock.utcMs
        ? { ...result.active, expiresAtUtc: new Date(expiry).toISOString() }
        : null;
    db.run('UPDATE account_boost SET tamper_high_water_utc=?,expires_at=? WHERE grant_id=?', [
      result.clamp.boost.tamperHighWaterUtc,
      new Date(expiry).toISOString(),
      r.grant_id,
    ]);
    if (running) {
      if (active) throw new LearningDataError('Multiple active boosts require recovery.');
      active = running;
    }
  }
  return active;
}
/** Caller provides its exclusive transaction. No registration is an introduction event. */
export function prepareLearningLaunch(
  db: Db,
  ports: LearningRuntimePorts,
  clock: LearningClock,
  courseId: string,
  request: LessonLaunch,
): PreparedLearningLaunch {
  const pack = ports.packs.get(courseId);
  if (!pack || pack.courseId !== courseId)
    throw new LearningUnavailableError('The verified course pack is unavailable.');
  const model = readPathModel(db, pack);
  if (request.kind !== 'path')
    throw new LearningUnavailableError('This entry needs its declared learning source plan.');
  const binding = pack.pack.path().forNode(request.request.nodeId),
    unit = allUnits(model)[binding.unitIndex];
  const nodeIndex = unit?.nodes.findIndex((n) => n.id === request.request.nodeId) ?? -1,
    node = unit?.nodes[nodeIndex];
  if (
    !node ||
    request.request.unitIndex !== binding.unitIndex ||
    !nodeUnlocked(model, binding.unitIndex, nodeIndex)
  )
    throw new LearningUnavailableError('This path node is not available.');
  const requested = request.request.flavour;
  if (!SESSION_FLAVOURS.includes(requested as SessionFlavour))
    throw new LearningUnavailableError('This node needs its declared player or assessment source.');
  const flavour = requested as SessionFlavour,
    config = DEFAULT_FLAVOUR_MATRIX[flavour],
    spec = specFor(node.type);
  const pathFlavour =
    flavour === 'nodePractice' ? 'practice' : flavour === 'endgameReview' ? 'endgame' : flavour;
  if (
    !spec.launchable.some((f) => f === pathFlavour) ||
    (flavour === 'legendary' && !isComplete(node))
  )
    throw new LearningUnavailableError('This flavour is not declared for this node.');
  if (flavour === 'lesson' && isComplete(node))
    throw new LearningUnavailableError('This completed node offers practice.');
  const all = declaredNodeSources(pack, node.id),
    selected =
      flavour === 'lesson' || flavour === 'unitReview'
        ? all.filter(
            (s) => s.item.lessonIndex === binding.node.sessions[node.subLessonsDone]?.lessonIndex,
          )
        : all;
  if (!selected.length)
    throw new LearningUnavailableError('The authored session population is unavailable.');
  let scheduler = new SqliteSchedulerStore(db).load(courseId, clock.zone.tzId);
  scheduler = registerSources(db, courseId, scheduler, all, clock);
  const day = localDayOfStamp(new Date(clock.utcMs), clock.zone),
    newIds = planIntroductions(
      scheduler.introductions,
      day,
      selected.flatMap((s) =>
        s.item.schedulerSurfaces.filter((t) => t.canonical).map((t) => asItemId(t.itemId)),
      ),
      scheduler.economy,
    );
  const newAllowed = new Set(newIds);
  const eligible = (source: RuntimeSource) => {
    const item = source.item;
    if (!sourceDeviceAllowed(db, ports, courseId, item)) return false;
    if (sourceIsKnownAndEligible(item, scheduler, clock)) return true;
    if (
      !config.mayIntroduceNewItems ||
      roleOfExerciseType(item.presentation.type) !== 'recognition'
    )
      return false;
    const canonical = item.schedulerSurfaces.filter((t) => t.canonical);
    return (
      canonical.length > 0 &&
      canonical.every((t) => {
        const existing = rowAt(scheduler, asItemId(t.itemId), t.surface);
        if (!existing || isHeldAt(existing, scheduler.holds, clock.utcMs)) return false;
        if (existing.introducedAt !== null)
          return (
            existing.introducedAt.getTime() <= clock.utcMs &&
            roleAllowedAt(
              scheduler.introductions,
              asItemId(t.itemId),
              'recognition',
              new Date(clock.utcMs),
              scheduler.economy,
            )
          );
        return (
          newAllowed.has(asItemId(t.itemId)) &&
          item.introductions.some(
            (i) =>
              i.when === 'prompt' &&
              i.surfaceId === t.surfaceId &&
              i.surface === t.surface &&
              i.language === pack.pack.meta.lang,
          )
        );
      })
    );
  };
  const candidates = selected.filter(eligible);
  const sourceByExercise = new Map(all.map((s) => [s.item.exerciseId, s]));
  // Ordinary path padding uses this frozen eligibility snapshot as provenance. It
  // does not masquerade as either of the two spent-marker entry points (2026-09-13).
  const due: RuntimeSource[] = [];
  for (const u of allUnits(model))
    for (let i = 0; i < u.nodes.length; i++) {
      const n = u.nodes[i]!;
      if (!sourceUnlockedAt(db, pack, model, { unitIndex: u.index, nodeIndex: i }, clock.utcMs))
        continue;
      for (const source of declaredNodeSources(pack, n.id)) {
        if (
          !sourceDeviceAllowed(db, ports, courseId, source.item) ||
          !sourceIsKnownAndEligible(source.item, scheduler, clock)
        )
          continue;
        const canonical = source.item.schedulerSurfaces.filter((t) => t.canonical);
        if (
          !canonical.every(
            (t) =>
              rowAt(scheduler, asItemId(t.itemId), t.surface)!.card.due.getTime() <= clock.utcMs,
          )
        )
          continue;
        due.push(source);
        sourceByExercise.set(source.item.exerciseId, source);
      }
    }
  due.sort((a, b) => {
    const time = (s: RuntimeSource) =>
      Math.min(
        ...s.item.schedulerSurfaces
          .filter((t) => t.canonical)
          .map((t) => rowAt(scheduler, asItemId(t.itemId), t.surface)!.card.due.getTime()),
      );
    return time(a) - time(b) || a.item.exerciseId.localeCompare(b.item.exerciseId);
  });
  new SqliteSchedulerStore(db).save(courseId, scheduler);
  const seedRow = db.get('SELECT selection_seed FROM account WHERE id=1');
  if (
    typeof seedRow?.selection_seed !== 'number' ||
    !Number.isSafeInteger(seedRow.selection_seed) ||
    seedRow.selection_seed < 0
  )
    throw new LearningDataError('The account selection seed is unavailable.');
  const pool = new SqlitePoolStore(db).open(
    courseId,
    day,
    String(seedRow.selection_seed),
    due.map((s) => asItemId(s.item.itemId)),
    clock.utcMs,
  );
  const dueInPool = due.filter((s) => pool.pool.itemIds.includes(asItemId(s.item.itemId)));
  const sessionId = ports.newSessionId();
  if (
    !sessionId.trim() ||
    db.get('SELECT session_id FROM committed_session WHERE session_id=?', [sessionId]) ||
    db.get('SELECT session_id FROM course_session_context WHERE session_id=?', [sessionId])
  )
    throw new LearningDataError('A fresh session identity is required.');
  const queueCandidates = candidates.map((s) => queuedSource(s, node.id)),
    padding = dueInPool.map((s) => queuedSource(s, node.id));
  const admitted = [...candidates, ...dueInPool];
  const ids = new Set(admitted.map((s) => s.item.itemId));
  const audioIds = new Set(
    admitted.filter((s) => ports.canPlayAudio(courseId, s.item)).map((s) => s.item.itemId),
  );
  const generated = generateSession({
    sessionId,
    courseId,
    nodeRef: node.id,
    flavour,
    candidates: queueCandidates,
    seed: seedFor(seedFor(0, String(seedRow.selection_seed)), sessionId),
    audio: { canProduce: (id) => audioIds.has(id) },
    pack: {
      resolves: (id) => ids.has(id),
      nodeRefOf: (id) => (ids.has(id) ? node.id : null),
      assetPresent: (id) =>
        admitted
          .filter((s) => s.item.itemId === id)
          .every((s) => !s.item.presentation.options?.some((o) => o.imageUri)),
    },
    modality: { gatedFamilies: () => [] },
    scheduler: {
      isSeen: (_course, id) => scheduler.introductions.firstIntroducedAt.has(asItemId(id)),
      duePool: () => padding,
      openMistakes: () => [],
      commit: () => {
        throw new LearningDataError('Generation cannot commit attempts.');
      },
    },
  });
  if (!generated.offered)
    throw new LearningUnavailableError(
      'There are not enough eligible authored exercises available right now.',
    );
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
    boostAtStart: boostAtStart(db, clock),
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
