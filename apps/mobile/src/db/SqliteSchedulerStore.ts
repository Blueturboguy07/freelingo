import type { Db, DbRow } from '@freelingo/schema';
import { toLocalDay } from '@freelingo/core/day';
import {
  ANOMALY_KINDS,
  HOLD_REASONS,
  ITEM_KINDS,
  REVIEW_KINDS,
  asItemId,
  asSessionId,
  attemptKeyOf,
  attemptTargetKeyOf,
  attemptLedgerOf,
  emptySchedulerState,
  parseRowKey,
  recordIntroduction,
  rowKeyOf,
  type AttemptRow,
  type EncounterRole,
  type Grade,
  type FsrsRow,
  type HoldWindow,
  type SchedulerState,
} from '@freelingo/core/scheduler';
import type { Answer } from '@freelingo/core/session';

/** Source and answer facts captured together by the learning runtime, before grading
 * checkpoints can be killed. The scheduler's resulting attempt is joined to these facts. */
export interface SchedulerTargetEvidence {
  readonly itemId: string;
  readonly surfaceId: string;
  readonly surface: string;
  readonly role: EncounterRole;
  readonly rubyShown: boolean;
  readonly grade: Grade;
}
export interface SchedulerAnswerEvidence {
  readonly sessionId: string;
  readonly exerciseId: string;
  readonly packContentHash: string;
  readonly answer: Answer;
  readonly surface: string;
  readonly role: EncounterRole;
  readonly rubyShown: boolean;
  readonly answeredAtUtc: string;
  readonly activeMs: number;
  /** Complete frozen target set; absent only for historical single-target callers. */
  readonly targets?: readonly SchedulerTargetEvidence[];
}
export class LearningDataError extends Error {}
function fail(field: string): never {
  throw new LearningDataError('Invalid learning data: ' + field);
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') return fail(field);
  return value;
}
function number(value: unknown, field: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    return fail(field);
  return value;
}
function integer(value: unknown, field: string, min = -Number.MAX_SAFE_INTEGER): number {
  const n = number(value, field, min, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(n)) return fail(field);
  return n;
}
function date(value: unknown, field: string): Date {
  const d = new Date(integer(value, field));
  if (!Number.isFinite(d.getTime())) return fail(field);
  return d;
}
function optionalDate(value: unknown, field: string): Date | null {
  return value === null ? null : date(value, field);
}
function enumeration<T extends string | number>(
  value: unknown,
  values: readonly T[],
  field: string,
): T {
  const found = values.find((v) => v === value);
  if (found === undefined) return fail(field);
  return found;
}
function stamp(value: Date): number {
  return date(value.getTime(), 'timestamp').getTime();
}
function same(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown) =>
    JSON.stringify(value, (_key, part: unknown) =>
      part !== null && typeof part === 'object' && !Array.isArray(part)
        ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b)))
        : part,
    );
  return canonical(left) === canonical(right);
}
function scopeIdentity(h: HoldWindow): string {
  return JSON.stringify([
    h.scope.kind,
    h.scope.kind === 'item' ? h.scope.itemId : h.scope.modality,
    h.reason,
    stamp(h.from),
  ]);
}
function readHold(row: DbRow): HoldWindow {
  const kind = enumeration(row.scope_kind, ['item', 'modality'] as const, 'hold scope');
  const from = date(row.from_utc_ms, 'hold start'),
    until = optionalDate(row.until_utc_ms, 'hold end');
  if (until !== null && until < from) return fail('hold interval');
  if (kind === 'item' ? row.modality !== null : row.item_id !== null)
    return fail('hold scope fields');
  return {
    scope:
      kind === 'item'
        ? { kind, itemId: asItemId(text(row.item_id, 'held item')) }
        : { kind, modality: text(row.modality, 'held modality') },
    reason: enumeration(row.reason, HOLD_REASONS, 'hold reason'),
    from,
    until,
  };
}
function readAttempt(row: DbRow): AttemptRow | null {
  const group = [
    row.surface,
    row.scheduler_grade,
    row.encounter_role,
    row.scheduler_review_kind,
    row.ruby_shown,
  ];
  if (group.every((v) => v === null)) return null; // Historical/non-scheduler facts remain in SQL.
  if (group.some((v) => v === null)) return fail('partial scheduler attempt');
  enumeration(row.encounter_role, ['recognition', 'production'] as const, 'attempt role');
  enumeration(row.ruby_shown, [0, 1] as const, 'attempt ruby');
  integer(row.attempt_sequence, 'attempt sequence', 0);
  const atText = text(row.answered_at, 'answered timestamp');
  const at = new Date(atText);
  if (!Number.isFinite(at.getTime())) return fail('answered timestamp');
  return {
    sessionId: asSessionId(text(row.session_id, 'attempt session')),
    exerciseIndex: integer(row.exercise_index, 'exercise index'),
    itemId: asItemId(text(row.item_id, 'attempt item')),
    surface: text(row.surface, 'attempt surface'),
    grade: enumeration(row.scheduler_grade, [1, 2, 3, 4] as const, 'grade'),
    reviewKind: enumeration(row.scheduler_review_kind, REVIEW_KINDS, 'review kind'),
    at,
  };
}

