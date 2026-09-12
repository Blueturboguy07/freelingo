/**
 * THE economy config table.
 *
 * Plan §The build workflow step 1: exactly one task per phase may touch this file, and
 * every constant in it is NAMED and DATED. A number with no source comment is a bug; a
 * number spelled a second time anywhere else in the tree is the bug INV-ECO-01,
 * INV-ECO-14, INV-ECO-15, INV-ECO-17 and INV-ECO-32 exist to catch, and `config.test.ts`
 * greps the shipped sources for exactly that.
 *
 * Source shorthand used throughout:
 *   [obs 2026-09-10]     live guest capture, `~/duolingo-research/scope/08`, `scope/09`
 *   [duoplanet DATE]     secondary, dated in `deep/04` §Rules and constants
 *   [blog DATE]          blog.duolingo.com, dated in `deep/04` §Sources
 *   [ruling 2026-09-11]  founder ruling: plan §Rulings, `deep/00-EDGE-CASES.md`
 *   [DERIVED]            Freelingo's own decision; no Duolingo source exists
 */
import type { SessionFlavour, SessionOutcomeKind, XpLadderMode } from '../types/index.js';

/* ============================================================== 1. the daily goal */

export interface GoalTier {
  readonly key: 'casual' | 'regular' | 'serious' | 'intense';
  /** The label the picker shows. Minutes are a LABEL only (INV-ECO-21, EC-ECO-24). */
  readonly minutes: number;
  /** What the app stores and what `goalMet` compares against. */
  readonly xp: number;
}

/**
 * INV-ECO-01 / ruling EC-ECO-01: the minutes<->XP mapping exists exactly ONCE.
 *
 * The 5/10/15/20-minute labels are [obs 2026-09-10, onboarding step 7]; the XP values are
 * the older documented arm [duoplanet XP guide 2022-08-12]. The ruling stores XP and
 * labels minutes, and picks the 50 arm — `deep/07`'s 40 is not shipped.
 */
export const GOAL_TIERS: readonly GoalTier[] = [
  { key: 'casual', minutes: 5, xp: 10 },
  { key: 'regular', minutes: 10, xp: 20 },
  { key: 'serious', minutes: 15, xp: 30 },
  { key: 'intense', minutes: 20, xp: 50 },
] as const;

export type GoalTierKey = GoalTier['key'];

/** [obs 2026-09-10] the guest onboarding pre-selects the ten-minute tier. */
export const DEFAULT_GOAL_TIER: GoalTierKey = 'regular';

/** [obs 2026-09-10] the day-1 chest read "You earned 5 gems!". */
export const DAILY_GOAL_CHEST_GEMS = 5;

/* ============================================================== 2. XP per flavour */

/** [duoplanet XP guide 2022-08-12] base XP of a standard lesson. */
export const LESSON_BASE_XP = 10;

/**
 * [obs 2026-09-10] a real Practice session paid a flat 10 XP over 11 exercises at 100%
 * accuracy, with the combo tile contributing nothing. Ruling EC-ECO-19: the node popup
 * renders this same constant, not the observed `+5` label, because a `+5` label under a
 * 10 XP goal steers a five-minute learner into a longer lesson every single day.
 */
export const PRACTICE_XP = 10;

/**
 * [obs 2026-09-10, node popup `PRACTICE +5 XP`] what a REPLAY pays.
 *
 * A replay is not a first completion: Legendary pays this on its second pass
 * (INV-ECO-07) and a completed Daily Refresh level pays it forever after (INV-ECO-08).
 * It is deliberately below `PRACTICE_XP` so a replay can never be mistaken for one.
 */
export const REPLAY_PRACTICE_XP = 5;

/** [duoplanet legendary 2023-02-27] 40 on completion, >=20 at the mid checkpoint. */
export const LEGENDARY_XP = 40;
export const LEGENDARY_CHECKPOINT_XP = 20;

/** [ruling EC-ECO-15] a placement test awards nothing, so ability is not farmable. */
export const PLACEMENT_XP = 0;
/** [ruling EC-ECO-15] a jump-here test unlocks a section; it does not pay XP. */
export const JUMP_HERE_XP = 0;
/** [ruling EC-PTH-35] `deep/01` §S20's 50 XP stays a config constant. */
export const SECTION_TEST_XP = 50;
/** [DERIVED] no source states a Unit Review award; one named constant, lesson-sized. */
export const UNIT_REVIEW_XP = 20;
/** [DERIVED, EC-PTH-15] the level award; replays pay `REPLAY_PRACTICE_XP`. */
export const DAILY_REFRESH_LEVEL_XP = 10;
/** [ruling EC-FRZ-08] a recovery lesson is an ordinary lesson and pays like one. */
export const RECOVERY_LESSON_XP = LESSON_BASE_XP;
/** [DEPART D-NOFARM] the endgame generator pays a review award, then the daily ladder. */
export const ENDGAME_REVIEW_XP = REPLAY_PRACTICE_XP;

/**
 * [ruling EC-ECO-37 / INV-ECO-32] ONE table per long-form format, keyed by the FOUR
 * entry points EC-ECO-37 names: `{first, replay_plain, hub_recommended, legendary}`.
 *
 * The node button interpolates the key for the entry point it is offering and the
 * ceremony commits the same key, so "advertised == awarded" holds at every entry point
 * rather than only at first completion, and six replays can never pay first-completion
 * XP. `perLocalDayKey` is EC-ECO-08's once-per-day scope: the hub-recommended bonus is
 * once per story per `local_day` and radio's first-completion award is once per EPISODE
 * per `local_day`, so the two formats key their day ledger by different columns and the
 * ledger writer must be told which.
 */
export interface LongFormXpTable {
  /** First ever completion of this story/episode. */
  readonly first: number;
  /** Any later replay reached from the path or the list. */
  readonly replay_plain: number;
  /** [EC-ECO-08] the hub promotion, once per story/episode per `local_day`. */
  readonly hub_recommended: number;
  /** The legendary entry point, when a format ships one. */
  readonly legendary: number;
  /** The column the once-per-`local_day` keys are written against (EC-ECO-08). */
  readonly perLocalDayKey: 'story_id' | 'episode_id';
  /** The per-mode daily ladder this format consumes (EC-ECO-07, INV-ECO-06). */
  readonly ladderMode: XpLadderMode;
}

/**
 * [duoplanet XP guide 2022-08-12] stories paid 14-28. [ruling EC-ECO-37] "Story first is
 * 20, not a floor of 10"; the plain replay is the review award, and the hub promotion
 * pays between the two, once per story per `local_day`.
 */
export const STORY_XP: LongFormXpTable = {
  first: 20,
  replay_plain: REPLAY_PRACTICE_XP,
  hub_recommended: 10,
  legendary: LEGENDARY_XP,
  perLocalDayKey: 'story_id',
  ladderMode: 'story',
};

