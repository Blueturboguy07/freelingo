/**
 * The freeze ledger — held, not scheduled.
 *
 * EC-FRZ-01 is a spec-vs-spec contradiction the plan settled: `deep/04` §8 says freezes
 * must be evaluated *proactively at rollover, not reactively when the app opens*, and §20
 * implements exactly the reactive walk it forbids. On a truly local, truly offline device
 * the reactive walk is the only possible implementation. **Ruling: a freeze is consumed
 * for a missed day iff it was owned BEFORE that day began** — retroactive in mechanism,
 * faithful in outcome, and the same thing the help centre says ("A streak freeze must be
 * purchased in advance of the day of a missed lesson", observed 2026-09-10).
 *
 * That is why this is a LEDGER and not a counter. A counter cannot answer "how many did
 * you hold on the 23rd?" after the fact, so freezes bought on the morning of the return
 * would retroactively rescue the gap. Every grant records the day from which it is owned;
 * every consumption records the day it COVERS separately from the day it was written
 * (`consumed_for_day` vs `consumed_on_day`), which is also what makes replay a no-op
 * (INV-FRZ-05).
 */
import type { LocalDay } from './civil.js';
import { DAY_CONFIG } from './config.js';

/**
 * Freeze acquisition has exactly THREE channels (INV-FRZ-03). No spec defines
 * replenishment, so `deep/04`'s EC-FRZ-06 ruling ships all three:
 * - `timed_refill` — "Refills in {{n}} days"
 * - `milestone_grant` — a streak milestone, and Streak Society tier entry (INV-FRZ-04)
 * - `reward_chest` — a chest drop
 */
export const FREEZE_CHANNELS = ['timed_refill', 'milestone_grant', 'reward_chest'] as const;
export type FreezeChannel = (typeof FREEZE_CHANNELS)[number];

/**
 * The `one_time` subtype: the distinct freeze gifted at a goal-met moment (EC-FRZ-06).
 * A subtype of a channel, not a fourth channel — INV-FRZ-03 counts three.
 */
export type FreezeSubtype = 'one_time' | null;

export interface FreezeGrant {
  /** The idempotency key. A second grant under the same key changes nothing. */
  readonly grantKey: string;
  readonly channel: FreezeChannel;
  readonly subtype: FreezeSubtype;
  /**
   * The first civil date this freeze is OWNED on. A missed day `d` may be covered only
   * by a grant with `ownedFromDay < d` — owned before the day began.
   */
  readonly ownedFromDay: LocalDay;
  /** What the caller asked for, before the cap clamp. Kept so the clamp is auditable. */
  readonly requested: number;
  /** What was actually added: `clamp(requested, 0, cap − held)` (INV-FRZ-06). */
  readonly applied: number;
}

export interface FreezeConsumption {
  /** The civil date this freeze covers. The ledger's key: one consumption per day, ever. */
  readonly consumedForDay: LocalDay;
  /** The day the walk actually wrote it — a return day, possibly much later. */
  readonly consumedOnDay: LocalDay;
}

export interface FreezeLedger {
  readonly cap: number;
  readonly grants: readonly FreezeGrant[];
  readonly consumptions: readonly FreezeConsumption[];
  /** `society_tier_entered_at` values already honoured, so a replay mints nothing. */
  readonly societyTierKeys: readonly string[];
}

/**
 * A new account: cap 2, two freezes pre-equipped and owned from before day one, so a
 * day-1 learner is already protected. Observed live 2026-09-10 ("2 / 2 EQUIPPED").
 */
export function newFreezeLedger(
  ownedFromDay: LocalDay,
  cap = DAY_CONFIG.freezeCapBase,
): FreezeLedger {
  return {
    cap,
    grants: [
      {
        grantKey: 'welcome',
        channel: 'reward_chest',
        subtype: null,
        ownedFromDay,
        requested: cap,
        applied: cap,
      },
    ],
    consumptions: [],
    societyTierKeys: [],
  };
}

/** Freezes held right now: everything granted, minus everything consumed. */
export function freezesHeld(ledger: FreezeLedger): number {
  let held = 0;
  for (const grant of ledger.grants) held += grant.applied;
  return held - ledger.consumptions.length;
}

/**
 * Freezes available to cover `day`: granted strictly BEFORE `day` began, minus the ones
 * already spent on earlier days. This is the EC-FRZ-01 reconstruction, and it is why a
 * freeze acquired on the morning of the return cannot rescue the gap behind it.
 */
