/**
 * The scheduler's named constants.
 *
 * Every number here carries a source, the same shorthand `economy/config.ts` uses:
 *   [EC-...]            the edge-case catalogue, `~/duolingo-research/deep/00-EDGE-CASES.md`
 *   [ts-fsrs]           the algorithm library's own default, re-exported rather than copied
 *   [DERIVED]           Freelingo's own decision; no Duolingo source exists
 *
 * THREE values here belong to other lanes, and all three use the same shape: an interface
 * the scheduler reads, a `DEFAULT_` constant, and a parameter every call site already
 * takes, so the owning task deletes the default and passes its own table WITHOUT touching a
 * single call site. Each is filed in `docs/owned/scheduler.json` -> `requests`.
 *
 *   `SchedulerEconomy`   -> `economy/config.ts` owns `max_new_items_per_local_day` and
 *                           `min_hours_between_introduction_and_production`, which EC-SCH-11
 *                           calls SHARED constants.
 *   `PackScoreCeiling`   -> `packs/` owns the Score ceiling a pack declares (EC-PACK-55).
 *
 * The band floor the Score is also maxed against (`score_floor`, EC-PTH-09 / INV-PATH-06)
 * is `path/`'s and is passed straight into `displayedScore`; it is deliberately NOT a
 * constant here, because there is exactly one `score_floor` in the data model and it is not
 * this module's.
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
 * The interval we STORE is clamped to it. ts-fsrs clamps the interval it computes but then
 * re-derives `scheduled_days` from the due date, which lands on 36500, 36501 or 36502
 * depending on rounding. Measured 2026-09-11: that one-day jitter, and nothing else, makes
 * the INV-SCH-01 interval sequence non-monotonic once a card saturates. Clamping the stored
 * value removes an artefact, not a behaviour.
 *
 * It is NOT the honest-elapsed ceiling. That is a separate, much smaller number below, and
 * conflating the two is what let a ten-year clock jump read as honest.
 */
export const MAXIMUM_INTERVAL_DAYS = default_maximum_interval;

/**
 * [DERIVED 2026-09-11, EC-SCH-02] The largest elapsed the scheduler will accept: ten years.
 *
 * EC-SCH-02 is about "a negative OR ABSURD interval". A clamp at zero catches the clock
 * set back; it does nothing about a clock set forward, which drives retrievability to zero
 * and inflates stability on the very next answer.
 *
 * This constant was `MAXIMUM_INTERVAL_DAYS` (36,500 days) in the first draft. That was
 * wrong twice over, and the second half of the correction matters more than the first.
 *
 * WRONG ONCE: ts-fsrs's `default_maximum_interval` is a SENTINEL meaning "effectively never
 * clamp", not a claim about human memory, so the upper jaw did not close until a clock was
 * a CENTURY out. Ten years is the number instead, on three grounds:
 *
 * 1. Freelingo first ships in 2026, so no row can honestly carry a ten-year gap before
 *    2036 — by which date this dated constant is due a second look regardless.
 * 2. No scheduling decision differs between a ten-year gap and a hundred-year one:
 *    retrievability is indistinguishable from zero at both and the item is maximally
 *    overdue at both.
 * 3. The failure direction is safe. Under-reporting elapsed makes the next stability grow
 *    LESS, i.e. schedules the item sooner. EC-SCH-02's harm is "pushes a weak item months
 *    out"; a slightly-too-soon review is the opposite of that.
 *
 * WRONG TWICE, and this is the part a reader must not misread: AN ABSOLUTE CEILING IS A
 * BACKSTOP AGAINST ABSURDITY, NOT A DEFENCE AGAINST A PLAUSIBLY-SIZED FORWARD CLOCK.
 * Measured 2026-09-11, ts-fsrs 5.4.2, a card at stability 163.0 after five honest reviews
 * (`zz`-free repro in `fsrs.test.ts`, `[INV-SCH-02] a ten-year forward clock`):
 *
 *   +10 years, UNCLAMPED        S -> 1604.67
 *   +10 years, clamped at 3,650 S -> 1604.45   <- the clamp buys 0.2 of stability
 *   +100 years, UNCLAMPED       S -> 2457.82
 *   +100 years, clamped         S -> 1604.45   <- here it buys 853
 *
 * So the ceiling stops the garbage (a library throw, a 2,457-day stability, anything
 * beyond) and does essentially nothing about a decade. It cannot: from inside this module a
 * forward clock and an honest absence are the same two numbers. Telling them apart needs
 * the monotonic-clock signal `day/` already derives for EC-STK-02 / INV-DAY-02 ("a
 * `local_day` regression is honoured iff UTC is monotonic AND the zone changed"), which is
 * another lane — filed in `docs/owned/scheduler.json` -> `requests`.
 *
 * Crossing the ceiling clamps and writes an `implausibleElapsed` anomaly row of its own.
 */
export const MAX_HONEST_ELAPSED_DAYS = 3_650;
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

/**
 * The Score SCALE: 0–160.
 *
 * [blog.duolingo.com/duolingo-score, 2024-10-23] via `deep/04`:147 ("Scale. **0–160**, with
 * current advanced courses covering content through **120**") and `deep/02`:98 ("Score is
 * 0–160, CEFR-pegged"). The CEFR pegging of the bands lives in `deep/02`:98 and belongs to
 * `path/`; the scheduler only needs the top of the scale.
 *
 * This replaces a `SCORE_MAX = 150` that a previous draft of this file carried under an
 * `[obs 2026-09-10]` tag. No such observation exists in the corpus, `[obs]` is not one of
 * the three provenance tags this file declares, and the number contradicted four corpus
 * lines. It is recorded here rather than silently deleted because a fabricated measurement
 * that survives review is worse than a wrong one that is argued about.
 */
export const SCORE_SCALE_MAX = 160;

/**
 * The ceiling that actually CLAMPS the chip is the PACK's, not this scale.
 *
 * [EC-PACK-55] "clamp Score to the pack's declared ceiling so completion copy cannot
 * contradict a chip reading `29 / 160`" — an A1-band beta pack completes at 29, not at 160.
 * [EC-PTH-40 / INV-PATH-22] "one course-level 0–160 number"; a per-section figure is a pure
 * clamp of that one number into the band, never a second model.
 *
 * `packs/` owns the declared ceiling and this task may not touch that lane, so it is
 * injected with a default exactly as `SchedulerEconomy` is, and every call site already
 * takes the parameter. See `docs/owned/scheduler.json` -> `requests`.
 */
export interface PackScoreCeiling {
  /** The pack manifest's declared ceiling, `0 < ceiling <= SCORE_SCALE_MAX`. */
  readonly declaredScoreCeiling: number;
}

/** DELETE at integration and read the installed pack's manifest instead. */
export const DEFAULT_PACK_SCORE_CEILING: PackScoreCeiling = {
  declaredScoreCeiling: SCORE_SCALE_MAX,
};

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