/**
 * [ruling EC-ECO-08 / EC-ECO-37] "Radio: 20 first / **10** replay, once per episode per
 * day", scaled by the episode-duration ramp at P6. Both formats are excluded from the XP
 * Boost (EC-ECO-35) — that exclusion lives on the matrix row, not here.
 */
export const RADIO_XP: LongFormXpTable = {
  first: 20,
  replay_plain: 10,
  hub_recommended: 10,
  legendary: LEGENDARY_XP,
  perLocalDayKey: 'episode_id',
  ladderMode: 'radio',
};

export const LONG_FORM_XP_KEYS = ['first', 'replay_plain', 'hub_recommended', 'legendary'] as const;
export type LongFormEntryPoint = (typeof LONG_FORM_XP_KEYS)[number];

/**
 * [ruling EC-ECO-38] Roleplay "takes ninety seconds and pays up to 40 XP", so it joins
 * the per-mode daily ladder: full XP for the first scenario per `local_day`, the floor
 * thereafter, and the unconditional-acceptance fallback pays the floor rather than the
 * ceiling. Freelingo ships Roleplay where Duolingo gates it behind Max, so the anti-farm
 * bound matters more here than upstream, not less.
 */
export const ROLEPLAY_FIRST_XP = 40;
export const ROLEPLAY_FLOOR_XP = 10;

/**
 * [ruling EC-ECO-28] "Bring hub XP-per-exercise down to the path lesson rate and apply
 * the per-mode daily ladder to every hub mode, not only Words." One rate, one constant:
 * the hub is not a shortcut round the path.
 */
export const HUB_SESSION_XP = LESSON_BASE_XP;

/**
 * [ruling EC-ECO-31] The timed-challenge surface does NOT ship in v1: the only surface
 * for it is a side-character tableau that may ship decorative. The flag is the one thing
 * that decides whether the Challenger-shaped achievement renders (INV-ECO-26) and whether
 * the flavour is offerable — the matrix row exists either way (EC-ECO-15).
 */
export const TIMED_CHALLENGES_ENABLED = false;
export const TIMED_CHALLENGE_XP = LESSON_BASE_XP;

/**
 * [duoplanet XP guide 2022-08-12] the combo bonus is 1-5 XP by answers in a row. The
 * exact 2026 arithmetic is not derivable (13, 14 and 15 XP were all observed at 87-92%
 * accuracy, and a `COMBO 10` tile preceded both a 13 and a 14), so Freelingo ships an
 * explicit formula instead of guessing: `clamp(floor(maxCombo / 3), 0, 5)`
 * [deep/02 §Freelingo's chosen formulas].
 */
export const COMBO_BONUS_DIVISOR = 3;
export const COMBO_BONUS_MAX = 5;

export function comboBonus(maxCombo: number | undefined): number {
  if (maxCombo === undefined || !Number.isFinite(maxCombo) || maxCombo <= 0) return 0;
  return Math.max(0, Math.min(COMBO_BONUS_MAX, Math.floor(maxCombo / COMBO_BONUS_DIVISOR)));
}

/** [obs 2026-09-10] the progress bar turns gold at exactly six in a row. */
export const COMBO_GOLD_THRESHOLD = 6;

/** [ruling, deep/02] perfection pays in the headline, not in XP. */
export const PERFECT_LESSON_BONUS_XP = 0;

/**
 * Accuracy tier labels. 87% -> `GOOD!`, 92% -> `GREAT!`, 100% -> `AMAZING`
 * [obs 2026-09-10]; the 60 and 80 boundaries are extrapolated from three points and are
 * flagged `inferred` here rather than quietly presented as observation.
 */
export interface AccuracyTier {
  readonly minAccuracy: number;
  readonly label: string;
  readonly inferred: boolean;
}

export const ACCURACY_TIERS: readonly AccuracyTier[] = [
  { minAccuracy: 1, label: 'AMAZING', inferred: false },
  { minAccuracy: 0.9, label: 'GREAT!', inferred: false },
  { minAccuracy: 0.8, label: 'GOOD!', inferred: false },
  { minAccuracy: 0.6, label: 'NICE!', inferred: true },
  { minAccuracy: 0, label: 'KEEP GOING!', inferred: true },
] as const;

/* ==================================================================== 3. boosts */

/** [duoplanet XP boost 2022-08-12] "temporarily doubles the amount of XP you can earn". */
export const BOOST_MULTIPLIER = 2;

/** [duoplanet XP boost 2022-08-12] "It lasts for 15 minutes." Per GRANT, never global. */
export const BOOST_DEFAULT_DURATION_MINUTES = 15;
/** [S122, obs 2026-09-10] a milestone grant carries 30 minutes. Duration rides the grant. */
export const BOOST_MILESTONE_DURATION_MINUTES = 30;

/** [S122] a grant during an active boost enters inventory; the cap is five. */
export const MAX_BOOST_INVENTORY = 5;

/**
 * [ruling EC-ECO-02 / INV-ECO-02] The multiplier is read at session start and written to
 * the session row, but a parked session may not bank a boost forever: if
 * `commit_time > boost_expiry + BOOST_GRACE_SECONDS` the session commits at 1x and S067
 * carries a one-line explanation of the smaller number. Two minutes is long enough to
 * cover a phone call mid-ceremony and short enough that parking a session overnight
 * cannot bank a boost.
 */
export const BOOST_GRACE_SECONDS = 120;

/**
 * The five power-ups with ZERO occurrences in the 2026 bundle [deep/04 adversarial
 * review + obs 2026-09-10 shop]. Ruling EC-ECO-22: keep the TYPES so a future build can
 * enable one without a schema migration, and give them no catalogue entry (INV-ECO-12).
 */
export const DEPRECATED_BOOST_KINDS = [
  'timerBoost',
  'doubleOrNothing',
  'happyHour',
  'earlyBird',
  'weekendAmulet',
] as const;

export type DeprecatedBoostKind = (typeof DEPRECATED_BOOST_KINDS)[number];

/* ======================================================== 4. the per-mode ladders */

/**
 * [ruling EC-ECO-07 / INV-ECO-06] Diminishing returns are a per-mode ladder with a hard
 * daily cap, keyed GLOBALLY by `local_day` — not per course (EC-ECO-06), because the
 * rule's whole purpose is anti-farming and XP is global state.
 *
 * `reducedMultipliers[n]` is the multiplier for the (n+1)th session of that mode today;
 * past the end of the list the last value repeats. `dailyXpCap` is the bound the
 * INV-ECO-06 property checks: whatever the sequence of sessions and however many courses
 * they were spread across, one mode cannot pay more than this in one local day.
 */
export interface XpLadder {
  readonly dailyXpCap: number;
  readonly reducedMultipliers: readonly number[];
}

