/**
 * Holds: the windows during which an item accrues ZERO elapsed (INV-SCH-07, INV-SCH-08).
 *
 * Two edge cases, one mechanism:
 *
 * - EC-SCH-08: an open report suppresses the item from generation for 7 local days AND
 *   freezes its FSRS clock, "so dismissal does not read as a lapse".
 * - EC-SCH-09: `Listening exercises` OFF for three days must hold items whose ONLY forms
 *   are listening out of generation and pause their clocks, "otherwise re-enabling buries
 *   new material under a several-hundred-item false backlog". The same pause applies to
 *   the one-hour modality suspensions.
 *
 * The mechanism is a set of half-open windows `[from, until)`. A row is held at `t` when a
 * window applies to it at `t`, and the elapsed that reaches FSRS has the held measure
 * subtracted (`elapsed.ts`). Subtracting the held measure and shifting `due_at` by the
 * same amount are the same operation seen from two ends, which is why the due set on
 * re-enable is the due set at disable time and not one item further on.
 */
import { addCivilDays, localDayOf, type LocalDay } from '../day/civil.js';
import { REPORT_SUPPRESSION_LOCAL_DAYS } from './config.js';
import type { ItemId, Modality } from './types.js';

export const HOLD_REASONS = ['report', 'modalityDisabled', 'modalitySuspended'] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/**
 * What the window covers.
 *
 * `item` holds one item across every surface: a report is about the CONTENT, so holding
 * only the surface that happened to be on screen would let the same bad sentence come
 * back through a different form the same afternoon.
 *
 * `modality` holds a modality, and a row is held by modality only when EVERY modality it
 * can be generated in is covered — EC-SCH-09's "items whose only forms are listening".
 */
export type HoldScope =
  | { readonly kind: 'item'; readonly itemId: ItemId }
  | { readonly kind: 'modality'; readonly modality: Modality };

export interface HoldWindow {
  readonly scope: HoldScope;
  readonly reason: HoldReason;
  readonly from: Date;
  /** `null` = still open. A dismissal or a re-enable closes it by setting this. */
  readonly until: Date | null;
}

/** What a hold needs to know about a row. `FsrsRow` satisfies it structurally. */
export interface HoldableRow {
  readonly itemId: ItemId;
  /** The modalities this row can be generated in. Empty = not modality-gated. */
  readonly modalities: readonly Modality[];
}

function openAt(window: HoldWindow, t: number): boolean {
  if (t < window.from.getTime()) return false;
  return window.until === null || t < window.until.getTime();
}

/**
 * Is this row held at this instant?
 *
 * Item windows are a plain OR. Modality windows are an AND over the row's modalities: a
 * listening-and-reading item is still generable with listening off, so it keeps running.
 */
export function isHeldAt(
  row: HoldableRow,
  windows: readonly HoldWindow[],
  at: Date | number,
): boolean {
  const t = typeof at === 'number' ? at : at.getTime();
  const openModalities = new Set<Modality>();
  for (const window of windows) {
    if (!openAt(window, t)) continue;
    if (window.scope.kind === 'item') {
      if (window.scope.itemId === row.itemId) return true;
    } else {
      openModalities.add(window.scope.modality);
    }
  }
  if (row.modalities.length === 0) return false;
  return row.modalities.every((m) => openModalities.has(m));
}

/**
 * The measure of `[from, to)` during which the row was held, in milliseconds.
 *
 * Computed over the window boundaries rather than by sampling: every `from` and `until`
 * inside the interval is a breakpoint, `isHeldAt` is constant between two consecutive
 * breakpoints, so evaluating it once per sub-interval is exact. Sampling on a fixed grid
 * would miss a one-hour suspension inside a three-day gap, which is precisely the case
 * EC-SCH-09 says must be paused.
 */
export function heldMsBetween(
  row: HoldableRow,
  windows: readonly HoldWindow[],
  from: Date | number,
  to: Date | number,
): number {
  const start = typeof from === 'number' ? from : from.getTime();
  const end = typeof to === 'number' ? to : to.getTime();
  if (!(end > start)) return 0;

  const breakpoints = new Set<number>([start, end]);
  for (const window of windows) {
    const a = window.from.getTime();
    if (a > start && a < end) breakpoints.add(a);
    const b = window.until?.getTime();
    if (b !== undefined && b > start && b < end) breakpoints.add(b);
  }
  const cuts = [...breakpoints].sort((x, y) => x - y);

  let held = 0;
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const lo = cuts[i]!;
    const hi = cuts[i + 1]!;
    // The midpoint: `isHeldAt` is constant on the open sub-interval, and the half-open
    // convention makes the endpoints ambiguous.
    if (isHeldAt(row, windows, (lo + hi) / 2)) held += hi - lo;
  }
  return held;
}

