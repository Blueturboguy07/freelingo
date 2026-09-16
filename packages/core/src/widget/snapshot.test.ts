import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { renderWidget, widgetDeepLink } from './index.js';
import {
  parseSharedWidgetSnapshot,
  projectWidgetSnapshot,
  type WidgetAccountRead,
} from './snapshot.js';
import { parseWidgetRoute } from './route.js';

const now = Date.parse('2026-09-13T23:30:00Z');
const known: WidgetAccountRead = {
  kind: 'known',
  localDay: '2026-09-13',
  streak: 12,
  lastCompletedLocalDay: '2026-09-13',
  freezesOwned: 0,
  previousDayDisposition: 'completed',
  streakExtendedToday: true,
  earnedXp: 13,
  goalXp: 40,
  goalMet: false,
  lifetimeSessions: 12,
  course: { courseId: 'en-es', activeNodeId: 'u1/l2', hasResumableSession: false },
  equippedCosmeticId: null,
};
const clock = { nowMs: now, zone: 'UTC' };

describe('snapshot-only widget source projection', () => {
  it('[INV-WID-01][INV-WID-08] projects the committed split streak/goal facts without inferring goal from a lesson', () => {
    const result = projectWidgetSnapshot(known, clock);
    expect(result.kind).toBe('snapshot');
    if (result.kind !== 'snapshot') throw new Error('known source');
    expect(result.snapshot.streak_extended_today).toBe(true);
    expect(result.snapshot.goal_met).toBe(false);
    expect(renderWidget(result.snapshot, now, 'UTC').state).toBe('STREAK_SAFE_GOAL_UNMET');
    expect(JSON.parse(JSON.stringify(result.snapshot))).toEqual(result.snapshot);
  });
  it('[INV-WID-05][INV-WID-10] unknown history is neutral even when stored counters happen to be zero', () => {
    for (const reason of ['unknown-history', 'unavailable', 'rollover-pending'] as const) {
      const result = projectWidgetSnapshot({ kind: 'unavailable', reason }, clock);
      expect(result.kind).toBe('unknown');
      expect(renderWidget(null, now, 'UTC').streak).toBeNull();
    }
    const cold = projectWidgetSnapshot(
      {
        ...known,
        streak: 0,
        lastCompletedLocalDay: null,
        streakExtendedToday: false,
        earnedXp: 0,
        lifetimeSessions: 0,
      },
      clock,
    );
    expect(cold.kind === 'snapshot' && renderWidget(cold.snapshot, now, 'UTC').state).toBe('COLD');
  });
  it('[INV-WID-10] rejects stale, malformed and unknown-field shared records rather than repairing them', () => {
    const result = projectWidgetSnapshot(known, clock);
    if (result.kind !== 'snapshot') throw new Error('known source');
    for (const record of [
      null,
      {},
      { ...result.snapshot, extra: true },
      { ...result.snapshot, freezes_owned: -1 },
      { ...result.snapshot, active_course_id: '' },
      { ...result.snapshot, day_boundary_utc: '2026-09-20T00:00:00Z' },
      { ...result.snapshot, tz_id: 'bad/zone' },
      { ...result.snapshot, initialized: false },
    ]) {
      expect(parseSharedWidgetSnapshot(JSON.stringify(record))).toBeNull();
    }
    expect(parseSharedWidgetSnapshot('{broken')).toBeNull();
    expect(projectWidgetSnapshot({ ...known, localDay: '2026-09-12' }, clock).kind).toBe('unknown');
  });
  it('[INV-WID-03][INV-WID-06] time changes use the draw clock or an honest unknown state', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 172_800_000 }), (delay) => {
        const result = projectWidgetSnapshot(known, clock);
        if (result.kind !== 'snapshot') throw new Error('known source');
        const draw = renderWidget(
          parseSharedWidgetSnapshot(JSON.stringify(result.snapshot)),
          now + delay,
          'UTC',
        );
        if (delay < 30 * 60_000)
          expect(draw.remainingMinutes).toBe(Math.ceil((30 * 60_000 - delay) / 60_000));
        else {
          expect(draw.state).toBe('UNKNOWN');
          expect(draw.streak).toBeNull();
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('validated widget course routes', () => {
  it('[INV-WID-02][INV-WID-09] preserves the encoded snapshot course and resume priority without session access', () => {
    const result = projectWidgetSnapshot(
      {
        ...known,
        course: { courseId: 'en-es & ja', activeNodeId: 'unit/2?x=1', hasResumableSession: true },
      },
      clock,
    );
    if (result.kind !== 'snapshot') throw new Error('known source');
    expect(parseWidgetRoute(widgetDeepLink(result.snapshot))).toEqual({
      surface: 'resume',
      courseId: 'en-es & ja',
    });
    expect(parseWidgetRoute('freelingo://path?course=en-es&node=unit%2F2')).toEqual({
      surface: 'path',
      courseId: 'en-es',
      nodeId: 'unit/2',
    });
    expect(parseWidgetRoute('freelingo://open')).toEqual({ surface: 'open' });
  });
  it('[INV-WID-02][INV-WID-09] rejects ambiguous, foreign and mutation-shaped deep links', () => {
    for (const url of [
      'https://practice?course=en-es',
      'freelingo://practice',
      'freelingo://resume?course=en-es&course=en-ja',
      'freelingo://practice?course=%',
      'freelingo://resume?course=en-es&start=true',
      'freelingo://resume?course=en-es&node=x',
      'freelingo://path?course=en-es&node=',
      'freelingo://user@path?course=en-es',
      'freelingo://path:42?course=en-es',
      'freelingo://practice/extra?course=en-es',
      'freelingo://practice?course=en-es#resume',
      'freelingo://open?course=en-es',
      'freelingo://path?course=%FF',
      'freelingo://path?course=%00',
    ])
      expect(parseWidgetRoute(url)).toBeNull();
  });
});
