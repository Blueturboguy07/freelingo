/**
 * Day-keyed economy: the goal chest, session active time and personal records.
 *
 * Owns INV-ECO-05 (the goal chest is granted at most once per `local_day`, idempotently,
 * and a mid-day goal change neither re-fires it nor un-meets the day), INV-ECO-20
 * (`active_ms` is non-null, never advances while backgrounded or modal, and every
 * minutes-shaped string reads it) and INV-ECO-23 (personal-record celebrations are
 * throttled and never enter the ceremony chain).
 */
import type { LocalDay } from '../day/civil.js';
import {
  DAILY_GOAL_CHEST_GEMS,
  RECORD_CELEBRATION_COOLDOWN_DAYS,
  RECORD_CELEBRATION_MIN_MARGIN_ABSOLUTE,
  RECORD_CELEBRATION_MIN_MARGIN_RATIO,
} from './config.js';
import { goalMet } from './xp.js';

/* -------------------------------------------------------------- the goal chest */

/**
 * The day's goal ledger row. `grantedAtUtc !== null` is the idempotency key: the chest
 * fires when the row is created and never again for that `local_day`, whatever happens
 * to the goal afterwards.
 */
export interface GoalDayRow {
  readonly localDay: LocalDay;
  /** XP earned on this local day, all courses, all flavours that count toward the goal. */
  readonly earnedXp: number;
  /** The goal in force when the chest was granted. Kept for the ceremony copy. */
  readonly goalXpAtGrant: number | null;
  readonly grantedAtUtc: string | null;
}

export type GoalLedger = ReadonlyMap<LocalDay, GoalDayRow>;

export interface GoalChestResult {
  readonly ledger: GoalLedger;
  /** Gems to pay. 0 on every call after the first for that day. */
  readonly gemsAwarded: number;
  readonly chestFired: boolean;
  /** True whenever the day is met, whether or not the chest fired on THIS call. */
  readonly dayMet: boolean;
}

/**
 * Record XP against a local day and decide whether the goal chest fires (INV-ECO-05).
 *
 * Idempotent by construction: replaying the same commit (the ceremony was killed and
 * relaunched, deep/04 case 29) finds `grantedAtUtc` already set and pays nothing.
 *
 * The mid-day goal change is the other half, and it is the half that gets written wrong.
 * Once a day is met it STAYS met: lowering the goal does not re-fire the chest (the row
 * is already granted) and raising it does not un-meet the day (nothing re-reads
 * `goalXp` for a granted row). Both directions are edge cases EC-ECO-09/EC-CER-06 and
 * both are properties in `daily.test.ts`.
 */
export function recordGoalXp(
  ledger: GoalLedger,
  localDay: LocalDay,
  xpToAdd: number,
  goalXpNow: number,
  atUtc: string,
): GoalChestResult {
  const next = new Map(ledger);
  const existing = next.get(localDay);
  const earnedXp = (existing?.earnedXp ?? 0) + Math.max(0, xpToAdd);
  const alreadyGranted = existing?.grantedAtUtc != null;

  if (alreadyGranted) {
    next.set(localDay, { ...(existing as GoalDayRow), earnedXp });
    return { ledger: next, gemsAwarded: 0, chestFired: false, dayMet: true };
  }

  const met = goalMet(earnedXp, goalXpNow);
  next.set(localDay, {
    localDay,
    earnedXp,
    goalXpAtGrant: met ? goalXpNow : null,
    grantedAtUtc: met ? atUtc : null,
  });
  return {
    ledger: next,
    gemsAwarded: met ? DAILY_GOAL_CHEST_GEMS : 0,
    chestFired: met,
    dayMet: met,
  };
}

/** Whether the chest has ever fired for a day. The only definition of "met" anyone reads. */
export function goalDayIsMet(ledger: GoalLedger, localDay: LocalDay): boolean {
  return ledger.get(localDay)?.grantedAtUtc != null;
}

/**
 * Changing the daily goal mid-day (S132).
 *
 * Returns the ledger UNCHANGED. That is the implementation: a goal change touches
 * `account.daily_goal_xp` and nothing day-keyed. Written as a function anyway so the
 * invariant has something to call and the next person has somewhere to read the rule.
 */
export function changeDailyGoal(ledger: GoalLedger): GoalLedger {
  return ledger;
}

/* ------------------------------------------------------------------- active_ms */

/**
 * A span of session time with the two flags that stop the clock (INV-ECO-20).
 *
 * `active_ms` is time the learner could actually have been answering. It never advances
 * while the app is backgrounded and never advances behind a modal — which is exactly why
 * a weekly-report figure derived from wall-clock session spans is the named falsifier.
 */
export interface ActiveSpan {
  readonly ms: number;
  readonly backgrounded: boolean;
  readonly modal: boolean;
}

