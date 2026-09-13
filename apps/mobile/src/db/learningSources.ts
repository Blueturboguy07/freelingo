import type { Db } from '@freelingo/schema';
import { allUnits, nodeUnlocked, type PathModel } from '@freelingo/core/path';
import { exerciseSpec, type QueuedItem } from '@freelingo/core/session';
import {
  asItemId,
  registerRows,
  rowAt,
  introduce,
  isHeldAt,
  roleAllowedAt,
  roleOfExerciseType,
  type SchedulerState,
} from '@freelingo/core/scheduler';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import type { LearningRuntimePorts, LearningClock } from './learningRuntimePorts';
import type { LessonSlotBinding } from './SqliteLearningContextStore';
import { LearningDataError } from './SqliteSchedulerStore';
import { SqlitePreferences } from './SqlitePreferences';
export class LearningUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearningUnavailableError';
  }
}
export interface RuntimeSource {
  readonly item: VerifiedRuntimeItem;
  readonly nodeId: string;
  readonly unitId: string;
  readonly unitIndex: number;
  readonly nodeIndex: number;
}
export function declaredNodeSources(
  pack: VerifiedInstalledPack,
  nodeId: string,
): readonly RuntimeSource[] {
  const path = pack.pack.path(),
    binding = path.forNode(nodeId);
  const unit = path.sections.flatMap((s) => s.units).find((u) => u.unitId === binding.unitId);
  const nodeIndex = unit?.nodes.findIndex((n) => n.nodeId === nodeId) ?? -1;
  if (nodeIndex < 0) throw new LearningDataError('Declared source node is unavailable.');
  return binding.node.sessions.flatMap((session) =>
    session.exerciseIds.map((id) => {
      const item = pack.runtimeItem(id);
      if (
        item.exerciseId !== id ||
        item.unitId !== binding.unitId ||
        item.lessonIndex !== session.lessonIndex ||
        item.itemId !== item.gradable.itemId ||
        item.itemId !== item.presentation.itemId
      )
        throw new LearningDataError('Authored source changed its declared destination.');
      if (
        !item.schedulerSurfaces.length ||
        item.schedulerSurfaces.some(
          (s) =>
            !s.itemRef.trim() ||
            !['lexeme', 'grapheme', 'grammarConcept'].includes(s.kind) ||
            s.language !== pack.pack.meta.lang,
        )
      )
        throw new LearningDataError('The scheduler source objective is unavailable.');
      if (item.gradable.rubySpans?.length)
        throw new LearningUnavailableError('Rendered ruby evidence is unavailable.');
      return { item, nodeId, unitId: binding.unitId, unitIndex: binding.unitIndex, nodeIndex };
    }),
  );
}
export function sourceBinding(item: VerifiedRuntimeItem, slotId: string): LessonSlotBinding {
  if (item.gradable.rubySpans?.length)
    throw new LearningUnavailableError('Rendered ruby evidence is unavailable.');
  const canonical = item.schedulerSurfaces.filter((s) => s.canonical);
  const surface =
    canonical.find((s) => s.itemId === item.itemId)?.surface ??
    (item.gradable.family === 'match' ? item.presentation.prompt : undefined);
  if (!surface?.trim()) throw new LearningDataError('The served target surface is undeclared.');
  return {
    slotId,
    exerciseId: item.exerciseId,
    itemId: item.itemId,
    surface,
    role: roleOfExerciseType(item.presentation.type),
    rubyShown: false,
  };
}
export function queuedSource(source: RuntimeSource, nodeRef: string): QueuedItem {
  const item = source.item,
    spec = exerciseSpec(item.presentation.type),
    canonical = item.schedulerSurfaces.filter((s) => s.canonical);
  const conceptId = canonical.length === 1 ? canonical[0]!.itemRef : item.itemId;
  return {
    id: `exercise:${item.exerciseId}`,
    itemId: item.itemId,
    type: item.presentation.type,
    family: spec.family,
    conceptId,
    nodeRef,
    requiresAudio: spec.requiresAudio,
  };
}
export interface SourceRegistrationProjection {
  readonly scheduler: SchedulerState;
  readonly newItems: readonly { readonly itemId: string; readonly countable: boolean }[];
}
/** Preview exact reviewed source registration without teaching, spending or SQL writes.
 * Planned rows participate in the same countability checks as already persisted rows. */
