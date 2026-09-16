import type { Db } from '@freelingo/schema';
import { buildHub, type HubInput, type HubDailyState } from '@freelingo/core/hub';
import {
  readResumeCandidate,
  type ResumeInspection,
  type ExpectedResumeCandidate,
} from './learningResume';
import { SqliteHubReadModel } from './SqliteHubReadModel';
import { hubModeAtLaunch, hubSourceWasSupported } from './learningHubEvidence';
import { allHubSources } from './learningHubSources';
import {
  planStartOver,
  quitDecision,
  type StartOverPlan,
  exerciseSpec,
  step,
  resumeDecision,
  type SessionEvent,
  type StepDeps,
  type QueuedItem,
  type SessionState,
} from '@freelingo/core/session';
import type { LessonExposure } from '@freelingo/core/presentation';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import type { LearningRuntimePorts, LearningSessionView } from './learningRuntimePorts';
import { SqliteSessionStore } from './SqliteSessionStore';
import { SqliteWordStore } from './SqliteWordStore';
import {
  SqliteLearningContextStore,
  type LearningContext,
  type LessonSlotBinding,
} from './SqliteLearningContextStore';
import { LearningDataError, SqliteSchedulerStore } from './SqliteSchedulerStore';
import { type SchedulerState, asItemId, rowAt } from '@freelingo/core/scheduler';
import { localDayOfStamp } from '@freelingo/core/day';
import { SqliteDayStore, type PersistedDayState } from './SqliteDayStore';
import { SqlitePreferences } from './SqlitePreferences';
import { gradeRuntimeItem, targetsForRuntimeAnswer, type RuntimeGrade } from './learningGrading';
import { shouldStepUp } from './learningSessionPolicy';
import { prepareLearningLaunch } from './learningLaunch';
import { completionIntentFor } from './learningCompletionIntent';
import {
  LearningUnavailableError,
  registerSources,
  sourceBinding,
  sourceDeviceAllowed,
  sourceIsKnownAndEligible,
  sourceUnlockedAt,
} from './learningSources';
import { readPathModel } from '../services/readPathModel';
import { SqlitePoolStore } from './SqlitePoolStore';
import { SqliteCeremonyStore } from './SqliteCeremonyStore';
import { commitLearning } from './learningCompletion';
import type { CeremonyPresentation, CeremonyAdvance } from '../loop/contracts';
import type { LessonLaunch, SessionOffer, SessionOfferDecision } from '../app/ports';
import { validateLearningSessionPolicy, learningSessionPolicy } from './learningModePolicy';

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
    validateLearningSessionPolicy(state, context.launch);
    const pack = this.ports.packs.get(state.courseId);
    if (
      !pack ||
      pack.courseId !== state.courseId ||
      pack.contentHash !== context.launch.packContentHash
    )
      return fail('The saved lesson requires its original verified pack.');
    const current = state.currentReplay?.item ?? state.core.queue[state.core.index];
    const prior = state.core.answers.at(-1);
    const binding = context.slots.find((s) => s.slotId === (current?.id ?? prior?.slotId));
    if (!binding) return fail('Saved exercise binding is unavailable.');
    let queued = current;
    if (!queued) {
      if (!prior || !['interstitial', 'mistakeReview', 'outOfHearts'].includes(state.shellState))
        return fail('A challenge has no current queue slot.');
      const previous = pack.runtimeItem(binding.exerciseId),
        spec = exerciseSpec(previous.presentation.type),
        canonical = previous.schedulerSurfaces.filter((s) => s.canonical);
      queued = {
        id: binding.slotId,
        itemId: prior.itemId,
        type: prior.type,
        family: spec.family,
        nodeRef: state.nodeRef,
        conceptId: canonical.length === 1 ? canonical[0]!.itemRef : previous.itemId,
        requiresAudio: spec.requiresAudio,
      };
    }
    const item = this.savedItem(state, context, queued, binding, pack);
    return { state, context, queued, binding, pack, item };
  }
  private savedItem(
    state: SessionState,
    context: LearningContext,
    queued: QueuedItem,
    binding: LessonSlotBinding,
    pack: VerifiedInstalledPack,
  ): VerifiedRuntimeItem {
    const item = pack.runtimeItem(binding.exerciseId),
      canonical = sourceBinding(item, binding.slotId);
    if (
      item.exerciseId !== binding.exerciseId ||
      item.itemId !== binding.itemId ||
      item.itemId !== queued.itemId ||
      item.presentation.itemId !== item.itemId ||
      item.gradable.itemId !== item.itemId ||
      item.presentation.type !== queued.type ||
      queued.nodeRef !== state.nodeRef ||
      canonical.surface !== binding.surface ||
      canonical.role !== binding.role ||
      canonical.rubyShown !== binding.rubyShown
    )
      return fail('The decoded exercise does not match the saved variant.');
    const path = pack.pack.path(),
      target = context.launch.targetNodeId;
    if (context.launch.origin.kind === 'path' && target !== state.nodeRef)
      return fail('Saved path node changed.');
    const contains = (
      node: { sessions: readonly { lessonIndex: number; exerciseIds: readonly string[] }[] },
      unitId: string,
    ) =>
      unitId === item.unitId &&
      node.sessions.some(
        (session) =>
          session.lessonIndex === item.lessonIndex && session.exerciseIds.includes(item.exerciseId),
      );
    if (target !== null) {
      const destination = path.forNode(target);
      if (contains(destination.node, destination.unitId)) return item;
    }
    if (!Array.isArray(path.sections as unknown))
      return fail('The saved exercise no longer belongs to its declared node.');
    const placements = path.sections.flatMap((section) =>
      section.units.flatMap((unit) =>
        unit.nodes.filter((node) => contains(node, unit.unitId)).map((node) => ({ node, unit })),
      ),
    );
    if (placements.length !== 1)
      return fail('The saved exercise no longer belongs to one declared node.');
    if (context.launch.origin.kind !== 'path' && context.launch.origin.kind !== 'hub')
      return fail('Saved non-path source planning evidence is unavailable.');
    const placement = placements[0]!,
      position = path.forNode(placement.node.nodeId),
      start = context.launch.start;
    const hub = context.launch.origin.kind === 'hub' ? hubModeAtLaunch(state, context) : null;
    if (hub && !hubSourceWasSupported(this.db, state, context, item, position.unitIndex))
      return fail('Saved Hub source did not support its requested mode.');
    const day = localDayOfStamp(new Date(start.startedAtUtcMs), start.startZone);
    const header = this.db.get(
      'SELECT opened_at_utc_ms FROM course_review_pool_day WHERE course_id=? AND local_day=?',
      [state.courseId, day],
    );
    const pool = new SqlitePoolStore(this.db).load(state.courseId, day);
    if (
      (!hub || hub.kind === 'today') &&
      (!header ||
        typeof header.opened_at_utc_ms !== 'number' ||
        header.opened_at_utc_ms > start.startedAtUtcMs ||
        !pool?.pool.itemIds.includes(asItemId(item.itemId)) ||
        (hub?.kind === 'today' && pool.pool.spentBy.get(asItemId(item.itemId)) !== 'todaysReview'))
    )
      return fail('Earlier-node source lacks its frozen launch pool receipt.');
    const at = {
      utcMs: start.startedAtUtcMs,
      monotonicMs: start.startedAtMonotonicMs,
      zone: start.startZone,
    };
    const scheduler = new SqliteSchedulerStore(this.db).load(state.courseId, start.startZone.tzId);
    if (
      !sourceIsKnownAndEligible(item, scheduler, at) ||
      !sourceUnlockedAt(
        this.db,
        pack,
        readPathModel(this.db, pack),
        {
          unitIndex: position.unitIndex,
          nodeIndex: placement.unit.nodes.findIndex((n) => n.nodeId === placement.node.nodeId),
        },
        at.utcMs,
      )
    )
      return fail('Earlier-node source was not eligible when this session started.');
    return item;
  }
  readSession(): LearningSessionView | null {
    const source = this.activeSource();
    return source
      ? {
          exerciseId: source.binding.exerciseId,
          state: source.state,
          challenge:
            source.state.currentReplay !== null ||
            source.state.core.index < source.state.core.queue.length
              ? source.item.presentation
              : null,
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
        const clock = this.clock(),
          at = clock.utcMs;
        const observedSurfaceIds: string[] = [];
        if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime()))
          return fail('Invalid observation clock.');
        const language = pack.pack.meta.lang;
        if (typeof language !== 'string' || !language.trim())
          return fail('Verified pack target language is missing.');
        for (const exposure of item.introductions) {
          if (exposure.when !== request.when || exposure.language !== language) continue;
          let rendered: string | undefined;
          let renderedLanguage: string;
          if (exposure.location === 'option') {
            const options = item.presentation.options?.filter((o) => o.id === exposure.optionId);
            const option = options?.length === 1 ? options[0] : undefined;
            if (
              request.when !== 'prompt' ||
              item.presentation.type !== 'pictureSelect' ||
              item.presentation.introduction !== 'word' ||
              !option ||
              item.presentation.language !== language ||
              !item.gradable.accepted.some(
                (a) => a.surfaceId === exposure.surfaceId && a.surface === exposure.surface,
              ) ||
              !item.schedulerSurfaces.some(
                (s) =>
                  s.kind === 'lexeme' &&
                  s.surfaceId === exposure.surfaceId &&
                  s.surface === exposure.surface &&
                  s.language === language,
              )
            )
              return fail('Observed option is not the declared correct NEW WORD target.');
            rendered = option.text;
            renderedLanguage = item.presentation.language;
          } else {
            rendered =
              request.when === 'prompt'
                ? item.presentation.prompt
                : item.presentation.acceptedAnswers[0];
            renderedLanguage =
              request.when === 'prompt'
                ? (item.presentation.promptLanguage ?? item.presentation.language)
                : item.responseLanguage;
          }
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
          } else
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
          const exact = this.db.get(
            'SELECT * FROM course_source_exposure WHERE course_id=? AND surface_id=? AND exercise_id=? AND pack_content_hash=?',
            [state.courseId, exposure.surfaceId, item.exerciseId, pack.contentHash],
          );
          if (exact) {
            if (exact.surface !== exposure.surface || exact.language !== exposure.language)
              return fail('Observed source identity changed.');
          } else
            this.db.run('INSERT INTO course_source_exposure VALUES(?,?,?,?,?,?,?,?,?,?)', [
              state.courseId,
              exposure.surfaceId,
              exposure.surface,
              exposure.language,
              state.sessionId,
              request.slotId,
              item.exerciseId,
              pack.contentHash,
              request.when,
              at,
            ]);
          observedSurfaceIds.push(exposure.surfaceId);
        }
        if (!observedSurfaceIds.length) return;
        // Display, first teaching instant, and semantic vocabulary identity survive
        // together even when the process dies before the next answer callback.
        const db = this.scopedDb(),
          scheduler = new SqliteSchedulerStore(db);
        scheduler.save(
          state.courseId,
          registerSources(
            db,
            state.courseId,
            scheduler.load(state.courseId, clock.zone.tzId),
            [{ item }],
            clock,
          ),
        );
        const words = new SqliteWordStore(db);
        for (const surfaceId of observedSurfaceIds)
          words.recordIntroduction({
            courseId: state.courseId,
            packContentHash: pack.contentHash,
            item,
            surfaceId,
          });
      }),
    );
  }
  private activeClock: { sessionId: string; monotonicMs: number } | null = null;
  private foregrounded = false;
  private clock() {
    const clock = this.ports.clock();
    if (
      !Number.isSafeInteger(clock.utcMs) ||
      !Number.isFinite(new Date(clock.utcMs).getTime()) ||
      !Number.isFinite(clock.monotonicMs) ||
      clock.monotonicMs < 0
    )
      return fail('Invalid learning clock.');
    return clock;
  }
  /** Store adapters join this one outer transaction. They never open nested native transactions. */
  private scopedDb(): Db {
    return {
      run: this.db.run.bind(this.db),
      all: this.db.all.bind(this.db),
      get: this.db.get.bind(this.db),
      withExclusiveTransaction: (work) => work(),
      close: () => {
        throw new LearningDataError('A transaction view cannot close the database.');
      },
    };
  }
  private accrueActive(state: SessionState, at: number, db: Db): void {
    const prior = this.activeClock;
    if (
      this.foregrounded &&
      prior?.sessionId === state.sessionId &&
      state.exited === null &&
      !['quitDialog', 'tips', 'interstitial', 'mistakeReview', 'outOfHearts'].includes(
        state.shellState,
      )
    ) {
      const delta = Math.max(0, Math.floor(at - prior.monotonicMs));
      if (delta > 0)
        new SqliteLearningContextStore(db).addActiveMs(state.courseId, state.sessionId, delta);
    }
  }
  readScheduler(courseId: string): SchedulerState {
    return new SqliteSchedulerStore(this.db).load(courseId, this.clock().zone.tzId);
  }
  readHub(courseId: string): HubInput {
    return new SqliteHubReadModel(this.db, this.ports).read(courseId);
  }
  saveHubDaily(state: HubDailyState): Promise<void> {
    return this.serial(() => new SqliteHubReadModel(this.db, this.ports).save(state));
  }
  readDay(): PersistedDayState {
    return new SqliteDayStore(this.db).load();
  }
  foreground(): Promise<void> {
    return this.serial(() => {
      const clock = this.clock(),
        state = new SqliteSessionStore(this.db).activeGraded();
      // A process restart/background gap is never inferred as time spent answering.
      this.foregrounded = true;
      this.activeClock =
        state && state.exited === null
          ? { sessionId: state.sessionId, monotonicMs: clock.monotonicMs }
          : null;
      if (state?.exited !== null && state !== null) this.completeNow();
    });
  }
  background(): Promise<void> {
    return this.serial(() => {
      try {
        const clock = this.clock(),
          state = new SqliteSessionStore(this.db).activeGraded();
        if (state)
          this.db.withExclusiveTransaction(() =>
            this.accrueActive(state, clock.monotonicMs, this.scopedDb()),
          );
      } finally {
        // The app is backgrounded even when its final SQL checkpoint fails.
        this.foregrounded = false;
        this.activeClock = null;
      }
    });
  }
  /** Exact same-node authored variants. Used only when the actual engine selects a
   * replay or requests a modality replacement; this never invents a new exercise. */
  private nodeItems(source: ActiveSource): readonly VerifiedRuntimeItem[] {
    const path = source.pack.pack.path(),
      nodeId = source.context.launch.targetNodeId;
    if (nodeId === null) {
      if (source.context.launch.origin.kind !== 'hub') return [source.item];
      return allHubSources(source.pack)
        .map((s) => s.item)
        .filter((item) => this.eligible(item, source, this.readScheduler(source.state.courseId)));
    }
    const nodes = [path.forNode(nodeId)];
    if (
      !nodes.some((n) =>
        n.node.sessions.some((s) => s.exerciseIds.includes(source.item.exerciseId)),
      )
    ) {
      for (const section of path.sections)
        for (const unit of section.units)
          for (const node of unit.nodes)
            if (node.sessions.some((s) => s.exerciseIds.includes(source.item.exerciseId)))
              nodes.push(path.forNode(node.nodeId));
    }
    const values = nodes.flatMap((node) =>
      node.node.sessions.flatMap((session) =>
        session.exerciseIds.map((id) => {
          const item = source.pack.runtimeItem(id);
          if (
            item.exerciseId !== id ||
            item.unitId !== node.unitId ||
            item.lessonIndex !== session.lessonIndex
          )
            return fail('Authored replacement changed its declared destination.');
          return item;
        }),
      ),
    );
    return [...new Map(values.map((item) => [item.exerciseId, item])).values()];
  }
  private eligible(
    item: VerifiedRuntimeItem,
    source: ActiveSource,
    scheduler: SchedulerState,
  ): boolean {
    if (
      !sourceDeviceAllowed(this.db, this.ports, source.state.courseId, item) ||
      !sourceIsKnownAndEligible(item, scheduler, this.clock())
    )
      return false;
    try {
      this.savedItem(
        source.state,
        source.context,
        { ...source.queued, itemId: item.itemId, type: item.presentation.type },
        sourceBinding(item, source.queued.id),
        source.pack,
      );
      return true;
    } catch {
      return false;
    }
  }

  private bindingFor(item: VerifiedRuntimeItem, slotId: string): LessonSlotBinding {
    return sourceBinding(item, slotId);
  }
  dispatch(event: SessionEvent): Promise<void> {
    return this.serial(() => this.dispatchNow(event));
  }
  private dispatchNow(event: SessionEvent): void {
    const source = this.activeSource();
    if (!source) return;
    const clock = this.clock();
    let finalState: SessionState = source.state;
    this.db.withExclusiveTransaction(() => {
      const db = this.scopedDb(),
        contexts = new SqliteLearningContextStore(db);
      const scheduler = registerSources(
        db,
        source.state.courseId,
        this.readScheduler(source.state.courseId),
        [{ item: source.item }],
        clock,
      );
      new SqliteSchedulerStore(db).save(source.state.courseId, scheduler);
      const candidates = this.nodeItems(source);
      const changes = new Map<string, VerifiedRuntimeItem>();
      const choose = (item: QueuedItem): VerifiedRuntimeItem => {
        if (
          item.id === source.queued.id &&
          item.itemId === source.item.itemId &&
          item.type === source.item.presentation.type
        )
          return source.item;
        const bound = source.context.slots.find((b) => b.slotId === item.id);
        if (bound) {
          const value = source.pack.runtimeItem(bound.exerciseId);
          if (value.itemId === item.itemId && value.presentation.type === item.type) return value;
        }
        const found = candidates.filter(
          (v) =>
            v.itemId === item.itemId &&
            v.presentation.type === item.type &&
            this.eligible(v, source, scheduler),
        );
        if (!found.length) return fail('The required replay has no eligible authored source.');
        return found[0]!;
      };
      const config = validateLearningSessionPolicy(source.state, source.context.launch);
      let lastGrade: RuntimeGrade | null = null;
      const deps: StepDeps = {
        config,
        clock: { nowMs: () => clock.monotonicMs },
        grading: {
          grade: (request) => {
            lastGrade = gradeRuntimeItem(choose(request.item), request, {
              introducedSurfaceIds: new Set(
                this.db
                  .all('SELECT surface_id FROM course_surface_exposure WHERE course_id=?', [
                    source.state.courseId,
                  ])
                  .map((r) => String(r.surface_id)),
              ),
            });
            return lastGrade.session;
          },
        },
        isTypeEligible: (type) =>
          candidates.some(
            (v) => v.presentation.type === type && this.eligible(v, source, scheduler),
          ),
        stepUpTripped: (state) =>
          shouldStepUp(
            state,
            (q) => {
              try {
                return this.eligible(choose(q), source, scheduler);
              } catch {
                return false;
              }
            },
            config,
          ),
        matchPairs: (q) => choose(q).presentation.pairs ?? [],
        traceDefinition: (q) => choose(q).presentation.trace ?? null,
        modalityReplacement: (target, ctx) => {
          const found = candidates.find((v) => {
            const spec = exerciseSpec(v.presentation.type),
              canonical = v.schedulerSurfaces.filter((s) => s.canonical);
            const concept = canonical.length === 1 ? canonical[0]!.itemRef : v.itemId;
            return (
              concept === target.conceptId &&
              (source.state.currentReplay?.item.id !== target.id || v.itemId === target.itemId) &&
              !ctx.excludedItemIds.includes(v.itemId) &&
              (ctx.family !== 'speaking' || spec.family !== 'speaking') &&
              (ctx.family !== 'listening' || !spec.requiresAudio) &&
              this.eligible(v, source, scheduler)
            );
          });
          if (!found) return null;
          changes.set(target.id, found);
          const spec = exerciseSpec(found.presentation.type);
          return {
            ...target,
            itemId: found.itemId,
            type: found.presentation.type,
            family: spec.family,
            requiresAudio: spec.requiresAudio,
          };
        },
      };
      this.accrueActive(source.state, clock.monotonicMs, db);
      let result = step(source.state, event, deps);
      // The actual checker runs inside this same exclusive transaction; the controlled
      // player does not emit fabricated verdicts or own a separate grading effect.
      if (result.state.shellState === 'grading')
        result = step(result.state, { type: 'graded' }, deps);
      finalState = result.state;
      if (result.suspendFamily)
        new SqlitePreferences(db, this.ports.modalityClock).suspend(
          source.state.courseId,
          result.suspendFamily,
        );
      for (const [slotId, item] of changes) {
        const q =
          finalState.currentReplay?.item.id === slotId
            ? finalState.currentReplay.item
            : finalState.core.queue.find((q) => q.id === slotId);
        if (q?.itemId === item.itemId)
          contexts.replaceSlot(
            source.state.courseId,
            source.state.sessionId,
            this.bindingFor(item, slotId),
            { before: source.state, after: finalState },
          );
      }
      for (const answer of finalState.core.answers.slice(source.state.core.answers.length)) {
        if (answer.slotId !== source.queued.id || answer.itemId !== source.item.itemId)
          return fail('A grade changed its served source.');
        contexts.recordReceipt(source.state.courseId, source.state.sessionId, {
          ...source.binding,
          exerciseIndex: answer.exerciseIndex,
          answeredAtUtcMs: clock.utcMs,
          answeredLocalDay: localDayOfStamp(new Date(clock.utcMs), clock.zone),
          activeMs: contexts.load(source.state.courseId, source.state.sessionId)!.activeMs,
        });
        const targets = targetsForRuntimeAnswer(source.item, answer, {
          targetLanguage: source.pack.pack.meta.lang,
          rubyShown: source.binding.rubyShown,
          responseSurfaceId: (lastGrade as RuntimeGrade | null)?.responseSurfaceId ?? null,
          partialState: finalState.inFlight.partialState,
        });
        if (targets.length)
          contexts.recordTargets(
            source.state.courseId,
            source.state.sessionId,
            answer.exerciseIndex,
            targets,
          );
      }
      const replay = finalState.currentReplay?.item;
      if (replay && !source.context.slots.some((b) => b.slotId === replay.id)) {
        const mistake = finalState.mistakes.find(
          (m) => replay.id === `${m.slotId}#replay${m.recyclesServed}`,
        );
        if (!mistake) return fail('Replay source history is unavailable.');
        const original = source.context.slots.find((b) => b.slotId === mistake.slotId);
        if (!original) return fail('Replay base slot is unavailable.');
        const originalItem = source.pack.runtimeItem(original.exerciseId);
        contexts.addReplaySlot(
          finalState,
          mistake.slotId,
          this.bindingFor(choose(replay), replay.id),
          originalItem.presentation.pairs?.map((p) => p.leftItemId) ?? [],
        );
      }
      new SqliteSessionStore(db, () => new Date(clock.utcMs).toISOString()).put(finalState);
      const savedContext = contexts.load(source.state.courseId, source.state.sessionId)!;
      const intent = completionIntentFor(
        source.state,
        finalState,
        savedContext,
        contexts.receipts(source.state.courseId, source.state.sessionId),
        clock,
      );
      if (intent !== null && savedContext.completion === null)
        contexts.freezeCompletion(source.state.courseId, source.state.sessionId, intent);
    });
    if (finalState.exited !== null) this.completeNow();
    this.activeClock =
      this.foregrounded && finalState.exited === null
        ? { sessionId: finalState.sessionId, monotonicMs: clock.monotonicMs }
        : null;
  }
  private completionError: string | null = null;
  complete(): Promise<void> {
    return this.serial(() => this.completeNow());
  }
  private completeNow(): void {
    const state = new SqliteSessionStore(this.db).activeGraded();
    if (!state) return;
    const context = new SqliteLearningContextStore(this.db).load(state.courseId, state.sessionId);
    if (!context?.completion) {
      if (state.exited !== null) fail('The terminal checkpoint has no frozen completion intent.');
      return;
    }
    try {
      this.db.withExclusiveTransaction(() => {
        const db = this.scopedDb(),
          pack = this.ports.packs.get(state.courseId);
        if (!pack || pack.contentHash !== context.launch.packContentHash)
          fail('The original verified pack is required to finish this lesson.');
        commitLearning(db, {
          state,
          context,
          pack,
          resolve: (answer, receipt) => {
            const binding = context.slots.find((s) => s.slotId === answer.slotId);
            if (!binding || binding.exerciseId !== receipt.exerciseId)
              fail('The saved answer source is unavailable.');
            const value = pack.runtimeItem(binding.exerciseId),
              spec = exerciseSpec(answer.type),
              canonical = value.schedulerSurfaces.filter((s) => s.canonical);
            const queued: QueuedItem = {
              id: answer.slotId,
              itemId: answer.itemId,
              type: answer.type,
              family: spec.family,
              nodeRef: state.nodeRef,
              conceptId: canonical.length === 1 ? canonical[0]!.itemRef : value.itemId,
              requiresAudio: spec.requiresAudio,
            };
            return this.savedItem(state, context, queued, binding, pack);
          },
        });
        new SqliteSessionStore(db).delete(state.courseId, state.sessionKind, state.nodeRef);
        db.run('DELETE FROM course_session_context WHERE session_id=? AND course_id=?', [
          state.sessionId,
          state.courseId,
        ]);
      });
      this.completionError = null;
      this.activeClock = null;
    } catch (error) {
      this.completionError =
        error instanceof Error ? error.message : 'The lesson could not be saved.';
      throw error;
    }
  }
  readCeremony(): CeremonyPresentation | null {
    const saved = new SqliteCeremonyStore(this.db, () =>
      new Date(this.clock().utcMs).toISOString(),
    ).pending();
    if (saved) {
      const receipt = saved.receipt;
      return {
        status: 'committed',
        state: receipt.state,
        result: receipt.result,
        index: saved.index,
        facts: receipt.facts,
        animations: new SqlitePreferences(this.db, this.ports.modalityClock).readCourse(
          receipt.state.course.courseId,
        ).preferences.animations,
        reduceMotion: this.ports.reduceMotion(),
      };
    }
    if (this.completionError !== null) return { status: 'failed', message: this.completionError };
    const state = new SqliteSessionStore(this.db).activeGraded();
    if (state && state.exited !== null) {
      const context = new SqliteLearningContextStore(this.db).load(state.courseId, state.sessionId);
      if (context?.completion) return { status: 'saving' };
    }
    return null;
  }
  advanceCeremony(request: CeremonyAdvance): Promise<void> {
    return this.serial(() => {
      new SqliteCeremonyStore(this.db, () => new Date(this.clock().utcMs).toISOString()).advance(
        request,
      );
    });
  }
  private offer: {
    readonly value: SessionOffer;
    readonly courseId: string;
    readonly request: LessonLaunch | null;
    readonly resumable: boolean;
    readonly inspected?: {
      readonly packContentHash: string;
      readonly selectedCourseId: string | null;
    };
  } | null = null;
  readOffer(): SessionOffer | null {
    return this.offer?.value ?? null;
  }
  readResumableCourse(courseId: string): ResumeInspection {
    const result = readResumeCandidate(this.db, courseId, (state) => this.savedResolves(state));
    return result.status === 'ready' ? { status: 'ready', candidate: result.candidate } : result;
  }
  prepareResumeOffer(courseId: string, expected: ExpectedResumeCandidate): Promise<void> {
    return this.serial(() => {
      const result = this.readResumableCourse(courseId);
      if (result.status !== 'ready')
        throw new LearningUnavailableError('The saved lesson is unavailable for resume.');
      if (
        result.candidate.sessionId !== expected.sessionId ||
        result.candidate.packContentHash !== expected.packContentHash
      )
        throw new LearningDataError('The inspected saved lesson changed.');
      if (this.offer) {
        if (
          this.offer.inspected &&
          this.offer.value.kind === 'resume' &&
          this.offer.courseId === courseId &&
          this.offer.value.sessionId === expected.sessionId &&
          this.offer.inspected.packContentHash === expected.packContentHash
        )
          return;
        throw new LearningDataError('Resolve the existing session offer first.');
      }
      const selected = this.db.get(
        'SELECT course_id FROM course_selection WHERE is_active=1',
      )?.course_id;
      if (selected !== undefined && typeof selected !== 'string')
        throw new LearningDataError('Invalid selected course.');
      this.offer = {
        value: {
          kind: 'resume',
          sessionId: result.candidate.sessionId,
          lessonLabel: result.candidate.nodeRef,
        },
        courseId,
        request: null,
        resumable: true,
        inspected: {
          packContentHash: expected.packContentHash,
          selectedCourseId: selected ?? null,
        },
      };
    });
  }
  /** Reconstruct a fresh request only after explicit START OVER, inside its rollback boundary.
   * Inspection never reads a new offer, reserves a pool, or runs the generator. */
  private restartRequestFor(state: SessionState, context: LearningContext): LessonLaunch {
    const pack = this.ports.packs.get(state.courseId);
    if (!pack || pack.contentHash !== context.launch.packContentHash)
      throw new LearningUnavailableError('The saved lesson requires its original verified pack.');
    const launch = context.launch;
    if (launch.origin.kind === 'path' && launch.targetNodeId === state.nodeRef) {
      const source = pack.pack.path().forNode(state.nodeRef);
      return {
        kind: 'path',
        request: {
          nodeId: state.nodeRef,
          unitIndex: source.unitIndex,
          flavour: learningSessionPolicy(launch).engineFlavour,
        },
      };
    }
    if (launch.origin.kind === 'hub' && launch.targetNodeId === null) {
      const mode = hubModeAtLaunch(state, context);
      const offer = buildHub(this.readHub(state.courseId)).modes.find(
        (m) =>
          m.kind === mode.kind &&
          (mode.unitIndex === null || m.offer?.unitIndex === mode.unitIndex),
      )?.offer;
      if (!offer)
        throw new LearningUnavailableError('A fresh set for this saved Hub mode is unavailable.');
      return { kind: 'hub', offer };
    }
    throw new LearningUnavailableError('The saved entry requires its explicit restart surface.');
  }
  private savedResolves(state: SessionState): boolean {
    const context = new SqliteLearningContextStore(this.db).load(state.courseId, state.sessionId),
      pack = this.ports.packs.get(state.courseId);
    if (
      !context ||
      !pack ||
      pack.courseId !== state.courseId ||
      pack.contentHash !== context.launch.packContentHash
    )
      return false;
    try {
      return [
        ...state.core.queue,
        ...(state.currentReplay ? [state.currentReplay.item] : []),
      ].every((q) => {
        const binding = context.slots.find((b) => b.slotId === q.id);
        if (!binding) return false;
        this.savedItem(state, context, q, binding, pack);
        return true;
      });
    } catch {
      return false;
    }
  }
  start(courseId: string, request: LessonLaunch): Promise<void> {
    return this.serial(() => this.startNow(courseId, request));
  }
  private startNow(
    courseId: string,
    request: LessonLaunch,
    restart?: { plan: StartOverPlan; previousSessionId: string },
  ): void {
    const clock = this.clock();
    let started: SessionState | null = null;
    this.db.withExclusiveTransaction(() => {
      const db = this.scopedDb(),
        sessions = new SqliteSessionStore(db, () => new Date(clock.utcMs).toISOString());
      if (
        db.get('SELECT course_id FROM course_selection WHERE is_active=1')?.course_id !== courseId
      )
        throw new LearningDataError('Select the course before launching its lesson.');
      const active = sessions.activeGraded();
      if (active?.exited !== null && active !== null)
        throw new LearningUnavailableError(
          'Finish the saved completion before starting another session.',
        );
      if (new SqliteCeremonyStore(db, () => new Date(clock.utcMs).toISOString()).pending())
        throw new LearningUnavailableError(
          'Finish the saved celebration before starting another session.',
        );
      const nodeRef =
        request.kind === 'path'
          ? request.request.nodeId
          : request.kind === 'hub'
            ? request.offer.id
            : null;
      const own = nodeRef === null ? null : sessions.get(courseId, 'graded', nodeRef);
      if (active && active !== own && active.sessionId !== own?.sessionId) {
        this.offer = {
          value: {
            kind: 'collision',
            sessionId: active.sessionId,
            lessonLabel: active.nodeRef,
            exerciseIndex: active.core.index,
            exerciseCount: active.core.queue.length,
          },
          courseId,
          request,
          resumable: this.savedResolves(active),
        };
        return;
      }
      if (own) {
        const resolves = this.savedResolves(own),
          decision = resumeDecision({
            state: own,
            nowMonotonicMs: clock.monotonicMs,
            queueResolvesInPack: resolves,
          });
        if (decision.kind !== 'silentResume') {
          this.offer = {
            value: { kind: 'resume', sessionId: own.sessionId, lessonLabel: own.nodeRef },
            courseId,
            request,
            resumable: resolves,
          };
          return;
        }
        sessions.activate(own);
        started = own;
        return;
      }
      const prepared = prepareLearningLaunch(
        db,
        this.ports,
        clock,
        courseId,
        request,
        restart?.plan,
      );
      if (prepared.state.sessionId === restart?.previousSessionId)
        throw new LearningDataError('Regeneration requires a fresh session identity.');
      new SqliteLearningContextStore(db).create(prepared.launch, prepared.slots);
      sessions.activate(prepared.state);
      started = prepared.state;
    });
    if (started !== null) {
      this.offer = null;
      this.foregrounded = true;
      this.activeClock = {
        sessionId: (started as SessionState).sessionId,
        monotonicMs: clock.monotonicMs,
      };
    }
  }
  resolveOffer(decision: SessionOfferDecision): Promise<void> {
    return this.serial(() => {
      const pending = this.offer;
      if (!pending) return;
      if (decision === 'cancel') {
        this.offer = null;
        return;
      }
      if (pending.inspected) {
        const inspection = this.readResumableCourse(pending.courseId);
        if (
          inspection.status !== 'ready' ||
          inspection.candidate.sessionId !== pending.value.sessionId ||
          inspection.candidate.packContentHash !== pending.inspected.packContentHash
        )
          throw new LearningUnavailableError(
            'The inspected saved lesson is unavailable or changed.',
          );
      }
      if (decision === 'resume') {
        if (!pending.resumable)
          throw new LearningUnavailableError(
            'The saved source is unavailable; start over is required.',
          );
        const clock = this.clock();
        this.db.withExclusiveTransaction(() => {
          const sessions = new SqliteSessionStore(this.scopedDb()),
            state = sessions.all().find((s) => s.sessionId === pending.value.sessionId);
          if (!state || !this.savedResolves(state))
            throw new LearningDataError('The saved lesson changed while the choice was open.');
          if (
            !this.db.get('SELECT course_id FROM course_selection WHERE course_id=?', [
              state.courseId,
            ])
          )
            throw new LearningDataError('The saved lesson course selection is unavailable.');
          this.db.run('UPDATE course_selection SET is_active=0 WHERE is_active=1');
          this.db.run('UPDATE course_selection SET is_active=1 WHERE course_id=?', [
            state.courseId,
          ]);
          sessions.activate(state);
        });
        this.offer = null;
        this.foregrounded = true;
        this.activeClock = { sessionId: pending.value.sessionId, monotonicMs: clock.monotonicMs };
        return;
      }
      if (
        (pending.value.kind === 'resume' && decision !== 'start-over') ||
        (pending.value.kind === 'collision' && decision !== 'end-and-start-new')
      )
        throw new LearningDataError('This decision does not match the saved session offer.');
      let regenerated: SqliteLearningRuntime | null = null;
      this.db.withExclusiveTransaction(() => {
        const db = this.scopedDb(),
          sessions = new SqliteSessionStore(db);
        const old = sessions.all().find((state) => state.sessionId === pending.value.sessionId);
        const context = old
          ? new SqliteLearningContextStore(db).load(old.courseId, old.sessionId)
          : null;
        const pack = old ? this.ports.packs.get(old.courseId) : null;
        if (!old || !context)
          throw new LearningDataError('The saved session source is unavailable.');
        const sourceAvailable = pack !== null && this.savedResolves(old);
        const untouched =
          quitDecision(old).kind === 'exitImmediately' &&
          old.core.index === 0 &&
          old.core.answers.length === 0 &&
          old.mistakeRows.length === 0 &&
          old.weakItemRows.length === 0 &&
          context.completion === null &&
          new SqliteLearningContextStore(db).receipts(old.courseId, old.sessionId).length === 0;
        if (!sourceAvailable && !untouched)
          throw new LearningUnavailableError(
            'The original lesson source is unavailable. Restore its pack to recover the saved attempts.',
          );
        if (
          old.exited !== null ||
          (db.get('SELECT course_id FROM course_selection WHERE is_active=1')?.course_id ??
            null) !== (pending.inspected ? pending.inspected.selectedCourseId : pending.courseId) ||
          !db.get('SELECT course_id FROM course_selection WHERE course_id=?', [old.courseId])
        )
          throw new LearningDataError('The offered session or course selection changed.');
        // This child uses the SAME transaction-scoped connection. Its real End-session
        // completion and source-filtered regeneration either both commit or both roll back.
        const runtime = new SqliteLearningRuntime(db, this.ports);
        runtime.foregrounded = this.foregrounded;
        runtime.activeClock = this.activeClock;
        db.run('UPDATE course_selection SET is_active=0 WHERE is_active=1');
        db.run('UPDATE course_selection SET is_active=1 WHERE course_id=?', [old.courseId]);
        sessions.activate(old);
        if (sourceAvailable) {
          runtime.dispatchNow({ type: 'exit', route: 'closeButton' });
          if (sessions.activeGraded())
            runtime.dispatchNow({ type: 'endSession', route: 'closeButton' });
        } else {
          // The core first-unanswered quit contract writes no attempt or reward. An
          // unavailable old source cannot strand this empty row, nor bless a due exception.
          sessions.delete(old.courseId, old.sessionKind, old.nodeRef);
          db.run('DELETE FROM course_session_context WHERE course_id=? AND session_id=?', [
            old.courseId,
            old.sessionId,
          ]);
        }
        if (new SqliteCeremonyStore(db, () => new Date(this.clock().utcMs).toISOString()).pending())
          throw new LearningUnavailableError(
            'Resume and end this lesson to finish its earned celebration before starting another session.',
          );
        const clock = this.clock(),
          scheduler = new SqliteSchedulerStore(db).load(old.courseId, clock.zone.tzId);
        const plan = planStartOver(old, (itemId) => {
          if (!sourceAvailable || !pack) return false;
          const sources = context.slots
            .filter((slot) => slot.itemId === itemId)
            .map((slot) => pack.runtimeItem(slot.exerciseId));
          return (
            sources.length > 0 &&
            sources.some(
              (item) =>
                sourceIsKnownAndEligible(item, scheduler, clock) &&
                item.schedulerSurfaces
                  .filter((surface) => surface.canonical)
                  .every(
                    (surface) =>
                      (rowAt(
                        scheduler,
                        asItemId(surface.itemId),
                        surface.surface,
                      )?.card.due.getTime() ?? Infinity) <= clock.utcMs,
                  ),
            )
          );
        });
        db.run('UPDATE course_selection SET is_active=0 WHERE is_active=1');
        db.run('UPDATE course_selection SET is_active=1 WHERE course_id=?', [pending.courseId]);
        runtime.startNow(
          pending.courseId,
          pending.request ?? runtime.restartRequestFor(old, context),
          old.courseId === pending.courseId
            ? { plan, previousSessionId: old.sessionId }
            : undefined,
        );
        regenerated = runtime;
      });
      const result = regenerated as SqliteLearningRuntime | null;
      if (result) {
        this.offer = result.offer;
        this.activeClock = result.activeClock;
        this.foregrounded = result.foregrounded;
        this.completionError = null;
      }
    });
  }
}
