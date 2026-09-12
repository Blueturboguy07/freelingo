/**
 * `rolloverTo(localDay)` — the load-bearing screen-less state (`deep/04` §20).
 *
 * One idempotent function, run on app foreground, lesson completion, a notification fire
 * and any background refresh the OS grants. It walks every un-processed civil date
 * between `last_processed_day` and today−1 and decides each one: completed → extend;
 * missed with a freeze owned before the day began → consume one, the day is `frozen`, the
 * streak survives; missed with none → the streak breaks, `broken_on` and
 * `previous_streak` are RECORDED, and recovery is armed.
 *
 * Four rules that are easy to get wrong and are all asserted as properties:
 *
 * - It iterates **civil dates, not elapsed hours** (INV-DAY-05). A 23-hour and a 25-hour
 *   day each consume exactly zero or one freeze.
 * - It is **idempotent and terminating** for any input (INV-DAY-09). Each civil day's
 *   decision is one exclusive transaction over (freeze decrement, disposition,
 *   `last_processed_day`), and the freeze ledger is keyed by the day it covers, so a kill
 *   after any write makes the replay a no-op (INV-FRZ-05).
 * - A gap longer than `maxOfflineDays` is **collapsed**, never enumerated (INV-DAY-07).
 * - It never walks backwards. A day already decided stays decided however the clock moves
 *   afterwards (INV-DAY-06).
 *
 * Internally the walk mutates a single draft. Rebuilding the disposition map once per
 * civil date turns a 400-day trace into O(n²), and these properties run 10,000 of them.
 */
import {
  addCivilDays,
  civilDaysBetween,
  firstDayOfNextMonth,
  monthKeyOf,
  type LocalDay,
} from './civil.js';
import { DAY_CONFIG, type DayConfig } from './config.js';
import { streakFromDispositions, type DayDisposition } from './dispositions.js';
import { freezesOwnedBefore, type FreezeConsumption, type FreezeLedger } from './freeze.js';
import { expireChallengeIfLapsed } from './recovery.js';
import type { BreakRecord, DayEngineState, LongAbsence, MonthSettlement } from './state.js';

export interface RolloverContext {
  /** Civil dates credited by a completed session (see `session.ts`). */
  readonly completedDays: ReadonlySet<LocalDay>;
  /** Civil dates the local clock jumped over via a zone change (`unlived.ts`). */
  readonly unlivedDays?: ReadonlySet<LocalDay>;
  /**
   * The subset of `completedDays` whose credit came from the midnight grace window —
   * `SessionRow.creditedByGrace` on the row that credited the day (INV-DAY-08).
   *
   * The walk records it rather than dropping it, because S127's `half-flame` cell is a
   * product-map state and an undefined state is a build bug: without this the calendar
   * cannot tell a day the learner finished from a day the grace window saved, and the
   * `Just made it!` provenance has nowhere to come from.
   */
  readonly graceCreditedDays?: ReadonlySet<LocalDay>;
}

export type RolloverEvent =
  | { readonly kind: 'day'; readonly day: LocalDay; readonly disposition: DayDisposition }
  | { readonly kind: 'freeze-consumed'; readonly day: LocalDay }
  | { readonly kind: 'break'; readonly day: LocalDay; readonly previousStreak: number }
  | { readonly kind: 'long-absence'; readonly absence: LongAbsence }
  | { readonly kind: 'month-settled'; readonly settlement: MonthSettlement }
  | { readonly kind: 'clock-adopted'; readonly day: LocalDay };

export interface RolloverResult {
  readonly state: DayEngineState;
  readonly events: readonly RolloverEvent[];
  /** Freezes spent by THIS call. `min(missed_days, owned_at_absence_start)` (INV-FRZ-01). */
  readonly freezesConsumed: number;
  /** Civil dates decided by this call, collapsed absences counted once per cell written. */
  readonly daysProcessed: number;
}

/** A mutable draft of everything the walk touches. Frozen back into state at the end. */
interface Draft {
  dispositions: Map<LocalDay, DayDisposition>;
  graceCreditedDays: Set<LocalDay>;
  longestStreak: number;
  consumptions: FreezeConsumption[];
  settlements: MonthSettlement[];
  lastProcessedMonth: string | null;
  settledMonths: Set<string>;
  longAbsences: LongAbsence[];
  brk: BreakRecord | null;
  /**
   * Is the CURRENT break still open? A break closes the moment a day is completed again.
   * Without this flag a missed day years after an unrecovered break would be appended to
   * that old break's uncovered list instead of recording the new one.
   */
  breakOpen: boolean;
  uncovered: LocalDay[];
  activeStreak: number;
  ownedFreezes: number;
  events: RolloverEvent[];
  consumedCount: number;
  daysProcessed: number;
}