export function projectSourceRegistration(
  db: Pick<Db, 'get'>,
  courseId: string,
  state: SchedulerState,
  sources: readonly Pick<RuntimeSource, 'item'>[],
  clock: LearningClock,
): SourceRegistrationProjection {
  const pending = new Map<string, boolean>();
  const existingItem = (itemId: string) =>
    db.get('SELECT countable,quarantined FROM course_item WHERE course_id=? AND item_id=?', [
      courseId,
      itemId,
    ]) ??
    (pending.has(itemId) ? { countable: Number(pending.get(itemId)), quarantined: 0 } : undefined);
  let next = state;
  for (const source of sources) {
    // SQL exercise.item_id is an aggregate accuracy/scheduling anchor, never a distinct
    // lexical word. Semantic child targets require their own signed countability proof.
    const oldParent = existingItem(source.item.itemId);
    if (
      oldParent &&
      (oldParent.countable !== 0 || ![0, 1].includes(oldParent.quarantined as number))
    )
      throw new LearningDataError('Aggregate item history needs counter reconciliation.');
    if (!oldParent) pending.set(source.item.itemId, false);
    for (const surface of source.item.schedulerSurfaces) {
      if (surface.itemId !== source.item.itemId) {
        // The repository decoder proves the authored meaning and review hash. Join its
        // exact child surface here; aggregate parents remain non-countable above.
        const matches = source.item.lexicalBindings?.filter(
          (b) => b.schedulerItemId === surface.itemId && b.surfaceId === surface.surfaceId,
        );
        const binding = matches?.length === 1 ? matches[0] : undefined;
        if (
          surface.kind !== 'lexeme' ||
          !binding ||
          binding.surface !== surface.surface ||
          binding.language !== surface.language ||
          binding.lexemeId !== surface.itemRef ||
          typeof binding.countable !== 'boolean' ||
          !['word', 'particle', 'bound-morpheme', 'character'].includes(binding.classification) ||
          (binding.countable && binding.classification !== 'word') ||
          binding.proof.sourceId !== source.item.proof.sourceId ||
          binding.proof.sourceSha256 !== source.item.proof.sourceSha256
        )
          throw new LearningDataError('Lexical scheduler countability proof changed.');
        const oldChild = existingItem(surface.itemId);
        if (
          oldChild &&
          (oldChild.countable !== Number(binding.countable) ||
            ![0, 1].includes(oldChild.quarantined as number))
        )
          throw new LearningDataError('Saved lexical countability changed.');
        if (!oldChild) pending.set(surface.itemId, binding.countable);
      }
      const id = asItemId(surface.itemId),
        old = rowAt(next, id, surface.surface),
        spec = exerciseSpec(source.item.presentation.type);
      if (old && old.kind !== surface.kind)
        throw new LearningDataError('Saved scheduler objective changed.');
      const modality =
        spec.family === 'speaking' ? 'speaking' : spec.requiresAudio ? 'listening' : 'reading';
      next = registerRows(next, [
        { itemId: id, surface: surface.surface, kind: surface.kind, modalities: [modality] },
      ]);
      const registered = rowAt(next, id, surface.surface)!;
      if (!registered.modalities.includes(modality)) {
        const rows = new Map(next.rows);
        rows.set(registered.key, {
          ...registered,
          modalities: [...registered.modalities, modality],
        });
        next = { ...next, rows };
      }
      const receipt = db.get(
        'SELECT surface,language,observed_at_utc_ms FROM course_surface_exposure WHERE course_id=? AND surface_id=?',
        [courseId, surface.surfaceId],
      );
      if (receipt) {
        if (
          receipt.surface !== surface.surface ||
          receipt.language !== surface.language ||
          !Number.isSafeInteger(receipt.observed_at_utc_ms) ||
          !Number.isFinite(new Date(receipt.observed_at_utc_ms as number).getTime()) ||
          (receipt.observed_at_utc_ms as number) > clock.utcMs
        )
          throw new LearningDataError('Observed scheduler surface changed.');
        next = introduce(next, id, surface.surface, new Date(receipt.observed_at_utc_ms as number));
      }
    }
  }
  return {
    scheduler: next,
    newItems: [...pending].map(([itemId, countable]) => ({ itemId, countable })),
  };
}
/** Caller provides the write transaction. Preview and actual registration share every
 * source guard; no registry insert occurs until the whole projection validates. */
