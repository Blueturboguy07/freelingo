/**
 * Boost inventory and the running boost (INV-ECO-03, INV-ECO-18; screen S122).
 *
 * Three rules, all of them things a naive implementation gets wrong:
 * 1. Boosts never STACK in multiplier — two boosts are not 4x.
 * 2. A grant never EXTENDS a running timer — the second boost does not make the first
 *    one 30 minutes long.
 * 3. A grant during an active boost enters inventory, and inventory is capped at
 *    `MAX_BOOST_INVENTORY` [DEPART D-NOFARM].
 *
 * Duration is per GRANT (2026 strings: `+1 XP Boost for {n} minute(s)`), so it lives on
 * the grant object and never on a module constant.
 */
import type { ActiveBoost, BoostGrant } from '../types/index.js';
import { MAX_BOOST_INVENTORY } from './config.js';

export interface BoostState {
  readonly activeBoost: ActiveBoost | null;
  readonly inventory: readonly BoostGrant[];
}

export const EMPTY_BOOST_STATE: BoostState = { activeBoost: null, inventory: [] };

function isRunning(boost: ActiveBoost | null, nowUtc: string): boolean {
  if (boost === null) return false;
  return Date.parse(boost.expiresAtUtc) > Date.parse(nowUtc);
}

/** Drop a boost whose instant has passed. Expiry is a UTC instant, never a civil time. */
export function expireBoosts(state: BoostState, nowUtc: string): BoostState {
  if (state.activeBoost === null) return state;
  return isRunning(state.activeBoost, nowUtc) ? state : { ...state, activeBoost: null };
}

/**
 * Grant a boost.
 *
 * With nothing running it starts immediately; with a boost running it goes to inventory.
 * A grant that arrives when inventory is already full is DROPPED, not queued: the cap is
 * the anti-farming bound, and a queue behind a cap is not a cap. The returned
 * `accepted` flag lets the caller render "your boosts are full" instead of lying.
 */
export function grantBoost(
  state: BoostState,
  grant: BoostGrant,
  nowUtc: string,
): { readonly state: BoostState; readonly accepted: boolean; readonly started: boolean } {
  const cleaned = expireBoosts(state, nowUtc);
  if (cleaned.activeBoost === null) {
    const expiresAtUtc = new Date(
      Date.parse(nowUtc) + grant.durationMinutes * 60_000,
    ).toISOString();
    return {
      state: {
        activeBoost: {
          kind: grant.kind,
          multiplier: grant.multiplier,
          startedAtUtc: nowUtc,
          expiresAtUtc,
        },
        inventory: cleaned.inventory,
      },
      accepted: true,
      started: true,
    };
  }
  if (cleaned.inventory.length >= MAX_BOOST_INVENTORY) {
    return { state: cleaned, accepted: false, started: false };
  }
  return {
    state: { ...cleaned, inventory: [...cleaned.inventory, grant] },
    accepted: true,
    started: false,
  };
}

/**
 * Start a held grant. A no-op while a boost is running — that is rule 2: the learner
 * cannot spend a second grant to extend the first, and the inventory entry stays put.
 */
export function startHeldBoost(
  state: BoostState,
  index: number,
  nowUtc: string,
): { readonly state: BoostState; readonly started: boolean } {
  const cleaned = expireBoosts(state, nowUtc);
  if (cleaned.activeBoost !== null) return { state: cleaned, started: false };
  const grant = cleaned.inventory[index];
  if (grant === undefined) return { state: cleaned, started: false };
  const inventory = cleaned.inventory.filter((_, i) => i !== index);
  const expiresAtUtc = new Date(Date.parse(nowUtc) + grant.durationMinutes * 60_000).toISOString();
  return {
    state: {
      activeBoost: {
        kind: grant.kind,
        multiplier: grant.multiplier,
        startedAtUtc: nowUtc,
        expiresAtUtc,
      },
      inventory,
    },
    started: true,
  };
}

/* ---------------------------------------------------- Daily Refresh boost grants */

/**
 * INV-ECO-18: "Boosts granted from Daily Refresh over any 400-day clock-tampered span
 * equal the number of distinct `local_day`s on which the final level was completed."
 *
 * The grant is keyed by the LOCAL DAY of the completion, so a clock wound back and forth
 * across the same day grants once, and the same day completed five times grants once.
 * Non-final levels grant nothing at all.
 */
export interface DailyRefreshCompletion {
  readonly localDay: string;
  readonly isFinalLevel: boolean;
}

export function dailyRefreshBoostGrantDays(
  completions: readonly DailyRefreshCompletion[],
): string[] {
  const days = new Set<string>();
  for (const completion of completions) {
    if (completion.isFinalLevel) days.add(completion.localDay);
  }
  return [...days].sort();
}

export function dailyRefreshBoostGrantCount(
  completions: readonly DailyRefreshCompletion[],
): number {
  return dailyRefreshBoostGrantDays(completions).length;
}

/**
 * The second half of INV-ECO-18: "legendary state on a Daily Refresh level clears with
 * the set". A new day's set is a new set of levels, so yesterday's legendary flags do
 * not carry — returning the empty set is the whole rule, written down so the caller
 * cannot forget it.
 */
export function clearDailyRefreshLegendary(): readonly string[] {
  return [];
}
