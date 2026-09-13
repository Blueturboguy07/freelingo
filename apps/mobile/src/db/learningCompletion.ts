import type { Db } from '@freelingo/schema';
import {
  canonicalJson,
  exerciseSpec,
  isGradedAttempt,
  type Answer,
  type SessionState,
} from '@freelingo/core/session';
import {
  applyEncounter,
  asItemId,
  asSessionId,
  roleOfExerciseType,
  rowAt,
  type SchedulerState,
} from '@freelingo/core/scheduler';
import {
  allUnits,
  isComplete,
  nodeUnlocked,
  unlockDailyRefresh,
  transitionsBetween,
  viewportAfterCeremony,
  viewportOf,
  type PathModel,
} from '@freelingo/core/path';
import { commitSession } from '@freelingo/core/day';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';
import {
  SqliteLearningContextStore,
  type AnswerReceipt,
  type LearningContext,
} from './SqliteLearningContextStore';
import {
  SqliteSchedulerStore,
  LearningDataError,
  type SchedulerTargetEvidence,
  type SchedulerAnswerEvidence,
} from './SqliteSchedulerStore';
import { SqliteMistakeStore } from './SqliteMistakeStore';
import { readPathModel } from '../services/readPathModel';
import { planLearningRewards, writeLearningRewards } from './learningRewards';
import type { LearningSchedulerTransition } from './learningTransitions';
import type { CeremonyReceipt } from './ceremonyCodec';
import { LEARNING_GRADE_POLICY } from './learningGrading';