export function freezesOwnedBefore(ledger: FreezeLedger, day: LocalDay): number {
  let owned = 0;
  for (const grant of ledger.grants) {
    if (grant.ownedFromDay < day) owned += grant.applied;
  }
  for (const consumption of ledger.consumptions) {
    if (consumption.consumedForDay < day) owned -= 1;
  }
  return owned;
}

export interface GrantRequest {
  readonly grantKey: string;
  readonly channel: FreezeChannel;
  readonly subtype?: FreezeSubtype;
  readonly ownedFromDay: LocalDay;
  readonly amount: number;
}

export interface GrantOutcome {
  readonly ledger: FreezeLedger;
  /** How many freezes the balance actually gained. Zero for a replay or a full balance. */
  readonly applied: number;
  /**
   * Whether the grant earns a ceremony screen. **A zero-effect grant produces no screen
   * and no copy** (INV-FRZ-06): a day-1 learner already at 2/2 sees the 5-gem chest, not
   * a freeze card promising something that did not happen.
   */
  readonly ceremony: boolean;
}

/**
 * Grant freezes, idempotent on `grantKey`, clamped to `cap − held`.
 *
 * A grant NEVER raises the cap to absorb a gift (EC-FRZ-17). Only Streak Society tier
 * entry moves the cap, and it does so before granting — see `enterSocietyTier`.
 */
export function grantFreezes(ledger: FreezeLedger, request: GrantRequest): GrantOutcome {
  if (ledger.grants.some((g) => g.grantKey === request.grantKey)) {
    return { ledger, applied: 0, ceremony: false };
  }
  const room = Math.max(0, ledger.cap - freezesHeld(ledger));
  const applied = Math.max(0, Math.min(request.amount, room));
  const grant: FreezeGrant = {
    grantKey: request.grantKey,
    channel: request.channel,
    subtype: request.subtype ?? null,
    ownedFromDay: request.ownedFromDay,
    requested: request.amount,
    applied,
  };
  return {
    ledger: { ...ledger, grants: [...ledger.grants, grant] },
    applied,
    ceremony: applied > 0,
  };
}

/**
 * Streak Society tier entry: the cap rises AND the freezes are granted (EC-FRZ-07 —
 * 2/2 → 3/3, not a ceiling the learner must then fill at 200 gems). Idempotent on
 * `society_tier_entered_at`, so winding the clock back and re-entering the tier mints
 * nothing (INV-FRZ-04).
 */
export function enterSocietyTier(
  ledger: FreezeLedger,
  tier: string,
  societyTierEnteredAt: string,
  ownedFromDay: LocalDay,
): GrantOutcome {
  const key = `society_tier:${tier}:${societyTierEnteredAt}`;
  if (ledger.societyTierKeys.includes(key)) return { ledger, applied: 0, ceremony: false };
  const tierConfig = DAY_CONFIG.societyTiers.find((t) => t.tier === tier);
  if (tierConfig === undefined) return { ledger, applied: 0, ceremony: false };
  const raised = Math.max(ledger.cap, tierConfig.cap);
  const increase = raised - ledger.cap;
  const withCap: FreezeLedger = {
    ...ledger,
    cap: raised,
    societyTierKeys: [...ledger.societyTierKeys, key],
  };
  if (increase === 0) return { ledger: withCap, applied: 0, ceremony: false };
  return grantFreezes(withCap, {
    grantKey: key,
    channel: 'milestone_grant',
    ownedFromDay,
    amount: increase,
  });
}

/**
 * Spend one freeze on `forDay`, written on `onDay`.
 *
 * Keyed by the day it COVERS, so a kill-and-replay of the rollover walk finds the
 * consumption already there and changes nothing (INV-FRZ-05). Refuses when nothing was
 * owned before `forDay` began.
 */
export function consumeFreezeFor(
  ledger: FreezeLedger,
  forDay: LocalDay,
  onDay: LocalDay,
): { ledger: FreezeLedger; consumed: boolean } {
  if (ledger.consumptions.some((c) => c.consumedForDay === forDay)) {
    return { ledger, consumed: false };
  }
  if (freezesOwnedBefore(ledger, forDay) <= 0) return { ledger, consumed: false };
  return {
    ledger: {
      ...ledger,
      consumptions: [...ledger.consumptions, { consumedForDay: forDay, consumedOnDay: onDay }],
    },
    consumed: true,
  };
}

/** Freezes spent, total. `freezes_consumed` in INV-FRZ-01's property. */
export function freezesConsumed(ledger: FreezeLedger): number {
  return ledger.consumptions.length;
}