export function accumulateActiveMs(spans: readonly ActiveSpan[]): number {
  let total = 0;
  for (const span of spans) {
    if (span.backgrounded || span.modal) continue;
    if (!Number.isFinite(span.ms) || span.ms <= 0) continue;
    total += span.ms;
  }
  return total;
}

/**
 * The one minutes-shaped string in the engine (INV-ECO-20, INV-ECO-21).
 *
 * Every "you spent N minutes" surface reads `active_ms` through this function. It is
 * deliberately NOT usable for progress: INV-ECO-21's second falsifier is "a bar reading
 * `5/5 min`", so nothing that renders goal progress may call this.
 */
export function activeMinutesString(activeMs: number): string {
  const minutes = Math.max(0, Math.round(activeMs / 60_000));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/* ----------------------------------------------------------- personal records */

/**
 * Personal records (S126). Three, and they update SILENTLY: "Daily Most XP" changes on
 * almost every session for a heavy user, so a ceremony screen for it would be a ceremony
 * screen for every session.
 */
export const PERSONAL_RECORD_KINDS = ['longestStreak', 'dailyMostXp', 'perfectLessons'] as const;
export type PersonalRecordKind = (typeof PERSONAL_RECORD_KINDS)[number];

/**
 * INV-ECO-23: over any 30-day simulated history the number of celebrations is
 * `<= ceil(days / 7)`, and zero of them appear in the ceremony chain.
 *
 * The bound comes out of one cooldown constant: at most one record celebration per
 * seven local days, whatever the records did in between. Twelve consecutive record days
 * therefore produce two celebrations, not twelve — that is the named falsifier.
 *
 * EC-ECO-27's second condition is the MARGIN: "only when the margin exceeds a configured
 * threshold". A personal best by one XP is not a personal best worth a card, and without
 * the margin the cooldown alone would still celebrate a one-point improvement every
 * seventh day forever. Both constants live in `config.ts`, with everything else.
 */
export { RECORD_CELEBRATION_COOLDOWN_DAYS } from './config.js';

export interface RecordEvent {
  readonly localDay: LocalDay;
  readonly kind: PersonalRecordKind;
  /** The record BEFORE this event. 0 when there was none. */
  readonly previousValue?: number;
  /** The record after this event. */
  readonly value?: number;
}

/**
 * EC-ECO-27's margin gate. A record with no previous value (the first one ever) always
 * clears it; after that the improvement must beat BOTH thresholds, so neither a large
 * relative jump on a tiny number nor a large absolute jump on a huge one sneaks through
 * alone.
 */
export function marginIsCelebrationWorthy(previousValue: number, value: number): boolean {
  if (value <= previousValue) return false;
  if (previousValue <= 0) return true;
  const delta = value - previousValue;
  return (
    delta >= RECORD_CELEBRATION_MIN_MARGIN_ABSOLUTE &&
    delta >= previousValue * RECORD_CELEBRATION_MIN_MARGIN_RATIO
  );
}

/**
 * Which record events actually get a celebration, in order.
 *
 * `dayIndex` is the caller's own civil-day index (days since any fixed epoch) so this
 * function stays pure and calendar-free; `packages/core/day` owns civil arithmetic.
 */
export function celebratedRecords(
  events: readonly (RecordEvent & { readonly dayIndex: number })[],
): (RecordEvent & { readonly dayIndex: number })[] {
  const ordered = [...events].sort((a, b) => a.dayIndex - b.dayIndex);
  const celebrated: (RecordEvent & { readonly dayIndex: number })[] = [];
  let lastCelebratedDay: number | null = null;
  for (const event of ordered) {
    // EC-ECO-27's margin gate. Events that carry no values are treated as worthy, so a
    // caller that only tracks days still gets the cooldown bound it asked for.
    if (
      event.value !== undefined &&
      !marginIsCelebrationWorthy(event.previousValue ?? 0, event.value)
    ) {
      continue;
    }
    if (
      lastCelebratedDay === null ||
      event.dayIndex - lastCelebratedDay >= RECORD_CELEBRATION_COOLDOWN_DAYS
    ) {
      celebrated.push(event);
      lastCelebratedDay = event.dayIndex;
    }
  }
  return celebrated;
}

/**
 * The ceremony chain's candidate screens, in order (product map Surface 4).
 *
 * Listed here for one reason: INV-ECO-23's second half is "zero of them appear in the
 * ceremony chain", and an invariant about absence needs the list it is absent from.
 * `ceremony/` owns the predicates; this is the id set it may draw from.
 */
export const CEREMONY_CHAIN_SCREEN_IDS: readonly string[] = [
  'S067', // XP tiles
  'S068', // Score unlock
  'S069', // Score progress
  'S070', // streak count-up
  'S071', // streak goal picker
  'S075', // milestone
  'S078', // quests progress
  'S079', // goal chest
  'S080', // gem chest / bundle
  'S083', // node complete
  'S085', // unit complete
] as const;

/** No personal-record screen is in the chain. A function so the test can call it. */
export const PERSONAL_RECORD_SCREEN_ID = 'S126';
