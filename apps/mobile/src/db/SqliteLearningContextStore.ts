import type { Db, DbRow } from '@freelingo/schema';
import {
  localDayOfStamp,
  toLocalDay,
  type LocalDay,
  type SessionStart,
  type ZoneStamp,
} from '@freelingo/core/day';
import {
  SESSION_KINDS,
  canonicalJson,
  type SessionKind,
  type SessionState,
} from '@freelingo/core/session';
import { LONG_FORM_XP_KEYS, type LongFormEntryPoint } from '@freelingo/core/economy';
import {
  SESSION_FLAVOURS,
  SESSION_OUTCOMES,
  type SessionFlavour,
  type SessionOutcomeKind,
  type ActiveBoost,
} from '@freelingo/core/types';
import type { EncounterRole } from '@freelingo/core/scheduler';
import { LearningDataError } from './SqliteSchedulerStore';

export interface LearningLaunch {
  readonly courseId: string;
  readonly sessionKind: SessionKind;
  readonly nodeRef: string;
  readonly start: SessionStart;
  readonly economyFlavour: SessionFlavour;
  readonly practiceItemRatio: number;
  readonly longFormEntry: LongFormEntryPoint | null;
  readonly boostAtStart: ActiveBoost | null;
  readonly packContentHash: string;
  readonly origin:
    | { readonly kind: 'path' | 'placement' }
    | { readonly kind: 'hub'; readonly offerId: string; readonly localDay: LocalDay };
  readonly targetNodeId: string | null;
}
export interface LessonSlotBinding {
  readonly slotId: string;
  readonly exerciseId: string;
  readonly itemId: string;
  readonly surface: string;
  readonly role: EncounterRole;
  readonly rubyShown: boolean;
}
export interface AnswerReceipt extends LessonSlotBinding {
  readonly exerciseIndex: number;
  readonly answeredAtUtcMs: number;
  readonly answeredLocalDay: LocalDay;
  readonly activeMs: number;
}
export interface CompletionIntent {
  readonly completedAtUtcMs: number;
  readonly completedAtMonotonicMs: number;
  readonly completionZone: ZoneStamp;
  readonly outcome: SessionOutcomeKind;
  readonly intendedAtUtc: string;
}
export interface LearningContext {
  readonly launch: LearningLaunch;
  readonly startedLocalDay: LocalDay;
  readonly slots: readonly LessonSlotBinding[];
  readonly activeMs: number;
  readonly completion: CompletionIntent | null;
}
function fail(field: string): never {
  throw new LearningDataError('Invalid lesson context: ' + field);
}
function text(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) return fail(field);
  return v;
}
function num(v: unknown, field: string, min = 0, max = Number.MAX_VALUE): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return fail(field);
  return v;
}
function int(v: unknown, field: string, min = 0): number {
  const n = num(v, field, min, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(n)) return fail(field);
  return n;
}
function stamp(v: unknown, field: string): number {
  const n = int(v, field, -Number.MAX_SAFE_INTEGER);
  if (!Number.isFinite(new Date(n).getTime())) return fail(field);
  return n;
}
function iso(v: unknown, field: string): string {
  const s = text(v, field);
  if (!Number.isFinite(Date.parse(s))) return fail(field);
  return s;
}
function day(v: unknown, field: string): LocalDay {
  return toLocalDay(text(v, field));
}
function optional(v: unknown, field: string): string | null {
  return v === null ? null : text(v, field);
}
function oneOf<T extends string | number>(v: unknown, vs: readonly T[], field: string): T {
  const found = vs.find((x) => x === v);
  if (found === undefined) return fail(field);
  return found;
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function zone(r: DbRow, prefix: string): ZoneStamp {
  return {
    tzId: text(r[prefix + 'tz_id'], 'zone'),
    utcOffsetMinutes: int(r[prefix + 'utc_offset_minutes'], 'offset', -Number.MAX_SAFE_INTEGER),
    tzSource: oneOf(
      r[prefix + 'tz_source'],
      ['iana', 'fixed_offset', 'unknown'] as const,
      'zone source',
    ),
  };
}
function binding(r: DbRow): LessonSlotBinding {
  return {
    slotId: text(r.slot_id, 'slot'),
    exerciseId: text(r.exercise_id, 'exercise'),
    itemId: text(r.item_id, 'item'),
    surface: text(r.surface, 'surface'),
    role: oneOf(r.encounter_role, ['recognition', 'production'] as const, 'role'),
    rubyShown: oneOf(r.ruby_shown, [0, 1] as const, 'ruby') === 1,
  };
}
function bindingRow(s: LessonSlotBinding): DbRow {
  return {
    slot_id: s.slotId,
    exercise_id: s.exerciseId,
    item_id: s.itemId,
    surface: s.surface,
    encounter_role: s.role,
    ruby_shown: typeof s.rubyShown === 'boolean' ? Number(s.rubyShown) : null,
  };
}
function readLaunch(r: DbRow): LearningLaunch {
  const origin = oneOf(r.origin, ['path', 'hub', 'placement'] as const, 'origin');
  if (origin !== 'hub' && (r.origin_offer_id !== null || r.origin_local_day !== null))
    return fail('origin fields');
  const boostValues = [
    r.boost_kind,
    r.boost_multiplier,
    r.boost_started_at_utc,
    r.boost_expires_at_utc,
  ];
  let boost: ActiveBoost | null = null;
  if (!boostValues.every((v) => v === null)) {
    boost = {
      kind: oneOf(
        r.boost_kind,
        ['xpBoost', 'timerBoost', 'happyHour', 'earlyBird'] as const,
        'boost',
      ),
      multiplier: int(r.boost_multiplier, 'boost multiplier', 1),
      startedAtUtc: iso(r.boost_started_at_utc, 'boost start'),
      expiresAtUtc: iso(r.boost_expires_at_utc, 'boost expiry'),
    };
    if (Date.parse(boost.expiresAtUtc) < Date.parse(boost.startedAtUtc))
      return fail('boost interval');
  }
  return {
    courseId: text(r.course_id, 'course'),
    sessionKind: oneOf(r.session_kind, SESSION_KINDS, 'session kind'),
    nodeRef: text(r.node_ref, 'node'),
    start: {
      sessionId: text(r.session_id, 'session'),
      startedAtUtcMs: stamp(r.started_at_utc_ms, 'start time'),
      startedAtMonotonicMs: num(r.started_at_monotonic_ms, 'start monotonic'),
      startZone: zone(r, 'start_'),
    },
    economyFlavour: oneOf(r.economy_flavour, SESSION_FLAVOURS, 'economy flavour'),
    practiceItemRatio: num(r.practice_item_ratio, 'practice ratio', 0, 1),
    longFormEntry:
      r.long_form_entry === null ? null : oneOf(r.long_form_entry, LONG_FORM_XP_KEYS, 'entry'),
    boostAtStart: boost,
    packContentHash: text(r.pack_content_hash, 'pack hash'),
    origin:
      origin === 'hub'
        ? {
            kind: origin,
            offerId: text(r.origin_offer_id, 'offer'),
            localDay: day(r.origin_local_day, 'offer day'),
          }
        : { kind: origin },
    targetNodeId: optional(r.target_node_id, 'target node'),
  };
}
function launchRow(l: LearningLaunch): DbRow {
  const b = l.boostAtStart,
    z = l.start.startZone;
  return {
    session_id: l.start.sessionId,
    course_id: l.courseId,
    session_kind: l.sessionKind,
    node_ref: l.nodeRef,
    started_at_utc_ms: l.start.startedAtUtcMs,
    started_at_monotonic_ms: l.start.startedAtMonotonicMs,
    start_tz_id: z.tzId,
    start_utc_offset_minutes: z.utcOffsetMinutes,
    start_tz_source: z.tzSource,
    started_local_day: localDayOfStamp(new Date(l.start.startedAtUtcMs), z),
    economy_flavour: l.economyFlavour,
    practice_item_ratio: l.practiceItemRatio,
    long_form_entry: l.longFormEntry,
    boost_kind: b?.kind ?? null,
    boost_multiplier: b?.multiplier ?? null,
    boost_started_at_utc: b?.startedAtUtc ?? null,
    boost_expires_at_utc: b?.expiresAtUtc ?? null,
    pack_content_hash: l.packContentHash,
    origin: l.origin.kind,
    origin_offer_id: l.origin.kind === 'hub' ? l.origin.offerId : null,
    origin_local_day: l.origin.kind === 'hub' ? l.origin.localDay : null,
    target_node_id: l.targetNodeId,
  };
}
function completionRow(c: CompletionIntent): DbRow {
  return {
    completed_at_utc_ms: c.completedAtUtcMs,
    completed_at_monotonic_ms: c.completedAtMonotonicMs,
    completion_tz_id: c.completionZone.tzId,
    completion_utc_offset_minutes: c.completionZone.utcOffsetMinutes,
    completion_tz_source: c.completionZone.tzSource,
    completion_outcome: c.outcome,
    completion_intent_at_utc: c.intendedAtUtc,
  };
}
function readCompletion(r: DbRow): CompletionIntent | null {
  const columns = [
    'completed_at_utc_ms',
    'completed_at_monotonic_ms',
    'completion_tz_id',
    'completion_utc_offset_minutes',
    'completion_tz_source',
    'completion_outcome',
    'completion_intent_at_utc',
  ];
  if (columns.every((k) => r[k] === null)) return null;
  return {
    completedAtUtcMs: stamp(r.completed_at_utc_ms, 'completion time'),
    completedAtMonotonicMs: num(r.completed_at_monotonic_ms, 'completion monotonic'),
    completionZone: zone(r, 'completion_'),
    outcome: oneOf(r.completion_outcome, SESSION_OUTCOMES, 'completion outcome'),
    intendedAtUtc: iso(r.completion_intent_at_utc, 'completion intent'),
  };
}
function insert(db: Db, table: string, row: DbRow): void {
  // Table/column identifiers are defined only by this module, never user input.
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    keys.map((k) => row[k]),
  );
}
/** A staging boundary, not reward authority. Runtime verifies these source bindings against
 * the signed pack and saves the corresponding SessionState in the SAME transaction.
 * Receipts preserve source facts for negative-index replays; completion clocks are first-write. */
