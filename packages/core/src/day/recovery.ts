/**
 * Both recovery mechanics, side by side.
 *
 * EC-FRZ-08 was a contradiction — one reading deleted the repair modal, another kept it.
 * The plan's ruling is **both**.
 *
 * (A correction to an earlier version of this comment: the plan's ruling row says the old
 * INV-REC-01 grep gate forbidding the string "Streak Repair" "is deleted", but no such
 * gate ever existed in this repository — `grep -rn 'Streak Repair' scripts/ .github/ docs/
 * packages/` on origin/main finds nothing, and docs/invariants.md already carries the
 * amended INV-REC-01. Nothing was removed here. What the ruling means in practice is the
 * rule below.)
 *
 * What INV-REC-01 requires:
 *
 * - **The 3-lesson recovery challenge**, window **2 local days** from `broken_on` (the
 *   bundle's own "Only 2 days left" ladder, not the invented 7). Its lessons pay full XP,
 *   advance quests and count toward the goal whether the challenge lands, lapses or is
 *   abandoned; completion sets `streak = previous_streak` **with today marked satisfied**.
 * - **A monthly Streak Repair**, `streakRepairsPerMonth = 1`, idempotent on `(year,
 *   month)`, which restores `streak = previous_streak` **with today left unsatisfied**.
 *
 * And the rule that keeps them from double-paying: a repair never stacks with a freeze on
 * the same day, and no local day is ever both freeze-covered and repaired. A restore of
 * either kind repaints exactly the UNCOVERED broken dates as `recovered` — never a frozen
 * one, which already has its snowflake and its own truthful cell (EC-FRZ-19).
 */
import { addCivilDays, civilDaysBetween, monthKeyOf, type LocalDay } from './civil.js';
import { DAY_CONFIG } from './config.js';
import { streakFromDispositions, type DayDisposition } from './dispositions.js';
import { milestonesCrossed } from '../streak/milestones.js';
import type { DayEngineState, RecoveryChallenge } from './state.js';

export type RecoveryDecline =
  | 'no-break'
  | 'window-expired'
  | 'too-many-uncovered-days'
  | 'nothing-to-restore'
  /**
   * The restore ran but did not reach `previous_streak + 1`, so it was ABANDONED and the
   * break record kept. A restore that half-works is the worst outcome available: the
   * learner loses the streak and the offer at once. See `completeChallenge`.
   */
  | 'restore-incomplete';

export type RepairDecline =
  RecoveryDecline | 'month-already-repaired' | 'break-too-large-for-repair';

export interface RecoveryOffer {
  /** The 3-lesson challenge, offered iff the break is recent and small enough. */
  readonly challengeArmed: boolean;
  /** The monthly repair, offered iff the allowance is unspent and the break is ≤ 2 days. */
  readonly repairArmed: boolean;
  readonly brokenOn: LocalDay | null;
  readonly previousStreak: number;
  readonly uncoveredDays: readonly LocalDay[];
  /** Local days left on the challenge window, for the "Only N days left" ladder. */
  readonly daysLeft: number;
  readonly declinedBecause: RecoveryDecline | null;
}

const NO_OFFER: RecoveryOffer = {
  challengeArmed: false,
  repairArmed: false,
  brokenOn: null,
  previousStreak: 0,
  uncoveredDays: [],
  daysLeft: 0,
  declinedBecause: 'no-break',
};

/**
 * What to offer on `today`.
 *
 * INV-REC-06: armed **iff** the break is inside the recency window AND the count of
 * missed days **not covered by a freeze** is inside the cap. Freeze-covered days never
 * count toward that cap, because the streak never broke on them (EC-FRZ-18) — the
 * three-date gap with two freezes spent IS offered the challenge.
 */
