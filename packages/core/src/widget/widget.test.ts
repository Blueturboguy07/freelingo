import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  renderWidget,
  widgetDeepLink,
  widgetTimeline,
  planWidgetReload,
  type WidgetSnapshot,
} from './index.js';

const base: WidgetSnapshot = {
  initialized: true,
  local_day: '2026-09-13',
  computed_at_utc: '2026-09-13T00:00:00Z',
  tz_id: 'UTC',
  day_boundary_utc: '2026-09-14T00:00:00Z',
  streak: 12,
  last_completed_local_day: '2026-09-12',
  freezes_owned: 0,
  previous_day_disposition: 'completed',
  streak_extended_today: false,
  goal_met: false,
  earned_xp: 0,
  goal_xp: 40,
  lifetime_sessions: 12,
  active_course_id: 'es',
  active_node_id: 'unit-1/lesson-2',
  has_resumable_session: false,
  equipped_cosmetic_id: null,
};
const draw = (
  overrides: Partial<WidgetSnapshot> = {},
  time = '2026-09-13T19:00:00Z',
  zone = 'UTC',
) => renderWidget({ ...base, ...overrides }, Date.parse(time), zone);

describe('widget state and snapshot boundaries', () => {
  it('[INV-WID-10] absent, uninitialized, stale and malformed snapshots render no numeral or flame', () => {
    for (const snapshot of [
      null,
      {},
      { ...base, initialized: false },
      { ...base, local_day: '2026-09-12' },
      { ...base, streak: NaN },
      { ...base, streak: -1 },
      { ...base, computed_at_utc: 'tomorrow' },
    ]) {
      const result = renderWidget(snapshot, Date.parse('2026-09-13T19:00:00Z'), 'UTC');
      expect(result.state).toBe('UNKNOWN');
      expect(result.streak).toBeNull();
      expect(result.flame).toBe('none');
      expect(result.copy).toBe('Open Freelingo');
    }
  });

  it('[INV-WID-05] a real initialized account with no history is cold rather than zero streak', () => {
    const result = draw({ lifetime_sessions: 0, streak: 0, last_completed_local_day: null });
    expect(result.state).toBe('COLD');
    expect(result.copy).toBe('Tap to start');
    expect(result.streak).toBeNull();
  });

  it('[INV-WID-06] the 18–20 hour gap has an evening state and every threshold is closed', () => {
    const witnesses = [
      [11, 'IDLE_MORNING'],
      [12, 'IDLE_AFTERNOON'],
      [18, 'IDLE_EVENING'],
      [19, 'IDLE_EVENING'],
      [20, 'NUDGE'],
      [22, 'NUDGE'],
      [23, 'DANGER'],
    ] as const;
    for (const [hour, expected] of witnesses) {
      expect(draw({}, `2026-09-13T${hour}:00:00Z`).state).toBe(expected);
    }
    expect(draw({ goal_met: true, streak_extended_today: true }).state).toBe('DONE');
    expect(draw({ streak: 0, previous_day_disposition: 'missed' }).state).toBe('LOST');
    expect(
      draw({ previous_day_disposition: 'frozen', freezes_owned: 0 }, '2026-09-13T09:00:00Z').state,
    ).toBe('FROZEN');
  });

  it('[INV-WID-08] any completed lesson keeps the streak safe even below the XP goal', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 39 }),
        fc.integer({ min: 0, max: 1439 }),
        (xp, minute) => {
          const result = renderWidget(
            { ...base, earned_xp: xp, streak_extended_today: true },
            Date.parse('2026-09-13T00:00:00Z') + minute * 60_000,
            'UTC',
          );
          expect(result.state).toBe('STREAK_SAFE_GOAL_UNMET');
          expect(result.copy).toContain('Streak safe');
          expect(result.copy).not.toMatch(/lost|reset|extend/);
          expect(result.flame).toBe('lit');
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-WID-03] draw-time remaining follows the current zone, including DST and half-hour changes', () => {
    const cases = [
      ['America/Los_Angeles', '2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z', '2026-03-08'],
      ['America/Los_Angeles', '2026-11-01T07:00:00Z', '2026-11-02T08:00:00Z', '2026-11-01'],
      ['Australia/Lord_Howe', '2026-10-03T13:30:00Z', '2026-10-04T13:00:00Z', '2026-10-04'],
      ['Pacific/Kiritimati', '2026-09-12T10:00:00Z', '2026-09-13T10:00:00Z', '2026-09-13'],
    ] as const;
    for (const [zone, start, end, day] of cases) {
      const result = renderWidget(
        { ...base, local_day: day, computed_at_utc: start, last_completed_local_day: null },
        Date.parse(start),
        zone,
      );
      expect(result.remainingMinutes).toBe((Date.parse(end) - Date.parse(start)) / 60_000);
    }
    // Fly from Tokyo to Los Angeles while both zones still display the same civil day.
    const flown = draw(
      { tz_id: 'Asia/Tokyo', day_boundary_utc: '2026-09-13T15:00:00Z' },
      '2026-09-13T11:00:00Z',
      'America/Los_Angeles',
    );
    expect(flown.remainingMinutes).toBe(20 * 60);
    expect(flown.state).toBe('IDLE_MORNING');
  });

  it('[INV-WID-03] throttled post-midnight entries become neutral rather than showing yesterday’s countdown', () => {
    expect(renderWidget(base, Date.parse('2026-09-14T01:00:00Z'), 'UTC').state).toBe('UNKNOWN');
  });

  it('[INV-WID-02][INV-WID-09] links encode the snapshot course and select resume before node before practice without mutation', () => {
    const state = { ...base, active_course_id: 'es & ja', active_node_id: 'unit/3?x=1' };
    const original = JSON.stringify(state);
    const resume = new URL(
      widgetDeepLink({ ...state, has_resumable_session: true, goal_met: true }),
    );
    expect(resume.hostname).toBe('resume');
    expect(resume.searchParams.get('course')).toBe('es & ja');
    const active = new URL(widgetDeepLink(state));
    expect(active.hostname).toBe('path');
    expect(active.searchParams.get('node')).toBe('unit/3?x=1');
    expect(new URL(widgetDeepLink({ ...state, goal_met: true })).hostname).toBe('practice');
    expect(JSON.stringify(state)).toBe(original);
  });

  it('[INV-WID-06] timeline entries include the missing 18:00 transition and every countdown threshold', () => {
    const entries = widgetTimeline(base, Date.parse('2026-09-13T06:00:00Z'), 'UTC');
    const iso = entries.map((entry) => new Date(entry.atMs).toISOString().slice(11, 16));
    for (const time of [
      '12:00',
      '18:00',
      '20:00',
      '21:00',
      '22:00',
      '23:00',
      '23:15',
      '23:30',
      '23:45',
      '00:00',
    ]) {
      expect(iso).toContain(time);
    }
    expect(entries.find((entry) => new Date(entry.atMs).getUTCHours() === 18)?.render.state).toBe(
      'IDLE_EVENING',
    );
    expect(entries.at(-1)?.render.state).toBe('UNKNOWN');
  });

  it('[INV-WID-04] bursts coalesce to state changes and never exceed the 15 minute or daily budget', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 86_399_999 }), { minLength: 1, maxLength: 100 }),
        (offsets) => {
          let budget = {
            localDay: '2026-09-13',
            lastReloadAtMs: null as number | null,
            reloadCount: 0,
            pendingKey: null as string | null,
            lastRenderedKey: null as string | null,
          };
          const times = offsets.sort((a, b) => a - b);
          const reloads: number[] = [];
          for (const [index, now] of times.entries()) {
            const result = planWidgetReload(budget, `state-${index}`, now, '2026-09-13');
            budget = result.budget;
            if (result.reload) reloads.push(now);
          }
          expect(reloads.length).toBeLessThanOrEqual(40);
          for (let i = 1; i < reloads.length; i++)
            expect(reloads[i]! - reloads[i - 1]!).toBeGreaterThanOrEqual(15 * 60_000);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

it('[INV-WID-06] yesterday’s consumed freeze cannot hide tonight’s unprotected streak', () => {
  const facts = {
    previous_day_disposition: 'frozen' as const,
    last_completed_local_day: '2026-09-11',
    freezes_owned: 0,
  };
  expect(draw(facts, '2026-09-13T09:00:00Z').copy).toContain('yesterday');
  expect(draw(facts, '2026-09-13T23:30:00Z').state).toBe('DANGER');
});
it('[INV-WID-06] an available freeze prevents unprotected-loss copy for the current day', () => {
  expect(draw({ freezes_owned: 1 }, '2026-09-13T23:30:00Z').state).toBe('FROZEN');
  expect(draw({ freezes_owned: 1 }, '2026-09-13T23:30:00Z').copy).not.toContain('streak is lost');
});
