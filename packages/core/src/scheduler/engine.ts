/**
 * The scheduler's state and the one entry point that changes it.
 *
 * Everything in this directory is a pure rule over its own slice. This file is the slice
 * that owns the ORDER those rules run in, because several of the §5 invariants are really
 * statements about ordering:
 *
 *   - an attempt already on file short-circuits before FSRS is touched   INV-SCH-03
 *   - the production delay is checked before the item is credited        INV-SCH-10
 *   - the held measure is computed before elapsed reaches the algorithm  INV-SCH-07, -08
 *   - mastery is observed after the row moves, never before              INV-SCH-09
 *
 * A caller that assembled these itself would get the same result four times out of five,
 * and the fifth is the one that costs a learner their memory model.
 */
import { localDayOf, type LocalDay } from '../day/civil.js';
import type { AttemptLedger, AttemptRow } from './attempts.js';
import { appendAttempt, attemptKeyOf, EMPTY_ATTEMPT_LEDGER } from './attempts.js';
import { DEFAULT_SCHEDULER_ECONOMY, type SchedulerEconomy } from './config.js';
import type { FsrsRow, NewRowSpec, ReviewResult } from './fsrs.js';
import { introduceRow, isIntroduced, newRow, reviewRow } from './fsrs.js';
import type { HoldWindow } from './holds.js';
import { heldMsBetween, isHeldAt } from './holds.js';
import type { IntroductionLedger } from './introduction.js';
import {
  EMPTY_INTRODUCTION_LEDGER,
  introductionRecordFor,
  recordIntroduction,
  roleAllowedAt,
} from './introduction.js';
import type { ReviewPoolDay } from './pool.js';
import { EMPTY_SCORE_STATE, observeMastery, type ScoreState } from './score.js';
import type { AnomalyRow, Encounter, FsrsRowKey, ItemId, Surface } from './types.js';
import { rowKeyOf } from './types.js';

export interface SchedulerState {
  /** The learner's zone. Every local-day rule in here reads it, none guesses it. */
  readonly timeZone: string;
  readonly rows: ReadonlyMap<FsrsRowKey, FsrsRow>;
  readonly holds: readonly HoldWindow[];
  readonly anomalies: readonly AnomalyRow[];
  readonly attempts: AttemptLedger;
  readonly introductions: IntroductionLedger;
  readonly score: ScoreState;
  readonly pool: ReviewPoolDay | null;
  readonly economy: SchedulerEconomy;
}

export function emptySchedulerState(
  timeZone: string,
  economy: SchedulerEconomy = DEFAULT_SCHEDULER_ECONOMY,
): SchedulerState {
  return {
    timeZone,
    rows: new Map(),
    holds: [],
    anomalies: [],
    attempts: EMPTY_ATTEMPT_LEDGER,
    introductions: EMPTY_INTRODUCTION_LEDGER,
    score: EMPTY_SCORE_STATE,
    pool: null,
    economy,
  };
}

/** Put rows in the state without introducing them: they exist, they may not be served. */
export function registerRows(state: SchedulerState, specs: readonly NewRowSpec[]): SchedulerState {
  const rows = new Map(state.rows);
  for (const spec of specs) {
    const key = rowKeyOf(spec.itemId, spec.surface);
    if (rows.has(key)) continue;
    rows.set(key, newRow(spec));
  }
  return { ...state, rows };
}

export function rowAt(
  state: SchedulerState,
  itemId: ItemId,
  surface: Surface,
): FsrsRow | undefined {
  return state.rows.get(rowKeyOf(itemId, surface));
}

export function localDayAt(state: SchedulerState, at: Date): LocalDay {
  return localDayOf(at, state.timeZone);
}

/**
 * The introduction beat for one surface (INV-SCH-11), which also feeds INV-SCH-10's
 * per-local-day budget.
 *
 * This does NOT enforce the budget: `planIntroductions` does, before the generator commits
 * to a queue. Enforcing it again here would make a legitimate replay of an already-taught
 * item look like a budget breach. Introducing an already-introduced surface is a no-op on
 * the row and appends only a record, so replay is safe.
 */
export function introduce(
  state: SchedulerState,
  itemId: ItemId,
  surface: Surface,
  at: Date,
): SchedulerState {
  const key = rowKeyOf(itemId, surface);
  const row = state.rows.get(key);
  if (row === undefined) return state;
  if (isIntroduced(row)) return state;
  const rows = new Map(state.rows);
  rows.set(key, introduceRow(row, at));
  return {
    ...state,
    rows,
    introductions: recordIntroduction(
      state.introductions,
      introductionRecordFor(itemId, surface, at, state.timeZone),
    ),
  };
}