/** SQLite is authoritative. This class writes full scheduler rows, never a hand-made
 * forgetting curve. Public saves are exclusive; a containing completion transaction may
 * supply its transaction-scoped Db view so every reward shares that same transaction. */
export class SqliteSchedulerStore {
  constructor(private readonly db: Db) {}
  private course(courseId: string): DbRow {
    const r = this.db.get('SELECT * FROM course_progress WHERE course_id=?', [courseId]);
    if (!r) throw new LearningDataError('The course no longer exists.');
    return r;
  }
  load(courseId: string, timeZone: string): SchedulerState {
    const course = this.course(courseId);
    const initial = emptySchedulerState(timeZone);
    const modes = new Map<string, string[]>();
    for (const row of this.db.all(
      'SELECT * FROM course_item_surface_modality WHERE course_id=? ORDER BY modality',
      [courseId],
    )) {
      const key = rowKeyOf(
        asItemId(text(row.item_id, 'modality item')),
        text(row.surface, 'modality surface'),
      );
      const list = modes.get(key) ?? [];
      list.push(text(row.modality, 'modality'));
      modes.set(key, list);
    }
    const rows = new Map(initial.rows);
    for (const r of this.db.all(
      'SELECT * FROM course_item_surface WHERE course_id=? ORDER BY item_id,surface',
      [courseId],
    )) {
      const id = asItemId(text(r.item_id, 'item'));
      const surface = text(r.surface, 'surface');
      const key = rowKeyOf(id, surface);
      const last = optionalDate(r.last_review_utc_ms, 'last review');
      const row: FsrsRow = {
        key,
        itemId: id,
        surface,
        kind: enumeration(r.kind, ITEM_KINDS, 'item kind'),
        modalities: modes.get(key) ?? [],
        card: {
          due: date(r.due_utc_ms, 'due'),
          stability: number(r.stability, 'stability', 0),
          difficulty: number(r.difficulty, 'difficulty', 0),
          elapsed_days: number(r.elapsed_days, 'elapsed days', 0),
          scheduled_days: number(r.scheduled_days, 'scheduled days', 0),
          learning_steps: integer(r.learning_steps, 'learning steps', 0),
          reps: integer(r.reps, 'reps', 0),
          lapses: integer(r.lapses, 'lapses', 0),
          state: enumeration(r.state, [0, 1, 2, 3] as const, 'FSRS state'),
          ...(last === null ? {} : { last_review: last }),
        },
        retrievability: number(r.retrievability, 'retrievability', 0, 1),
        introducedAt: optionalDate(r.introduced_at_utc_ms, 'introduction'),
        lastReviewKind:
          r.last_review_kind === null
            ? null
            : enumeration(r.last_review_kind, REVIEW_KINDS, 'last review kind'),
      };
      rows.set(key, row);
      modes.delete(key);
    }
    if (modes.size) return fail('orphan surface modalities');
    let introductions = initial.introductions;
    for (const r of this.db.all(
      'SELECT * FROM course_introduction WHERE course_id=? ORDER BY sequence',
      [courseId],
    )) {
      const itemId = asItemId(text(r.item_id, 'introduction item')),
        surface = text(r.surface, 'introduction surface');
      const at = date(r.introduced_at_utc_ms, 'introduction instant');
      if (integer(r.sequence, 'introduction sequence', 0) !== introductions.records.length)
        return fail('gapped introduction sequence');
      if (rows.get(rowKeyOf(itemId, surface))?.introducedAt?.getTime() !== at.getTime())
        return fail('introduction source join');
      introductions = recordIntroduction(introductions, {
        itemId,
        surface,
        at,
        localDay: toLocalDay(text(r.local_day, 'introduction day')),
      });
    }
    for (const row of rows.values())
      if (
        row.introducedAt !== null &&
        !introductions.records.some((i) => i.itemId === row.itemId && i.surface === row.surface)
      )
        return fail('missing surface introduction proof');
    const attempts: AttemptRow[] = [];
    for (const r of this.db.all(
      'SELECT * FROM course_attempt WHERE course_id=? ORDER BY attempt_sequence,rowid',
      [courseId],
    )) {
      const children = this.readTargets(r);
      if (children.length) attempts.push(...children.map((c) => c.attempt));
      else {
        const attempt = readAttempt(r);
        if (attempt) attempts.push(attempt);
      }
    }
    const anomalies = this.db
      .all('SELECT * FROM course_scheduler_anomaly WHERE course_id=? ORDER BY anomaly_sequence', [
        courseId,
      ])
      .map((r, index) => {
        if (integer(r.anomaly_sequence, 'anomaly sequence', 0) !== index)
          return fail('gapped anomaly sequence');
        if ((r.item_id === null) !== (r.surface === null)) return fail('anomaly source pair');
        return {
          kind: enumeration(r.kind, ANOMALY_KINDS, 'anomaly kind'),
          rowKey:
            r.item_id === null
              ? null
              : rowKeyOf(
                  asItemId(text(r.item_id, 'anomaly item')),
                  text(r.surface, 'anomaly surface'),
                ),
          at: date(r.at_utc_ms, 'anomaly time'),
          observedMs:
            r.observed_ms === null ? null : number(r.observed_ms, 'observed milliseconds'),
          usedMs: r.used_ms === null ? null : number(r.used_ms, 'used milliseconds', 0),
          note: typeof r.note === 'string' ? r.note : fail('anomaly note'),
        };
      });
    return {
      ...initial,
      rows,
      introductions,
      attempts: attemptLedgerOf(attempts),
      anomalies,
      holds: this.db
        .all('SELECT * FROM course_scheduler_hold WHERE course_id=? ORDER BY hold_id', [courseId])
        .map(readHold),
      score: {
        masteredItemIds: new Set(
          this.db
            .all(
              'SELECT item_id FROM course_scheduler_mastery WHERE course_id=? ORDER BY item_id',
              [courseId],
            )
            .map((r) => asItemId(text(r.item_id, 'mastered item'))),
        ),
        masteryHighWaterPoints: integer(course.mastery_high_water_points, 'mastery high water', 0),
      },
    };
  }
  private readTargets(parent: DbRow): { attempt: AttemptRow; evidence: SchedulerTargetEvidence }[] {
    const rows = this.db.all(
      'SELECT * FROM course_attempt_target WHERE session_id=? AND exercise_index=? ORDER BY position',
      [parent.session_id, parent.exercise_index],
    );
    if (!rows.length) return [];
    if (
      [
        parent.surface,
        parent.scheduler_grade,
        parent.encounter_role,
        parent.scheduler_review_kind,
        parent.ruby_shown,
      ].some((v) => v !== null)
    )
      return fail('mixed legacy and target proof');
    integer(parent.attempt_sequence, 'target parent sequence', 0);
    text(parent.exercise_id, 'target parent source');
    text(parent.pack_content_hash, 'target parent pack');
    return rows.map((r, position) => {
      if (r.course_id !== parent.course_id || r.position !== position)
        return fail('target position or course');
      const at = date(r.answered_at_utc_ms, 'target timestamp');
      if (Date.parse(text(parent.answered_at, 'parent timestamp')) !== at.getTime())
        return fail('target parent timestamp');
      const evidence: SchedulerTargetEvidence = {
        itemId: text(r.target_item_id, 'target item'),
        surfaceId: text(r.target_surface_id, 'target surface ID'),
        surface: text(r.target_surface, 'target surface'),
        role: enumeration(r.encounter_role, ['recognition', 'production'] as const, 'target role'),
        rubyShown: enumeration(r.ruby_shown, [0, 1] as const, 'target ruby') === 1,
        grade: enumeration(r.grade, [1, 2, 3, 4] as const, 'target grade'),
      };
      return {
        evidence,
        attempt: {
          sessionId: asSessionId(text(r.session_id, 'target session')),
          exerciseIndex: integer(r.exercise_index, 'target index'),
          itemId: asItemId(evidence.itemId),
          surface: evidence.surface,
          targetSurfaceId: evidence.surfaceId,
          grade: evidence.grade,
          at,
          reviewKind: enumeration(r.review_kind, REVIEW_KINDS, 'target review kind'),
        },
      };
    });
  }
  save(
    courseId: string,
    next: SchedulerState,
    evidence: readonly SchedulerAnswerEvidence[] = [],
  ): void {
    this.db.withExclusiveTransaction(() => this.write(courseId, next, evidence));
  }
  private write(
    courseId: string,
    next: SchedulerState,
    evidence: readonly SchedulerAnswerEvidence[],
  ): void {
    const prior = this.load(courseId, next.timeZone);
    if (next.pool !== null)
      throw new LearningDataError('Daily pool persistence belongs to the shared pool store.');
    const byKey = new Map(
      evidence.map((e) => [attemptKeyOf(asSessionId(e.sessionId), e.answer.exerciseIndex), e]),
    );
    if (byKey.size !== evidence.length) return fail('duplicate answer evidence');
    const additions: {
      attempt: AttemptRow;
      e: SchedulerAnswerEvidence;
      targets: readonly AttemptRow[];
    }[] = [];
    const targetsByParent = new Map<string, AttemptRow[]>();
    for (const [key, target] of next.attempts.targetRows) {
      if (
        target.targetSurfaceId === undefined ||
        key !== attemptTargetKeyOf({ ...target, targetSurfaceId: target.targetSurfaceId })
      )
        return fail('target key');
      const parentKey = attemptKeyOf(target.sessionId, target.exerciseIndex);
      if (next.attempts.rows.get(parentKey)?.targetSurfaceId === undefined)
        return fail('orphan target parent');
      const group = targetsByParent.get(parentKey) ?? [];
      group.push(target);
      targetsByParent.set(parentKey, group);
    }
    for (const [key, old] of prior.attempts.targetRows)
      if (!same(next.attempts.targetRows.get(key), old)) return fail('target history changed');
    for (const [key, old] of prior.attempts.rows) {
      const group = targetsByParent.get(key) ?? [];
      const previous = [...prior.attempts.targetRows.values()].filter(
        (t) => attemptKeyOf(t.sessionId, t.exerciseIndex) === key,
      );
      if (!same(group, previous)) return fail('frozen answer target set changed');
      const e = byKey.get(key);
      if (e !== undefined && previous.length > 0) {
        if (e.targets === undefined) return fail('missing target receipt on retry');
        const parent = this.db.get(
          'SELECT * FROM course_attempt WHERE session_id=? AND exercise_index=?',
          [old.sessionId, old.exerciseIndex],
        );
        if (
          !parent ||
          !same(
            this.readTargets(parent).map((t) => t.evidence),
            e.targets,
          )
        )
          return fail('target receipt changed');
        if (
          parent.exercise_id !== e.exerciseId ||
          parent.pack_content_hash !== e.packContentHash ||
          parent.item_id !== e.answer.itemId ||
          parent.slot_id !== e.answer.slotId ||
          parent.exercise_type !== e.answer.type ||
          parent.verdict !== e.answer.verdict ||
          parent.answered_at !== e.answeredAtUtc ||
          parent.active_ms !== e.activeMs ||
          parent.queue !== e.answer.queue ||
          parent.first_try !== Number(e.answer.queue === 'main') ||
          parent.soft_corrected !== Number(e.answer.softCorrected) ||
          parent.cost_paid !== e.answer.costPaid ||
          parent.skipped !== Number(e.answer.skipped) ||
          parent.scorable !== Number(e.answer.scorable) ||
          parent.note !== e.answer.note ||
          (parent.verdict === 'wrong') !== e.answer.wrong
        )
          return fail('target parent evidence changed');
      }
    }
    for (const [key, old] of prior.attempts.rows)
      if (!same(next.attempts.rows.get(key), old)) return fail('attempt history changed');
    for (const [key, attempt] of next.attempts.rows) {
      if (key !== attemptKeyOf(attempt.sessionId, attempt.exerciseIndex))
        return fail('attempt key');
      if (prior.attempts.rows.has(key)) continue;
      if (
        this.db.get('SELECT 1 FROM course_attempt WHERE session_id=? AND exercise_index=?', [
          attempt.sessionId,
          attempt.exerciseIndex,
        ])
      )
        return fail('existing legacy attempt cannot be regraded');
      const e = byKey.get(key);
      if (!e) return fail('missing answer evidence');
      const targets = targetsByParent.get(key) ?? [];
      if (attempt.targetSurfaceId !== undefined) {
        if (
          !e.targets ||
          !targets.length ||
          !same(targets[0], attempt) ||
          e.targets.length !== targets.length
        )
          return fail('incomplete target evidence');
        for (let i = 0; i < targets.length; i++) {
          const target = targets[i]!,
            proof = e.targets[i]!;
          if (
            proof.itemId !== target.itemId ||
            proof.surfaceId !== target.targetSurfaceId ||
            proof.surface !== target.surface ||
            proof.grade !== target.grade ||
            stamp(target.at) !== Date.parse(e.answeredAtUtc)
          )
            return fail('target evidence join');
          enumeration(proof.role, ['recognition', 'production'] as const, 'target role');
          if (typeof proof.rubyShown !== 'boolean') return fail('target ruby');
        }
      } else if (e.targets !== undefined || targets.length) return fail('legacy target mismatch');
      else if (e.surface !== attempt.surface) return fail('answer evidence surface');
      if (
        (targets.length === 0 && e.answer.itemId !== attempt.itemId) ||
        e.answer.skipped ||
        e.answer.verdict === 'noVerdict' ||
        Date.parse(e.answeredAtUtc) !== stamp(attempt.at)
      )
        return fail('answer evidence join');
      text(e.exerciseId, 'source exercise');
      text(e.packContentHash, 'source pack content hash');
      text(e.answer.slotId, 'answer slot');
      enumeration(e.role, ['recognition', 'production'] as const, 'answer role');
      integer(e.activeMs, 'answer active milliseconds', 0);
      additions.push({ attempt, e, targets });
    }
    // Append-only facts must be a prefix even when wall time moves backwards.
    if (
      !same(
        next.introductions.records.slice(0, prior.introductions.records.length),
        prior.introductions.records,
      )
    )
      return fail('introduction history changed');
    if (!same(next.anomalies.slice(0, prior.anomalies.length), prior.anomalies))
      return fail('anomaly history changed');
    if (
      next.score.masteryHighWaterPoints < prior.score.masteryHighWaterPoints ||
      [...prior.score.masteredItemIds].some((id) => !next.score.masteredItemIds.has(id))
    )
      return fail('mastery history decreased');
    for (const key of prior.rows.keys())
      if (!next.rows.has(key)) return fail('surface history removed');
    for (const row of next.rows.values()) this.writeRow(courseId, row, next);
    next.introductions.records.slice(prior.introductions.records.length).forEach((r, i) => {
      this.db.run(
        'INSERT INTO course_introduction(course_id,item_id,surface,introduced_at_utc_ms,local_day,sequence) VALUES(?,?,?,?,?,?)',
        [
          courseId,
          r.itemId,
          r.surface,
          stamp(r.at),
          toLocalDay(r.localDay),
          prior.introductions.records.length + i,
        ],
      );
    });
    const oldHolds = this.db.all('SELECT * FROM course_scheduler_hold WHERE course_id=?', [
      courseId,
    ]);
    const holdIds = new Map(
      oldHolds.map((r) => [scopeIdentity(readHold(r)), text(r.hold_id, 'hold id')]),
    );
    const retained = new Set(next.holds.map(scopeIdentity));
    if (oldHolds.some((r) => !retained.has(scopeIdentity(readHold(r)))))
      return fail('hold history removed');
    for (const h of next.holds) {
      const identity = scopeIdentity(h),
        id = holdIds.get(identity) ?? identity;
      const previous = oldHolds.find((r) => r.hold_id === id);
      if (
        previous &&
        previous.until_utc_ms !== null &&
        previous.until_utc_ms !== h.until?.getTime()
      )
        return fail('closed hold changed');
      this.db.run(
        `INSERT INTO course_scheduler_hold(course_id,hold_id,scope_kind,item_id,modality,reason,from_utc_ms,until_utc_ms)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(course_id,hold_id) DO UPDATE SET until_utc_ms=excluded.until_utc_ms`,
        [
          courseId,
          id,
          h.scope.kind,
          h.scope.kind === 'item' ? h.scope.itemId : null,
          h.scope.kind === 'modality' ? h.scope.modality : null,
          h.reason,
          stamp(h.from),
          h.until === null ? null : stamp(h.until),
        ],
      );
    }
    next.anomalies.slice(prior.anomalies.length).forEach((r, i) => {
      const ref = r.rowKey === null ? null : parseRowKey(r.rowKey);
      this.db.run('INSERT INTO course_scheduler_anomaly VALUES(?,?,?,?,?,?,?,?,?)', [
        courseId,
        prior.anomalies.length + i,
        r.kind,
        ref?.itemId ?? null,
        ref?.surface ?? null,
        stamp(r.at),
        r.observedMs,
        r.usedMs,
        r.note,
      ]);
    });
    let sequence =
      integer(
        this.db.get(
          'SELECT COALESCE(MAX(attempt_sequence),-1) AS n FROM course_attempt WHERE course_id=?',
          [courseId],
        )?.n,
        'last attempt sequence',
      ) + 1;
    for (const { attempt: a, e, targets } of additions) {
      const answer = e.answer;
      this.db.run(
        `INSERT INTO course_attempt(session_id,exercise_index,course_id,item_id,exercise_type,verdict,first_try,answered_at,active_ms,
        surface,scheduler_grade,encounter_role,scheduler_review_kind,ruby_shown,slot_id,queue,soft_corrected,cost_paid,skipped,scorable,note,attempt_sequence,exercise_id,pack_content_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          a.sessionId,
          a.exerciseIndex,
          courseId,
          answer.itemId,
          answer.type,
          answer.verdict,
          Number(answer.queue === 'main'),
          e.answeredAtUtc,
          e.activeMs,
          targets.length ? null : a.surface,
          targets.length ? null : a.grade,
          targets.length ? null : e.role,
          targets.length ? null : a.reviewKind,
          targets.length ? null : Number(e.rubyShown),
          answer.slotId,
          answer.queue,
          Number(answer.softCorrected),
          answer.costPaid,
          Number(answer.skipped),
          Number(answer.scorable),
          answer.note,
          sequence++,
          e.exerciseId,
          e.packContentHash,
        ],
      );
      targets.forEach((target, position) => {
        const proof = e.targets![position]!;
        this.db.run(
          'INSERT INTO course_attempt_target(course_id,session_id,exercise_index,target_item_id,target_surface_id,target_surface,encounter_role,ruby_shown,grade,position,review_kind,answered_at_utc_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          [
            courseId,
            a.sessionId,
            a.exerciseIndex,
            target.itemId,
            target.targetSurfaceId,
            target.surface,
            proof.role,
            Number(proof.rubyShown),
            target.grade,
            position,
            target.reviewKind,
            stamp(target.at),
          ],
        );
      });
    }
    this.db.run('UPDATE course_progress SET mastery_high_water_points=? WHERE course_id=?', [
      next.score.masteryHighWaterPoints,
      courseId,
    ]);
    for (const id of next.score.masteredItemIds)
      this.db.run('INSERT OR IGNORE INTO course_scheduler_mastery(course_id,item_id) VALUES(?,?)', [
        courseId,
        id,
      ]);
  }
  private writeRow(courseId: string, r: FsrsRow, state: SchedulerState): void {
    if (r.key !== rowKeyOf(r.itemId, r.surface)) return fail('surface key');
    const proof = state.introductions.records.find(
      (i) => i.itemId === r.itemId && i.surface === r.surface,
    );
    if (
      r.introducedAt === null
        ? proof !== undefined
        : proof?.at.getTime() !== r.introducedAt.getTime()
    )
      return fail('surface introduction proof');
    const c = r.card;
    this.db.run(
      `INSERT INTO course_item_surface(course_id,item_id,surface,kind,due_utc_ms,last_review_utc_ms,stability,difficulty,elapsed_days,scheduled_days,learning_steps,reps,lapses,state,retrievability,introduced_at_utc_ms,last_review_kind)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(course_id,item_id,surface) DO UPDATE SET kind=excluded.kind,due_utc_ms=excluded.due_utc_ms,last_review_utc_ms=excluded.last_review_utc_ms,
      stability=excluded.stability,difficulty=excluded.difficulty,elapsed_days=excluded.elapsed_days,scheduled_days=excluded.scheduled_days,learning_steps=excluded.learning_steps,reps=excluded.reps,lapses=excluded.lapses,
      state=excluded.state,retrievability=excluded.retrievability,introduced_at_utc_ms=excluded.introduced_at_utc_ms,last_review_kind=excluded.last_review_kind`,
      [
        courseId,
        r.itemId,
        r.surface,
        r.kind,
        stamp(c.due),
        c.last_review === undefined ? null : stamp(c.last_review),
        c.stability,
        c.difficulty,
        c.elapsed_days,
        c.scheduled_days,
        c.learning_steps,
        c.reps,
        c.lapses,
        c.state,
        r.retrievability,
        r.introducedAt === null ? null : stamp(r.introducedAt),
        r.lastReviewKind,
      ],
    );
    this.db.run(
      'DELETE FROM course_item_surface_modality WHERE course_id=? AND item_id=? AND surface=?',
      [courseId, r.itemId, r.surface],
    );
    for (const modality of new Set(r.modalities))
      this.db.run('INSERT INTO course_item_surface_modality VALUES(?,?,?,?)', [
        courseId,
        r.itemId,
        r.surface,
        text(modality, 'modality'),
      ]);
  }
}
