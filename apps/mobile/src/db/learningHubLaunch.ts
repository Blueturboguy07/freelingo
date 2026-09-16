import type { Db } from '@freelingo/schema';
import {
  buildHub,
  prepareHubLaunch,
  HUB_CONFIG,
  type HubInput,
  type HubOffer,
} from '@freelingo/core/hub';
import {
  generateSession,
  seedFor,
  type StartOverPlan,
  type GeneratedSession,
} from '@freelingo/core/session';
import { asItemId } from '@freelingo/core/scheduler';
import type { LearningClock, LearningRuntimePorts } from './learningRuntimePorts';
import { SqliteHubReadModel } from './SqliteHubReadModel';
import { SqliteSchedulerStore, LearningDataError } from './SqliteSchedulerStore';
import { readPathModel } from '../services/readPathModel';
import { allHubSources, readHubPracticeSources } from './learningHubSources';
import { learningSessionPolicy, isHubLearningFlavour } from './learningModePolicy';
import {
  LearningUnavailableError,
  projectSourceRegistration,
  queuedSource,
} from './learningSources';

/** A UI offer is a request, never a source authorization. Rebuild it in the launch
 * transaction, preserving the full physical population and exact mode capability. */
export function previewHubLaunch(
  db: Db,
  ports: LearningRuntimePorts,
  clock: LearningClock,
  courseId: string,
  offered: HubOffer,
  startOver?: StartOverPlan,
) {
  const fixedPorts = { ...ports, clock: () => clock };
  let input: HubInput = new SqliteHubReadModel(db, fixedPorts).read(courseId);
  if (startOver) {
    const excluded = new Set(startOver.excludedItemIds);
    input = {
      ...input,
      practiceItems: input.practiceItems?.filter((i) => !excluded.has(i.itemId)),
    };
  }
  const fresh = buildHub(input).modes.find((m) => m.offer?.id === offered.id)?.offer;
  if (
    !fresh ||
    fresh.kind === 'path' ||
    offered.kind === 'path' ||
    !isHubLearningFlavour(fresh.flavour)
  )
    throw new LearningUnavailableError('This Hub source plan is unavailable.');
  if (startOver) {
    // Explicit Start Over requests the same mode with a regenerated eligible set.
    // The old award/items can change after the old graded quit is committed.
    for (const field of [
      'id',
      'courseId',
      'localDay',
      'kind',
      'flavour',
      'nodeId',
      'unitIndex',
    ] as const)
      if (fresh[field] !== offered[field])
        throw new LearningUnavailableError('The Hub restart identity changed.');
  } else prepareHubLaunch(input, offered);
  const pack = ports.packs.get(courseId);
  if (!pack || pack.courseId !== courseId)
    throw new LearningUnavailableError('The verified course pack is unavailable.');
  const mode = fresh.kind;
  const path = readPathModel(db, pack),
    before = new SqliteSchedulerStore(db).load(courseId, clock.zone.tzId);
  const available = readHubPracticeSources(
    db,
    ports,
    clock,
    pack,
    path,
    before,
    allHubSources(pack),
  );
  const candidates = fresh.itemIds.map((id) => {
    const choices = available.filter(
      (s) =>
        s.source.item.itemId === id &&
        s.modes.includes(mode) &&
        (fresh.kind !== 'rewind' || s.source.unitIndex === fresh.unitIndex),
    );
    if (!choices.length)
      throw new LearningUnavailableError('The offered practice variant is no longer available.');
    return choices[0]!.source;
  });
  if (new Set(candidates.map((s) => s.item.itemId)).size !== fresh.itemIds.length)
    throw new LearningDataError('Hub physical population changed.');
  const registrationSources = available.map((s) => s.source);
  const scheduler = projectSourceRegistration(
    db,
    courseId,
    before,
    registrationSources,
    clock,
  ).scheduler;
  const policy = learningSessionPolicy({
    economyFlavour: fresh.flavour,
    origin: { kind: 'hub', offerId: fresh.id, localDay: fresh.localDay },
    targetNodeId: null,
  });
  const sourceByExercise = new Map(candidates.map((s) => [s.item.exerciseId, s]));
  const ids = new Set(candidates.map((s) => s.item.itemId));
  const audioIds = new Set(
    candidates.filter((s) => ports.canPlayAudio(courseId, s.item)).map((s) => s.item.itemId),
  );
  const generate = (sessionId: string): GeneratedSession =>
    generateSession(
      {
        sessionId,
        courseId,
        nodeRef: fresh.id,
        flavour: policy.engineFlavour,
        candidates: candidates.map((s) => queuedSource(s, fresh.id)),
        seed: seedFor(seedFor(0, input.seed), sessionId),
        audio: { canProduce: (id) => audioIds.has(id) },
        pack: {
          resolves: (id) => ids.has(id),
          nodeRefOf: (id) => (ids.has(id) ? fresh.id : null),
          assetPresent: () => true,
        },
        modality: { gatedFamilies: () => [] },
        scheduler: {
          // The shared resolver proved ALL exact canonical target introductions/delays.
          // A MATCH's aggregate need not have a fabricated introduction of its own.
          isSeen: (_course, id) => ids.has(id),
          duePool: () => [],
          openMistakes: () => [],
          commit: () => {
            throw new LearningDataError('Hub generation cannot commit attempts.');
          },
        },
      },
      { flavours: { row: () => policy.config } },
    );
  const generated = generate('read-only-hub-preview');
  if (
    !generated.offered ||
    generated.queue.length !== fresh.itemIds.length ||
    generated.queue.length / HUB_CONFIG.target !== fresh.practiceItemRatio
  )
    throw new LearningUnavailableError('The advertised Hub population cannot be generated.');
  return {
    pack,
    offer: fresh,
    input,
    policy,
    scheduler,
    registrationSources,
    sourceByExercise,
    generate,
    poolItemIds: input.sharedReview.itemIds.map(asItemId),
    ...generated,
  };
}