export const XP_LADDERS: Record<XpLadderMode, XpLadder> = {
  // Path lessons are not the farm: they run out of new content. Capped, never reduced.
  lesson: { dailyXpCap: 400, reducedMultipliers: [1] },
  // [EC-ECO-07] full, then half for sessions 2-4, then 0 with the session still playable
  // and still updating FSRS, honestly labelled.
  practice: { dailyXpCap: 100, reducedMultipliers: [1, 0.5, 0.5, 0.5, 0] },
  legendary: { dailyXpCap: 200, reducedMultipliers: [1] },
  test: { dailyXpCap: 200, reducedMultipliers: [1] },
  review: { dailyXpCap: 120, reducedMultipliers: [1, 0.5, 0.5, 0.5, 0] },
  // Six levels a day is the whole set (S096); the seventh is a replay and pays nothing.
  dailyRefresh: { dailyXpCap: 120, reducedMultipliers: [1, 1, 1, 1, 1, 1, 0] },
  // [EC-FRZ-08] the recovery challenge is three lessons, and only three.
  recovery: { dailyXpCap: 60, reducedMultipliers: [1] },
  // [DEPART D-NOFARM] the endgame generator is unbounded in content, so it is bounded here.
  endgameReview: { dailyXpCap: 60, reducedMultipliers: [1, 0.5, 0.5, 0.5, 0] },

  // ---- the formats with no content floor (EC-ECO-07, EC-ECO-08, EC-ECO-38) ----
  // A story or an episode can be replayed forever. Without a ladder these are the
  // unbounded XP farm EC-ECO-07 names; the entry-point table decides the base and the
  // ladder decides how many times a day that base is worth anything.
  story: { dailyXpCap: 60, reducedMultipliers: [1, 0.5, 0.5, 0.5, 0] },
  radio: { dailyXpCap: 60, reducedMultipliers: [1, 0.5, 0.5, 0.5, 0] },
  // [EC-ECO-38] full for the first scenario of the day, the floor thereafter: 10/40.
  roleplay: { dailyXpCap: 80, reducedMultipliers: [1, 0.25] },

  // ---- every hub mode (EC-ECO-07 "applies to EVERY hub mode", EC-ECO-28) ----
  hubMistakes: { dailyXpCap: 60, reducedMultipliers: [1, 0.5, 0.5, 0.5, 0] },
  hubWords: { dailyXpCap: 60, reducedMultipliers: [1, 0.5, 0.5, 0.5, 0] },
  hubListenUp: { dailyXpCap: 60, reducedMultipliers: [1, 0.5, 0.5, 0.5, 0] },
  hubPronunciation: { dailyXpCap: 60, reducedMultipliers: [1, 0.5, 0.5, 0.5, 0] },
  hubTargetPractice: { dailyXpCap: 60, reducedMultipliers: [1, 0.5, 0.5, 0.5, 0] },
  hubUnitRewind: { dailyXpCap: 60, reducedMultipliers: [1, 0.5, 0.5, 0.5, 0] },

  // The surface is disabled (TIMED_CHALLENGES_ENABLED); the ladder exists so enabling it
  // is a flag flip and not a new anti-farming design.
  timedChallenge: { dailyXpCap: 60, reducedMultipliers: [1, 0.5, 0.5, 0.5, 0] },
};

/** The honest label when a mode's ladder has reached zero (EC-ECO-07). */
export const ZERO_AWARD_LABEL = 'Review +0 XP';

/* ============================================ 5. streak, freezes, repair, society */

/**
 * [ruling EC-ECO-21 / INV-ECO-14] The milestone set. 50 was contamination from the
 * streak-GOAL picker (7/14/30/50) and 14 is picker contamination by the same argument,
 * against `deep/04` §6's eleven-value list. ONE array, read by the ceremony predicate,
 * never inlined, so the two lists cannot diverge.
 */
export const STREAK_MILESTONES: readonly number[] = [7, 30, 100, 365, 1000] as const;

/** [obs 2026-09-10] the first-day goal picker. Purely motivational; it gates nothing. */
export const STREAK_GOAL_OPTIONS: readonly { readonly days: number; readonly label: string }[] = [
  { days: 7, label: 'Good' },
  { days: 14, label: 'Great' },
  { days: 30, label: 'Incredible' },
  { days: 50, label: 'Unstoppable' },
] as const;

/** [blog 2023-04-18 + obs 2026-09-10 "2 / 2 EQUIPPED"] the base cap, pre-equipped full. */
export const STREAK_FREEZE_CAP = 2;
export const STREAK_FREEZES_ON_NEW_ACCOUNT = 2;

/**
 * [ruling 2026-09-11, S121] The 200-gem figure is a 2023 LEGACY price
 * [duoplanet 2023-02-03], not a 2026 constant. Freelingo's price is its own dated
 * decision: low enough that a month of play can cover a lapse, high enough that the
 * cosmetics sink (S123, ~150 gems a month) still has something to absorb.
 */
export const STREAK_FREEZE_GEM_PRICE_2026 = 100;

/**
 * [ruling EC-ECO-20] The Streak Society, as the 2026 bundle ships it.
 *
 * Entry is at **7 days**, NOT the invented Ember-60/Blaze-180/Phoenix-365 ladder that an
 * earlier draft of this file carried: duoplanet's own thresholds conflict with each other
 * and with the 2026 streak post, and EC-ECO-20 strikes them by name. There are three
 * reward CHECKPOINTS after entry rather than three tiers of membership, and the perks are
 * fixed: +3 freezes on the cap, a 30-minute boost, and a VIP badge that upgrades yearly.
 *
 * The FRZ task consumes `SOCIETY_FREEZE_CAP_BONUS` for the `n/3..n/5` states of S121, so
 * these constants are load-bearing outside this file.
 */
export const SOCIETY_ENTRY_STREAK_DAYS = 7;

/** The cap bonus a Society member carries, on top of `STREAK_FREEZE_CAP` (S121). */
export const SOCIETY_FREEZE_CAP_BONUS = 3;

/** [EC-ECO-20] the boost perk, in minutes. Duration still rides the GRANT (EC-ECO-04). */
export const SOCIETY_BOOST_MINUTES = 30;

export interface SocietyCheckpoint {
  readonly id: string;
  /** Days of unbroken streak AFTER entry at which the checkpoint pays. */
  readonly streakDays: number;
  readonly freezes: number;
  readonly boostMinutes: number;
  /** The badge year. A member's badge upgrades once per year of membership. */
  readonly vipBadgeYear: number;
}

/**
 * The three reward checkpoints. 7 is entry itself; 30 and 365 are the milestone set's own
 * members (`STREAK_MILESTONES`), so the Society never invents a day the milestone screen
 * does not already land on — EC-ECO-21's "the two lists cannot diverge", applied here.
 */