export interface LearningCompletionInput {
  readonly state: SessionState;
  readonly context: LearningContext;
  readonly pack: VerifiedInstalledPack;
  /** The runtime verifies original path/pool placement as well as the exact saved variant. */
  readonly resolve: (answer: Answer, receipt: AnswerReceipt) => VerifiedRuntimeItem;
}
function fail(detail: string): never {
  throw new LearningDataError('Completion: ' + detail);
}
function equal(a: unknown, b: unknown) {
  return canonicalJson(a) === canonicalJson(b);
}
function validateTargets(
  item: VerifiedRuntimeItem,
  answer: Answer,
  receipt: AnswerReceipt,
  targets: readonly SchedulerTargetEvidence[],
  lang: string,
  finalExhaustedGrid: boolean,
): void {
  const graded = isGradedAttempt(answer);
  if (!graded) {
    if (targets.length) fail('ungraded answer has scheduler targets');
    return;
  }
  if (!targets.length) fail('graded answer has no target receipt');
  const match = item.gradable.family === 'match';
  if (!match && targets.length !== 1) fail('ordinary answer changed target cardinality');
  const ids = new Set<string>();
  for (const target of targets) {
    const maps = item.schedulerSurfaces.filter(
        (s) => s.itemId === target.itemId && s.surfaceId === target.surfaceId,
      ),
      mapping = maps[0];
    if (
      maps.length !== 1 ||
      !mapping ||
      mapping.surface !== target.surface ||
      mapping.language !== lang ||
      ids.has(target.itemId) ||
      target.role !== roleOfExerciseType(answer.type) ||
      target.rubyShown !== receipt.rubyShown ||
      target.rubyShown ||
      ![LEARNING_GRADE_POLICY.wrong, LEARNING_GRADE_POLICY.accepted].some(
        (grade) => grade === target.grade,
      )
    )
      fail('changed signed target, role or grade');
    ids.add(target.itemId);
    if (match) {
      if (!mapping.canonical) fail('MATCH target changed canonical left surface');
      if (target.grade === LEARNING_GRADE_POLICY.wrong && !answer.wrong)
        fail('wrong pair has accepted parent');
    } else {
      if (
        target.itemId !== item.itemId ||
        target.grade !==
          (answer.wrong ? LEARNING_GRADE_POLICY.wrong : LEARNING_GRADE_POLICY.accepted)
      )
        fail('answer grade differs from target');
      if ((answer.wrong || item.responseLanguage !== lang) && !mapping.canonical)
        fail('lapse or reverse answer changed canonical target');
    }
  }
  if (match) {
    const declared = (item.presentation.pairs ?? []).map((pair) => pair.leftItemId);
    const ordered = declared.filter((id) => ids.has(id));
    const wrongTargets = targets.filter((t) => t.grade === LEARNING_GRADE_POLICY.wrong).length;
    if (
      !declared.length ||
      new Set(declared).size !== declared.length ||
      !equal(
        ordered,
        targets.map((t) => t.itemId),
      )
    )
      fail('MATCH target population or order changed');
    if (
      answer.wrong !== wrongTargets > 0 ||
      (answer.wrong ? answer.costPaid < wrongTargets : answer.costPaid !== 0)
    )
      fail('MATCH paid errors differ from target grades');
    // Only the actual final allowance-exhausting grid can stop before every left
    // item is solved. Dispatch froze its observed targets from real pair taps.
    if (targets.length !== declared.length && (!answer.wrong || !finalExhaustedGrid))
      fail('MATCH completed grid omitted a declared target');
  }
}
function audit(
  db: Db,
  state: SessionState,
  answer: Answer,
  receipt: AnswerReceipt,
  packHash: string,
): void {
  if (isGradedAttempt(answer)) fail('graded answer cannot use audit-only storage');
  const sequence = Number(
    db.get(
      'SELECT COALESCE(MAX(attempt_sequence),-1)+1 AS n FROM course_attempt WHERE course_id=?',
      [state.courseId],
    )?.n,
  );
  if (!Number.isSafeInteger(sequence) || sequence < 0) fail('attempt chronology');
  db.run(
    `INSERT INTO course_attempt(session_id,exercise_index,course_id,item_id,exercise_type,verdict,first_try,answered_at,active_ms,slot_id,queue,soft_corrected,cost_paid,skipped,scorable,note,attempt_sequence,exercise_id,pack_content_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      state.sessionId,
      answer.exerciseIndex,
      state.courseId,
      answer.itemId,
      answer.type,
      answer.verdict,
      Number(answer.queue === 'main'),
      new Date(receipt.answeredAtUtcMs).toISOString(),
      receipt.activeMs,
      answer.slotId,
      answer.queue,
      Number(answer.softCorrected),
      answer.costPaid,
      Number(answer.skipped),
      Number(answer.scorable),
      answer.note,
      sequence,
      receipt.exerciseId,
      packHash,
    ],
  );
}
function progress(
  db: Db,
  input: LearningCompletionInput,
  before: PathModel,
  items: ReadonlyMap<string, VerifiedRuntimeItem>,
): PathModel {
  const { state, context, pack } = input,
    completion = context.completion!;
  if (completion.outcome !== 'completed' && completion.outcome !== 'replayed') return before;
  if (context.launch.origin.kind !== 'path' || context.launch.targetNodeId === null) return before;
  const declared = pack.pack.path(),
    binding = declared.forNode(context.launch.targetNodeId),
    unit = allUnits(before)[binding.unitIndex],
    nodeIndex = unit?.nodes.findIndex((n) => n.id === context.launch.targetNodeId) ?? -1,
    node = unit?.nodes[nodeIndex];
  if (!node || !nodeUnlocked(before, binding.unitIndex, nodeIndex))
    fail('destination is unavailable');
  const advances =
    state.flavour === 'lesson' ||
    state.flavour === 'unitReview' ||
    (state.flavour === 'nodePractice' && node.type === 'practice' && !isComplete(node));
  const legendary = state.flavour === 'legendary';
  if (!advances && !legendary) return before;
  if (legendary && (!isComplete(node) || !before.manifest.legendaryDenominator.includes(node.type)))
    fail('Legendary destination is not complete or eligible');
  if (advances && isComplete(node)) {
    if (state.flavour === 'lesson') fail('lesson destination was already completed');
    return before;
  }
  const session = advances ? binding.node.sessions[node.subLessonsDone] : null;
  if (
    advances &&
    (!session ||
      !state.core.answers.some(
        (a) =>
          a.queue === 'main' &&
          isGradedAttempt(a) &&
          items.get(a.slotId)?.lessonIndex === session.lessonIndex &&
          session.exerciseIds.includes(items.get(a.slotId)!.exerciseId),
      ))
  )
    fail('no graded source from the destination sub-session');
  const done = advances ? node.subLessonsDone + 1 : node.subLessonsDone;
  const derived = commitSession(
    context.launch.start,
    { ...completion, earnedXp: 0, earnedGems: 0 },
    { satisfiedDays: new Set() },
  ).derivedCompletionUtcMs;
  const timestamp = new Date(derived).toISOString();
  const sourceNodes = declared.sections.flatMap((s) => s.units.flatMap((u) => u.nodes)),
    ordinal = sourceNodes.findIndex((n) => n.nodeId === node.id),
    section = declared.sections[binding.sectionIndex];
  if (ordinal < 0 || !section) fail('destination source order');
  db.run(
    `INSERT INTO course_node(course_id,node_id,unit_id,section_id,node_type,node_index,levels_total,levels_completed,completed_at,legendary_awarded_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(course_id,node_id) DO UPDATE SET levels_completed=excluded.levels_completed,completed_at=COALESCE(course_node.completed_at,excluded.completed_at),legendary_awarded_at=COALESCE(course_node.legendary_awarded_at,excluded.legendary_awarded_at)`,
    [
      state.courseId,
      node.id,
      binding.unitId,
      String(section.sectionIndex),
      node.type,
      ordinal,
      node.subLessonsTotal,
      done,
      done === node.subLessonsTotal ? timestamp : null,
      legendary ? timestamp : null,
    ],
  );
  let after = readPathModel(db, pack);
  const viewport = viewportAfterCeremony(viewportOf(before), transitionsBetween(before, after)),
    unlocked = unlockDailyRefresh(after).model;
  // The last section has no successor; keep the real declared viewport in bounds.
  db.run(
    'UPDATE course_path_state SET viewing_section=?,daily_refresh_unlocked=? WHERE course_id=?',
    [
      Math.min(viewport.viewingSection, after.sections.length - 1),
      Number(unlocked.dailyRefreshUnlocked),
      state.courseId,
    ],
  );
  after = readPathModel(db, pack);
  return after;
}
/** Runs only inside the caller's one exclusive transaction and on its SAME scoped Db.
 * Actual applyEncounter results are captured once, then shared with rewards/word owners. */
export function commitLearning(db: Db, input: LearningCompletionInput): CeremonyReceipt | null {
  const { state, context, pack } = input,
    completion = context.completion;
  if (
    !completion ||
    state.courseId !== pack.courseId ||
    context.launch.packContentHash !== pack.contentHash ||
    context.launch.start.sessionId !== state.sessionId
  )
    fail('missing original completion source');
  if (
    completion.outcome === 'quit'
      ? state.exited !== 'quit'
      : completion.outcome === 'completed' || completion.outcome === 'replayed'
        ? state.exited !== 'complete'
        : completion.outcome !== 'failed'
  )
    fail('terminal outcome changed');
  if (
    (completion.outcome === 'completed' || completion.outcome === 'replayed') &&
    (state.core.index !== state.core.queue.length ||
      state.currentReplay !== null ||
      state.mistakes.some((m) => m.servesRemaining > 0))
  )
    fail('queue is not complete');
  if (
    db.get('SELECT session_id FROM committed_session WHERE session_id=?', [state.sessionId]) ||
    db.get('SELECT session_id FROM course_attempt WHERE session_id=?', [state.sessionId])
  )
    fail('unexpected existing completion history');
  const contexts = new SqliteLearningContextStore(db),
    receipts = contexts.receipts(state.courseId, state.sessionId);
  if (receipts.length !== state.core.answers.length) fail('incomplete answer receipts');
  const store = new SqliteSchedulerStore(db),
    schedulerBefore = store.load(state.courseId, completion.completionZone.tzId),
    pathBefore = readPathModel(db, pack);
  let scheduler: SchedulerState = schedulerBefore;
  const transitions: LearningSchedulerTransition[] = [],
    items = new Map<string, VerifiedRuntimeItem>();
  const seen = new Set<number>();
  for (let ordinal = 0; ordinal < state.core.answers.length; ordinal++) {
    const answer = state.core.answers[ordinal]!,
      receipt = receipts[ordinal]!;
    if (
      seen.has(answer.exerciseIndex) ||
      receipt.exerciseIndex !== answer.exerciseIndex ||
      receipt.slotId !== answer.slotId ||
      receipt.itemId !== answer.itemId ||
      receipt.activeMs > context.activeMs ||
      (ordinal > 0 && receipt.activeMs < receipts[ordinal - 1]!.activeMs)
    )
      fail('answer chronology/source changed');
    seen.add(answer.exerciseIndex);
    const item = input.resolve(answer, receipt);
    if (
      item.exerciseId !== receipt.exerciseId ||
      item.itemId !== answer.itemId ||
      item.presentation.type !== answer.type ||
      answer.scorable !== (!answer.skipped && exerciseSpec(answer.type).scorable) ||
      answer.wrong !== (answer.verdict === 'wrong')
    )
      fail('answer variant or grading flags changed');
    if (answer.queue === 'main') {
      const original = state.core.queue.find((q) => q.id === answer.slotId);
      if (
        !original ||
        original.itemId !== answer.itemId ||
        original.type !== answer.type ||
        answer.exerciseIndex < 0
      )
        fail('main source changed');
    } else if (answer.exerciseIndex >= 0) fail('replay answer identity changed');
    items.set(answer.slotId, item);
    const targets = contexts.targets(state.courseId, state.sessionId, answer.exerciseIndex);
    const hearts = state.core.hearts;
    const finalExhaustedGrid =
      completion.outcome === 'failed' &&
      ordinal === state.core.answers.length - 1 &&
      hearts.kind === 'pips' &&
      hearts.remaining === 0 &&
      state.core.answers.slice(0, ordinal + 1).reduce((sum, a) => sum + a.costPaid, 0) ===
        hearts.total;
    validateTargets(item, answer, receipt, targets, pack.pack.meta.lang, finalExhaustedGrid);
    if (!isGradedAttempt(answer)) {
      audit(db, state, answer, receipt, pack.contentHash);
      continue;
    }
    const evidence: SchedulerAnswerEvidence = {
      sessionId: state.sessionId,
      exerciseId: item.exerciseId,
      packContentHash: pack.contentHash,
      answer,
      surface: receipt.surface,
      role: receipt.role,
      rubyShown: receipt.rubyShown,
      answeredAtUtc: new Date(receipt.answeredAtUtcMs).toISOString(),
      activeMs: receipt.activeMs,
      targets,
    };
    for (let position = 0; position < targets.length; position++) {
      const target = targets[position]!,
        before = rowAt(scheduler, asItemId(target.itemId), target.surface) ?? null;
      if (!before) fail('graded target was not registered');
      const result = applyEncounter(scheduler, {
        sessionId: asSessionId(state.sessionId),
        exerciseIndex: answer.exerciseIndex,
        itemId: asItemId(target.itemId),
        surface: target.surface,
        targetSurfaceId: target.surfaceId,
        role: target.role,
        rubyShown: target.rubyShown,
        grade: target.grade,
        at: new Date(receipt.answeredAtUtcMs),
      });
      if (!result.wroteAttempt) fail('answer target was already applied');
      transitions.push({
        courseId: state.courseId,
        sessionId: state.sessionId,
        answerOrdinal: ordinal,
        targetPosition: position,
        answer,
        receipt,
        target,
        runtimeItem: item,
        packContentHash: pack.contentHash,
        before,
        after: rowAt(result.state, asItemId(target.itemId), target.surface) ?? null,
        review: result.review,
        wroteAttempt: result.wroteAttempt,
      });
      scheduler = result.state;
    }
    store.save(state.courseId, scheduler, [evidence]);
  }
  if (completion.outcome === 'completed' || completion.outcome === 'replayed')
    for (const slot of state.core.queue) {
      if (state.core.answers.filter((a) => a.queue === 'main' && a.slotId === slot.id).length !== 1)
        fail('completed slot lacks its one main answer');
    }
  // INV-SESS-23: audit-only completion is deliberately not a committed session.
  if (!state.core.answers.some(isGradedAttempt)) return null;
  new SqliteMistakeStore(db).apply({ state, transitions });
  const pathAfter = progress(db, input, pathBefore, items),
    schedulerAfter = store.load(state.courseId, completion.completionZone.tzId);
  if (!equal([...scheduler.rows.keys()], [...schedulerAfter.rows.keys()]))
    fail('scheduler target population changed during save');
  return writeLearningRewards(
    db,
    planLearningRewards(db, {
      state,
      context,
      pack,
      transitions,
      schedulerBefore,
      schedulerAfter,
      pathBefore,
      pathAfter,
    }),
  );
}