/** Settle `day`'s month if it has not been settled. Exactly one settlement per month. */
function settleMonth(draft: Draft, day: LocalDay): void {
  const month = monthKeyOf(day);
  if (draft.settledMonths.has(month)) return;
  const settlement: MonthSettlement = {
    month,
    settledMonth: draft.lastProcessedMonth,
    atDay: day,
  };
  draft.settledMonths.add(month);
  draft.settlements.push(settlement);
  draft.lastProcessedMonth = month;
  draft.events.push({ kind: 'month-settled', settlement });
}

/** Settle every distinct month in `[from, to]` without walking a single day. */
function settleMonthRange(draft: Draft, from: LocalDay, to: LocalDay): void {
  let cursor = from;
  while (cursor <= to) {
    settleMonth(draft, cursor);
    cursor = firstDayOfNextMonth(cursor);
  }
}

function dispose(draft: Draft, day: LocalDay, disposition: DayDisposition): void {
  draft.dispositions.set(day, disposition);
  draft.events.push({ kind: 'day', day, disposition });
  draft.daysProcessed += 1;
}

/** Record a break. Once recorded for a day it is never rewritten (INV-DAY-06). */
function recordBreak(draft: Draft, day: LocalDay): void {
  if (draft.brk !== null && draft.brk.brokenOn === day) return;
  draft.uncovered = [day];
  draft.brk = { brokenOn: day, previousStreak: draft.activeStreak, uncoveredDays: [day] };
  draft.events.push({ kind: 'break', day, previousStreak: draft.activeStreak });
  draft.activeStreak = 0;
  draft.breakOpen = true;
}

/**
 * One civil day's exclusive transaction (INV-FRZ-05): the freeze decrement, the day's
 * disposition and the advance of `last_processed_day` happen together or not at all.
 */
function decideDay(
  draft: Draft,
  day: LocalDay,
  onDay: LocalDay,
  ctx: RolloverContext,
  alreadyConsumedFor: ReadonlySet<LocalDay>,
): void {
  settleMonth(draft, day);
  if (ctx.unlivedDays?.has(day) === true) {
    // The clock jumped over it: not a missed day, no freeze, transparent to the walk.
    dispose(draft, day, 'unlived');
    return;
  }
  if (ctx.completedDays.has(day)) {
    dispose(draft, day, 'completed');
    if (ctx.graceCreditedDays?.has(day) === true) draft.graceCreditedDays.add(day);
    draft.activeStreak += 1;
    if (draft.activeStreak > draft.longestStreak) draft.longestStreak = draft.activeStreak;
    draft.breakOpen = false;
    return;
  }
  // A lived, missed day — including every day a powered-off phone slept through.
  if (alreadyConsumedFor.has(day)) {
    // A previous walk already spent a freeze on this date and was killed before it could
    // advance the marker. The consumption is keyed by the day it covers, so the replay
    // reproduces the same disposition and spends nothing (INV-FRZ-05).
    dispose(draft, day, 'frozen');
    return;
  }
  // Only a live streak is worth protecting: once it is 0 there is nothing a freeze saves,
  // and burning one there would break `min(missed_days, owned_at_absence_start)`.
  const protectable = draft.activeStreak > 0;
  if (protectable && draft.ownedFreezes > 0) {
    draft.ownedFreezes -= 1;
    draft.consumptions.push({ consumedForDay: day, consumedOnDay: onDay });
    draft.consumedCount += 1;
    draft.events.push({ kind: 'freeze-consumed', day });
    dispose(draft, day, 'frozen');
    return;
  }
  dispose(draft, day, 'missed');
  if (draft.breakOpen) {
    if (!draft.uncovered.includes(day)) draft.uncovered.push(day);
  } else {
    recordBreak(draft, day);
  }
}

function seal(
  state: DayEngineState,
  draft: Draft,
  ledger: FreezeLedger,
  lastProcessedDay: LocalDay,
  maxSeen: LocalDay,
): DayEngineState {
  const brk =
    draft.brk === null
      ? null
      : {
          brokenOn: draft.brk.brokenOn,
          previousStreak: draft.brk.previousStreak,
          uncoveredDays: [...draft.uncovered],
        };
  return {
    ...state,
    lastProcessedDay,
    maxLocalDaySeen: maxSeen,
    dispositions: draft.dispositions,
    graceCreditedDays: draft.graceCreditedDays,
    longestStreak: draft.longestStreak,
    ledger:
      draft.consumptions.length === ledger.consumptions.length
        ? ledger
        : { ...ledger, consumptions: draft.consumptions },
    brk,
    settlements: draft.settlements,
    lastProcessedMonth: draft.lastProcessedMonth,
    longAbsences: draft.longAbsences,
  };
}

