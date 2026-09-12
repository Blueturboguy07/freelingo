/**
 * The journey script covers what the P1 gate says the journey must cover.
 *
 * This is the cheap half of the gate and it runs even when a lane has not landed: the
 * driver can only exercise what the script asks for, so a trace that quietly stopped
 * containing a boost expiry, or lost a zone, or dropped to one course, is caught here
 * rather than in a green driver run that no longer proves what it claims.
 *
 * The zone arithmetic is asserted against the real `Intl` tz database rather than trusted
 * to the header, because the first version of this trace claimed a Los Angeles →
 * Kiritimati flight deleted a civil date. It does not: that jump is 21 hours and deleting
 * a date needs more than 24. The assertions below would have caught it.
 */
import { describe, expect, it } from 'vitest';
import {
  coursesInScript,
  invariantsInScript,
  JOURNEY,
  JOURNEY_DAYS,
  JOURNEY_END_LOCAL_DATE,
  JOURNEY_START_LOCAL_DATE,
  kindsInScript,
  MATRIX_ZONES,
  PRIMARY_COURSE,
  SECOND_COURSE,
  UNLIVED_DATE,
  ZONE_MIDWAY,
  zonesInScript,
  type EventKind,
} from './script.js';

/** The task's journey clauses, each mapped to the event kind that realises it. */
const REQUIRED: readonly { readonly clause: string; readonly kind: EventKind }[] = [
  { clause: 'onboarding-equivalent state (a course is installed)', kind: 'install-course' },
  { clause: 'session generation, grading and the ceremony commit', kind: 'lesson' },
  { clause: 'a missed day', kind: 'idle' },
  { clause: 'a recovery challenge', kind: 'recovery-lesson' },
  { clause: 'a monthly Streak Repair', kind: 'streak-repair' },
  { clause: 'a goal change mid-day', kind: 'change-goal-mid-day' },
  { clause: 'a course switch with a parked session', kind: 'switch-course' },
  { clause: 'a boost that expires past boostGraceSeconds', kind: 'commit-after-boost-expiry' },
  { clause: 'a kill-and-resume at a random instant', kind: 'kill-and-resume' },
  { clause: 'a pack major bump with quarantined rows', kind: 'pack-major-bump' },
  { clause: 'an export -> wipe -> import round trip', kind: 'export-wipe-import' },
  {
    clause: 'a session left open across the day boundary (bounded rollover)',
    kind: 'open-session-across-midnight',
  },
];

/** The civil date an instant falls on in a zone, straight from the tz database. */
function civilDate(instantIso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instantIso));
}

