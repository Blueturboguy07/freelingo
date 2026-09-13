import type { Db } from '@freelingo/schema';
import { exerciseSpec, type QueuedItem, type SessionState } from '@freelingo/core/session';
import type { LessonExposure } from '@freelingo/core/presentation';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import type { LearningRuntimePorts, LearningSessionView } from './learningRuntimePorts';
import { SqliteSessionStore } from './SqliteSessionStore';
import {
  SqliteLearningContextStore,
  type LearningContext,
  type LessonSlotBinding,
} from './SqliteLearningContextStore';
import { LearningDataError } from './SqliteSchedulerStore';

function fail(message: string): never {
  throw new LearningDataError(message);
}
interface ActiveSource {
  readonly state: SessionState;
  readonly context: LearningContext;
  readonly queued: QueuedItem;
  readonly binding: LessonSlotBinding;
  readonly pack: VerifiedInstalledPack;
  readonly item: VerifiedRuntimeItem;
}
/** One database owner. The source resolver never substitutes a different exercise variant;
 * actual observed surfaces are independent from successful answers and FSRS encounters.
 * Launch/dispatch/completion methods are being assembled against this same durable owner. */
export class SqliteLearningRuntime {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly db: Db,
    private readonly ports: LearningRuntimePorts,
  ) {}
  private serial(work: () => void): Promise<void> {
    const next = this.pending.then(work);
    this.pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private activeSource(): ActiveSource | null {
    const state = new SqliteSessionStore(this.db).activeGraded();
    if (!state || state.exited !== null) return null;
    const activeCourse = this.db.get('SELECT course_id FROM course_selection WHERE is_active=1');
    if (activeCourse?.course_id !== state.courseId) return null;
    const context = new SqliteLearningContextStore(this.db).load(state.courseId, state.sessionId);
    if (
      !context ||
      context.launch.sessionKind !== state.sessionKind ||
      context.launch.nodeRef !== state.nodeRef
    )
      return fail('Saved session context does not match its checkpoint.');
    const queued = state.currentReplay?.item ?? state.core.queue[state.core.index];
    if (!queued) return null;
    const binding = context.slots.find((s) => s.slotId === queued.id);
    if (!binding || binding.itemId !== queued.itemId || queued.nodeRef !== state.nodeRef)
      return fail('Saved exercise binding is unavailable.');
    const pack = this.ports.packs.get(state.courseId);
    if (
      !pack ||
      pack.courseId !== state.courseId ||
      pack.contentHash !== context.launch.packContentHash
    )
      return fail('The saved lesson requires its original verified pack.');
    const item = pack.runtimeItem(binding.exerciseId);
    if (
      item.exerciseId !== binding.exerciseId ||
      item.itemId !== binding.itemId ||
      item.presentation.itemId !== binding.itemId ||
      item.gradable.itemId !== binding.itemId ||
      item.presentation.type !== queued.type
    )
      return fail('The decoded exercise does not match the saved variant.');
    const path = pack.pack.path();
    const targetNode = context.launch.targetNodeId;
    if (context.launch.origin.kind === 'path' && targetNode !== state.nodeRef)
      return fail('Saved path node changed.');
    const destinations =
      targetNode !== null
        ? [path.forNode(targetNode)]
        : path.sections.flatMap((section) =>
            section.units.flatMap((unit) =>
              unit.nodes.map((node) => ({ node, unitId: unit.unitId })),
            ),
          );
    if (
      !destinations.some(
        (destination) =>
          destination.unitId === item.unitId &&
          destination.node.sessions.some(
            (session) =>
              session.lessonIndex === item.lessonIndex &&
              session.exerciseIds.includes(item.exerciseId),
          ),
      )
    )
      return fail('The saved exercise no longer belongs to its declared node.');
    return { state, context, queued, binding, pack, item };
  }
  readSession(): LearningSessionView | null {
    const source = this.activeSource();
    return source
      ? {
          exerciseId: source.binding.exerciseId,
          state: source.state,
          challenge: source.item.presentation,
        }
      : null;
  }
  /** Only actual render callbacks create observations. Stale callbacks are harmless no-ops;
   * a current callback whose saved pack/evidence is corrupt raises recoverable data error. */
  recordExposure(request: LessonExposure): Promise<void> {
    return this.serial(() =>
      this.db.withExclusiveTransaction(() => {
        const state = new SqliteSessionStore(this.db).activeGraded();
        if (!state || request.sessionId !== state.sessionId) return;
        const current = state.currentReplay?.item ?? state.core.queue[state.core.index];
        if (!current || request.slotId !== current.id || request.itemId !== current.itemId) return;
        const source = this.activeSource();
        if (!source || request.exerciseId !== source.binding.exerciseId) return;
        const { item, pack } = source;
        const visible = [
          'challenge.idle',
          'challenge.armed',
          'grading',
          'banner.correct',
          'banner.softCorrect',
          'banner.wrong',
          'quitDialog',
        ].includes(state.shellState);
        if (request.when === 'wrong-feedback') {
          if (state.shellState !== 'banner.wrong' || state.lastVerdict?.kind !== 'wrong') return;
        } else if (request.when === 'prompt') {
          if (
            !visible ||
            (exerciseSpec(item.presentation.type).requiresAudio &&
              item.presentation.type !== 'completeChat')
          )
            return;
        } else return fail('Unknown lesson display role.');
        const at = this.ports.clock().utcMs;
        if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime()))
          return fail('Invalid observation clock.');
        const language = pack.pack.meta.lang;
        if (typeof language !== 'string' || !language.trim())
          return fail('Verified pack target language is missing.');
        for (const exposure of item.introductions) {
          if (exposure.when !== request.when || exposure.language !== language) continue;
          const rendered =
            request.when === 'prompt'
              ? item.presentation.prompt
              : item.presentation.acceptedAnswers[0];
          const renderedLanguage =
            request.when === 'prompt'
              ? (item.presentation.promptLanguage ?? item.presentation.language)
              : item.responseLanguage;
          if (
            typeof exposure.surfaceId !== 'string' ||
            !exposure.surfaceId.trim() ||
            !exposure.surface.trim() ||
            exposure.surface !== rendered ||
            exposure.language !== renderedLanguage
          )
            return fail('Observed surface does not match the displayed source.');
          const old = this.db.get(
            'SELECT * FROM course_surface_exposure WHERE course_id=? AND surface_id=?',
            [state.courseId, exposure.surfaceId],
          );
          if (old) {
            if (old.surface !== exposure.surface || old.language !== exposure.language)
              return fail('Observed surface identity changed.');
            continue;
          }
          this.db.run(
            'INSERT INTO course_surface_exposure(course_id,surface_id,surface,language,session_id,slot_id,exercise_id,pack_content_hash,display_role,observed_at_utc_ms) VALUES(?,?,?,?,?,?,?,?,?,?)',
            [
              state.courseId,
              exposure.surfaceId,
              exposure.surface,
              exposure.language,
              state.sessionId,
              request.slotId,
              request.exerciseId,
              pack.contentHash,
              request.when,
              at,
            ],
          );
        }
      }),
    );
  }
}