export interface EncounterResult {
  readonly state: SchedulerState;
  /** `null` when the attempt was already on file: a replayed commit does nothing. */
  readonly review: ReviewResult | null;
  readonly wroteAttempt: boolean;
}

/**
 * Apply one answered exercise.
 *
 * Idempotent on `(session_id, exercise_index)` (INV-SCH-03): a replayed commit returns the
 * state it was given, by identity, and writes nothing — not an attempt row, not an
 * anomaly, not an FSRS update. That is the whole of "replay of any commit is idempotent",
 * and it is checked before anything else can have a side effect.
 */
export function applyEncounter(state: SchedulerState, encounter: Encounter): EncounterResult {
  const key = attemptKeyOf(encounter.sessionId, encounter.exerciseIndex);
  if (state.attempts.rows.has(key)) {
    return { state, review: null, wroteAttempt: false };
  }

  const rowKey = rowKeyOf(encounter.itemId, encounter.surface);
  const row = state.rows.get(rowKey);
  if (row === undefined) {
    const anomaly: AnomalyRow = {
      kind: 'uncreditedSurface',
      rowKey,
      at: encounter.at,
      observedMs: null,
      usedMs: null,
      note: 'encounter of a surface with no FSRS row',
    };
    return {
      state: withAttempt(
        { ...state, anomalies: [...state.anomalies, anomaly] },
        attemptRowFor(encounter, 'uncredited'),
      ),
      review: null,
      wroteAttempt: true,
    };
  }

  /**
   * INV-SCH-10's production delay, checked BEFORE the row is credited. A production
   * exercise the generator should not have built is recorded as an attempt — it happened —
   * and credits nothing, so the memory model never learns from a beat that was too early.
   */
  const roleOk = roleAllowedAt(
    state.introductions,
    encounter.itemId,
    encounter.role,
    encounter.at,
    state.economy,
  );
  if (!roleOk && isIntroduced(row)) {
    const anomaly: AnomalyRow = {
      kind: 'productionTooSoon',
      rowKey,
      at: encounter.at,
      observedMs: null,
      usedMs: null,
      note: 'production encounter inside min_hours_between_introduction_and_production',
    };
    return {
      state: withAttempt(
        { ...state, anomalies: [...state.anomalies, anomaly] },
        attemptRowFor(encounter, 'uncredited'),
      ),
      review: null,
      wroteAttempt: true,
    };
  }

  const since = row.card.last_review ?? row.introducedAt ?? encounter.at;
  const result = reviewRow(row, {
    grade: encounter.grade,
    now: encounter.at,
    rubyShown: encounter.rubyShown,
    held: isHeldAt(row, state.holds, encounter.at),
    heldMs: heldMsBetween(row, state.holds, since, encounter.at),
  });

  const rows = new Map(state.rows);
  rows.set(rowKey, result.row);
  const next: SchedulerState = {
    ...state,
    rows,
    anomalies: [...state.anomalies, ...result.anomalies],
    score: observeMastery(state.score, [result.row]),
  };
  return {
    state: withAttempt(next, attemptRowFor(encounter, result.kind)),
    review: result,
    wroteAttempt: true,
  };
}

function attemptRowFor(encounter: Encounter, reviewKind: AttemptRow['reviewKind']): AttemptRow {
  return {
    sessionId: encounter.sessionId,
    exerciseIndex: encounter.exerciseIndex,
    itemId: encounter.itemId,
    surface: encounter.surface,
    grade: encounter.grade,
    at: encounter.at,
    reviewKind,
  };
}

function withAttempt(state: SchedulerState, row: AttemptRow): SchedulerState {
  return { ...state, attempts: appendAttempt(state.attempts, row) };
}

/** Open a hold window (a report, a modality going off). */
export function addHold(state: SchedulerState, window: HoldWindow): SchedulerState {
  return { ...state, holds: [...state.holds, window] };
}

export function setHolds(state: SchedulerState, holds: readonly HoldWindow[]): SchedulerState {
  return { ...state, holds };
}

/** Every row that is not held right now, with its current due date. S066 reads this. */
export function servableRows(state: SchedulerState, at: Date): FsrsRow[] {
  const out: FsrsRow[] = [];
  for (const row of state.rows.values()) {
    if (!isIntroduced(row)) continue;
    if (isHeldAt(row, state.holds, at)) continue;
    out.push(row);
  }
  return out;
}