/**
 * Walk to `today`. Everything strictly before `today` is decided; `today` itself never is
 * — it is not over yet, and deciding it is exactly the bug that burns a freeze on a day
 * the learner is about to save (see `rolloverDeferral`).
 */
/**
 * Walk to `today`, then run the challenge's own lifecycle.
 *
 * `expireChallengeIfLapsed` used to be exported and called by nobody: a lapsed challenge
 * row survived every rollover and was killed only if a caller happened to ask. The walk
 * is the one place that always runs, so it is where the window closes.
 */
export function rolloverTo(
  state: DayEngineState,
  today: LocalDay,
  ctx: RolloverContext,
): RolloverResult {
  const result = walkTo(state, today, ctx);
  const expired = expireChallengeIfLapsed(result.state, today);
  return expired === result.state ? result : { ...result, state: expired };
}

function walkTo(
  state: DayEngineState,
  today: LocalDay,
  ctx: RolloverContext,
): RolloverResult {
  const ledger = state.ledger;
  const draft: Draft = {
    dispositions: new Map(state.dispositions),
    graceCreditedDays: new Set(state.graceCreditedDays),
    longestStreak: state.longestStreak,
    consumptions: [...ledger.consumptions],
    settlements: [...state.settlements],
    lastProcessedMonth: state.lastProcessedMonth,
    settledMonths: new Set(state.settlements.map((s) => s.month)),
    longAbsences: [...state.longAbsences],
    brk: state.brk,
    breakOpen: false,
    uncovered: state.brk === null ? [] : [...state.brk.uncoveredDays],
    activeStreak: 0,
    ownedFreezes: 0,
    events: [],
    consumedCount: 0,
    daysProcessed: 0,
  };

  const maxSeen =
    state.maxLocalDaySeen === null || today > state.maxLocalDaySeen ? today : state.maxLocalDaySeen;

  // The 1970 install (INV-DAY-14): day keying is deferred until a sane clock is observed,
  // and the first sane day becomes day one with NO backfill. Never 20,000 civil days.
  if (state.clockUnreliable) {
    if (today < DAY_CONFIG.buildLocalDay) {
      return { state, events: [], freezesConsumed: 0, daysProcessed: 0 };
    }
    settleMonth(draft, today);
    const adopted = seal(state, draft, ledger, addCivilDays(today, -1), maxSeen);
    draft.events.push({ kind: 'clock-adopted', day: today });
    return {
      state: { ...adopted, clockUnreliable: false },
      events: draft.events,
      freezesConsumed: 0,
      daysProcessed: 0,
    };
  }

  // First ever run: adopt YESTERDAY as the marker, not today.
  //
  // The marker means "everything up to and including this date is decided", and the walk
  // starts at `marker + 1`. Adopting today would therefore skip today forever — the day
  // the learner is about to practise on would never get a disposition, and the next
  // break would record `previous_streak = 0` for a learner who was on day one of a
  // streak. Nothing before today is invented: the walk has no history to reach back into.
  if (state.lastProcessedDay === null) {
    settleMonth(draft, today);
    return {
      state: seal(state, draft, ledger, addCivilDays(today, -1), maxSeen),
      events: draft.events,
      freezesConsumed: 0,
      daysProcessed: 0,
    };
  }

  // Never walk backwards. A clock set back leaves every decided day decided (INV-DAY-06).
  if (today <= state.lastProcessedDay) {
    return {
      state: state.maxLocalDaySeen === maxSeen ? state : { ...state, maxLocalDaySeen: maxSeen },
      events: [],
      freezesConsumed: 0,
      daysProcessed: 0,
    };
  }

  const start = addCivilDays(state.lastProcessedDay, 1);
  const end = addCivilDays(today, -1);
  const gap = civilDaysBetween(start, end) + 1;
  if (gap <= 0) {
    settleMonth(draft, today);
    return {
      state: seal(state, draft, ledger, state.lastProcessedDay, maxSeen),
      events: draft.events,
      freezesConsumed: 0,
      daysProcessed: 0,
    };
  }

  draft.activeStreak = streakFromDispositions(draft.dispositions, state.lastProcessedDay, false);
  if (draft.activeStreak > draft.longestStreak) draft.longestStreak = draft.activeStreak;
  // A break recorded earlier is still open only if nothing has been completed since.
  draft.breakOpen = state.brk !== null && draft.activeStreak === 0;
  draft.ownedFreezes = freezesOwnedBefore(ledger, start);
  const alreadyConsumedFor = new Set(ledger.consumptions.map((c) => c.consumedForDay));
  // Grants that become owned DURING the walk, applied in day order as the cursor passes
  // them. Precomputed so the inner loop stays O(1) per civil date.
  const pending = ledger.grants
    .filter((g) => g.ownedFromDay >= start && g.applied > 0)
    .sort((a, b) => (a.ownedFromDay < b.ownedFromDay ? -1 : 1));
  let pendingIndex = 0;

  if (gap > DAY_CONFIG.maxOfflineDays) {
    // One long absence: one freeze attempt run over its head, one break, and the rest
    // collapsed. `min(gap, owned, maxOfflineDays)` freezes, then a single breaking day.
    const attempt = Math.min(gap, draft.ownedFreezes, DAY_CONFIG.maxOfflineDays);
    let cursor = start;
    for (let i = 0; i < attempt; i += 1) {
      decideDay(draft, cursor, today, ctx, alreadyConsumedFor);
      cursor = addCivilDays(cursor, 1);
    }
    if (cursor <= end) {
      decideDay(draft, cursor, today, ctx, alreadyConsumedFor);
      cursor = addCivilDays(cursor, 1);
    }
    settleMonthRange(draft, cursor <= end ? cursor : end, end);
    const absence: LongAbsence = {
      from: start,
      to: end,
      days: gap,
      freezesConsumed: draft.consumedCount,
    };
    draft.longAbsences.push(absence);
    draft.events.push({ kind: 'long-absence', absence });
    settleMonth(draft, today);
    return {
      state: seal(state, draft, ledger, end, maxSeen),
      events: draft.events,
      freezesConsumed: draft.consumedCount,
      daysProcessed: draft.daysProcessed,
    };
  }

  let cursor = start;
  for (let i = 0; i < gap; i += 1) {
    while (pendingIndex < pending.length && pending[pendingIndex]!.ownedFromDay < cursor) {
      draft.ownedFreezes += pending[pendingIndex]!.applied;
      pendingIndex += 1;
    }
    decideDay(draft, cursor, today, ctx, alreadyConsumedFor);
    cursor = addCivilDays(cursor, 1);
  }
  settleMonth(draft, today);

  return {
    state: seal(state, draft, ledger, end, maxSeen),
    events: draft.events,
    freezesConsumed: draft.consumedCount,
    daysProcessed: draft.daysProcessed,
  };
}