export const SOCIETY_CHECKPOINTS: readonly SocietyCheckpoint[] = [
  {
    id: 'society-entry',
    streakDays: SOCIETY_ENTRY_STREAK_DAYS,
    freezes: SOCIETY_FREEZE_CAP_BONUS,
    boostMinutes: SOCIETY_BOOST_MINUTES,
    vipBadgeYear: 1,
  },
  {
    id: 'society-second',
    streakDays: 30,
    freezes: SOCIETY_FREEZE_CAP_BONUS,
    boostMinutes: SOCIETY_BOOST_MINUTES,
    vipBadgeYear: 1,
  },
  {
    id: 'society-third',
    streakDays: 365,
    freezes: SOCIETY_FREEZE_CAP_BONUS,
    boostMinutes: SOCIETY_BOOST_MINUTES,
    vipBadgeYear: 2,
  },
] as const;

/**
 * [obs 2026-09-10, S121] Three acquisition channels, plus a distinct `one_time` subtype.
 *
 * The subtype is not decoration: a one-time freeze is granted by a specific event (the
 * recovery offer, the onboarding grant) and must not be refilled by the timer, so the
 * schema stores the channel on the row rather than inferring it from a count.
 */
export const FREEZE_ACQUISITION_CHANNELS = [
  'streak_freeze_refill',
  'milestone_grant',
  'reward_chest',
] as const;
export type FreezeAcquisitionChannel = (typeof FREEZE_ACQUISITION_CHANNELS)[number];

export const FREEZE_SUBTYPES = ['standard', 'one_time'] as const;
export type FreezeSubtype = (typeof FREEZE_SUBTYPES)[number];

/** [obs 2026-09-10, S121 `Refills in {{n}} day(s)`] the timed-refill period. */
export const FREEZE_REFILL_DAYS = 7;

/**
 * [ruling EC-FRZ-08] BOTH mechanics ship. The repair is capped at one per calendar
 * month, idempotent on `(year, month)` of `max_local_day_seen` so winding the clock
 * forward cannot mint a second one, and it restores the previous streak with today
 * still unsatisfied.
 */
export const STREAK_REPAIRS_PER_MONTH = 1;
/** A break of more than two missed days gets the recovery challenge and no repair. */
export const STREAK_REPAIR_MAX_MISSED_DAYS = 2;
/** [DERIVED, deep/04 §9] the offer expires this many local days after the break. */
export const STREAK_REPAIR_OFFER_WINDOW_DAYS = 7;

/** [ruling EC-STK-14 / INV-DAY-09] a killed session can never starve day rollover. */
export const MAX_ROLLOVER_DEFERRAL_SECONDS = 300;

/** [DERIVED, deep/04 case 42] the midnight grace that credits the START day. */
export const MIDNIGHT_GRACE_SECONDS = 300;

/** [DERIVED, deep/04 cases 14 and 19] a longer gap is one absence, not 400 missed days. */
export const MAX_OFFLINE_DAYS = 30;

/* ============================================================ 6. gems and the shop */

/** [obs 2026-09-10] a new account starts at 500 gems. */
export const STARTING_GEMS = 500;

/** [ruling EC-ECO-14] the chip clamps its LABEL here; the database keeps the true value. */
export const GEM_DISPLAY_CLAMP = 9999;

/** [duoplanet gems 2023-03-16] a daily quest chest pays 5-15 gems. */
export const QUEST_CHEST_GEMS_MIN = 5;
export const QUEST_CHEST_GEMS_MAX = 15;

/**
 * The only two gem sinks, by ruling EC-ECO-13: cosmetics and the Streak Freeze.
 *
 * INV-ECO-12 is the rule that NO gem price exists on hearts, Legendary, streak recovery
 * or any learning surface — that paywall is the thing this clone exists to delete, and
 * reintroducing one to manufacture a sink is explicitly forbidden. `config.test.ts`
 * greps every id here against the learning-surface vocabulary.
 */
export type GemSink = 'cosmetic' | 'streakFreeze';

export interface ShopEntry {
  readonly id: string;
  readonly sink: GemSink;
  readonly displayName: string;
  readonly priceGems: number;
}

/**
 * Cosmetics are priced to absorb roughly 150 gems a month (S123). Under that the
 * currency inflates to meaninglessness by week two and the gem-chest ceremony celebrates
 * nothing; over it the learner never owns anything.
 */
export const SHOP_CATALOGUE: readonly ShopEntry[] = [
  {
    id: 'streak-freeze',
    sink: 'streakFreeze',
    displayName: 'Streak Freeze',
    priceGems: STREAK_FREEZE_GEM_PRICE_2026,
  },
  {
    id: 'cosmetic-explorer-outfit',
    sink: 'cosmetic',
    displayName: 'Explorer outfit',
    priceGems: 150,
  },
  { id: 'cosmetic-snowfall-suit', sink: 'cosmetic', displayName: 'Snowfall suit', priceGems: 200 },
  { id: 'cosmetic-carnival-suit', sink: 'cosmetic', displayName: 'Carnival suit', priceGems: 200 },
  { id: 'cosmetic-brass-perch', sink: 'cosmetic', displayName: 'Brass perch', priceGems: 120 },
  { id: 'cosmetic-bamboo-perch', sink: 'cosmetic', displayName: 'Bamboo perch', priceGems: 120 },
] as const;

// The per-tier achievement payout lives with the achievement registry
// (`economy/achievements.ts`, ACHIEVEMENT_TIER_GEMS): one constant, one home.

/* ================================================================== 7. quests */

/** [ruling, S118] three quests from day one; no cold-start padlock. */
export const QUESTS_PER_DAY = 3;

/**
 * [ruling EC-ECO-10 / INV-ECO-10] Targets scale from a TRAILING 7-DAY MEDIAN of daily
 * XP, clamped `[10, 200]`, so a twenty-lesson-a-day learner does not clear everything by
 * 09:00 and a returning learner is not handed an impossible target.
 */
export const QUEST_TREND_WINDOW_DAYS = 7;
export const QUEST_TARGET_MIN_XP = 10;
export const QUEST_TARGET_MAX_XP = 200;

/**
 * Slot multiples applied to the scaling base (EC-ECO-10): one easy, one at the base, one
 * stretch.
 *
 * COLD START: day one has no trailing median at all. `questBaseFor()` in `quests.ts`
 * falls back to the stored `goalXp` — NOT to the clamp floor, which would hand every
 * learner the same 10 XP quest whatever tier they picked — and the same three multiples
 * apply on top of it. In that state session-count quests are capped at
 * `ceil(goalXp / QUEST_SESSION_DIVISOR)` so the stretch slot cannot ask a brand-new
 * Intense learner for four lessons before they have done one.
 */
