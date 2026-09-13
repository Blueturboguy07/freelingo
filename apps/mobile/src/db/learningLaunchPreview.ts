import type { Db } from '@freelingo/schema';
import { allUnits, nodeUnlocked, isComplete, specFor, type PathNode } from '@freelingo/core/path';
import {
  generateSession,
  applyStartOverExclusion,
  seedFor,
  DEFAULT_FLAVOUR_MATRIX,
  SESSION_FLAVOURS,
  type StartOverPlan,
  type SessionFlavour,
  type QueuedItem,
  type GeneratedSession,
} from '@freelingo/core/session';
import {
  asItemId,
  planIntroductions,
  roleOfExerciseType,
  rowAt,
  isHeldAt,
  roleAllowedAt,
  openPoolDay,
  type SchedulerState,
  type ItemId,
} from '@freelingo/core/scheduler';
import { localDayOfStamp, type LocalDay } from '@freelingo/core/day';
import type { LessonLaunch } from '../app/ports';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import type { LearningRuntimePorts, LearningClock } from './learningRuntimePorts';
import { readPathModel } from '../services/readPathModel';
import { SqlitePoolStore } from './SqlitePoolStore';
import { SqliteSchedulerStore, LearningDataError } from './SqliteSchedulerStore';
import {
  LearningUnavailableError,
  declaredNodeSources,
  queuedSource,
  projectSourceRegistration,
  sourceDeviceAllowed,
  sourceIsKnownAndEligible,
  sourceUnlockedAt,
  type RuntimeSource,
} from './learningSources';
interface PathLaunchSources {
  readonly courseId: string;
  readonly pack: VerifiedInstalledPack;
  readonly node: PathNode;
  readonly flavour: SessionFlavour;
  readonly scheduler: SchedulerState;
  readonly registrationSources: readonly RuntimeSource[];
  readonly candidates: readonly RuntimeSource[];
  readonly dueSources: readonly RuntimeSource[];
  readonly dueInPool: readonly RuntimeSource[];
  readonly duePoolItemIds: readonly ItemId[];
  readonly sourceByExercise: ReadonlyMap<string, RuntimeSource>;
  readonly day: LocalDay;
  readonly selectionSeed: number;
  readonly startOver: StartOverPlan | undefined;
  readonly audioIds: ReadonlySet<string>;
}
export interface PathLaunchPreview extends PathLaunchSources, GeneratedSession {}
/** Exact source eligibility and the actual generator, without SQL writes, session-ID
 * allocation, boost changes or review reservations. A launcher recomputes this inside
 * its exclusive transaction; UI preview never becomes an authorization token. */
export function previewPathLaunch(
  db: Db,
  ports: LearningRuntimePorts,
  clock: LearningClock,
  courseId: string,
  request: Extract<LessonLaunch, { kind: 'path' }>,
  startOver?: StartOverPlan,
): PathLaunchPreview {
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
  scheduler = projectSourceRegistration(db, courseId, scheduler, all, clock).scheduler;
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
  const excluded = new Set(startOver?.excludedItemIds ?? []);
  const candidates = selected.filter(
    (source) => !excluded.has(source.item.itemId) && eligible(source),
  );
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
  const seedRow = db.get('SELECT selection_seed FROM account WHERE id=1');
  if (
    typeof seedRow?.selection_seed !== 'number' ||
    !Number.isSafeInteger(seedRow.selection_seed) ||
    seedRow.selection_seed < 0
  )
    throw new LearningDataError('The account selection seed is unavailable.');
  const pool = new SqlitePoolStore(db).load(courseId, day);
  const duePoolItemIds =
    pool?.pool.itemIds ??
    openPoolDay(
      day,
      due.map((s) => asItemId(s.item.itemId)),
    ).itemIds;
  const dueInPool = due.filter((s) => duePoolItemIds.includes(asItemId(s.item.itemId)));
  const admitted = [...candidates, ...dueInPool];
  const plan: PathLaunchSources = {
    courseId,
    pack,
    node,
    flavour,
    scheduler,
    registrationSources: all,
    candidates,
    dueSources: due,
    dueInPool,
    duePoolItemIds,
    sourceByExercise,
    day,
    selectionSeed: seedRow.selection_seed,
    startOver,
    audioIds: new Set(
      admitted.filter((s) => ports.canPlayAudio(courseId, s.item)).map((s) => s.item.itemId),
    ),
  };
  // The current generator orders by family/source and uses the session seed only for
  // option order. This names a preview calculation, never a durable session identity.
  return { ...plan, ...generatePathQueue(plan, 'read-only-path-preview') };
}
export function generatePathQueue(plan: PathLaunchSources, sessionId: string): GeneratedSession {
  const { courseId, node, flavour, scheduler, candidates, dueInPool, startOver, audioIds } = plan;
  const filter = (items: readonly QueuedItem[]) =>
    startOver ? applyStartOverExclusion(items, startOver) : items;
  const queueCandidates = filter(candidates.map((s) => queuedSource(s, node.id)));
  const padding = filter(dueInPool.map((s) => queuedSource(s, node.id)));
  const admitted = [...candidates, ...dueInPool];
  const ids = new Set(admitted.map((s) => s.item.itemId));
  return generateSession({
    sessionId,
    courseId,
    nodeRef: node.id,
    flavour,
    candidates: queueCandidates,
    seed: seedFor(seedFor(0, String(plan.selectionSeed)), sessionId),
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
}
