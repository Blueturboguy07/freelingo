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

/* ------------------------------------------ the rewind clamp (EC-ECO-39) */

/**
 * A boost as it is PERSISTED (INV-ECO-02 / EC-ECO-39, schema table `account_boost`).
 *
 * The falsifier is concrete: "a 15-minute x2 boost activated at 18:00; the app is killed
 * at 18:06 and the clock moves back 30 minutes before relaunch". A boost whose only
 * record is `expires_at` is then live again for 15 more minutes, every time, for free.
 *
 * So three things are written at activation instead of one:
 *
 *   `activatedAtUtc`        the wall clock when it started
 *   `activationSequenceMs`  a MONOTONIC sequence reading (`performance.now()`-shaped,
 *                           a boot-relative counter the user cannot set) at the same
 *                           instant. Wall clock can be rewound; this cannot.
 *   `durationSeconds`       the grant's own duration, so nothing recomputes it
 *
 * plus `tamperHighWaterUtc`, the highest wall clock the app has ever observed for this
 * boost. On every foreground, remaining time is the LESSER of the wall-clock remainder
 * and `duration - sequenceElapsed`, and a wall clock that has moved backwards against the
 * high-water mark expires the boost outright.
 */
export interface PersistedBoost {
  readonly kind: ActiveBoost['kind'];
  readonly multiplier: number;
  readonly activatedAtUtc: string;
  readonly activationSequenceMs: number;
  readonly durationSeconds: number;
  readonly tamperHighWaterUtc: string;
}

/** One observation of both clocks. The sequence is monotonic within a boot. */
export interface BoostClockReading {
  readonly nowUtc: string;
  /** Monotonic milliseconds since boot. Never derived from the wall clock. */
  readonly sequenceMs: number;
}

export type BoostExpiryReason = 'running' | 'elapsed' | 'sequence-elapsed' | 'clock-rewound';

export interface BoostClampResult {
  /** Seconds left, clamped to `[0, durationSeconds]`. */
  readonly remainingSeconds: number;
  readonly running: boolean;
  readonly reason: BoostExpiryReason;
  /** The persisted row with its high-water mark advanced. Persist this. */
  readonly boost: PersistedBoost;
}

/**
 * EC-ECO-39, in one function.
 *
 * Reading it as "the lesser of two remainders" is the whole trick: winding the clock
 * FORWARD shortens the wall remainder and expires the boost early (which costs the user
 * nothing they are entitled to), winding it BACK cannot lengthen anything because the
 * sequence remainder does not move, and a detected rewind expires it immediately because
 * a rewind is the only way the two disagree in the user's favour.
 *
 * A reboot resets the sequence to near zero, so `sequenceElapsed` goes negative; that is
 * clamped to 0 and the wall clock (checked against the high-water mark) governs, which is
 * the fail-safe direction: a rebooted phone cannot be used to bank a boost because the
 * wall-clock remainder is still shrinking.
 */
export function clampBoost(boost: PersistedBoost, clock: BoostClockReading): BoostClampResult {
  const nowMs = Date.parse(clock.nowUtc);
  const highWaterMs = Date.parse(boost.tamperHighWaterUtc);
  const advanced: PersistedBoost =
    nowMs > highWaterMs ? { ...boost, tamperHighWaterUtc: clock.nowUtc } : boost;

  if (nowMs < highWaterMs) {
    return { remainingSeconds: 0, running: false, reason: 'clock-rewound', boost: advanced };
  }

  const wallElapsedSeconds = (nowMs - Date.parse(boost.activatedAtUtc)) / 1_000;
  const sequenceElapsedSeconds = Math.max(
    0,
    (clock.sequenceMs - boost.activationSequenceMs) / 1_000,
  );
  const wallRemainder = boost.durationSeconds - wallElapsedSeconds;
  const sequenceRemainder = boost.durationSeconds - sequenceElapsedSeconds;
  const remaining = Math.min(wallRemainder, sequenceRemainder);

  if (remaining <= 0) {
    return {
      remainingSeconds: 0,
      running: false,
      reason: wallRemainder <= sequenceRemainder ? 'elapsed' : 'sequence-elapsed',
      boost: advanced,
    };
  }
  return {
    remainingSeconds: Math.min(remaining, boost.durationSeconds),
    running: true,
    reason: 'running',
    boost: advanced,
  };
}

/**
 * The `ActiveBoost` the session reads at start, derived from the clamped remainder.
 *
 * `expiresAtUtc` is recomputed from the CLAMP on every foreground rather than stored once,
 * so the value `resolveBoost` (INV-ECO-02's grace rule) sees can only ever shrink.
 */
export function activeBoostFrom(
  boost: PersistedBoost,
  clock: BoostClockReading,
): { readonly active: ActiveBoost | null; readonly clamp: BoostClampResult } {
  const clamp = clampBoost(boost, clock);
  if (!clamp.running) return { active: null, clamp };
  return {
    active: {
      kind: boost.kind,
      multiplier: boost.multiplier,
      startedAtUtc: boost.activatedAtUtc,
      expiresAtUtc: new Date(Date.parse(clock.nowUtc) + clamp.remainingSeconds * 1_000).toISOString(),
    },
    clamp,
  };
}

/** Persist a freshly activated grant with both clock readings (EC-ECO-39). */
export function activateBoost(
  grant: BoostGrant,
  clock: BoostClockReading,
): PersistedBoost {
  return {
    kind: grant.kind,
    multiplier: grant.multiplier,
    activatedAtUtc: clock.nowUtc,
    activationSequenceMs: clock.sequenceMs,
    durationSeconds: grant.durationMinutes * 60,
    tamperHighWaterUtc: clock.nowUtc,
  };
}

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