export const QUEST_SLOT_MULTIPLES: readonly number[] = [1, 1, 1.5] as const;

/**
 * Session-count quests divide the XP base by the median observed lesson award
 * [obs 2026-09-10: 13, 14 and 15 XP], so "complete n lessons" and "earn n XP" ask for
 * roughly the same amount of work.
 */
export const QUEST_SESSION_DIVISOR = 13;

/** What a quest's target counts. Drives how the target is derived from the base. */
export type QuestUnit = 'xp' | 'sessions' | 'gems' | 'streak';

export interface QuestTemplate {
  readonly id: string;
  readonly unit: QuestUnit;
  /** [obs 2026-09-10] S118's copy slots, verbatim. `{{n}}` is the target. */
  readonly copy: string;
}

export const QUEST_TEMPLATES: readonly QuestTemplate[] = [
  { id: 'earnXp', unit: 'xp', copy: 'Earn {{n}} XP' },
  { id: 'completeLessons', unit: 'sessions', copy: 'Complete {{n}} lesson(s)' },
  { id: 'perfectLessons', unit: 'sessions', copy: 'Complete {{n}} perfect lesson(s)' },
  { id: 'accuracy90', unit: 'sessions', copy: 'Score 90% or higher in {{n}} lesson(s)' },
  { id: 'accuracy80', unit: 'sessions', copy: 'Score 80% or higher in {{n}} lesson(s)' },
  { id: 'fiveInARow', unit: 'sessions', copy: 'Get 5 in a row correct in {{n}} lesson' },
  { id: 'tenInARow', unit: 'sessions', copy: 'Get 10 in a row correct in {{n}} lesson' },
  { id: 'comboBonusXp', unit: 'xp', copy: 'Earn {{n}} Combo Bonus XP' },
  { id: 'earnGems', unit: 'gems', copy: 'Earn {{n}} gem(s)' },
  { id: 'reachStreak', unit: 'streak', copy: 'Reach a {{n}} day streak' },
] as const;

/**
 * [ruling EC-ECO-25 / INV-ECO-22] The monthly badge counts COMPLETED QUESTS in the
 * calendar month, tiered so a fast finisher still has a target, keyed to the `YYYY-MM`
 * of `max_local_day_seen`, derived once at month start and never re-derived.
 */
export const MONTHLY_BADGE_TIERS: readonly { readonly tier: string; readonly quests: number }[] = [
  { tier: 'bronze', quests: 30 },
  { tier: 'silver', quests: 45 },
  { tier: 'gold', quests: 75 },
] as const;

/* ====================================================== 8. content pacing per day */

/**
 * [DERIVED, plan §Non-negotiables "people actually learn"] The two day budgets the
 * session generator reads. No Duolingo source publishes either; they live here so the
 * generator cannot invent a second value, and INV-SCH-10 consumes them.
 */
export const MAX_NEW_ITEMS_PER_LOCAL_DAY = 12;
/**
 * An item introduced in recognition is not demanded in production until this many hours
 * have passed — one sleep, which is where consolidation happens.
 */
export const MIN_HOURS_BETWEEN_INTRODUCTION_AND_PRODUCTION = 12;

/* ============================================== 9. mistake allowances, as pips */

/**
 * [ruling S056 / EC-PTH-28 / INV-ECO-17] Test flavours render a PIP allowance that is
 * NOT the hearts resource: jump-here 5 and section test 4 are the observed numbers,
 * Legendary's was never published so it is Freelingo's own named constant. The header
 * meter still reads infinity throughout and the pip counter is destroyed at test end.
 */
export const JUMP_HERE_MISTAKE_ALLOWANCE = 5;
export const SECTION_TEST_MISTAKE_ALLOWANCE = 4;
export const LEGENDARY_MISTAKE_ALLOWANCE = 3;

/** The meter glyph the header renders, always. Never a number, never a refill. */
export const MISTAKE_METER_GLYPH = '∞';

/* ============================================ 10. the session-flavour matrix */

/**
 * One row of the matrix, keyed `(flavour, outcome)` — INV-ECO-09, INV-ECO-19,
 * INV-ECO-30, INV-ECO-17, and EC-ECO-15's full column list.
 */
export interface FlavourRow {
  readonly extendsStreak: boolean;
  readonly countsTowardGoal: boolean;
  readonly awardsXp: boolean;
  readonly advancesQuests: boolean;
  /** Explicit for EVERY row, including the Daily Refresh sub-flavour (INV-ECO-30). */
  readonly boostApplies: boolean;
  /**
   * [EC-ECO-15] "counts_as_lesson: true (it extends the streak and counts toward the
   * goal)". It is the widget's, the danger nudge's and the goal chest's single read.
   */
  readonly countsAsLesson: boolean;
  /** [EC-ECO-15] a timed challenge is a real session that moves no node. */
  readonly advancesPath: boolean;
  /**
   * [EC-ECO-15] "satisfying XP-shaped quests but not lesson-shaped ones". The quest units
   * this outcome can move; an empty list is a session that advances no quest at all.
   */
  readonly questShapes: readonly QuestUnit[];
  /** [EC-ECO-15] "and writing no mistake rows". */
  readonly writesMistakeRows: boolean;
  /** Pips, never hearts. `null` means this flavour has no allowance (INV-ECO-17). */
  readonly mistakeAllowance: number | null;
  /**
   * The ONE award a row with `awardsXp: false` may still pay, named on the row itself.
   *
   * Legendary's failed row is the only user: EC-PTH-27 / INV-ECO-16 pay a checkpoint
   * consolation at most once per node per local day. Before this column existed the
   * engine paid 20 XP on a row that declared `awardsXp: false`, so any consumer reading
   * the matrix to decide "does this pay" disagreed with the ceremony by 20 XP. `null`
   * everywhere else, and `awardForSession` reads THIS field rather than a special case.
   */
  readonly checkpointConsolationXp: number | null;
  /** Non-empty on every row that does not pay: never a silent return (INV-ECO-19). */
  readonly consequenceString: string;
  /** Where the learner lands afterwards. Never empty. */
  readonly consequenceRoute: string;
}

const DID_NOT_COUNT = "This didn't count toward today's streak";

/** Every quest shape a full-credit session can move. */
const ALL_QUEST_SHAPES: readonly QuestUnit[] = ['xp', 'sessions', 'gems', 'streak'] as const;