/**
 * How long rollover may be deferred past local midnight — EC-STK-14, the plan's ruling.
 *
 * `deep/04` case 43 defers the freeze decision while a session is live, so a learner
 * finishing at 00:03 does not lose a freeze on the day they are about to save. But a
 * KILLED session leaves `session_in_progress` true forever: the deferral never lifts, the
 * freeze is never evaluated and the widget snapshot is never rewritten. So the deferral is
 * bounded twice — by the session's own staleness, and by a hard
 * `maxRolloverDeferralSeconds` ceiling measured from local midnight.
 *
 * The returned instant is ALWAYS ≤ midnight + `maxRolloverDeferralSeconds`. That is the
 * property: a session that never completes cannot starve rollover past the bound.
 */
export function rolloverDeferral(
  nowMs: number,
  localMidnightMs: number,
  ctx: { readonly sessionInProgress: boolean; readonly lastCheckpointMs: number | null },
  /**
   * Injectable so a test can raise the ceiling and watch the session-staleness term
   * actually move. At the shipped values `graceSeconds === maxRolloverDeferralSeconds`,
   * so the ceiling always binds and the staleness term is arithmetically inert — a test
   * written only against the shipped numbers cannot tell the session logic from a
   * constant, and would pass with it deleted.
   */
  config: Pick<
    DayConfig,
    'graceSeconds' | 'maxRolloverDeferralSeconds' | 'sessionTimeoutSeconds'
  > = DAY_CONFIG,
): { readonly defer: boolean; readonly untilMs: number } {
  const ceiling = localMidnightMs + config.maxRolloverDeferralSeconds * 1000;
  const graceEnd = localMidnightMs + config.graceSeconds * 1000;
  const staleness = (config.graceSeconds + config.sessionTimeoutSeconds) * 1000;
  const sessionEnd =
    ctx.sessionInProgress && ctx.lastCheckpointMs !== null
      ? ctx.lastCheckpointMs + staleness
      : localMidnightMs;
  const untilMs = Math.min(ceiling, Math.max(graceEnd, sessionEnd));
  return { defer: nowMs < untilMs, untilMs };
}
