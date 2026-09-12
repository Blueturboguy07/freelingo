/**
 * The 30-day, two-course, four-zone journey — as data.
 *
 * Plan §Phases, P4 gate: *"Headless 30-day journey in packages/core across two courses
 * and four zones"*, brought forward to the P1 gate because P1 is where the engine that
 * has to survive it is written. One learner, thirty simulated local days, two installed
 * courses and four IANA zones, driven on the testkit virtual clock.
 *
 * The script is separated from the driver on purpose. A journey written as three hundred
 * lines of imperative test body is unreviewable — nobody can answer "does this actually
 * exercise a boost that expires past the grace window?" by reading it, and a driver bug
 * that silently skips a day looks exactly like a passing test. Here the trace is a value:
 * every day names its zone, its events, and the invariant ids each event is there to
 * exercise, so `journey.test.ts` can assert *about the script* (that every required
 * behaviour appears, that every zone is visited, that the events the task enumerates are
 * all present) before it asserts anything about the engine.
 *
 * ## The calendar
 *
 * Day 1 is 2026-09-20 local. Thirty local days end on 2026-10-19, which puts a calendar
 * month boundary inside the trace (day 11 → day 12) — required, because the monthly
 * Streak Repair is idempotent on `(year, month)` (INV-REC-01) and a 30-day trace inside
 * one month can only ever prove half of that.
 *
 * ## The zones
 *
 * The matrix is `packages/testkit/src/zones.ts` and the flights are chosen for what each
 * crossing does to the civil date, not for plausibility:
 *
 * | day | from → to | what it proves |
 * |---|---|---|
 * | 8 | Asia/Tokyo → America/Los_Angeles | −17 h: the local day goes BACKWARDS while UTC advances. Honoured, because the zone changed (INV-DAY-02). A pure clock change with no zone change must be refused. |
 * | 15 | America/Los_Angeles → Pacific/Kiritimati | +22 h across the date line: a civil date is jumped over and is `unlived` — not missed, consumes no freeze (INV-DAY-03). |
 * | 22 | Pacific/Kiritimati → Australia/Lord_Howe | −3 h into the only 30-minute DST zone on earth: day arithmetic that is not a whole number of hours (INV-DAY-05). |
 *
 * Tokyo is the fourth zone, held for days 1–7.
 */

/** A journey day's index, 1-based. */
export type DayIndex = number;

/**
 * What happens on a day. One kind per behaviour the P1 gate names; the driver has one
 * handler per kind and `journey.test.ts` asserts that every kind appears at least once,
 * so a kind that no longer has a handler cannot be quietly dropped.
 */
export type EventKind =
  | 'install-course'
  | 'set-goal'
  | 'lesson'
  | 'park-session'
  | 'resume-parked'
  | 'switch-course'
  | 'kill-and-resume'
  | 'buy-freeze'
  | 'activate-boost'
  | 'commit-after-boost-expiry'
  | 'change-goal-mid-day'
  | 'idle'
  | 'recovery-lesson'
  | 'streak-repair'
  | 'pack-major-bump'
  | 'export-wipe-import'
  | 'open-session-across-midnight';