/** A row for an outcome that pays nothing and goes somewhere specific. */
function noCredit(
  route: string,
  consequenceString: string,
  mistakeAllowance: number | null,
  options: {
    readonly boostApplies?: boolean;
    readonly writesMistakeRows?: boolean;
    readonly checkpointConsolationXp?: number | null;
  } = {},
): FlavourRow {
  return {
    extendsStreak: false,
    countsTowardGoal: false,
    awardsXp: false,
    advancesQuests: false,
    boostApplies: options.boostApplies ?? false,
    countsAsLesson: false,
    advancesPath: false,
    questShapes: [],
    writesMistakeRows: options.writesMistakeRows ?? true,
    mistakeAllowance,
    checkpointConsolationXp: options.checkpointConsolationXp ?? null,
    consequenceString,
    consequenceRoute: route,
  };
}

/** A row for an outcome that pays in full. */
function fullCredit(
  route: string,
  boostApplies: boolean,
  mistakeAllowance: number | null,
  options: {
    readonly advancesPath?: boolean;
    readonly questShapes?: readonly QuestUnit[];
    readonly writesMistakeRows?: boolean;
  } = {},
): FlavourRow {
  return {
    extendsStreak: true,
    countsTowardGoal: true,
    awardsXp: true,
    advancesQuests: (options.questShapes ?? ALL_QUEST_SHAPES).length > 0,
    boostApplies,
    countsAsLesson: true,
    advancesPath: options.advancesPath ?? false,
    questShapes: options.questShapes ?? ALL_QUEST_SHAPES,
    writesMistakeRows: options.writesMistakeRows ?? true,
    mistakeAllowance,
    checkpointConsolationXp: null,
    consequenceString: '',
    consequenceRoute: route,
  };
}

/**
 * A long-form / hub row: full credit, never boostable (EC-ECO-35), never path-advancing
 * except where the format IS a node. Written as one helper so that "story, radio,
 * Listen-Up and Roleplay are not boostable" is one place rather than eight.
 */
function longFormCredit(
  route: string,
  options: { readonly advancesPath?: boolean } = {},
): FlavourRow {
  return fullCredit(route, false, null, { advancesPath: options.advancesPath ?? false });
}

/**
 * THE MATRIX.
 *
 * Typed `Record<SessionFlavour, Record<SessionOutcomeKind, FlavourRow>>`, so a flavour or
 * an outcome with no row is a TYPE ERROR: "a flavour with no row fails the build"
 * (INV-ECO-09) is enforced by `tsc`, and `config.test.ts` re-asserts it at runtime for
 * anyone who reaches the table through a cast.
 *
 * EC-ECO-15 is the reason the table runs past the ten path flavours: it demands "a
 * timed-challenge row … and a row for every Story, Radio, Roleplay, script and hub
 * flavour, since any session that commits a row and awards XP extends the streak".
 */
export const SESSION_FLAVOUR_MATRIX: Record<
  SessionFlavour,
  Record<SessionOutcomeKind, FlavourRow>
