/**
 * The 30-day, two-course, four-zone journey — as data.
 *
 * Plan §Phases, P4 gate: *"Headless 30-day journey in packages/core across two courses
 * and four zones"*, brought forward to the P1 gate because P1 is where the engine that
 * has to survive it is written. One learner, thirty simulated local days, two installed
 * courses and the four-zone matrix, driven on the testkit virtual clock.
 *
 * The script is separated from the driver on purpose. A journey written as three hundred
 * lines of imperative test body is unreviewable — nobody can answer "does this actually
 * exercise a boost that expires past the grace window?" by reading it, and a driver bug
 * that silently skips a day looks exactly like a passing test. Here the trace is a value:
 * every day names its zone, its events, and the invariant ids each event is there to
 * exercise, so `script.test.ts` can assert *about the script* (that every required
 * behaviour appears, that every zone is visited, that the clauses the P1 gate enumerates
 * are all present) before anything is asserted about the engine.
 *
 * ## The calendar
 *
 * Day 1 is 2026-09-20 local; day 30 is 2026-10-20. That is 31 calendar dates for 30 lived
 * days, because **2026-10-05 is never lived** (below). The month boundary inside the trace
 * is required: the monthly Streak Repair is idempotent on `(year, month)` (INV-REC-01) and
 * a trace inside one month can only ever prove half of that.
 *
 * ## The zones, and the arithmetic that fixed this trace once already
 *
 * The matrix is `packages/testkit/src/zones.ts`. The flights are chosen for what each
 * crossing does to the civil date, not for plausibility:
 *
 * | day | from → to | what it proves |
 * |---|---|---|
 * | 8 | Asia/Tokyo (+9) → America/Los_Angeles (−7) | −16 h: the local day goes BACKWARDS while UTC advances. Honoured, because the zone changed (INV-DAY-02); a clock change with no zone change must be refused. |
 * | 15 | America/Los_Angeles (−7) → Pacific/Midway (−11) | −4 h. A stopover, and the only reason it exists is the next row. |
 * | 16 | Pacific/Midway (−11) → Pacific/Kiritimati (+14) | **+25 h**: 2026-10-05 is deleted from the learner's life. `unlived` — not missed, consumes no freeze, is not a gap (INV-DAY-03). |
 * | 22 | Pacific/Kiritimati (+14) → Australia/Lord_Howe (+11) | −3 h into the only 30-minute-offset zone on earth: day arithmetic that is not a whole number of hours (INV-DAY-05). |
 *
 * **Why Midway is in a four-zone trace.** The first draft flew Los Angeles → Kiritimati
 * and claimed it skipped a civil date. It does not, and the gate would have asserted a
 * behaviour that cannot happen. Measured 2026-10 offsets: LA is −7, Kiritimati +14, so the
 * jump is 21 hours — the local date advances by exactly one, whenever the flight departs.
 * Deleting a whole civil date needs a forward jump of **more than 24 hours**, which in this
 * matrix is only reachable by arriving in Kiritimati from a zone at −11 or further west.
 * Hence the stopover. Verified: at `2026-10-05T10:00:00Z` Midway reads 2026-10-04 and
 * Kiritimati reads 2026-10-06.
 *
 * A travel day therefore declares `travelAtUtc`: **when** the zone changed decides which
 * dates are skipped, and an instant picked by the driver rather than the trace would make
 * the unlived date an accident of the driver's default hour.
 */

/** A journey day's index, 1-based. */
export type DayIndex = number;

/**
 * What happens on a day. One kind per behaviour the P1 gate names; the driver has one
 * handler per kind and `script.test.ts` asserts that every kind is accounted for, so a
 * kind that no longer has a handler cannot be quietly dropped.
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
  /** The local civil date this day is. */
  readonly localDate: string;
  /** The zone in force for the whole of this local day. */
  readonly zone: string;
  /** Set when the learner travelled into this day's zone. */
  readonly travelledFrom?: string;
  /** The UTC instant the zone changed. Declared, because it decides what is skipped. */
  readonly travelAtUtc?: string;
  readonly events: readonly JourneyEvent[];
}

/* --------------------------------------------------------------- named config */

