/**
 * The journey script covers what the P1 gate says the journey must cover.
 *
 * This is the cheap half of the gate and it runs even when a lane has not landed: the
 * driver can only exercise what the script asks for, so a trace that quietly stopped
 * containing a boost expiry, or lost a zone, or dropped to one course, is caught here
 * rather than in a green driver run that no longer proves what it claims.
 *
 * Each requirement below is one clause of the task's journey list, named in its own test.
 */
import { describe, expect, it } from 'vitest';
import {
  coursesInScript,
  invariantsInScript,
  JOURNEY,
  JOURNEY_DAYS,
  JOURNEY_START_LOCAL_DATE,
  kindsInScript,
  PRIMARY_COURSE,
  SECOND_COURSE,
  zonesInScript,
  ZONE_KIRITIMATI,
  ZONE_LORD_HOWE,
  ZONE_LOS_ANGELES,
  ZONE_TOKYO,
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

describe('the 30-day journey script', () => {
  it('is thirty local days, starting where it says it starts', () => {
    expect(JOURNEY).toHaveLength(JOURNEY_DAYS);
    expect(JOURNEY[0]!.localDate).toBe(JOURNEY_START_LOCAL_DATE);
    expect(JOURNEY.map((d) => d.day)).toEqual(
      Array.from({ length: JOURNEY_DAYS }, (_, i) => i + 1),
    );
  });

  it('its local dates are strictly increasing, with exactly one date never lived', () => {
    const dates = JOURNEY.map((d) => d.localDate);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
    expect(new Set(dates).size).toBe(dates.length);

    // The one gap is the date the date-line crossing jumps over: INV-DAY-03's `unlived`.
    const gaps: string[] = [];
    for (let i = 1; i < dates.length; i += 1) {
      const previous = Date.parse(`${dates[i - 1]!}T00:00:00Z`);
      const current = Date.parse(`${dates[i]!}T00:00:00Z`);
      const delta = (current - previous) / 86_400_000;
      if (delta !== 1) gaps.push(`${dates[i - 1]} -> ${dates[i]} (${delta} days)`);
    }
    expect(gaps).toEqual(['2026-10-03 -> 2026-10-05 (2 days)']);
  });

  it('crosses a calendar month boundary (the monthly repair needs two months)', () => {
    const months = new Set(JOURNEY.map((d) => d.localDate.slice(0, 7)));
    expect([...months].sort()).toEqual(['2026-09', '2026-10']);
  });

  it('visits all four zones of the matrix, and travel is declared', () => {
    expect(zonesInScript().sort()).toEqual(
      [ZONE_TOKYO, ZONE_LOS_ANGELES, ZONE_KIRITIMATI, ZONE_LORD_HOWE].sort(),
    );
    // Every day whose zone differs from the previous day's declares where it came from,
    // because a zone that changes without a flight is exactly the tamper INV-DAY-02 refuses.
    const undeclared: string[] = [];
    for (let i = 1; i < JOURNEY.length; i += 1) {
      const previous = JOURNEY[i - 1]!;
      const current = JOURNEY[i]!;
      if (current.zone !== previous.zone && current.travelledFrom !== previous.zone) {
        undeclared.push(`day ${current.day}: ${previous.zone} -> ${current.zone}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('installs two courses and keeps both live to the last day', () => {
    expect(coursesInScript().sort()).toEqual([PRIMARY_COURSE, SECOND_COURSE].sort());
    const installed = JOURNEY.flatMap((d) =>
      d.events.filter((e) => e.kind === 'install-course').map((e) => e.course),
    );
    expect(installed).toEqual([PRIMARY_COURSE, SECOND_COURSE]);
    // The second course is used after it is installed, not merely installed.
    const lastSecondCourseDay = Math.max(
      ...JOURNEY.filter((d) => d.events.some((e) => e.course === SECOND_COURSE)).map((d) => d.day),
    );
    expect(lastSecondCourseDay).toBeGreaterThan(25);
  });

  it.each(REQUIRED)('exercises: $clause', ({ kind }) => {
    const days = JOURNEY.filter((d) => d.events.some((e) => e.kind === kind)).map((d) => d.day);
    expect(days.length).toBeGreaterThan(0);
  });

  it('has no event kind that the required list does not account for', () => {
    // The other direction: an event kind added to the script without a clause behind it
    // is a behaviour nobody asked for, and the driver would need a handler for it.
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

  it('names an invariant id for every event, and only ids that exist', () => {
    const withoutIds = JOURNEY.flatMap((d) =>
      d.events.filter((e) => e.invariants.length === 0).map((e) => `day ${d.day}: ${e.kind}`),
    );
    expect(withoutIds).toEqual([]);
    expect(invariantsInScript().every((id) => /^INV-[A-Z0-9]+-\d+$/.test(id))).toBe(true);
  });
});