export function recoveryOffer(state: DayEngineState, today: LocalDay): RecoveryOffer {
  const brk = state.brk;
  if (brk === null || brk.previousStreak <= 0) return NO_OFFER;
  const elapsed = civilDaysBetween(brk.brokenOn, today);
  // Two LOCAL DAYS from `broken_on`: the break is discovered on `broken_on + 1` (the
  // rollover that decided it), so the ladder reads "Only 2 days left" there, "Only 1 day
  // left" the next day, and the challenge is dead on `broken_on + 3` — which is exactly
  // INV-REC-04's falsifier (one of three lessons done, three local days advanced).
  const daysLeft = Math.min(
    DAY_CONFIG.recoveryChallengeWindowLocalDays,
    DAY_CONFIG.recoveryChallengeWindowLocalDays - elapsed + 1,
  );
  const uncovered = brk.uncoveredDays;
  if (elapsed < 0 || daysLeft <= 0) {
    return {
      ...NO_OFFER,
      brokenOn: brk.brokenOn,
      previousStreak: brk.previousStreak,
      uncoveredDays: uncovered,
      daysLeft: 0,
      declinedBecause: 'window-expired',
    };
  }
  if (uncovered.length > DAY_CONFIG.recoveryChallengeUncoveredDayCap) {
    return {
      ...NO_OFFER,
      brokenOn: brk.brokenOn,
      previousStreak: brk.previousStreak,
      uncoveredDays: uncovered,
      daysLeft,
      declinedBecause: 'too-many-uncovered-days',
    };
  }
  const monthKey = monthKeyOf(state.maxLocalDaySeen ?? today);
  const repairsThisMonth = state.repairs.filter((r) => r.monthKey === monthKey).length;
  const repairArmed =
    repairsThisMonth < DAY_CONFIG.streakRepairsPerMonth &&
    uncovered.length <= DAY_CONFIG.repairMaxUncoveredDays;
  return {
    challengeArmed: true,
    repairArmed,
    brokenOn: brk.brokenOn,
    previousStreak: brk.previousStreak,
    uncoveredDays: uncovered,
    daysLeft,
    declinedBecause: null,
  };
}

/**
 * Accept the challenge. The window is measured from `broken_on`, never from acceptance
 * (EC-FRZ-15), and is kept in LOCAL DAYS so it cannot drift across DST.
 */
export function armChallenge(state: DayEngineState, today: LocalDay): DayEngineState {
  const offer = recoveryOffer(state, today);
  if (!offer.challengeArmed || offer.brokenOn === null) return state;
  if (state.challenge !== null && state.challenge.brokenOn === offer.brokenOn) return state;
  const challenge: RecoveryChallenge = {
    brokenOn: offer.brokenOn,
    previousStreak: offer.previousStreak,
    expiresAfterDay: addCivilDays(offer.brokenOn, DAY_CONFIG.recoveryChallengeWindowLocalDays),
    lessonsRequired: DAY_CONFIG.recoveryChallengeLessons,
    lessonsDone: 0,
    earnedOnDay: null,
  };
  return { ...state, challenge };
}

/**
 * Is a lesson STARTED on `startDay` eligible to count toward the challenge?
 *
 * INV-REC-05: eligibility is a function of the session START time only. A lesson begun
 * inside the window always completes and always counts, even if it finishes after the
 * window closes — and its XP and attempt rows commit identically either way.
 */
export function challengeEligibleAtStart(state: DayEngineState, startDay: LocalDay): boolean {
  const challenge = state.challenge;
  if (challenge === null) return false;
  if (challenge.lessonsDone >= challenge.lessonsRequired) return false;
  return startDay <= challenge.expiresAfterDay && startDay >= challenge.brokenOn;
}

/**
 * Record one completed recovery lesson. `startedOnDay` is the day the SESSION STARTED.
 * Persisted like any other session state, so an app kill loses nothing (INV-REC-03).
 */
