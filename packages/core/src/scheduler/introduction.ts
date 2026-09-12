/**
 * First exposure: the daily budget and the production delay (INV-SCH-10, INV-SCH-11).
 *
 * EC-SCH-11: "Day 2: twenty frontier lessons in four hours introduce ~120 new lexemes plus
 * their grammar-concept items. Ship shared constants `max_new_items_per_local_day = 40` and
 * `min_hours_between_introduction_and_production = 4`. On hitting the cap the generator
 * switches path lessons to REVIEW-ONLY DRAWS — the node still completes and still pays XP,
 * with one non-blocking line. NEVER A WALL, and never a recognition-then-production pair
 * inside one sitting."
 *
 * Two rules, two different keys, and getting the keys wrong is the whole bug:
 *
 * - The budget is per LOCAL DAY and counts distinct ITEMS first introduced that day. Local
 *   day, not 24 hours, so it resets with quests and the goal chest (INV-DAY-05); items,
 *   not rows, because the invariant says "first-exposure items" and a second accepted
 *   surface of a word already taught today is not new material (EC-SCH-12 gives that
 *   surface its own introduction beat, which INV-SCH-11 covers).
 * - The production delay is per LEXEME and measured in real hours from that lexeme's FIRST
 *   introduction, because "inside one sitting" is a statement about the clock, not about
 *   the calendar: introduced at 23:50 and produced at 00:10 is one sitting across two
 *   local days, and the delay must still bite.
 */
import { localDayOf, type LocalDay } from '../day/civil.js';
import { DEFAULT_SCHEDULER_ECONOMY, MS_PER_HOUR, type SchedulerEconomy } from './config.js';
import type { EncounterRole, ItemId, Surface } from './types.js';

export interface IntroductionRecord {
  readonly itemId: ItemId;
  readonly surface: Surface;
  readonly at: Date;
  readonly localDay: LocalDay;
}

export interface IntroductionLedger {
  /** Every introduction beat, in order. */
  readonly records: readonly IntroductionRecord[];
  /** item -> the instant of its FIRST introduction, any surface. */
  readonly firstIntroducedAt: ReadonlyMap<ItemId, Date>;
  /** local day -> the distinct items first introduced on it. */
  readonly firstExposuresByDay: ReadonlyMap<LocalDay, ReadonlySet<ItemId>>;
}

export const EMPTY_INTRODUCTION_LEDGER: IntroductionLedger = {
  records: [],
  firstIntroducedAt: new Map(),
  firstExposuresByDay: new Map(),
};

/**
 * Record one introduction beat.
 *
 * A repeat beat for an item already introduced still appends a record (a new SURFACE is a
 * real event) but does NOT move `firstIntroducedAt` and does NOT spend a day's budget
 * slot. Both of those must be first-write-wins, or a replayed commit would restart the
 * production delay and re-charge the budget.
 */
export function recordIntroduction(
  ledger: IntroductionLedger,
  record: IntroductionRecord,
): IntroductionLedger {
  const records = [...ledger.records, record];
  if (ledger.firstIntroducedAt.has(record.itemId)) {
    return { ...ledger, records };
  }
  const firstIntroducedAt = new Map(ledger.firstIntroducedAt);
  firstIntroducedAt.set(record.itemId, record.at);
  const firstExposuresByDay = new Map(ledger.firstExposuresByDay);
  const onDay = new Set(firstExposuresByDay.get(record.localDay) ?? []);
  onDay.add(record.itemId);
  firstExposuresByDay.set(record.localDay, onDay);
  return { records, firstIntroducedAt, firstExposuresByDay };
}

export function introductionRecordFor(
  itemId: ItemId,
  surface: Surface,
  at: Date,
  timeZone: string,
): IntroductionRecord {
  return { itemId, surface, at, localDay: localDayOf(at, timeZone) };
}

/** Distinct items first introduced on this local day. INV-SCH-10's counter. */
export function firstExposuresOnDay(ledger: IntroductionLedger, day: LocalDay): number {
  return ledger.firstExposuresByDay.get(day)?.size ?? 0;
}

export function remainingNewItemBudget(
  ledger: IntroductionLedger,
  day: LocalDay,
  economy: SchedulerEconomy = DEFAULT_SCHEDULER_ECONOMY,
): number {
  return Math.max(0, economy.maxNewItemsPerLocalDay - firstExposuresOnDay(ledger, day));
}

export function isIntroducedItem(ledger: IntroductionLedger, itemId: ItemId): boolean {
  return ledger.firstIntroducedAt.has(itemId);
}

/**
 * How many of `candidates` may be introduced now, in the order offered.
 *
 * Candidates the ledger already knows are dropped (they are not first exposures and cost
 * nothing); the rest are cut to the day's remaining budget. Returning a SHORTER list is
 * what "switches path lessons to review-only draws" means: the caller tops the node up
 * with reviews. It is never a refusal, and never a wall.
 */
export function planIntroductions(
  ledger: IntroductionLedger,
  day: LocalDay,
  candidates: readonly ItemId[],
  economy: SchedulerEconomy = DEFAULT_SCHEDULER_ECONOMY,
): ItemId[] {
  const budget = remainingNewItemBudget(ledger, day, economy);
  const fresh: ItemId[] = [];
  const seen = new Set<ItemId>();
  for (const id of candidates) {
    if (fresh.length >= budget) break;
    if (seen.has(id) || ledger.firstIntroducedAt.has(id)) continue;
    seen.add(id);
    fresh.push(id);
  }
  return fresh;
}

/**
 * INV-SCH-10's second clause: may this lexeme be PRODUCED yet?
 *
 * An item nobody has introduced cannot be produced at all (that is INV-SCH-11's gate as
 * seen from here). One that was introduced must have been introduced at least
 * `min_hours_between_introduction_and_production` ago, measured in real hours.
 *
 * A clock that has gone backwards yields a negative age, which is below any positive
 * threshold, so a tampered clock makes the gate STRICTER rather than opening it. That is
 * the direction a gate should fail in, and it is checked by the INV-SCH-10 property under
 * the same adversarial clock sequences INV-SCH-02 uses.
 */
export function productionAllowedAt(
  ledger: IntroductionLedger,
  itemId: ItemId,
  at: Date,
  economy: SchedulerEconomy = DEFAULT_SCHEDULER_ECONOMY,
): boolean {
  const introducedAt = ledger.firstIntroducedAt.get(itemId);
  if (introducedAt === undefined) return false;
  const ageMs = at.getTime() - introducedAt.getTime();
  return ageMs >= economy.minHoursBetweenIntroductionAndProduction * MS_PER_HOUR;
}

/** `productionAllowedAt`, applied to a role: recognition is always allowed. */
export function roleAllowedAt(
  ledger: IntroductionLedger,
  itemId: ItemId,
  role: EncounterRole,
  at: Date,
  economy: SchedulerEconomy = DEFAULT_SCHEDULER_ECONOMY,
): boolean {
  if (role === 'recognition') return isIntroducedItem(ledger, itemId);
  return productionAllowedAt(ledger, itemId, at, economy);
}