export const JOURNEY_START_LOCAL_DATE = '2026-09-20';
export const JOURNEY_END_LOCAL_DATE = '2026-10-20';
export const JOURNEY_DAYS = 30;
export const PRIMARY_COURSE = 'es';
export const SECOND_COURSE = 'fr';

export const ZONE_TOKYO = 'Asia/Tokyo';
export const ZONE_LOS_ANGELES = 'America/Los_Angeles';
export const ZONE_KIRITIMATI = 'Pacific/Kiritimati';
export const ZONE_LORD_HOWE = 'Australia/Lord_Howe';
/**
 * The stopover. NOT part of the four-zone property matrix — it is in this trace for one
 * reason, stated in the header: no pair of matrix zones can delete a civil date.
 */
export const ZONE_MIDWAY = 'Pacific/Midway';

/** The four zones every day/streak property runs in (plan §Verification). */
export const MATRIX_ZONES: readonly string[] = [
  ZONE_TOKYO,
  ZONE_LOS_ANGELES,
  ZONE_KIRITIMATI,
  ZONE_LORD_HOWE,
];

/** The civil date the day-16 crossing deletes. */
export const UNLIVED_DATE = '2026-10-05';

/** The hour of the local day a lesson is normally taken. Far from both boundaries. */
export const USUAL_LESSON_HOUR = 19;

/* ------------------------------------------------------------------ the trace */

function day(
  index: DayIndex,
  localDate: string,
  zone: string,
  events: readonly JourneyEvent[],
  travel?: { readonly from: string; readonly atUtc: string },
): JourneyDay {
  return travel === undefined
    ? { day: index, localDate, zone, events }
    : {
        day: index,
        localDate,
        zone,
        events,
        travelledFrom: travel.from,
        travelAtUtc: travel.atUtc,
      };
}

