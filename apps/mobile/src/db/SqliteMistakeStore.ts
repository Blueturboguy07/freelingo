import type { Db, DbRow } from '@freelingo/schema';
import {
  applyEncounter as reviewMistake,
  isGradedAttempt,
  exerciseSpec,
  type SessionState,
  type MistakeRow,
} from '@freelingo/core/session';
import { toLocalDay } from '@freelingo/core/day';
import type { LearningSchedulerTransition } from './learningTransitions';
import { LearningDataError } from './SqliteSchedulerStore';
import { validateLearningSessionPolicy } from './learningModePolicy';
import type { LearningLaunch } from './SqliteLearningContextStore';
export interface SavedMistake {
  readonly row: MistakeRow;
  readonly misses: number;
  readonly lastMissedAtUtcMs: number;
  readonly lastMissedLocalDay: string;
  readonly retiredAtUtcMs: number | null;
}
export interface MistakeCommitInput {
  readonly launch: LearningLaunch;
  readonly state: SessionState;
  readonly transitions: readonly LearningSchedulerTransition[];
}
interface Event {
  courseId: string;
  itemId: string;
  sequence: number;
  sessionId: string;
  exerciseIndex: number;
  surfaceId: string;
  exerciseId: string;
  packHash: string;
  conceptId: string;
  correct: boolean;
  creates: boolean;
  at: number;
  day: string;
}
interface Derived extends SavedMistake {
  origin: Event;
  lastSequence: number;
}
function fail(message: string): never {
  throw new LearningDataError('Mistake history: ' + message);
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return fail('invalid text');
  return value;
}
function int(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    return fail('invalid integer');
  return value;
}
function stamp(value: unknown): number {
  const n = int(value, -Number.MAX_SAFE_INTEGER);
  if (!Number.isFinite(new Date(n).getTime())) return fail('invalid timestamp');
  return n;
}
function same(a: unknown, b: unknown): boolean {
  return (
    JSON.stringify(a, (_k, v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
        : v,
    ) ===
    JSON.stringify(b, (_k, v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
        : v,
    )
  );
}
function eventFromRow(r: DbRow): Event {
  return {
    courseId: text(r.course_id),
    itemId: text(r.item_id),
    sequence: int(r.sequence),
    sessionId: text(r.session_id),
    exerciseIndex: int(r.exercise_index, -Number.MAX_SAFE_INTEGER),
    surfaceId: text(r.target_surface_id),
    exerciseId: text(r.exercise_id),
    packHash: text(r.pack_content_hash),
    conceptId: text(r.concept_id),
    correct: int(r.correct) === 1,
    creates: int(r.creates_mistake) === 1,
    at: stamp(r.answered_at_utc_ms),
    day: toLocalDay(text(r.local_day)),
  };
}
function advance(prior: Derived | undefined, e: Event): Derived {
  if (e.creates) {
    if (e.correct || (prior && prior.retiredAtUtcMs === null)) return fail('invalid new lifecycle');
    return {
      row: {
        courseId: e.courseId,
        itemId: e.itemId,
        conceptId: e.conceptId,
        createdInSessionId: e.sessionId,
        reviewStreak: 0,
      },
      misses: 1,
      lastMissedAtUtcMs: e.at,
      lastMissedLocalDay: e.day,
      retiredAtUtcMs: null,
      origin: e,
      lastSequence: e.sequence,
    };
  }
  if (!prior || prior.retiredAtUtcMs !== null || prior.row.conceptId !== e.conceptId)
    return fail('encounter has no active matching lifecycle');
  const result = reviewMistake({ row: prior.row, sessionId: e.sessionId, correct: e.correct });
  return {
    ...prior,
    row: result.row,
    misses: prior.misses + Number(!e.correct),
    lastMissedAtUtcMs: e.correct ? prior.lastMissedAtUtcMs : e.at,
    lastMissedLocalDay: e.correct ? prior.lastMissedLocalDay : e.day,
    retiredAtUtcMs: result.retired ? e.at : null,
    lastSequence: e.sequence,
  };
}
function columns(s: Derived): DbRow {
  return {
    course_id: s.row.courseId,
    item_id: s.row.itemId,
    concept_id: s.row.conceptId,
    created_in_session_id: s.row.createdInSessionId,
    created_exercise_index: s.origin.exerciseIndex,
    source_exercise_id: s.origin.exerciseId,
    pack_content_hash: s.origin.packHash,
    review_streak: s.row.reviewStreak,
    misses: s.misses,
    last_missed_at_utc_ms: s.lastMissedAtUtcMs,
    last_missed_local_day: s.lastMissedLocalDay,
    retired_at_utc_ms: s.retiredAtUtcMs,
    last_sequence: s.lastSequence,
  };
}
/** Exact committed answer targets own encounter provenance. Replay runs only the small
 * core MistakeRow retention rule; it never reviews an FSRS card or awards an achievement. */
export class SqliteMistakeStore {
  constructor(private readonly db: Db) {}
  private source(e: Event): DbRow {
    const p = this.db.get(
      `SELECT p.*,t.target_item_id,t.target_surface_id,t.target_surface,t.encounter_role,t.ruby_shown,t.grade AS target_grade,t.position AS target_position,t.answered_at_utc_ms AS target_at
   FROM course_attempt p JOIN course_attempt_target t ON t.course_id=p.course_id AND t.session_id=p.session_id AND t.exercise_index=p.exercise_index
   WHERE p.course_id=? AND p.session_id=? AND p.exercise_index=? AND t.target_item_id=? AND t.target_surface_id=?`,
      [e.courseId, e.sessionId, e.exerciseIndex, e.itemId, e.surfaceId],
    );
    if (
      !p ||
      p.exercise_id !== e.exerciseId ||
      p.pack_content_hash !== e.packHash ||
      p.skipped !== 0 ||
      !['correct', 'softCorrect', 'accepted', 'wrong'].includes(String(p.verdict)) ||
      Number(e.correct) !== Number(p.target_grade !== 1) ||
      p.target_at !== e.at ||
      Date.parse(text(p.answered_at)) !== e.at ||
      (e.creates && p.verdict !== 'wrong')
    )
      return fail('changed graded source receipt');
    return p;
  }
  private histories(courseId: string): Map<string, Derived> {
    if (!this.db.get('SELECT course_id FROM course_progress WHERE course_id=?', [courseId]))
      return fail('course was removed');
    if (
      this.db.get(
        'SELECT item_id FROM course_mistake WHERE course_id=? AND retired_at IS NULL LIMIT 1',
        [courseId],
      )
    )
      return fail('legacy live backlog has no normalized retention proof');
    const found = new Map<string, Derived>();
    for (const r of this.db.all(
      'SELECT * FROM course_mistake_encounter WHERE course_id=? ORDER BY item_id,sequence',
      [courseId],
    )) {
      const e = eventFromRow(r),
        prior = found.get(e.itemId);
      if (e.courseId !== courseId || e.sequence !== (prior ? prior.lastSequence + 1 : 0))
        return fail('gapped encounter sequence');
      this.source(e);
      found.set(e.itemId, advance(prior, e));
    }
    const cached = this.db.all('SELECT * FROM course_mistake_state WHERE course_id=?', [courseId]);
    if (cached.length !== found.size) return fail('cache population differs from actual history');
    for (const r of cached) {
      const s = found.get(text(r.item_id));
      if (!s || !same(r, columns(s))) return fail('cache differs from actual history');
    }
    return found;
  }
  load(courseId: string): readonly SavedMistake[] {
    return [...this.histories(courseId).values()].map(
      ({ row, misses, lastMissedAtUtcMs, lastMissedLocalDay, retiredAtUtcMs }) => ({
        row,
        misses,
        lastMissedAtUtcMs,
        lastMissedLocalDay,
        retiredAtUtcMs,
      }),
    );
  }
  /** Reuse the exact retention reducer for a saved launch; later misses or retirement
   * cannot retroactively change which form that launch was reviewing. Full current
   * provenance/cache validation still runs before projecting the historical prefix. */
  loadAt(courseId: string, throughUtcMs: number): readonly SavedMistake[] {
    const through = stamp(throughUtcMs);
    this.histories(courseId);
    const found = new Map<string, Derived>();
    for (const r of this.db.all(
      'SELECT * FROM course_mistake_encounter WHERE course_id=? ORDER BY item_id,sequence',
      [courseId],
    )) {
      const e = eventFromRow(r);
      if (e.at > through) continue;
      const prior = found.get(e.itemId);
      if (e.sequence !== (prior ? prior.lastSequence + 1 : 0))
        return fail('historical clock order is unavailable');
      found.set(e.itemId, advance(prior, e));
    }
    return [...found.values()].map(
      ({ row, misses, lastMissedAtUtcMs, lastMissedLocalDay, retiredAtUtcMs }) => ({
        row,
        misses,
        lastMissedAtUtcMs,
        lastMissedLocalDay,
        retiredAtUtcMs,
      }),
    );
  }
  apply(input: MistakeCommitInput): void {
    this.db.withExclusiveTransaction(() => {
      const { state, launch } = input;
      const config = validateLearningSessionPolicy(state, launch);
      if (
        launch.courseId !== state.courseId ||
        launch.start.sessionId !== state.sessionId ||
        launch.nodeRef !== state.nodeRef ||
        launch.sessionKind !== state.sessionKind
      )
        return fail('launch binding');
      const found = this.histories(state.courseId);
      let previous = [-1, -1];
      for (const t of input.transitions) {
        if (
          t.courseId !== state.courseId ||
          t.sessionId !== state.sessionId ||
          !same(state.core.answers[t.answerOrdinal], t.answer) ||
          !isGradedAttempt(t.answer) ||
          t.answerOrdinal < previous[0]! ||
          (t.answerOrdinal === previous[0] && t.targetPosition <= previous[1]!)
        )
          return fail('changed or unordered answer input');
        previous = [t.answerOrdinal, t.targetPosition];
        const old = found.get(t.target.itemId),
          canonical = t.runtimeItem.schedulerSurfaces.filter((s) => s.canonical),
          concept =
            t.target.itemId !== t.runtimeItem.itemId
              ? t.target.itemId
              : canonical.length === 1
                ? canonical[0]!.itemRef
                : t.runtimeItem.itemId;
        const candidate = state.mistakeRows.find((r) => r.itemId === t.target.itemId);
        const creates = (old === undefined || old.retiredAtUtcMs !== null) && t.target.grade === 1;
        const e: Event = {
          courseId: t.courseId,
          itemId: t.target.itemId,
          sequence: old ? old.lastSequence + 1 : 0,
          sessionId: t.sessionId,
          exerciseIndex: t.answer.exerciseIndex,
          surfaceId: t.target.surfaceId,
          exerciseId: t.receipt.exerciseId,
          packHash: t.packContentHash,
          conceptId: concept,
          correct: t.target.grade !== 1,
          creates,
          at: t.receipt.answeredAtUtcMs,
          day: toLocalDay(t.receipt.answeredLocalDay),
        };
        const p = this.source(e),
          mapping = t.runtimeItem.schedulerSurfaces.filter(
            (s) => s.itemId === e.itemId && s.surfaceId === e.surfaceId,
          );
        if (
          t.runtimeItem.exerciseId !== e.exerciseId ||
          t.runtimeItem.itemId !== t.answer.itemId ||
          t.runtimeItem.presentation.type !== t.answer.type ||
          mapping.length !== 1 ||
          mapping[0]!.surface !== t.target.surface ||
          t.receipt.itemId !== t.answer.itemId ||
          t.receipt.slotId !== t.answer.slotId ||
          t.receipt.exerciseIndex !== e.exerciseIndex ||
          p.item_id !== t.answer.itemId ||
          p.slot_id !== t.answer.slotId ||
          p.exercise_type !== t.answer.type ||
          p.verdict !== t.answer.verdict ||
          p.queue !== t.answer.queue ||
          p.soft_corrected !== Number(t.answer.softCorrected) ||
          p.cost_paid !== t.answer.costPaid ||
          p.scorable !== Number(t.answer.scorable) ||
          p.note !== t.answer.note ||
          p.active_ms !== t.receipt.activeMs ||
          p.target_position !== t.targetPosition ||
          p.target_grade !== t.target.grade ||
          p.target_surface !== t.target.surface ||
          p.encounter_role !== t.target.role ||
          p.ruby_shown !== Number(t.target.rubyShown)
        )
          return fail('answer target/source proof changed');
        const existing = this.db.get(
          'SELECT * FROM course_mistake_encounter WHERE course_id=? AND item_id=? AND session_id=? AND exercise_index=?',
          [e.courseId, e.itemId, e.sessionId, e.exerciseIndex],
        );
        if (existing) {
          const original = eventFromRow(existing);
          if (!same({ ...e, sequence: original.sequence, creates: original.creates }, original))
            return fail('encounter retry changed');
          continue;
        }
        if (!old || old.retiredAtUtcMs !== null) {
          if (!creates || !candidate) continue;
          if (
            candidate.courseId !== state.courseId ||
            candidate.createdInSessionId !== state.sessionId ||
            candidate.conceptId !== concept ||
            candidate.reviewStreak !== 0 ||
            t.answer.queue !== 'main' ||
            !t.answer.wrong ||
            !exerciseSpec(t.answer.type).punitive ||
            !config.recyclesMistakes
          )
            return fail('new mistake has no actual main-queue origin');
        }
        const next = advance(old, e);
        this.db.run('INSERT INTO course_mistake_encounter VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [
          e.courseId,
          e.itemId,
          e.sequence,
          e.sessionId,
          e.exerciseIndex,
          e.surfaceId,
          e.exerciseId,
          e.packHash,
          e.conceptId,
          Number(e.correct),
          Number(e.creates),
          e.at,
          e.day,
        ]);
        const row = columns(next),
          names = Object.keys(row);
        this.db.run(
          `INSERT INTO course_mistake_state(${names.join(',')}) VALUES(${names.map(() => '?').join(',')}) ON CONFLICT(course_id,item_id) DO UPDATE SET ${names
            .filter((n) => n !== 'course_id' && n !== 'item_id')
            .map((n) => `${n}=excluded.${n}`)
            .join(',')}`,
          Object.values(row),
        );
        found.set(e.itemId, next);
      }
      this.histories(state.courseId);
    });
  }
}
