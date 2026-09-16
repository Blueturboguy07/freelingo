import type { Db } from '@freelingo/schema';
import type { HubPracticeMode } from '@freelingo/core/hub';
import type { PathModel } from '@freelingo/core/path';
import { EXERCISE_TYPES, exerciseSpec, type ExerciseType } from '@freelingo/core/session';
import type { SchedulerState } from '@freelingo/core/scheduler';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import type { LearningRuntimePorts, LearningClock } from './learningRuntimePorts';
import { SqliteMistakeStore } from './SqliteMistakeStore';
import { LearningDataError } from './SqliteSchedulerStore';
import {
  declaredNodeSources,
  sourceDeviceAllowed,
  sourceIsKnownAndEligible,
  sourceUnlockedAt,
  type RuntimeSource,
} from './learningSources';

interface PracticeShape {
  readonly type: ExerciseType;
  readonly gradingFamily: VerifiedRuntimeItem['gradable']['family'];
  readonly targetItemIds: readonly string[];
}
/** Capability of one whole reviewed exercise, never a fabricated subset of a MATCH grid. */
export function practiceModesFor(
  source: PracticeShape,
  missedTypes: ReadonlyMap<string, ExerciseType>,
): readonly HubPracticeMode[] {
  const spec = exerciseSpec(source.type);
  const modes: HubPracticeMode[] = ['today', 'target', 'rewind'];
  if (source.type === 'matchPairs' && source.gradingFamily === 'match') modes.push('words');
  if (spec.requiresAudio) modes.push('listen');
  if (spec.family === 'speaking') modes.push('speak');
  const missed = source.targetItemIds.flatMap((id) => {
    const type = missedTypes.get(id);
    return type === undefined ? [] : [type];
  });
  if (
    missed.length > 0 &&
    missed.every(
      (type) => type !== source.type && exerciseSpec(type).recycleTargets.includes(source.type),
    )
  )
    modes.push('mistakes');
  return modes;
}
/** Validate normalized history first, then read the latest wrong form, preserving the
 * exact scheduler target. Later correct reviews do not replace the missed form. */
export function readPracticeMistakeOrigins(
  db: Db,
  courseId: string,
  atUtcMs?: number,
): ReadonlyMap<string, ExerciseType> {
  const origins = new Map<string, ExerciseType>();
  const store = new SqliteMistakeStore(db);
  const history = atUtcMs === undefined ? store.load(courseId) : store.loadAt(courseId, atUtcMs);
  for (const mistake of history) {
    if (mistake.retiredAtUtcMs !== null) continue;
    const row = db.get(
      `SELECT p.exercise_type FROM course_mistake_encounter e
       JOIN course_attempt p ON p.course_id=e.course_id AND p.session_id=e.session_id AND p.exercise_index=e.exercise_index
       WHERE e.course_id=? AND e.item_id=? AND e.correct=0 AND (? IS NULL OR e.answered_at_utc_ms<=?) ORDER BY e.sequence DESC LIMIT 1`,
      [courseId, mistake.row.itemId, atUtcMs ?? null, atUtcMs ?? null],
    );
    const type = row?.exercise_type;
    if (typeof type !== 'string' || !EXERCISE_TYPES.some((declared) => declared === type))
      throw new LearningDataError('Practice Hub: mistake source exercise type is unavailable.');
    origins.set(mistake.row.itemId, type as ExerciseType);
  }
  return origins;
}
export interface HubPracticeSource {
  readonly source: RuntimeSource;
  readonly modes: readonly HubPracticeMode[];
}
/** The read model and launcher consume this same deterministic reviewed population. */
export function readHubPracticeSources(
  db: Db,
  ports: LearningRuntimePorts,
  clock: LearningClock,
  pack: VerifiedInstalledPack,
  path: PathModel,
  scheduler: SchedulerState,
  sources: readonly RuntimeSource[],
): readonly HubPracticeSource[] {
  const origins = readPracticeMistakeOrigins(db, pack.courseId);
  return sources.flatMap((source): HubPracticeSource[] => {
    const item = source.item;
    if (
      !sourceUnlockedAt(db, pack, path, source, clock.utcMs) ||
      !sourceDeviceAllowed(db, ports, pack.courseId, item) ||
      !sourceIsKnownAndEligible(item, scheduler, clock) ||
      // No verified picture inventory is available to this runtime yet.
      item.presentation.options?.some((option) => option.imageUri)
    )
      return [];
    return [
      {
        source,
        modes: practiceModesFor(
          {
            type: item.presentation.type,
            gradingFamily: item.gradable.family,
            targetItemIds: item.schedulerSurfaces.filter((s) => s.canonical).map((s) => s.itemId),
          },
          origins,
        ),
      },
    ];
  });
}

const indices = new WeakMap<VerifiedInstalledPack, readonly RuntimeSource[]>();
export function allHubSources(pack: VerifiedInstalledPack): readonly RuntimeSource[] {
  let existing = indices.get(pack);
  if (existing) return existing;
  existing = pack.pack
    .path()
    .sections.flatMap((section) =>
      section.units.flatMap((unit) =>
        unit.nodes.flatMap((node) => declaredNodeSources(pack, node.nodeId)),
      ),
    );
  indices.set(pack, existing);
  return existing;
}