export function recordChallengeLesson(
  state: DayEngineState,
  startedOnDay: LocalDay,
): DayEngineState {
  if (!challengeEligibleAtStart(state, startedOnDay)) return state;
  const challenge = state.challenge!;
  const lessonsDone = challenge.lessonsDone + 1;
  return {
    ...state,
    challenge: {
      ...challenge,
      lessonsDone,
      earnedOnDay: lessonsDone >= challenge.lessonsRequired ? startedOnDay : null,
    },
  };
}

/**
 * Expire the challenge when `today` is past the window: the challenge row, its persisted
 * partial progress and the armed offer all go in ONE transaction, and the streak stays
 * broken (EC-FRZ-15, INV-REC-04). `previous_streak` survives only as the record.
 */
export function expireChallengeIfLapsed(state: DayEngineState, today: LocalDay): DayEngineState {
  const challenge = state.challenge;
  if (challenge === null) return state;
  if (today <= challenge.expiresAfterDay) return state;
  // INV-REC-05 deliberately lets a session STARTED inside the window finish late, and the
  // third such lesson is already recorded here. An earned challenge is therefore awaiting
  // its commit, not lapsed, and the walk must not delete it out from under the ceremony —
  // but the wait is BOUNDED by the day the work was actually done, so an earned challenge
  // cannot sit open forever waiting for a commit that never comes.
  if (challenge.lessonsDone >= challenge.lessonsRequired) {
    if (challenge.earnedOnDay === null) return state;
    const deadline = addCivilDays(challenge.earnedOnDay, DAY_CONFIG.challengeCommitGraceLocalDays);
    if (today <= deadline) return state;
  }
  return { ...state, challenge: null };
}

export interface RestoreResult<Decline = RecoveryDecline> {
  readonly state: DayEngineState;
  readonly restored: boolean;
  readonly streakBefore: number;
  readonly streakAfter: number;
  /** At most one, by construction: a restore never vaults past a milestone (INV-REC-07). */
  readonly milestones: readonly number[];
  readonly repaintedDays: readonly LocalDay[];
  readonly declinedBecause: Decline | null;
}

function repaint(
  dispositions: ReadonlyMap<LocalDay, DayDisposition>,
  days: readonly LocalDay[],
): { map: Map<LocalDay, DayDisposition>; repainted: LocalDay[] } {
  const map = new Map(dispositions);
  const repainted: LocalDay[] = [];
  for (const day of days) {
    // EXACTLY the uncovered dates. A frozen day keeps its snowflake; a completed day is
    // not a broken date at all.
    if (map.get(day) !== 'missed') continue;
    map.set(day, 'recovered');
    repainted.push(day);
  }
  return { map, repainted };
}

/**
 * Complete the challenge: the streak returns to `previous_streak` and **today is marked
 * satisfied**, so the learner resumes at N+1 rather than at N-with-today-pending
 * (EC-FRZ-09, INV-REC-02). The caller has already committed the third lesson's XP.
 */
