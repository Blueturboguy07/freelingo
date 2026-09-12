/**
 * The scheduler's named constants.
 *
 * Every number here carries a source, the same shorthand `economy/config.ts` uses:
 *   [EC-...]            the edge-case catalogue, `~/duolingo-research/deep/00-EDGE-CASES.md`
 *   [ts-fsrs]           the algorithm library's own default, re-exported rather than copied
 *   [DERIVED]           Freelingo's own decision; no Duolingo source exists
 *
 * TWO of these belong to the economy config, not here. `max_new_items_per_local_day` and
 * `min_hours_between_introduction_and_production` are named by EC-SCH-11 as "shared
 * constants", and `economy/config.ts` is a single-owner file this task may not touch — it
 * did not carry them when this branch was cut. They are therefore declared as an injected
 * `SchedulerEconomy` view with a default, so that the integration task can delete
 * `DEFAULT_SCHEDULER_ECONOMY` and pass the economy table's values instead WITHOUT touching
 * a single call site. See `docs/owned/scheduler.json` -> `requests`.
 */
import { default_maximum_interval, generatorParameters, type FSRSParameters } from 'ts-fsrs';

/* ============================================================ 1. the early-review guard */

/**
 * [EC-SCH-01] Below this fraction of the scheduled interval a review updates
 * retrievability and logs `review_kind='early'`, and leaves stability and `due_at` alone.
 *
 * "20 sessions a day re-encounter items far ahead of their due date ... otherwise
 * intervals collapse toward zero and the clone's core claim fails quietly in exactly the
 * users who use it most." Nothing in the corpus defines early-review handling; 0.6 is the
 * catalogue's number and the invariant text repeats it.
 */
export const EARLY_REVIEW_FRACTION = 0.6;

/* ======================================================== 2. the honest-elapsed window */

export const MS_PER_DAY = 86_400_000;
export const MS_PER_HOUR = 3_600_000;

/**
 * [ts-fsrs] the algorithm's own ceiling on a scheduled interval, 36,500 days.
 *
 * Read from the library rather than copied, so a version bump cannot leave a stale 36500
 * behind. It is used for two separate jobs:
 *
 * 1. The interval we STORE is clamped to it. ts-fsrs clamps the interval it computes but
 *    then re-derives `scheduled_days` from the due date, which lands on 36500, 36501 or
 *    36502 depending on rounding. Measured 2026-09-11: that one-day jitter, and nothing
 *    else, makes the INV-SCH-01 interval sequence non-monotonic once a card saturates.
 *    Clamping the stored value removes an artefact, not a behaviour.
 * 2. It is the upper end of the honest-elapsed window below.
 */
export const MAXIMUM_INTERVAL_DAYS = default_maximum_interval;

/**
 * [DERIVED, EC-SCH-02] The largest elapsed the scheduler will accept.
 *
 * EC-SCH-02 is about "a negative OR ABSURD interval". A clamp at zero catches the clock
 * set back; it does nothing about a clock set forward a century, which drives
 * retrievability to zero and inflates stability on the very next answer. An item can never
 * honestly have been due more than one maximum interval ago, because that is the longest
 * interval the algorithm will ever schedule, so anything beyond it is a clock fault by
 * construction and is clamped with an anomaly row of its own.
 */
export const MAX_HONEST_ELAPSED_DAYS = MAXIMUM_INTERVAL_DAYS;
export const MAX_HONEST_ELAPSED_MS = MAX_HONEST_ELAPSED_DAYS * MS_PER_DAY;

/* ==================================================================== 3. FSRS itself */

/**
 * [ts-fsrs] default weights, with fuzz OFF.
 *
 * `enable_fuzz` spreads the due date by a random ±5% so that a big import does not pile
 * every card onto one day. Freelingo cannot have it: the plan's whole verification story
 * is properties over a virtual clock, and a scheduler whose output depends on
 * `Math.random()` has no properties. The item-level spread that fuzz buys is provided
 * here by the daily pool instead (INV-SCH-05).
 */
export const FSRS_PARAMETERS: FSRSParameters = generatorParameters({ enable_fuzz: false });

/* ========================================================== 4. holds and suppressions */

/**
 * [EC-SCH-08] "An open report suppresses that item from generation for 7 LOCAL DAYS (or
 * until dismissed in Settings) and freezes its FSRS clock for the window rather than
 * accruing overdue-ness, so dismissal does not read as a lapse."
 *
 * Local days, not 168 hours: the window is civil-date arithmetic in the learner's zone,
 * like every other day-keyed rule (INV-DAY-05).
 */
export const REPORT_SUPPRESSION_LOCAL_DAYS = 7;

/* ==================================================================== 5. the Score */

/**
 * [DERIVED, EC-SCH-10] the stability at which an item counts as MASTERED, in days.
 *
 * Score is defined over "a persisted high-water set of ever-mastered items, never live
 * retrievability". This constant is the only place the threshold is spelled; crossing it
 * once puts the item in the set forever, and nothing takes it out.
 *
 * Three weeks is the smallest interval at which the item has survived a real forgetting
 * gap rather than a single day's cramming; no Duolingo source states a figure.
 */
export const MASTERY_STABILITY_DAYS = 21;

/** [DERIVED] how many mastered items one displayed Score point is worth. */
export const ITEMS_PER_SCORE_POINT = 20;
/** [obs 2026-09-10] the Score chip tops out; the observed ceiling of the 2026 arm. */
export const SCORE_MAX = 150;

/* ========================================================= 6. the due-backlog rule */

/**
 * [INV-SCH-04, EC-PTH-19] `due_items > k x session_length` surfaces a review session
 * first on course re-entry.
 *
 * k = 3 [DERIVED]: below three sessions' worth of backlog the learner can clear it inside
 * the lessons they were going to do anyway, so interrupting them buys nothing.
 */
export const DUE_BACKLOG_SESSION_MULTIPLIER = 3;

/* ============================================== 7. the two constants economy will own */

/**
 * The economy fields the scheduler reads. Injected, never imported, until
 * `economy/config.ts` carries them (see the header note).
 */
export interface SchedulerEconomy {
  /** [EC-SCH-11] `max_new_items_per_local_day = 40`. */
  readonly maxNewItemsPerLocalDay: number;
  /** [EC-SCH-11] `min_hours_between_introduction_and_production = 4`. */
  readonly minHoursBetweenIntroductionAndProduction: number;
}

/**
 * [EC-SCH-11] "Ship shared constants `max_new_items_per_local_day = 40` and
 * `min_hours_between_introduction_and_production = 4`."
 *
 * DELETE THIS at integration and read the economy table instead. It exists so the
 * scheduler is testable and shippable before that file grows the two fields, not because
 * the scheduler is the right home for them.
 */
export const DEFAULT_SCHEDULER_ECONOMY: SchedulerEconomy = {
  maxNewItemsPerLocalDay: 40,
  minHoursBetweenIntroductionAndProduction: 4,
};