/* ======================================================== local-day window arithmetic */

/**
 * Memo for `startOfLocalDay`. `localDayOf` builds an `Intl.DateTimeFormat` per call and the
 * bisection below makes twelve of them; the INV-SCH-07 property asks for the same handful
 * of civil dates tens of thousands of times. The function is pure, so caching it changes
 * nothing but the clock.
 *
 * Bounded, because this ships in the app and an unbounded map keyed by date is a slow leak
 * in a process that runs for months.
 */
const START_OF_DAY_CACHE = new Map<string, number>();
const START_OF_DAY_CACHE_LIMIT = 4_096;

/**
 * The UTC instant at which a civil date begins in a zone.
 *
 * `day/civil.ts` maps an instant to a civil date; the report window needs the inverse, and
 * `day/` is another task's file lane. Implemented as a bisection over `localDayOf` so it
 * uses only that module's public behaviour and inherits its DST handling: zone offsets are
 * whole minutes, so bisecting to the minute is exact, not approximate.
 *
 * MOVE THIS into `day/` when that module lands; it is day arithmetic, not scheduling.
 */
export function startOfLocalDay(day: LocalDay, timeZone: string): Date {
  const cacheKey = `${timeZone}|${day}`;
  const cached = START_OF_DAY_CACHE.get(cacheKey);
  if (cached !== undefined) return new Date(cached);
  const found = bisectStartOfLocalDay(day, timeZone);
  if (START_OF_DAY_CACHE.size >= START_OF_DAY_CACHE_LIMIT) START_OF_DAY_CACHE.clear();
  START_OF_DAY_CACHE.set(cacheKey, found);
  return new Date(found);
}

function bisectStartOfLocalDay(day: LocalDay, timeZone: string): number {
  const MINUTE = 60_000;
  const anchor = Date.parse(`${day}T00:00:00Z`);
  // No zone is more than 26 hours from UTC in either direction; two days is slack.
  let lo = anchor - 2 * 86_400_000;
  let hi = anchor + 2 * 86_400_000;
  // Invariant: localDayOf(lo) < day <= localDayOf(hi), on a whole-minute grid.
  lo -= lo % MINUTE;
  hi += (MINUTE - (hi % MINUTE)) % MINUTE;
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / (2 * MINUTE)) * MINUTE;
    if (localDayOf(new Date(mid), timeZone) < day) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * EC-SCH-08's report window: from the report instant to the start of the 7th local day
 * after the day it was filed, in the learner's zone.
 *
 * "Within 7 local days" counts the reporting day as day 0, so an item reported at 09:00 on
 * the 1st is generable again at 00:00 on the 8th — seven whole civil dates suppressed,
 * whatever the clock does to the hours in between.
 */
export function reportHoldWindow(itemId: ItemId, reportedAt: Date, timeZone: string): HoldWindow {
  const reportedDay = localDayOf(reportedAt, timeZone);
  const releaseDay = addCivilDays(reportedDay, REPORT_SUPPRESSION_LOCAL_DAYS);
  return {
    scope: { kind: 'item', itemId },
    reason: 'report',
    from: reportedAt,
    until: startOfLocalDay(releaseDay, timeZone),
  };
}

/**
 * Dismissing a report in Settings closes the window early (EC-SCH-08 "or until dismissed").
 *
 * Closing it rather than deleting it is the point: the elapsed the row did not accrue is
 * computed from the window, so a deleted window would hand the item back its whole
 * suppressed week as overdue-ness — which is exactly the lapse the edge case forbids.
 */
export function dismissHold(
  windows: readonly HoldWindow[],
  itemId: ItemId,
  at: Date,
): HoldWindow[] {
  return windows.map((window) => {
    if (window.reason !== 'report') return window;
    if (window.scope.kind !== 'item' || window.scope.itemId !== itemId) return window;
    if (window.until !== null && window.until.getTime() <= at.getTime()) return window;
    return { ...window, until: at };
  });
}

/** Turning a modality OFF opens a window; there is no end until it is turned back on. */
export function disableModality(modality: Modality, at: Date): HoldWindow {
  return {
    scope: { kind: 'modality', modality },
    reason: 'modalityDisabled',
    from: at,
    until: null,
  };
}

/**
 * Turning it back ON closes every open window for it.
 *
 * Ruling EC-MOD-03: "Toggling a modality ON clears a running suspension; OFF never starts
 * one" — so this closes `modalitySuspended` windows too.
 */
export function enableModality(
  windows: readonly HoldWindow[],
  modality: Modality,
  at: Date,
): HoldWindow[] {
  return windows.map((window) => {
    if (window.scope.kind !== 'modality' || window.scope.modality !== modality) return window;
    if (window.until !== null) return window;
    return { ...window, until: at };
  });
}