> = {
  lesson: {
    completed: fullCredit('ceremony', true, null, { advancesPath: true }),
    replayed: fullCredit('ceremony', true, null),
    failed: noCredit('path.node', DID_NOT_COUNT, null),
    quit: noCredit('path.node', DID_NOT_COUNT, null),
  },
  nodePractice: {
    completed: fullCredit('ceremony', true, null),
    replayed: fullCredit('ceremony', true, null),
    failed: noCredit('path.node', DID_NOT_COUNT, null),
    quit: noCredit('path.node', DID_NOT_COUNT, null),
  },
  legendary: {
    completed: fullCredit('ceremony', true, LEGENDARY_MISTAKE_ALLOWANCE, { advancesPath: true }),
    // [EC-PTH-04] a re-tapped legendary node exposes ONLY the practice route, and the
    // 40 XP award is never paid a second time (INV-ECO-07).
    replayed: fullCredit('node.practice-only', true, LEGENDARY_MISTAKE_ALLOWANCE),
    // The checkpoint consolation is declared ON THE ROW (INV-ECO-16 / EC-PTH-27) and paid
    // at most once per node per local day. `awardsXp: false` stays true of the row's own
    // award — the session pays nothing for what it did; the consolation is a separate,
    // named, once-a-day term, and it is never multiplied, hence `boostApplies: false`.
    failed: noCredit(
      'node.legendary-retry',
      `${DID_NOT_COUNT}. The legendary challenge is always free to try again.`,
      LEGENDARY_MISTAKE_ALLOWANCE,
      { checkpointConsolationXp: LEGENDARY_CHECKPOINT_XP },
    ),
    quit: noCredit('node.legendary-retry', DID_NOT_COUNT, LEGENDARY_MISTAKE_ALLOWANCE),
  },
  placement: {
    // [ruling EC-ECO-15] "a completed placement or jump-here test extends the streak and
    // counts toward the goal … but awards 0 XP". Both halves, verbatim: a five-minute
    // learner must not lose a streak on the day they add a course, and the ability
    // estimate is not farmable. Goal progress on a 0 XP session is the day being SEEN,
    // not XP appearing from nowhere — `countsTowardGoal` is what the goal chest reads,
    // and the XP bar still moves by exactly the 0 XP this paid.
    completed: {
      extendsStreak: true,
      countsTowardGoal: true,
      awardsXp: false,
      advancesQuests: false,
      boostApplies: false,
      countsAsLesson: true,
      advancesPath: true,
      questShapes: [],
      writesMistakeRows: false,
      mistakeAllowance: null,
      checkpointConsolationXp: null,
      consequenceString: '',
      consequenceRoute: 'path.section',
    },
    replayed: noCredit('path.section', DID_NOT_COUNT, null, { writesMistakeRows: false }),
    failed: noCredit(
      'path.section.first',
      `${DID_NOT_COUNT}. Start from the beginning instead.`,
      null,
      { writesMistakeRows: false },
    ),
    quit: noCredit(
      'path.section.first',
      `${DID_NOT_COUNT}. Start from the beginning instead.`,
      null,
      { writesMistakeRows: false },
    ),
  },
  jumpHere: {
    completed: {
      extendsStreak: true,
      countsTowardGoal: true,
      awardsXp: false,
      advancesQuests: false,
      boostApplies: false,
      countsAsLesson: true,
      advancesPath: true,
      questShapes: [],
      writesMistakeRows: false,
      mistakeAllowance: JUMP_HERE_MISTAKE_ALLOWANCE,
      checkpointConsolationXp: null,
      consequenceString: '',
      consequenceRoute: 'path.unit-unlocked',
    },
    replayed: noCredit(
      'path.retry-offer',
      `${DID_NOT_COUNT}. Try again when you are ready.`,
      JUMP_HERE_MISTAKE_ALLOWANCE,
      { writesMistakeRows: false },
    ),
    // [EC-PTH-32 / INV-ECO-19] the named falsifier is a failed jump-here returning
    // SILENTLY to the path on an otherwise empty day. It never does: it says so and it
    // offers the retry.
    failed: noCredit(
      'path.retry-offer',
      `${DID_NOT_COUNT}. Try again, or finish a lesson to keep it going.`,
      JUMP_HERE_MISTAKE_ALLOWANCE,
      { writesMistakeRows: false },
    ),
    quit: noCredit(
      'path.retry-offer',
      `${DID_NOT_COUNT}. Try again whenever you like.`,
      JUMP_HERE_MISTAKE_ALLOWANCE,
      { writesMistakeRows: false },
    ),
  },
  sectionTest: {
    completed: fullCredit('ceremony', false, SECTION_TEST_MISTAKE_ALLOWANCE, {
      advancesPath: true,
      writesMistakeRows: false,
    }),
    replayed: fullCredit('ceremony', false, SECTION_TEST_MISTAKE_ALLOWANCE, {
      writesMistakeRows: false,
    }),
    // Exhaustion RESTARTS a section test (ruling S056); it never costs a heart and there
    // is no refill to offer.
    failed: noCredit(
      'path.section-test',
      `${DID_NOT_COUNT}. Try again when you are ready.`,
      SECTION_TEST_MISTAKE_ALLOWANCE,
      { writesMistakeRows: false },
    ),
    quit: noCredit(
      'path.section-test',
      `${DID_NOT_COUNT}. Try again when you are ready.`,
      SECTION_TEST_MISTAKE_ALLOWANCE,
      { writesMistakeRows: false },
    ),
  },
  unitReview: {
    completed: fullCredit('ceremony', true, null),
    replayed: fullCredit('ceremony', true, null),
    failed: noCredit('path.unit', DID_NOT_COUNT, null),
    quit: noCredit('path.unit', DID_NOT_COUNT, null),
  },
  dailyRefresh: {
    completed: fullCredit('ceremony', true, null),
    // [EC-PTH-15 / INV-ECO-08] a completed level stays replayable and pays the replay
    // award — never a dead screen, never the level award twice.
    replayed: fullCredit('refresh', true, null),
    failed: noCredit('refresh', DID_NOT_COUNT, null),
    quit: noCredit('refresh', DID_NOT_COUNT, null),
  },
  recovery: {
    // [EC-FRZ-08] the recovery challenge pays full XP and advances quests and the goal.
    completed: fullCredit('recovery', true, null),
    replayed: fullCredit('recovery', true, null),
    failed: noCredit('recovery', `${DID_NOT_COUNT}. Your recovery challenge is still open.`, null),
    quit: noCredit('recovery', `${DID_NOT_COUNT}. Your recovery challenge is still open.`, null),
  },
  endgameReview: {
    // [DEPART D-NOFARM] the endgame generator is unbounded, so it is excluded from the
    // boost and bounded by its own ladder.
    completed: fullCredit('ceremony', false, null),
    replayed: fullCredit('ceremony', false, null),
    failed: noCredit('path.endgame', DID_NOT_COUNT, null),
    quit: noCredit('path.endgame', DID_NOT_COUNT, null),
  },

  /* ---------------- long-form formats: credit, never boostable (EC-ECO-35) ---- */

  // A story node IS a path node, so a first completion advances the path; a replay does
  // not. `boost_applies: false` on every row is EC-ECO-35: "the wall-clock timer keeps
  // burning through excluded sessions, the chip stays visible, and that session's XP tile
  // renders GOLD rather than purple". INV-ECO-30's named falsifier is a purple tile on a
  // story replay, and this is the row that makes it impossible.
  story: {
    completed: longFormCredit('story.complete', { advancesPath: true }),
    replayed: longFormCredit('story.complete'),
    failed: noCredit('story.list', DID_NOT_COUNT, null, { writesMistakeRows: false }),
    quit: noCredit('story.list', DID_NOT_COUNT, null, { writesMistakeRows: false }),
  },
  radio: {
    completed: longFormCredit('radio.complete', { advancesPath: true }),
    replayed: longFormCredit('radio.complete'),
    failed: noCredit('radio.list', DID_NOT_COUNT, null, { writesMistakeRows: false }),
    quit: noCredit('radio.list', DID_NOT_COUNT, null, { writesMistakeRows: false }),
  },
  // [EC-ECO-38] Roleplay "cannot be failed", so its failed row is an abandonment, and it
  // is excluded from the boost "on the same reasoning as audio lessons".
  roleplay: {
    completed: longFormCredit('roleplay.summary'),
    replayed: longFormCredit('roleplay.summary'),
    failed: noCredit('hub.root', DID_NOT_COUNT, null, { writesMistakeRows: false }),
    quit: noCredit('hub.root', DID_NOT_COUNT, null, { writesMistakeRows: false }),
  },

  /* ------------------------------- the Practice Hub (EC-ECO-28, EC-ECO-35) ---- */

  hubMistakes: {
    completed: fullCredit('ceremony', true, null),
    replayed: fullCredit('ceremony', true, null),
    failed: noCredit('hub.root', DID_NOT_COUNT, null),
    quit: noCredit('hub.root', DID_NOT_COUNT, null),
  },
  hubWords: {
    completed: fullCredit('ceremony', true, null),
    replayed: fullCredit('ceremony', true, null),
    failed: noCredit('hub.root', DID_NOT_COUNT, null),
    quit: noCredit('hub.root', DID_NOT_COUNT, null),
  },
  // [EC-ECO-35] Listen-Up is on the exclusion list by name.
  hubListenUp: {
    completed: longFormCredit('ceremony'),
    replayed: longFormCredit('ceremony'),
    failed: noCredit('hub.root', DID_NOT_COUNT, null),
    quit: noCredit('hub.root', DID_NOT_COUNT, null),
  },
  // Speaking never costs a heart and never writes a mistake row [DEPART D-SKIPSPEAK].
  hubPronunciation: {
    completed: fullCredit('ceremony', true, null, { writesMistakeRows: false }),
    replayed: fullCredit('ceremony', true, null, { writesMistakeRows: false }),
    failed: noCredit('hub.root', DID_NOT_COUNT, null, { writesMistakeRows: false }),
    quit: noCredit('hub.root', DID_NOT_COUNT, null, { writesMistakeRows: false }),
  },
  hubTargetPractice: {
    completed: fullCredit('ceremony', true, null),
    replayed: fullCredit('ceremony', true, null),
    failed: noCredit('hub.root', DID_NOT_COUNT, null),
    quit: noCredit('hub.root', DID_NOT_COUNT, null),
  },
  hubUnitRewind: {
    completed: fullCredit('ceremony', true, null),
    replayed: fullCredit('ceremony', true, null),
    failed: noCredit('hub.root', DID_NOT_COUNT, null),
    quit: noCredit('hub.root', DID_NOT_COUNT, null),
  },

  /* ------------------------------------------- the timed challenge (EC-ECO-15) */

  /**
   * `counts_as_lesson: true` (it extends the streak and counts toward the goal) with
   * `advances_path: false`, "satisfying XP-shaped quests but not lesson-shaped ones and
   * writing no mistake rows" — EC-ECO-15, column by column. The surface ships disabled
   * (`TIMED_CHALLENGES_ENABLED`); the row exists so the widget, the danger nudge and the
   * goal chest keep reading one table.
   */
  timedChallenge: {
    completed: {
      extendsStreak: true,
      countsTowardGoal: true,
      awardsXp: true,
      advancesQuests: true,
      boostApplies: false,
      countsAsLesson: true,
      advancesPath: false,
      questShapes: ['xp', 'gems', 'streak'],
      writesMistakeRows: false,
      mistakeAllowance: null,
      checkpointConsolationXp: null,
      consequenceString: '',
      consequenceRoute: 'ceremony',
    },
    replayed: {
      extendsStreak: true,
      countsTowardGoal: true,
      awardsXp: true,
      advancesQuests: true,
      boostApplies: false,
      countsAsLesson: true,
      advancesPath: false,
      questShapes: ['xp', 'gems', 'streak'],
      writesMistakeRows: false,
      mistakeAllowance: null,
      checkpointConsolationXp: null,
      consequenceString: '',
      consequenceRoute: 'ceremony',
    },
    failed: noCredit('hub.root', DID_NOT_COUNT, null, { writesMistakeRows: false }),
    quit: noCredit('hub.root', DID_NOT_COUNT, null, { writesMistakeRows: false }),
  },
};