/**
 * The trace. Read it top to bottom: it is thirty days of one learner's life.
 *
 * The freeze arithmetic, because it is what makes the two breaks happen at all: the
 * account starts with 2 freezes owned from day 1 and the cap is 2. Day 3 spends one
 * (held 1); day 5 buys one back (held 2); days 12 and 13 spend both (held 0); day 14 is
 * therefore uncovered and BREAKS the streak, which arms the recovery challenge. Day 20 is
 * missed with nothing left and breaks it a second time, which is what the monthly Streak
 * Repair on day 21 is for.
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
      what: 'the first of two lessons: the goal is met and the goal chest is granted once',
      invariants: ['INV-DAY-08', 'INV-ECO-01'],
      detail: { correct: 9, wrong: 1 },
    },
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'the second lesson of the same day — the chest must not be granted twice',
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
        what: 'flies Tokyo → Los Angeles (the local day goes backwards) and resumes the parked session',
        invariants: ['INV-DAY-02', 'INV-DAY-04', 'INV-SESS-01', 'INV-SESS-05', 'INV-SESS-08'],
      },
    ],
    { from: ZONE_TOKYO, atUtc: '2026-09-27T06:00:00Z' },
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
      what: 'leaves the lesson parked past the boost expiry plus boostGraceSeconds: commits at 1x',
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
      what: 'a second lesson under the raised goal, on the last day of September',
      invariants: ['INV-ECO-01', 'INV-DAY-16'],
      detail: { correct: 10, wrong: 0 },
    },
  ]),
  day(12, '2026-10-01', ZONE_LOS_ANGELES, [
    {
      kind: 'idle',
      what: 'a missed day in a new month, covered by the first of the two held freezes',
      invariants: ['INV-DAY-16', 'INV-FRZ-01'],
      detail: { expectFreezeConsumed: 1 },
    },
  ]),
  day(13, '2026-10-02', ZONE_LOS_ANGELES, [
    {
      kind: 'idle',
      what: 'a second missed day, covered by the last freeze: the balance is now zero',
      invariants: ['INV-FRZ-01', 'INV-FRZ-02'],
      detail: { expectFreezeConsumed: 1 },
    },
  ]),
  day(14, '2026-10-03', ZONE_LOS_ANGELES, [
    {
      kind: 'idle',
      what: 'a third missed day with nothing left to cover it: the streak breaks, recorded as a fact',
      invariants: ['INV-DAY-06', 'INV-REC-06'],
      detail: { expectFreezeConsumed: 0 },
    },
  ]),
  day(
    15,
    '2026-10-04',
    ZONE_MIDWAY,
    [
      {
        kind: 'recovery-lesson',
        course: PRIMARY_COURSE,
        what: 'flies to Midway and takes the first of three recovery lessons, inside the 2-day window',
        invariants: ['INV-REC-04', 'INV-REC-05', 'INV-REC-06'],
        detail: { lesson: 1, of: 3 },
      },
      {
        kind: 'recovery-lesson',
        course: PRIMARY_COURSE,
        what: 'the second recovery lesson: partial progress is persisted like any other session',
        invariants: ['INV-REC-03', 'INV-REC-05'],
        detail: { lesson: 2, of: 3 },
      },
      {
        kind: 'recovery-lesson',
        course: PRIMARY_COURSE,
        what: 'the third: the streak is restored and today is marked satisfied',
        invariants: ['INV-REC-02', 'INV-REC-07'],
        detail: { lesson: 3, of: 3 },
      },
    ],
    { from: ZONE_LOS_ANGELES, atUtc: '2026-10-04T18:00:00Z' },
  ),
  day(
    16,
    '2026-10-06',
    ZONE_KIRITIMATI,
    [
      {
        kind: 'lesson',
        course: PRIMARY_COURSE,
        what: 'flies Midway → Kiritimati (+25 h): 2026-10-05 is deleted, and is unlived, not missed',
        invariants: ['INV-DAY-03', 'INV-DAY-05'],
        detail: { correct: 9, wrong: 1, unlivedDate: UNLIVED_DATE },
      },
    ],
    { from: ZONE_MIDWAY, atUtc: '2026-10-05T10:00:00Z' },
  ),
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
      invariants: ['INV-PACK-01', 'INV-PACK-35', 'INV-SCH-01'],
      detail: { from: '1.4.0', to: '2.0.0', quarantined: 3 },
    },
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'a lesson after the bump: a quarantined row is never scheduled',
      invariants: ['INV-SCH-01'],
      detail: { correct: 10, wrong: 0 },
    },
  ]),
  day(20, '2026-10-10', ZONE_KIRITIMATI, [
    {
      kind: 'idle',
      what: 'a missed day with no freezes left: the streak breaks a second time, in October',
      invariants: ['INV-DAY-06'],
      detail: { expectFreezeConsumed: 0 },
    },
  ]),
  day(21, '2026-10-11', ZONE_KIRITIMATI, [
    {
      kind: 'streak-repair',
      what: "uses October's Streak Repair: streak = previous_streak, today still unsatisfied",
      invariants: ['INV-REC-01'],
      // The ONE day of the trace that ends unsatisfied on purpose. That is the whole
      // difference between the repair and the challenge (EC-FRZ-13), and it is what gives
      // day 22 a live break to refuse a second repair against.
      detail: { month: '2026-10', expectGranted: true, leavesTodayUnsatisfied: true },
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
        // There IS a break to repair on this day: day 21's repair left today unsatisfied
        // (that is the whole difference between the repair and the challenge), so 10-11
        // rolls over missed and breaks the streak again. Without a live break the refusal
        // would be "no-break" and the trace would prove nothing about the monthly cap —
        // hence `expectDeclinedBecause`.
        detail: {
          month: '2026-10',
          expectGranted: false,
          expectDeclinedBecause: 'month-already-repaired',
        },
      },
      {
        kind: 'lesson',
        course: PRIMARY_COURSE,
        what: 'a lesson in a 30-minute-offset zone',
        invariants: ['INV-DAY-05', 'INV-DAY-17'],
        detail: { correct: 10, wrong: 0 },
      },
    ],
    { from: ZONE_KIRITIMATI, atUtc: '2026-10-11T20:00:00Z' },
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
    {
      kind: 'lesson',
      course: PRIMARY_COURSE,
      what: 'and then practises: a day spent moving data is still a day the learner showed up',
      invariants: ['INV-DAT-01'],
      detail: { correct: 10, wrong: 0 },
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
