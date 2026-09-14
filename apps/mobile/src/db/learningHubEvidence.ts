import type { Db } from '@freelingo/schema';
import { HUB_MODES, HUB_CONFIG, type HubPracticeMode } from '@freelingo/core/hub';
import { localDayOfStamp } from '@freelingo/core/day';
import type { SessionState } from '@freelingo/core/session';
import type { LearningContext } from './SqliteLearningContextStore';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import { LearningDataError } from './SqliteSchedulerStore';
import { practiceModesFor, readPracticeMistakeOrigins } from './learningHubSources';
function fail(): never {
  throw new LearningDataError('Saved Hub source or launch identity changed.');
}
export function hubModeAtLaunch(
  state: SessionState,
  context: LearningContext,
): { kind: HubPracticeMode; unitIndex: number | null } {
  const { launch } = context,
    origin = launch.origin;
  if (
    origin.kind !== 'hub' ||
    launch.targetNodeId !== null ||
    state.nodeRef !== origin.offerId ||
    origin.localDay !==
      localDayOfStamp(new Date(launch.start.startedAtUtcMs), launch.start.startZone) ||
    state.core.queue.length / HUB_CONFIG.target !== launch.practiceItemRatio
  )
    return fail();
  const prefix = origin.localDay + '/' + state.courseId + '/';
  const mode = HUB_MODES.find(
    (m) => m.flavour === launch.economyFlavour && origin.offerId.startsWith(prefix + m.kind + '/'),
  );
  if (!mode) return fail();
  const suffix = origin.offerId.slice((prefix + mode.kind + '/').length);
  if (mode.kind !== 'rewind') {
    if (suffix !== '') return fail();
    return { kind: mode.kind, unitIndex: null };
  }
  if (!/^(0|[1-9][0-9]*)$/.test(suffix) || !Number.isSafeInteger(Number(suffix))) return fail();
  return { kind: mode.kind, unitIndex: Number(suffix) };
}
export function hubSourceWasSupported(
  db: Db,
  state: SessionState,
  context: LearningContext,
  item: VerifiedRuntimeItem,
  unitIndex: number,
): boolean {
  const mode = hubModeAtLaunch(state, context);
  if (mode.unitIndex !== null && mode.unitIndex !== unitIndex) return false;
  const missed =
    mode.kind === 'mistakes'
      ? readPracticeMistakeOrigins(db, state.courseId, context.launch.start.startedAtUtcMs)
      : new Map();
  return practiceModesFor(
    {
      type: item.presentation.type,
      gradingFamily: item.gradable.family,
      targetItemIds: item.schedulerSurfaces.filter((s) => s.canonical).map((s) => s.itemId),
    },
    missed,
  ).includes(mode.kind);
}