export class SqliteLearningContextStore {
  constructor(private readonly db: Db) {}
  private require(courseId: string, sessionId: string): LearningContext {
    const c = this.load(courseId, sessionId);
    if (!c) return fail('missing session');
    return c;
  }
  load(courseId: string, sessionId: string): LearningContext | null {
    const r = this.db.get('SELECT * FROM course_session_context WHERE session_id=?', [sessionId]);
    if (!r) return null;
    const launch = readLaunch(r);
    if (launch.courseId !== courseId) return fail('course binding');
    const startedLocalDay = day(r.started_local_day, 'start day');
    if (
      startedLocalDay !==
      localDayOfStamp(new Date(launch.start.startedAtUtcMs), launch.start.startZone)
    )
      return fail('start day binding');
    const slots = this.db
      .all('SELECT * FROM course_session_slot WHERE session_id=? ORDER BY slot_id', [sessionId])
      .map((row) => {
        if (row.course_id !== courseId) return fail('slot course binding');
        return binding(row);
      });
    return {
      launch,
      startedLocalDay,
      slots,
      activeMs: int(r.active_ms, 'active time'),
      completion: readCompletion(r),
    };
  }
  create(launch: LearningLaunch, slots: readonly LessonSlotBinding[]): LearningContext {
    return this.db.withExclusiveTransaction(() => {
      const row = launchRow(launch),
        checked = readLaunch(row),
        bindings = slots
          .map((s) => binding(bindingRow(s)))
          .sort((a, b) => a.slotId.localeCompare(b.slotId));
      if (new Set(bindings.map((s) => s.slotId)).size !== bindings.length)
        return fail('duplicate slot');
      const old = this.load(launch.courseId, launch.start.sessionId);
      if (old) {
        if (!same(old.launch, checked)) return fail('changed launch');
        if (!same(old.slots, bindings)) return fail('changed slot binding');
        return old;
      }
      insert(this.db, 'course_session_context', row);
      for (const b of bindings)
        insert(this.db, 'course_session_slot', {
          session_id: launch.start.sessionId,
          course_id: launch.courseId,
          ...bindingRow(b),
        });
      return this.require(launch.courseId, launch.start.sessionId);
    });
  }
  addActiveMs(courseId: string, sessionId: string, deltaMs: number): number {
    return this.db.withExclusiveTransaction(() => {
      const c = this.require(courseId, sessionId);
      if (c.completion) return fail('completion is frozen');
      const active = int(c.activeMs + int(deltaMs, 'active increment'), 'active time');
      this.db.run('UPDATE course_session_context SET active_ms=? WHERE session_id=?', [
        active,
        sessionId,
      ]);
      return active;
    });
  }
  freezeCompletion(
    courseId: string,
    sessionId: string,
    intent: CompletionIntent,
  ): CompletionIntent {
    return this.db.withExclusiveTransaction(() => {
      const c = this.require(courseId, sessionId);
      if (c.completion) return c.completion;
      const row = completionRow(intent),
        checked = readCompletion(row)!;
      const keys = Object.keys(row);
      this.db.run(
        `UPDATE course_session_context SET ${keys.map((k) => k + '=?').join(',')} WHERE session_id=?`,
        [...keys.map((k) => row[k]), sessionId],
      );
      return checked;
    });
  }
  replaceSlot(
    courseId: string,
    sessionId: string,
    next: LessonSlotBinding,
    transition?: { readonly before: SessionState; readonly after: SessionState },
  ): void {
    this.db.withExclusiveTransaction(() => {
      const c = this.require(courseId, sessionId);
      if (c.completion) return fail('completion is frozen');
      const checked = binding(bindingRow(next)),
        old = c.slots.find((s) => s.slotId === checked.slotId);
      if (!old) return fail('missing slot');
      if (transition) {
        this.checkState(c, transition.before);
        this.checkState(c, transition.after);
        const beforeReplay = transition.before.currentReplay?.item;
        const replay = beforeReplay?.id === old.slotId;
        const before = replay
          ? beforeReplay
          : transition.before.core.queue
              .slice(transition.before.core.index)
              .find((q) => q.id === old.slotId);
        const after = replay
          ? transition.after.currentReplay?.item
          : transition.after.core.queue
              .slice(transition.after.core.index)
              .find((q) => q.id === checked.slotId);
        if (
          !before ||
          !after ||
          before.itemId !== old.itemId ||
          after.id !== checked.slotId ||
          after.itemId !== checked.itemId ||
          before.conceptId !== after.conceptId ||
          before.nodeRef !== after.nodeRef ||
          after.nodeRef !== c.launch.nodeRef ||
          (replay && before.itemId !== after.itemId)
        )
          return fail('replacement item transition');
      } else if (old.itemId !== checked.itemId)
        return fail('replacement item requires core transition');
      if (same(old, checked)) return;
      if (this.receipts(courseId, sessionId).some((r) => r.slotId === next.slotId))
        return fail('already graded slot');
      this.db.run(
        'UPDATE course_session_slot SET exercise_id=?,item_id=?,surface=?,encounter_role=?,ruby_shown=? WHERE session_id=? AND slot_id=?',
        [
          checked.exerciseId,
          checked.itemId,
          checked.surface,
          checked.role,
          Number(checked.rubyShown),
          sessionId,
          checked.slotId,
        ],
      );
    });
  }
  /** Bind only a replay the core has actually served. The factory supplies pair item IDs
   * from the verified original grid when that grid's first wrong LEFT item is replayed. */
  addReplaySlot(
    state: SessionState,
    baseSlotId: string,
    next: LessonSlotBinding,
    verifiedMatchPairItemIds: readonly string[] = [],
  ): void {
    this.db.withExclusiveTransaction(() => {
      const c = this.require(state.courseId, state.sessionId);
      this.checkState(c, state);
      if (c.completion) return fail('completion is frozen');
      const checked = binding(bindingRow(next));
      const replay = state.currentReplay?.item;
      const base = c.slots.find((s) => s.slotId === baseSlotId);
      const missed = state.mistakes.find(
        (m) => m.slotId === baseSlotId && m.itemId === replay?.itemId,
      );
      const original = state.core.queue.find((q) => q.id === baseSlotId);
      const originalAnswer = state.core.answers.find(
        (a) => a.slotId === baseSlotId && a.wrong && a.queue === 'main',
      );
      const originalReceipt = this.receipts(state.courseId, state.sessionId).find(
        (r) => r.slotId === baseSlotId && r.exerciseIndex === originalAnswer?.exerciseIndex,
      );
      if (
        !replay ||
        !base ||
        !missed ||
        !original ||
        !originalAnswer ||
        !originalReceipt ||
        original.itemId !== base.itemId ||
        originalReceipt.exerciseId !== base.exerciseId ||
        checked.slotId !== replay.id ||
        checked.itemId !== replay.itemId ||
        replay.id !== `${baseSlotId}#replay${missed.recyclesServed}` ||
        replay.nodeRef !== c.launch.nodeRef
      )
        return fail('replay source binding');
      if (missed.originalType === 'matchPairs') {
        if (original.type !== 'matchPairs' || !verifiedMatchPairItemIds.includes(checked.itemId))
          return fail('replay pair source');
      } else if (checked.itemId !== base.itemId) return fail('replay semantic item');
      const existing = c.slots.find((s) => s.slotId === checked.slotId);
      if (existing) {
        if (!same(existing, checked)) return fail('changed replay binding');
        return;
      }
      insert(this.db, 'course_session_slot', {
        session_id: state.sessionId,
        course_id: state.courseId,
        ...bindingRow(checked),
      });
    });
  }
  private checkState(context: LearningContext, state: SessionState): void {
    if (
      state.sessionId !== context.launch.start.sessionId ||
      state.courseId !== context.launch.courseId ||
      state.sessionKind !== context.launch.sessionKind ||
      state.nodeRef !== context.launch.nodeRef
    )
      return fail('checkpoint binding');
  }
  receipts(courseId: string, sessionId: string): readonly AnswerReceipt[] {
    const c = this.require(courseId, sessionId);
    const result: AnswerReceipt[] = [];
    for (const r of this.db.all(
      'SELECT * FROM course_session_answer_receipt WHERE session_id=? ORDER BY receipt_sequence',
      [sessionId],
    )) {
      if (r.receipt_sequence !== result.length) return fail('receipt sequence');
      if (r.course_id !== courseId) return fail('receipt course binding');
      const b = binding(r);
      if (
        !same(
          c.slots.find((s) => s.slotId === b.slotId),
          b,
        )
      )
        return fail('receipt source binding');
      result.push({
        ...b,
        exerciseIndex: int(r.exercise_index, 'answer index', -Number.MAX_SAFE_INTEGER),
        answeredAtUtcMs: stamp(r.answered_at_utc_ms, 'answer timestamp'),
        answeredLocalDay: day(r.answered_local_day, 'answer day'),
        activeMs: int(r.active_ms, 'answer active time'),
      });
    }
    return result;
  }
  recordReceipt(courseId: string, sessionId: string, receipt: AnswerReceipt): void {
    this.db.withExclusiveTransaction(() => {
      const c = this.require(courseId, sessionId),
        existing = this.receipts(courseId, sessionId);
      const old = existing.find((r) => r.exerciseIndex === receipt.exerciseIndex);
      if (old) {
        if (!same(old, receipt)) return fail('changed receipt');
        return;
      }
      if (c.completion) return fail('completion is frozen');
      const b = binding(bindingRow(receipt));
      if (
        !same(
          c.slots.find((s) => s.slotId === b.slotId),
          b,
        )
      )
        return fail('receipt source binding');
      insert(this.db, 'course_session_answer_receipt', {
        session_id: sessionId,
        course_id: courseId,
        exercise_index: int(receipt.exerciseIndex, 'answer index', -Number.MAX_SAFE_INTEGER),
        receipt_sequence: existing.length,
        ...bindingRow(b),
        answered_at_utc_ms: stamp(receipt.answeredAtUtcMs, 'answer timestamp'),
        answered_local_day: day(receipt.answeredLocalDay, 'answer day'),
        active_ms: int(receipt.activeMs, 'answer active time'),
      });
    });
  }
}