describe('the 30-day journey script', () => {
  it('is thirty local days, starting and ending where it says it does', () => {
    expect(JOURNEY).toHaveLength(JOURNEY_DAYS);
    expect(JOURNEY[0]!.localDate).toBe(JOURNEY_START_LOCAL_DATE);
    expect(JOURNEY[JOURNEY_DAYS - 1]!.localDate).toBe(JOURNEY_END_LOCAL_DATE);
    expect(JOURNEY.map((d) => d.day)).toEqual(
      Array.from({ length: JOURNEY_DAYS }, (_, i) => i + 1),
    );
  });

  it('its local dates are strictly increasing, with exactly one date never lived', () => {
    const dates = JOURNEY.map((d) => d.localDate);
    expect(dates).toEqual([...dates].sort());
    expect(new Set(dates).size).toBe(dates.length);

    const gaps: string[] = [];
    for (let i = 1; i < dates.length; i += 1) {
      const delta =
        (Date.parse(`${dates[i]!}T00:00:00Z`) - Date.parse(`${dates[i - 1]!}T00:00:00Z`)) /
        86_400_000;
      if (delta !== 1) gaps.push(`${dates[i - 1]} -> ${dates[i]} (${delta} days)`);
    }
    expect(gaps).toEqual(['2026-10-04 -> 2026-10-06 (2 days)']);
    expect(dates).not.toContain(UNLIVED_DATE);
  });

  it('the flight that deletes a civil date really deletes it, per the tz database', () => {
    const arrival = JOURNEY.find((d) => d.travelledFrom === ZONE_MIDWAY)!;
    expect(arrival.travelAtUtc).toBeDefined();
    const before = civilDate(arrival.travelAtUtc!, arrival.travelledFrom!);
    const after = civilDate(arrival.travelAtUtc!, arrival.zone);
    // 2026-10-04 in Midway, 2026-10-06 in Kiritimati: 2026-10-05 is strictly between and
    // is therefore never lived. This is the assertion the first draft of the trace failed.
    expect(before).toBe('2026-10-04');
    expect(after).toBe('2026-10-06');
    expect(UNLIVED_DATE > before && UNLIVED_DATE < after).toBe(true);
  });

  it('every flight is classified: one deletes a date, one runs the day backwards, none else', () => {
    const classified: string[] = [];
    for (const d of JOURNEY) {
      if (d.travelledFrom === undefined) continue;
      const before = civilDate(d.travelAtUtc!, d.travelledFrom);
      const after = civilDate(d.travelAtUtc!, d.zone);
      const delta =
        (Date.parse(`${after}T00:00:00Z`) - Date.parse(`${before}T00:00:00Z`)) / 86_400_000;
      // delta < 0: the local date went backwards — a travel regression, honoured only
      //            because the zone changed (INV-DAY-02). It deletes nothing.
      // delta 0/1: an ordinary crossing.
      // delta > 1: delta - 1 civil dates were deleted and are unlived (INV-DAY-03).
      const kind = delta < 0 ? 'regression' : delta > 1 ? `deletes ${delta - 1}` : 'ordinary';
      classified.push(
        `day ${d.day} ${d.travelledFrom} -> ${d.zone}: ${before} -> ${after} (${kind})`,
      );
      // A flight always lands inside its own local day, at or before the noon the driver
      // takes its readings at.
      expect(Date.parse(d.travelAtUtc!)).toBeLessThan(
        Date.parse(`${d.localDate}T12:00:00Z`) + 15 * 3_600_000,
      );
    }
    expect(classified.filter((line) => line.includes('deletes'))).toHaveLength(1);
    expect(classified.filter((line) => line.includes('regression'))).toHaveLength(1);
    expect(classified).toHaveLength(4);
  });

  it('crosses a calendar month boundary (the monthly repair needs two months)', () => {
    expect([...new Set(JOURNEY.map((d) => d.localDate.slice(0, 7)))].sort()).toEqual([
      '2026-09',
      '2026-10',
    ]);
  });

  it('visits all four zones of the matrix, and the only extra zone is the declared stopover', () => {
    const visited = zonesInScript();
    for (const zone of MATRIX_ZONES) expect(visited).toContain(zone);
    expect(visited.filter((z) => !MATRIX_ZONES.includes(z))).toEqual([ZONE_MIDWAY]);
  });

  it('declares where every zone change came from', () => {
    const undeclared: string[] = [];
    for (let i = 1; i < JOURNEY.length; i += 1) {
      const previous = JOURNEY[i - 1]!;
      const current = JOURNEY[i]!;
      if (current.zone !== previous.zone && current.travelledFrom !== previous.zone) {
        undeclared.push(`day ${current.day}: ${previous.zone} -> ${current.zone}`);
      }
      if (current.zone === previous.zone && current.travelledFrom !== undefined) {
        undeclared.push(`day ${current.day}: declares travel but the zone did not change`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('installs two courses and keeps both live to the last week', () => {
    expect(coursesInScript().sort()).toEqual([PRIMARY_COURSE, SECOND_COURSE].sort());
    const installed = JOURNEY.flatMap((d) =>
      d.events.filter((e) => e.kind === 'install-course').map((e) => e.course),
    );
    expect(installed).toEqual([PRIMARY_COURSE, SECOND_COURSE]);
    const lastSecondCourseDay = Math.max(
      ...JOURNEY.filter((d) => d.events.some((e) => e.course === SECOND_COURSE)).map((d) => d.day),
    );
    expect(lastSecondCourseDay).toBeGreaterThan(25);
  });

  it.each(REQUIRED)('exercises: $clause', ({ kind }) => {
    expect(JOURNEY.filter((d) => d.events.some((e) => e.kind === kind)).length).toBeGreaterThan(0);
  });

  it('has no event kind that the required list does not account for', () => {
    const accountedFor = new Set<EventKind>([
      ...REQUIRED.map((r) => r.kind),
      'set-goal',
      'park-session',
      'resume-parked',
      'buy-freeze',
      'activate-boost',
    ]);
    expect(kindsInScript().filter((kind) => !accountedFor.has(kind))).toEqual([]);
  });

  it('parks a session on one course and switches to the other before resuming it', () => {
    const parkDay = JOURNEY.find((d) => d.events.some((e) => e.kind === 'park-session'))!;
    const switchEvent = parkDay.events.find((e) => e.kind === 'switch-course')!;
    const resumeDay = JOURNEY.find((d) => d.events.some((e) => e.kind === 'resume-parked'))!;
    expect(parkDay.events.find((e) => e.kind === 'park-session')!.course).toBe(PRIMARY_COURSE);
    expect(switchEvent.course).toBe(SECOND_COURSE);
    expect(resumeDay.day).toBeGreaterThan(parkDay.day);
    // The resume happens after a zone change, so the parked row survives travel too.
    expect(resumeDay.travelledFrom).toBeDefined();
  });

  it('spends every freeze it owns before the day it expects a break', () => {
    // The arithmetic in the script header, asserted: 2 owned + 1 bought = 3 grants, and
    // exactly 3 idle days are expected to consume one. A trace that quietly gained a
    // fourth freeze would never break the streak, and the recovery half would go untested.
    const idleDays = JOURNEY.filter((d) => d.events.some((e) => e.kind === 'idle'));
    const covered = idleDays.filter((d) =>
      d.events.some((e) => e.detail?.['expectFreezeConsumed'] === 1),
    );
    const uncovered = idleDays.filter((d) =>
      d.events.some((e) => e.detail?.['expectFreezeConsumed'] === 0),
    );
    expect(covered).toHaveLength(3);
    expect(uncovered).toHaveLength(2);
    expect(JOURNEY.filter((d) => d.events.some((e) => e.kind === 'buy-freeze'))).toHaveLength(1);
    // Both breaks come before a restore that needs them.
    const firstRecovery = JOURNEY.find((d) => d.events.some((e) => e.kind === 'recovery-lesson'))!;
    const firstRepair = JOURNEY.find((d) => d.events.some((e) => e.kind === 'streak-repair'))!;
    expect(uncovered[0]!.day).toBeLessThan(firstRecovery.day);
    expect(uncovered[1]!.day).toBeLessThan(firstRepair.day);
  });

  it('names an invariant id for every event, and only well-formed ids', () => {
    const withoutIds = JOURNEY.flatMap((d) =>
      d.events.filter((e) => e.invariants.length === 0).map((e) => `day ${d.day}: ${e.kind}`),
    );
    expect(withoutIds).toEqual([]);
    expect(invariantsInScript().every((id) => /^INV-[A-Z0-9]+-\d+$/.test(id))).toBe(true);
  });
});