export function registerSources(
  db: Db,
  courseId: string,
  state: SchedulerState,
  sources: readonly Pick<RuntimeSource, 'item'>[],
  clock: LearningClock,
): SchedulerState {
  const projection = projectSourceRegistration(db, courseId, state, sources, clock);
  for (const row of projection.newItems)
    db.run('INSERT INTO course_item(course_id,item_id,countable,quarantined) VALUES(?,?,?,0)', [
      courseId,
      row.itemId,
      Number(row.countable),
    ]);
  return projection.scheduler;
}
/** Current eligibility and historical replay evidence are separate. A later unlock may
 * not retroactively authorize an earlier-node padding slot saved before it existed. */
export function sourceUnlockedAt(
  db: Db,
  pack: VerifiedInstalledPack,
  model: PathModel,
  source: Pick<RuntimeSource, 'unitIndex' | 'nodeIndex'>,
  at: number,
): boolean {
  if (!nodeUnlocked(model, source.unitIndex, source.nodeIndex)) return false;
  const units = allUnits(model),
    unit = units[source.unitIndex];
  if (!unit) return false;
  const completedBefore = (id: string) => {
    const row = db.get('SELECT completed_at FROM course_node WHERE course_id=? AND node_id=?', [
      pack.courseId,
      id,
    ]);
    return typeof row?.completed_at === 'string' && Date.parse(row.completed_at) <= at;
  };
  if (source.nodeIndex > 0 && !completedBefore(unit.nodes[source.nodeIndex - 1]!.id)) return false;
  if (source.unitIndex === 0) return true;
  const previous = units[source.unitIndex - 1]?.nodes.at(-1);
  if (previous && completedBefore(previous.id)) return true;
  const unitId = pack.pack.path().sections.flatMap((s) => s.units)[source.unitIndex]?.unitId;
  const claim = db.get(
    'SELECT s.completed_at_utc_ms FROM course_path_jump j JOIN committed_session s ON s.session_id=j.source_session_id WHERE j.course_id=? AND j.unit_id=?',
    [pack.courseId, unitId ?? ''],
  );
  return typeof claim?.completed_at_utc_ms === 'number' && claim.completed_at_utc_ms <= at;
}
export function sourceDeviceAllowed(
  db: Db,
  ports: LearningRuntimePorts,
  courseId: string,
  item: VerifiedRuntimeItem,
): boolean {
  // INV-A11Y-06: a gesture-graded source cannot enter a spoken-accessibility queue.
  // Any substitute must remain a separately declared, eligible source variant.
  if (
    ports.screenReaderActive() &&
    (item.gradable.family === 'character-trace' || item.presentation.type === 'characterTrace')
  )
    return false;
  if (
    [item.itemId, ...item.schedulerSurfaces.map((s) => s.itemId)].some(
      (id) =>
        db.get('SELECT quarantined FROM course_item WHERE course_id=? AND item_id=?', [
          courseId,
          id,
        ])?.quarantined === 1,
    )
  )
    return false;
  const prefs = new SqlitePreferences(db, ports.modalityClock).readCourse(courseId),
    spec = exerciseSpec(item.presentation.type);
  if (
    spec.requiresAudio &&
    (!prefs.preferences.listening ||
      prefs.suspensions.listening !== null ||
      !ports.canPlayAudio(courseId, item))
  )
    return false;
  if (
    spec.family === 'speaking' &&
    (!prefs.preferences.speaking ||
      prefs.suspensions.speaking !== null ||
      !ports.canRecognizeSpeech(courseId, item))
  )
    return false;
  if (item.presentation.requiresIme && !ports.hasTargetScriptInput(item.responseLanguage))
    return false;
  return true;
}
export function sourceIsKnownAndEligible(
  item: VerifiedRuntimeItem,
  state: SchedulerState,
  clock: LearningClock,
): boolean {
  const at = new Date(clock.utcMs),
    canonical = item.schedulerSurfaces.filter((s) => s.canonical);
  if (!canonical.length) return false;
  return canonical.every((s) => {
    const id = asItemId(s.itemId),
      row = rowAt(state, id, s.surface);
    return (
      row !== undefined &&
      row.introducedAt !== null &&
      row.introducedAt.getTime() <= clock.utcMs &&
      !isHeldAt(row, state.holds, at) &&
      roleAllowedAt(
        state.introductions,
        id,
        roleOfExerciseType(item.presentation.type),
        at,
        state.economy,
      )
    );
  });
}