export function completeChallenge(state: DayEngineState, today: LocalDay): RestoreResult {
  const streakBefore = streakFromDispositions(state.dispositions, today);
  const decline = (because: RecoveryDecline): RestoreResult => ({
    state,
    restored: false,
    streakBefore,
    streakAfter: streakBefore,
    milestones: [],
    repaintedDays: [],
    declinedBecause: because,
  });
  const challenge = state.challenge;
  if (challenge === null) return decline('no-break');
  // The BREAK RECORD is the live copy of what has to be repainted, and the challenge row
  // holds no copy of its own. `rolloverTo` appends every further missed day inside the
  // window to `brk.uncoveredDays`, so reading it here — and only here, at completion
  // time — is what makes a challenge armed on day one still restore a break that grew on
  // day two (INV-REC-02, INV-REC-07).
  const brk = state.brk;
  if (brk === null || brk.brokenOn !== challenge.brokenOn) return decline('no-break');
  if (challenge.lessonsDone < challenge.lessonsRequired) return decline('nothing-to-restore');
  // The commit's own bound. Eligibility was settled at session START (INV-REC-05), so a
  // late finish is fine; a commit days after the work was done is not.
  if (
    challenge.earnedOnDay !== null &&
    today > addCivilDays(challenge.earnedOnDay, DAY_CONFIG.challengeCommitGraceLocalDays)
  ) {
    return decline('window-expired');
  }

  const { map, repainted } = repaint(state.dispositions, brk.uncoveredDays);
  // Today is satisfied by the challenge's own third lesson.
  map.set(today, 'completed');
  const streakAfter = streakFromDispositions(map, today);
  // A restore that cannot reach `previous_streak + 1` has not restored anything, and the
  // one thing it must never do is clear `brk` on the way out: that is the only record of
  // `previous_streak`, and losing it costs the learner the streak AND the second offer.
  // Refuse, keep every fact, and let the caller show the offer again.
  if (streakAfter < brk.previousStreak + 1) return decline('restore-incomplete');

  const restored: DayEngineState = {
    ...state,
    dispositions: map,
    challenge: null,
    brk: null,
  };
  return {
    state: restored,
    restored: true,
    streakBefore,
    streakAfter,
    // Measured from `previous_streak`, not from the broken 0: the learner already
    // celebrated 7 and 14 on the way up to 22, and a restore must not replay them. The
    // restore's own contribution is one lived day — today — so this is at most one
    // screen (INV-REC-07).
    milestones: milestonesCrossed(brk.previousStreak, streakAfter),
    repaintedDays: repainted,
    declinedBecause: null,
  };
}

/**
 * Spend the monthly Streak Repair.
 *
 * Restores `streak = previous_streak` with **today left unsatisfied** — unlike the
 * challenge, which marks today satisfied (EC-FRZ-13). Idempotent on `(year, month)` of
 * `max_local_day_seen`, which is the month key EC-STK-25 settled, so travel across a
 * month boundary mints nothing extra. Never stacks with a freeze on the same day: only
 * `missed` days are repainted, so no local day is ever both freeze-covered and repaired.
 */
export function repairStreak(state: DayEngineState, today: LocalDay): RestoreResult<RepairDecline> {
  const streakBefore = streakFromDispositions(state.dispositions, today);
  const decline = (because: RepairDecline): RestoreResult<RepairDecline> => ({
    state,
    restored: false,
    streakBefore,
    streakAfter: streakBefore,
    milestones: [],
    repaintedDays: [],
    declinedBecause: because,
  });
  const offer = recoveryOffer(state, today);
  if (offer.brokenOn === null) return decline('no-break');
  if (offer.declinedBecause !== null) return decline(offer.declinedBecause);
  const monthKey = monthKeyOf(state.maxLocalDaySeen ?? today);
  if (
    state.repairs.filter((r) => r.monthKey === monthKey).length >= DAY_CONFIG.streakRepairsPerMonth
  ) {
    return decline('month-already-repaired');
  }
  if (offer.uncoveredDays.length > DAY_CONFIG.repairMaxUncoveredDays) {
    return decline('break-too-large-for-repair');
  }
  const { map, repainted } = repaint(state.dispositions, offer.uncoveredDays);
  const streakIfRepaired = streakFromDispositions(map, today);
  // Same discipline as the challenge: a repair that cannot restore `previous_streak`
  // spends the monthly allowance for nothing and destroys the break record on its way
  // out. Refuse instead, and keep both.
  if (streakIfRepaired < offer.previousStreak) return decline('restore-incomplete');
  const repaired: DayEngineState = {
    ...state,
    dispositions: map,
    brk: null,
    challenge: null,
    repairs: [
      ...state.repairs,
      { monthKey, onDay: today, restoredStreak: offer.previousStreak, repaintedDays: repainted },
    ],
  };
  const streakAfter = streakIfRepaired;
  return {
    state: repaired,
    restored: true,
    streakBefore,
    streakAfter,
    milestones: milestonesCrossed(offer.previousStreak, streakAfter),
    repaintedDays: repainted,
    declinedBecause: null,
  };
}
