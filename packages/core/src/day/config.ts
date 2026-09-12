/**
 * Named, dated constants for the day boundary, the freeze walk and both recovery
 * mechanics.
 *
 * Every number here is referenced by an invariant id, and every one of them is either
 * quoted from the research corpus with its date or marked DERIVED. A literal repeated
 * in three call sites is a constant nobody can change safely, and a constant with no
 * provenance is a guess somebody will later defend as a fact.
 *
 * This is NOT the economy config (`packages/core/src/economy`, a different P1 task):
 * that one owns XP tiers, boosts, the freeze *price* and the cosmetics catalogue. These
 * are the day engine's own constants and nothing outside `day/` and `streak/` reads them.
 */

export interface DayConfig {
  /**
   * A gap longer than this resolves to ONE freeze attempt and ONE break however large
   * it is — never 400 missed days, never 400 animated grey cells.
   * `deep/04` case 14/19, EC-STK-11, EC-FRZ-04. INV-DAY-07.
   */
  readonly maxOfflineDays: number;
  /**
   * The midnight grace window, in seconds. A session that STARTED before local midnight
   * and completes within this many seconds after it credits the STREAK to the start day
   * ("Just made it!"). XP, quests, the goal chest and Daily Most XP stay keyed to
   * completion time. `deep/04` case 42 (DERIVED, 5 minutes), EC-STK-12. INV-DAY-08.
   */
  readonly graceSeconds: number;
  /**
   * The hard ceiling on how long rollover may be deferred past local midnight.
   * EC-STK-14: `deep/04` case 43 defers rollover while a session is live, but a KILLED
   * session leaves `session_in_progress` true forever and the deferral never lifts. The
   * plan's ruling: `maxRolloverDeferralSeconds = 300`, and a killed session can never
   * starve rollover. INV-DAY-09.
   */
  readonly maxRolloverDeferralSeconds: number;
  /**
   * How long after its last checkpoint a live session is still considered live.
   * DERIVED — no source states it. It is named rather than inlined because EC-STK-14's
   * rule is written in terms of it (`now − last_checkpoint < grace + session_timeout`),
   * even though `maxRolloverDeferralSeconds` always binds first at these values. If the
   * cap is ever raised, this is the number that starts to matter.
   */
  readonly sessionTimeoutSeconds: number;
  /**
   * The binary's build date as a civil date. A first-ever session whose local day
   * precedes it is flagged `clock_unreliable`: XP and gems are awarded, day keying is
   * deferred, and the first sane day becomes day one with no backfill.
   * EC-STK-23. INV-DAY-14.
   */
  readonly buildLocalDay: string;
  /** Freezes a new account holds, pre-equipped. Observed live 2026-09-10: "2 / 2 EQUIPPED". */
  readonly freezeCapBase: number;
  /**
   * Streak Society tiers and the freeze cap each one steps to (`deep/04` §7, DERIVED:
   * Ember 60 · Blaze 180 · Phoenix 365, cap 2 → 3 → 4 → 5). Tier entry GRANTS the
   * freezes as well as raising the cap (EC-FRZ-07), idempotent on
   * `society_tier_entered_at` (INV-FRZ-04).
   */
  readonly societyTiers: readonly {
    readonly tier: string;
    readonly streak: number;
    readonly cap: number;
  }[];
  /**
   * The recovery challenge's window, in LOCAL DAYS from `broken_on` — the bundle's own
   * "Only 2 days left" / "Only 1 day left" ladder, not the invented 7 (EC-FRZ-11).
   * Local days so it cannot drift across DST (EC-FRZ-15). INV-REC-04.
   */
  readonly recoveryChallengeWindowLocalDays: number;
  /** Lessons the recovery challenge asks for (EC-FRZ-08/09). INV-REC-02. */
  readonly recoveryChallengeLessons: number;
  /**
   * The cap on UNCOVERED missed days for the challenge to arm. Freeze-covered days never
   * count toward it, because the streak never broke on them (EC-FRZ-18). Set to
   * `maxOfflineDays` so a long absence — which is already outside the recency window —
   * is never armed (EC-FRZ-04). INV-REC-06.
   */
  readonly recoveryChallengeUncoveredDayCap: number;
  /** Monthly Streak Repair allowance, idempotent on `(year, month)` (EC-FRZ-13). INV-REC-01. */
  readonly streakRepairsPerMonth: number;
  /**
   * The repair's own gate: it covers a break of at most this many UNCOVERED missed days,
   * so a three-missed-day break is offered the challenge only (EC-FRZ-08). INV-REC-01.
   */
  readonly repairMaxUncoveredDays: number;
}

/** The shipped values. Dated 2026-09-11; each line names its source above. */
export const DAY_CONFIG: DayConfig = {
  maxOfflineDays: 30,
  graceSeconds: 300,
  maxRolloverDeferralSeconds: 300,
  sessionTimeoutSeconds: 600,
  buildLocalDay: '2026-09-11',
  freezeCapBase: 2,
  societyTiers: [
    { tier: 'ember', streak: 60, cap: 3 },
    { tier: 'blaze', streak: 180, cap: 4 },
    { tier: 'phoenix', streak: 365, cap: 5 },
  ],
  recoveryChallengeWindowLocalDays: 2,
  recoveryChallengeLessons: 3,
  recoveryChallengeUncoveredDayCap: 30,
  streakRepairsPerMonth: 1,
  repairMaxUncoveredDays: 2,
};