/**
 * The lookup every consumer uses. It THROWS rather than returning undefined: a flavour
 * with no row is a build bug and the engine must never silently award nothing.
 */
export function flavourRow(flavour: SessionFlavour, outcome: SessionOutcomeKind): FlavourRow {
  const rows = SESSION_FLAVOUR_MATRIX[flavour];
  if (rows === undefined) throw new Error(`flavour matrix: no rows for ${flavour}`);
  const row = rows[outcome];
  if (row === undefined) throw new Error(`flavour matrix: no row for ${flavour}/${outcome}`);
  return row;
}

/* ==================================================== 11. XP shape per flavour */

export interface FlavourXp {
  /** What a first completion pays, before the combo bonus and before any multiplier. */
  readonly base: number;
  /** Whether the combo bonus applies, which is also whether the advert is a floor. */
  readonly comboApplies: boolean;
  /** Which per-mode daily ladder this flavour consumes (INV-ECO-06). */
  readonly ladderMode: XpLadderMode;
  /** The product-map screen, so the table and the map cannot drift apart. */
  readonly screen: string;
  /**
   * The long-form entry-point table this flavour reads instead of `base`, when it has one
   * (EC-ECO-37). `null` for every flavour with a single award.
   */
  readonly longForm: LongFormXpTable | null;
  /** What a replay pays. `null` = the shared `REPLAY_PRACTICE_XP`. */
  readonly replayXp: number | null;
}

function scalarFlavour(
  base: number,
  comboApplies: boolean,
  ladderMode: XpLadderMode,
  screen: string,
  replayXp: number | null = null,
): FlavourXp {
  return { base, comboApplies, ladderMode, screen, longForm: null, replayXp };
}

export const FLAVOUR_XP: Record<SessionFlavour, FlavourXp> = {
  lesson: scalarFlavour(LESSON_BASE_XP, true, 'lesson', 'S057'),
  nodePractice: scalarFlavour(PRACTICE_XP, false, 'practice', 'S058'),
  legendary: scalarFlavour(LEGENDARY_XP, true, 'legendary', 'S059'),
  placement: scalarFlavour(PLACEMENT_XP, false, 'test', 'S060'),
  jumpHere: scalarFlavour(JUMP_HERE_XP, false, 'test', 'S061'),
  sectionTest: scalarFlavour(SECTION_TEST_XP, false, 'test', 'S062'),
  unitReview: scalarFlavour(UNIT_REVIEW_XP, false, 'review', 'S063'),
  dailyRefresh: scalarFlavour(DAILY_REFRESH_LEVEL_XP, false, 'dailyRefresh', 'S064'),
  recovery: scalarFlavour(RECOVERY_LESSON_XP, true, 'recovery', 'S065'),
  endgameReview: scalarFlavour(ENDGAME_REVIEW_XP, false, 'endgameReview', 'S066'),

  // The two long-form formats read their four-key table; `base` is the `first` entry so a
  // caller that ignores the table still cannot invent a number (EC-ECO-37).
  story: {
    base: STORY_XP.first,
    comboApplies: false,
    ladderMode: STORY_XP.ladderMode,
    screen: 'S101',
    longForm: STORY_XP,
    replayXp: STORY_XP.replay_plain,
  },
  radio: {
    base: RADIO_XP.first,
    comboApplies: false,
    ladderMode: RADIO_XP.ladderMode,
    screen: 'S112',
    longForm: RADIO_XP,
    replayXp: RADIO_XP.replay_plain,
  },
  // [EC-ECO-38] full for the first scenario per local_day, the floor thereafter.
  roleplay: scalarFlavour(ROLEPLAY_FIRST_XP, false, 'roleplay', 'S117', ROLEPLAY_FLOOR_XP),

  hubMistakes: scalarFlavour(HUB_SESSION_XP, false, 'hubMistakes', 'S092'),
  hubWords: scalarFlavour(HUB_SESSION_XP, false, 'hubWords', 'S094'),
  hubListenUp: scalarFlavour(HUB_SESSION_XP, false, 'hubListenUp', 'S095'),
  hubPronunciation: scalarFlavour(HUB_SESSION_XP, false, 'hubPronunciation', 'S096'),
  hubTargetPractice: scalarFlavour(HUB_SESSION_XP, false, 'hubTargetPractice', 'S099'),
  hubUnitRewind: scalarFlavour(HUB_SESSION_XP, false, 'hubUnitRewind', 'S099'),

  timedChallenge: scalarFlavour(TIMED_CHALLENGE_XP, false, 'timedChallenge', 'S091'),
};

/* ======================================== 12. personal records (EC-ECO-27) */

/**
 * [ruling EC-ECO-27 / INV-ECO-23] Records update SILENTLY and are celebrated "at most
 * once per 7 local days … and only when the MARGIN exceeds a configured threshold".
 *
 * Both halves are constants because both halves are the rule: the cooldown stops twelve
 * record days producing twelve cards, and the margin stops a one-XP personal best being
 * called a personal best at all.
 */
export const RECORD_CELEBRATION_COOLDOWN_DAYS = 7;

/** A new record must beat the old one by this fraction before anything is shown. */
export const RECORD_CELEBRATION_MIN_MARGIN_RATIO = 0.1;
/** …and by at least this absolute amount, so small records are not celebrated per point. */
export const RECORD_CELEBRATION_MIN_MARGIN_ABSOLUTE = 5;