export interface JourneyEvent {
  readonly kind: EventKind;
  /** Which course this event acts on, when it acts on one. */
  readonly course?: string;
  /** One line: what the learner did, in the learner's terms. */
  readonly what: string;
  /** The invariant ids this event exists to exercise. */
  readonly invariants: readonly string[];
  /** Event-specific numbers, all named. */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export interface JourneyDay {
  readonly day: DayIndex;
  /** The local civil date this day is expected to be, before any zone effect. */
  readonly localDate: string;
  /** The zone in force for the whole of this local day. */
  readonly zone: string;
  /** Set when the learner travels at the start of this day. */
  readonly travelledFrom?: string;
  readonly events: readonly JourneyEvent[];
}

/* --------------------------------------------------------------- named config */

export const JOURNEY_START_LOCAL_DATE = '2026-09-20';
export const JOURNEY_DAYS = 30;
export const PRIMARY_COURSE = 'es';
export const SECOND_COURSE = 'fr';

export const ZONE_TOKYO = 'Asia/Tokyo';
export const ZONE_LOS_ANGELES = 'America/Los_Angeles';
export const ZONE_KIRITIMATI = 'Pacific/Kiritimati';
export const ZONE_LORD_HOWE = 'Australia/Lord_Howe';

/** The hour of the local day a lesson is normally taken. Far from both boundaries. */
export const USUAL_LESSON_HOUR = 19;

/* ------------------------------------------------------------------ the trace */

function day(
  index: DayIndex,
  localDate: string,
  zone: string,
  events: readonly JourneyEvent[],
  travelledFrom?: string,
): JourneyDay {
  return travelledFrom === undefined
    ? { day: index, localDate, zone, events }
    : { day: index, localDate, zone, events, travelledFrom };
}

/**
 * The trace. Read it top to bottom: it is the thirty days of one learner's life.
 */
export const JOURNEY: readonly JourneyDay[] = [
  day(1, '2026-09-20', ZONE_TOKYO, [
    {
      kind: 'install-course',
      course: PRIMARY_COURSE,
      what: 'installs Spanish and lands on the path (onboarding-equivalent state)',
      invariants: ['INV-PACK-01', 'INV-PATH-01'],
    },
    {
      kind: 'set-goal',
      course: PRIMARY_COURSE,
      what: 'picks the Regular goal, 20 XP',
      invariants: ['INV-ECO-01'],
      detail: { goal: 'regular', xp: 20 },
    },
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'first lesson, all correct: session generation, grading, the ceremony commit',
      invariants: ['INV-SESS-13', 'INV-GRD-01', 'INV-CER-01', 'INV-DAY-01'],
      detail: { correct: 10, wrong: 0 },
    },
  ]),
  day(2, '2026-09-21', ZONE_TOKYO, [
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'two lessons: the goal is met and the goal chest is granted once',
      invariants: ['INV-DAY-08', 'INV-ECO-01'],
      detail: { correct: 9, wrong: 1 },
    },
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'the second lesson of the day — the chest must not be granted twice',
      invariants: ['INV-DAY-08', 'INV-CER-02'],
      detail: { correct: 10, wrong: 0 },
    },
  ]),
  day(3, '2026-09-22', ZONE_TOKYO, [
    {
      kind: 'idle',
      what: 'a missed day, covered by a freeze owned before the day began',
      invariants: ['INV-FRZ-01', 'INV-FRZ-02', 'INV-DAY-05'],
      detail: { expectFreezeConsumed: 1 },
    },
  ]),
  day(4, '2026-09-23', ZONE_TOKYO, [
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'back the next day: the frozen day preserved the streak and did not increment it',
      invariants: ['INV-FRZ-02', 'INV-DAY-01'],
      detail: { correct: 8, wrong: 2 },
    },
  ]),
  day(5, '2026-09-24', ZONE_TOKYO, [
    {
      kind: 'buy-freeze',
      what: 'buys a Streak Freeze with gems, clamped to the cap',
      invariants: ['INV-FRZ-03', 'INV-FRZ-06', 'INV-ECO-13'],
    },
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'an ordinary lesson',
      invariants: ['INV-CER-01'],
      detail: { correct: 10, wrong: 0 },
    },
  ]),
  day(6, '2026-09-25', ZONE_TOKYO, [
    {
      kind: 'install-course',
      course: SECOND_COURSE,
      what: 'installs French: a second course, and the account region must not fork',
      invariants: ['INV-CER-03', 'INV-PER-03'],
    },
    {
      kind: 'lesson',
      course: SECOND_COURSE,
      what: 'first French lesson — course-scoped ceremony screens fire again, account-scoped do not',
      invariants: ['INV-CER-03', 'INV-ECO-13'],
      detail: { correct: 10, wrong: 0 },
    },
  ]),
  day(7, '2026-09-26', ZONE_TOKYO, [
    {
      kind: 'park-session',
      course: PRIMARY_COURSE,
      what: 'starts a Spanish lesson and walks away mid-queue',
      invariants: ['INV-SESS-01', 'INV-SESS-06'],
      detail: { stopAfter: 4 },
    },
    {
      kind: 'switch-course',
      course: SECOND_COURSE,
      what: 'switches to French with the Spanish session parked: the parked row survives',
      invariants: ['INV-SESS-07', 'INV-SESS-09'],
    },
    {
      kind: 'lesson',
      course: SECOND_COURSE,
      what: 'completes a French lesson while Spanish stays parked',
      invariants: ['INV-SESS-07', 'INV-CER-03'],
      detail: { correct: 9, wrong: 1 },
    },
  ]),
  day(
    8,
    '2026-09-27',
    ZONE_LOS_ANGELES,
    [
      {
        kind: 'resume-parked',
        course: PRIMARY_COURSE,
        what: 'flies Tokyo → Los Angeles and resumes the parked Spanish session',
        invariants: ['INV-DAY-02', 'INV-DAY-04', 'INV-SESS-01', 'INV-SESS-05', 'INV-SESS-08'],
      },
    ],
    ZONE_TOKYO,
  ),
  day(9, '2026-09-28', ZONE_LOS_ANGELES, [
    {
      kind: 'activate-boost',
      what: 'activates a 15-minute XP boost',
      invariants: ['INV-ECO-02'],
      detail: { minutes: 15, multiplier: 2 },
    },
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'a lesson finished inside the boost: the multiplier read at session start applies',
      invariants: ['INV-ECO-02'],
      detail: { correct: 10, wrong: 0, expectMultiplier: 2 },
    },
  ]),
  day(10, '2026-09-29', ZONE_LOS_ANGELES, [
    {
      kind: 'activate-boost',
      what: 'activates another boost and starts a lesson under it',
      invariants: ['INV-ECO-02'],
      detail: { minutes: 15, multiplier: 2 },
    },
    {
      kind: 'commit-after-boost-expiry',
      course: PRIMARY_COURSE,
      what: 'leaves the lesson open past the boost expiry plus boostGraceSeconds: commits at 1x',
      invariants: ['INV-ECO-02', 'INV-DAY-15'],
      detail: { correct: 10, wrong: 0, expectMultiplier: 1 },
    },
  ]),
  day(11, '2026-09-30', ZONE_LOS_ANGELES, [
    {
      kind: 'change-goal-mid-day',
      what: 'raises the daily goal from Regular (20) to Serious (30) after one lesson',
      invariants: ['INV-ECO-01', 'INV-DAY-08'],
      detail: { from: 'regular', to: 'serious' },
    },
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'a second lesson under the raised goal',
      invariants: ['INV-ECO-01'],
      detail: { correct: 10, wrong: 0 },
    },
  ]),
  day(12, '2026-10-01', ZONE_LOS_ANGELES, [
    {
      kind: 'idle',
      what: 'a missed day with no freeze left: the month has also rolled over',
      invariants: ['INV-DAY-16', 'INV-FRZ-01'],
      detail: { expectFreezeConsumed: 0 },
    },
  ]),
  day(13, '2026-10-02', ZONE_LOS_ANGELES, [
    {
      kind: 'idle',
      what: 'a second missed day: the streak breaks and the break is recorded as a fact',
      invariants: ['INV-DAY-06', 'INV-REC-06'],
    },
  ]),
  day(14, '2026-10-03', ZONE_LOS_ANGELES, [
    {
      kind: 'recovery-lesson',
      course: PRIMARY_COURSE,
      what: 'accepts the recovery challenge and completes 1 of 3 lessons',
      invariants: ['INV-REC-04', 'INV-REC-05', 'INV-REC-06'],
      detail: { lesson: 1, of: 3 },
    },
  ]),
  day(
    15,
    '2026-10-05',
    ZONE_KIRITIMATI,
    [
      {
        kind: 'recovery-lesson',
        course: PRIMARY_COURSE,
        what: 'flies Los Angeles → Kiritimati across the date line: 2026-10-04 is never lived',
        invariants: ['INV-DAY-03', 'INV-REC-04'],
        detail: { lesson: 2, of: 3, unlivedDate: '2026-10-04' },
      },
      {
        kind: 'recovery-lesson',
        course: PRIMARY_COURSE,
        what: 'the third recovery lesson inside the window: the streak is restored and today is satisfied',
        invariants: ['INV-REC-02', 'INV-REC-07'],
        detail: { lesson: 3, of: 3 },
      },
    ],
    ZONE_LOS_ANGELES,
  ),
  day(16, '2026-10-06', ZONE_KIRITIMATI, [
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'an ordinary day on the far side of the date line',
      invariants: ['INV-DAY-01'],
      detail: { correct: 9, wrong: 1 },
    },
  ]),
  day(17, '2026-10-07', ZONE_KIRITIMATI, [
    {
      kind: 'open-session-across-midnight',
      course: PRIMARY_COURSE,
      what: 'starts a lesson before midnight and is still in it after: rollover may defer, but is bounded',
      invariants: ['INV-DAY-09', 'INV-DAY-15', 'INV-DAY-04'],
      detail: { startHour: 23, minutesHeld: 40 },
    },
  ]),
  day(18, '2026-10-08', ZONE_KIRITIMATI, [
    {
      kind: 'lesson',
      course: SECOND_COURSE,
      what: 'a French lesson: the second course still has its own progress region',
      invariants: ['INV-PER-03', 'INV-CER-03'],
      detail: { correct: 10, wrong: 0 },
    },
  ]),
  day(19, '2026-10-09', ZONE_KIRITIMATI, [
    {
      kind: 'pack-major-bump',
      course: PRIMARY_COURSE,
      what: 'the Spanish pack updates across a major version: rows whose items are gone are quarantined',
      invariants: ['INV-PACK-01', 'INV-SCH-01'],
      detail: { from: '1.4.0', to: '2.0.0', quarantined: 3 },
    },
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'a lesson after the bump: quarantined rows are never scheduled',
      invariants: ['INV-SCH-01'],
      detail: { correct: 10, wrong: 0 },
    },
  ]),
  day(20, '2026-10-10', ZONE_KIRITIMATI, [
    {
      kind: 'idle',
      what: 'a missed day with no freezes: the streak breaks again, in October',
      invariants: ['INV-DAY-06'],
    },
  ]),
  day(21, '2026-10-11', ZONE_KIRITIMATI, [
    {
      kind: 'streak-repair',
      what: 'uses the monthly Streak Repair: streak = previous_streak, today still unsatisfied',
      invariants: ['INV-REC-01'],
      detail: { month: '2026-10', expectGranted: true },
    },
  ]),
  day(
    22,
    '2026-10-12',
    ZONE_LORD_HOWE,
    [
      {
        kind: 'streak-repair',
        what: 'flies to Lord Howe and tries a second repair in the same calendar month: refused',
        invariants: ['INV-REC-01'],
        detail: { month: '2026-10', expectGranted: false },
      },
      {
        kind: 'lesson',
        course: PRIMARY_COURSE,
        what: 'a lesson in a 30-minute-offset zone',
        invariants: ['INV-DAY-05', 'INV-DAY-17'],
        detail: { correct: 10, wrong: 0 },
      },
    ],
    ZONE_KIRITIMATI,
  ),
  day(23, '2026-10-13', ZONE_LORD_HOWE, [
    {
      kind: 'kill-and-resume',
      course: PRIMARY_COURSE,
      what: 'the process is killed at a pseudo-random instant inside a lesson and relaunched',
      invariants: ['INV-SESS-01', 'INV-SESS-04', 'INV-SESS-05', 'INV-SESS-10', 'INV-CER-01'],
    },
  ]),
  day(24, '2026-10-14', ZONE_LORD_HOWE, [
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'an ordinary lesson with two wrong answers, feeding the mistake queue',
      invariants: ['INV-MIS-01', 'INV-GRD-01'],
      detail: { correct: 8, wrong: 2 },
    },
  ]),
  day(25, '2026-10-15', ZONE_LORD_HOWE, [
    {
      kind: 'lesson',
      course: SECOND_COURSE,
      what: 'a French lesson: both courses are live at the end of the trace',
      invariants: ['INV-SESS-07'],
      detail: { correct: 9, wrong: 1 },
    },
  ]),
  day(26, '2026-10-16', ZONE_LORD_HOWE, [
    {
      kind: 'export-wipe-import',
      what: 'exports progress, wipes the device and imports it back: the ledger must survive verbatim',
      invariants: ['INV-DAT-01', 'INV-DAT-04', 'INV-PER-03'],
    },
  ]),
  day(27, '2026-10-17', ZONE_LORD_HOWE, [
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'the first lesson after the import: the restored state is usable, not merely readable',
      invariants: ['INV-DAT-01', 'INV-SESS-13'],
      detail: { correct: 10, wrong: 0 },
    },
  ]),
  day(28, '2026-10-18', ZONE_LORD_HOWE, [
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'an ordinary lesson',
      invariants: ['INV-DAY-01'],
      detail: { correct: 10, wrong: 0 },
    },
  ]),
  day(29, '2026-10-19', ZONE_LORD_HOWE, [
    {
      kind: 'lesson',
      course: SECOND_COURSE,
      what: 'an ordinary French lesson',
      invariants: ['INV-DAY-01'],
      detail: { correct: 10, wrong: 0 },
    },
  ]),
  day(30, '2026-10-20', ZONE_LORD_HOWE, [
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'the last day of the trace: the end-state ledger is asserted after this',
      invariants: ['INV-DAY-01', 'INV-ECO-13'],
      detail: { correct: 10, wrong: 0 },
    },
  ]),
];

/* ------------------------------------------------------------------- queries */

/** Every event kind the script uses, in first-appearance order. */
export function kindsInScript(script: readonly JourneyDay[] = JOURNEY): EventKind[] {
  const seen: EventKind[] = [];
  for (const d of script) {
    for (const event of d.events) if (!seen.includes(event.kind)) seen.push(event.kind);
  }
  return seen;
}

/** Every zone the script visits. */
export function zonesInScript(script: readonly JourneyDay[] = JOURNEY): string[] {
  return [...new Set(script.map((d) => d.zone))];
}

/** Every invariant id any event in the script names. */
export function invariantsInScript(script: readonly JourneyDay[] = JOURNEY): string[] {
  return [...new Set(script.flatMap((d) => d.events.flatMap((e) => [...e.invariants])))].sort();
}

/** Every course the script ever touches. */
export function coursesInScript(script: readonly JourneyDay[] = JOURNEY): string[] {
  return [
    ...new Set(
      script.flatMap((d) =>
        d.events.map((e) => e.course).filter((c): c is string => c !== undefined),
      ),
    ),
  ];
}
