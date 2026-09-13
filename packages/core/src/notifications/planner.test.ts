import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { toLocalDay, addCivilDays } from '../day/civil.js';
import {
  buildNotificationPlan,
  chooseTemplate,
  notificationMayPresent,
  recencyScore,
  NOTIFICATION_CONFIG,
  NOTIFICATION_TEMPLATES,
  type NotificationPlanInput,
  type NotificationDelivery,
} from './planner.js';
const localDay = toLocalDay('2026-09-13');
function input(): NotificationPlanInput {
  return {
    nowUtc: '2026-09-13T18:00:00Z',
    localDay,
    timeZone: 'UTC',
    nextLocalMidnightUtc: '2026-09-14T00:00:00Z',
    settings: {
      platform: 'android',
      permission: 'granted',
      requestedPermission: true,
      undeterminedForegrounds: 0,
      practiceEnabled: true,
      streakEnabled: true,
      hour: 19,
      minute: 0,
      channels: { daily: 'enabled', streak: 'enabled' },
      capabilities: { exactAlarmCapable: true, fireTimeRecheckCapable: true },
    },
    native: {
      calendarRearmCapable: true,
      expirationCapable: true,
      pendingLimit: 64,
      otherPendingCount: 0,
    },
    day: {
      localDay,
      goalMet: false,
      streakExtendedToday: false,
      streakCount: 5,
      freezeCoversToday: false,
      previousDayDisposition: 'extended',
      recoveryUntilUtc: null,
    },
    courses: [
      {
        courseId: 'en-es',
        courseName: 'Spanish',
        lastSessionLocalDay: localDay,
        mistakesDue: 0,
        recentWeakItems: 0,
        hasProgress: true,
        hasContentTease: true,
      },
    ],
    dailyOccurrences: [
      {
        localDay,
        atUtc: '2026-09-13T19:00:00Z',
        calendar: { year: 2026, month: 9, day: 13, hour: 19, minute: 0 },
      },
    ],
    history: [],
  };
}
const daily = (value: NotificationPlanInput) =>
  buildNotificationPlan(value).find((n) => n.slot === 'daily')!;
describe('notification planning from actual local day facts', () => {
  it('[INV-NOT-01] preserves civil calendar fields across different UTC offsets without manufacturing a fixed offset', () => {
    const value = input();
    value.dailyOccurrences = [
      {
        localDay: toLocalDay('2026-10-31'),
        atUtc: '2026-11-01T00:00:00Z',
        calendar: { year: 2026, month: 10, day: 31, hour: 19, minute: 0 },
      },
      {
        localDay: toLocalDay('2026-11-01'),
        atUtc: '2026-11-02T01:00:00Z',
        calendar: { year: 2026, month: 11, day: 1, hour: 19, minute: 0 },
      },
    ];
    value.settings = { ...value.settings, streakEnabled: false };
    value.timeZone = 'America/Chicago';
    value.nowUtc = '2026-10-31T12:00:00Z';
    value.localDay = toLocalDay('2026-10-31');
    value.day = { ...value.day, localDay: value.localDay, streakExtendedToday: true };
    value.nextLocalMidnightUtc = '2026-11-01T05:00:00Z';
    expect(buildNotificationPlan(value).map((n) => n.trigger)).toEqual(
      value.dailyOccurrences.map((o) => ({
        kind: 'calendar',
        ...o.calendar,
        repeats: false,
        inexact: true,
      })),
    );
  });
  it('[INV-NOT-01] Android cannot masquerade absolute dates as timezone-safe calendar capability', () => {
    const value = input();
    value.native = { ...value.native, calendarRearmCapable: false };
    expect(buildNotificationPlan(value)).toEqual([]);
    value.settings = { ...value.settings, platform: 'ios' };
    expect(daily(value).trigger.kind).toBe('calendar');
  });
  it('[INV-NOT-02] danger is current-day only and needs exact, fire-time and expiration proof', () => {
    const value = input();
    expect(buildNotificationPlan(value).find((n) => n.slot === 'discretionary')).toMatchObject({
      expiresAtUtc: new Date(value.nextLocalMidnightUtc).toISOString(),
      trigger: { kind: 'absolute', atUtc: '2026-09-13T22:00:00.000Z' },
    });
    for (const patch of [
      { goalMet: true },
      { streakExtendedToday: true },
      { streakCount: 0 },
      { freezeCoversToday: true },
    ]) {
      expect(
        buildNotificationPlan({ ...value, day: { ...value.day, ...patch } }).every(
          (n) => n.slot === 'daily',
        ),
      ).toBe(true);
    }
    expect(
      buildNotificationPlan({
        ...value,
        native: { ...value.native, expirationCapable: false },
      }).every((n) => n.slot === 'daily'),
    ).toBe(true);
  });
  it('[INV-NOT-03] goal-met pool is broad and never danger; freeze-covered state never congratulates', () => {
    const value = input();
    value.day = { ...value.day, goalMet: true, streakExtendedToday: true };
    expect(
      NOTIFICATION_TEMPLATES.filter((t) => t.family === 'goal_met').length,
    ).toBeGreaterThanOrEqual(6);
    expect(daily(value).family).toBe('goal_met');
    expect(buildNotificationPlan(value)).toHaveLength(1);
    value.day = { ...value.day, freezeCoversToday: true };
    expect(daily(value).family).not.toBe('goal_met');
  });
  it('[INV-NOT-04] per-course eligibility binds the winner and payload to the motivating course', () => {
    const value = input();
    value.day = { ...value.day, streakCount: 0 };
    value.courses = [
      value.courses[0]!,
      { ...value.courses[0]!, courseId: 'en-fr', courseName: 'French', mistakesDue: 8 },
    ];
    const request = buildNotificationPlan(value).find((n) => n.slot === 'discretionary')!;
    expect(request).toMatchObject({ courseId: 'en-fr', family: 'mistakes_due' });
    expect(request.body).toContain('French');
  });
  it('[INV-NOT-05] recency penalty is continuous and never an eligibility exclusion', () => {
    expect(recencyScore(1, 0)).toBeCloseTo(1 - 0.017);
    expect(recencyScore(1, 15)).toBeCloseTo(1 - 0.017 / 2);
    expect(recencyScore(1, 30)).toBeCloseTo(1 - 0.017 / 4);
    const value = input(),
      template = NOTIFICATION_TEMPLATES[0]!;
    expect(chooseTemplate(value, 'daily', value.localDay, [template])?.template.id).toBe(
      template.id,
    );
  });
  it('[INV-NOT-06] reserves room for other app notifications and never exceeds the native pending ceiling', () => {
    const value = input();
    value.native = { ...value.native, pendingLimit: 64, otherPendingCount: 63 };
    expect(buildNotificationPlan(value)).toHaveLength(1);
    value.native = { ...value.native, otherPendingCount: 64 };
    expect(buildNotificationPlan(value)).toEqual([]);
  });
  it('[INV-NOT-07] presentation suppresses a live bounded lease, but an abandoned or rebooted lease expires', () => {
    const value = input(),
      request = daily(value),
      nowUtc = '2026-09-13T19:00:00Z';
    const facts = {
      input: { ...value, nowUtc },
      clock: { bootId: 'A', monotonicMs: 1000 },
      session: { bootId: 'A', checkpointMonotonicMs: 1000 },
    };
    expect(notificationMayPresent(request, facts)).toBe(false);
    expect(
      notificationMayPresent(request, { ...facts, clock: { bootId: 'A', monotonicMs: 301000 } }),
    ).toBe(true);
    expect(
      notificationMayPresent(request, { ...facts, clock: { bootId: 'B', monotonicMs: 0 } }),
    ).toBe(true);
  });
  it('[INV-NOT-08] a passed reminder time is never backfilled and occurrence mismatches reject', () => {
    const value = input();
    value.nowUtc = '2026-09-13T20:30:00Z';
    expect(buildNotificationPlan(value).some((n) => n.slot === 'daily')).toBe(false);
    expect(() =>
      buildNotificationPlan({
        ...input(),
        dailyOccurrences: [
          {
            ...input().dailyOccurrences[0]!,
            calendar: { year: 2026, month: 9, day: 13, hour: 8, minute: 0 },
          },
        ],
      }),
    ).toThrow(/reminder time/i);
  });
  it('[INV-NOT-09] every reminder minute collapses collision to danger', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1439 }), (minute) => {
        const value = input();
        value.nowUtc = '2026-09-13T00:00:00Z';
        const midnight = Date.parse(value.nextLocalMidnightUtc);
        value.settings = { ...value.settings, hour: Math.floor(minute / 60), minute: minute % 60 };
        const at = midnight - 24 * 3600000 + minute * 60000;
        value.dailyOccurrences = [
          {
            ...value.dailyOccurrences[0]!,
            atUtc: new Date(at).toISOString(),
            calendar: {
              year: 2026,
              month: 9,
              day: 13,
              hour: value.settings.hour,
              minute: value.settings.minute,
            },
          },
        ];
        const plan = buildNotificationPlan(value);
        for (let i = 1; i < plan.length; i++)
          expect(Date.parse(plan[i]!.atUtc) - Date.parse(plan[i - 1]!.atUtc)).toBeGreaterThan(
            600000,
          );
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
  it('[INV-NOT-10] off and blocked channels produce no requests or history mutation', () => {
    const value = input(),
      before = JSON.stringify(value.history);
    value.settings = { ...value.settings, practiceEnabled: false };
    expect(buildNotificationPlan(value)).toEqual([]);
    expect(JSON.stringify(value.history)).toBe(before);
    value.settings = {
      ...value.settings,
      practiceEnabled: true,
      channels: { daily: 'blocked', streak: 'blocked' },
    };
    expect(buildNotificationPlan(value)).toEqual([]);
  });
  it('[INV-NOT-11] all bodies lack decaying numbers and presentation expires stale danger', () => {
    const value = input();
    expect(
      NOTIFICATION_TEMPLATES.every(
        (t) => !/[0-9]|\b(hours?|minutes?|tomorrow|lost|reset)\b/i.test(t.body),
      ),
    ).toBe(true);
    const request = buildNotificationPlan(value).find((n) => n.slot === 'discretionary')!;
    expect(
      notificationMayPresent(request, {
        input: { ...value, nowUtc: value.nextLocalMidnightUtc },
        clock: { bootId: 'A', monotonicMs: 0 },
        session: null,
      }),
    ).toBe(false);
  });
  it('[INV-NOT-12] no exact-alarm capability leaves one inexact daily occurrence and zero danger', () => {
    const value = input();
    value.settings = {
      ...value.settings,
      capabilities: { ...value.settings.capabilities, exactAlarmCapable: false },
    };
    const plan = buildNotificationPlan(value);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ slot: 'daily', trigger: { kind: 'calendar', inexact: true } });
  });
  it('[INV-NOT-14] stale day proof and resolved motivation suppress presentation and revive excludes comeback', () => {
    const value = input();
    value.day = { ...value.day, streakCount: 0, recoveryUntilUtc: value.nextLocalMidnightUtc };
    value.courses = [
      { ...value.courses[0]!, lastSessionLocalDay: toLocalDay('2026-09-09'), mistakesDue: 8 },
    ];
    const request = buildNotificationPlan(value).find((n) => n.slot === 'discretionary')!;
    expect(request.family).toBe('revive');
    expect(
      notificationMayPresent(request, {
        input: { ...value, nowUtc: request.atUtc, day: { ...value.day, recoveryUntilUtc: null } },
        clock: { bootId: 'A', monotonicMs: 0 },
        session: null,
      }),
    ).toBe(false);
    expect(
      buildNotificationPlan({
        ...value,
        day: { ...value.day, localDay: toLocalDay('2026-09-12') },
      }),
    ).toEqual([]);
  });
  it('[INV-NOT-16] goal-met and ordinary thirty-day delivery traces never repeat within seven civil days', () => {
    for (const goalMet of [false, true]) {
      const history: NotificationDelivery[] = [];
      const seen = new Map<string, number>();
      for (let day = 0; day < 30; day++) {
        const value = input(),
          current = addCivilDays(localDay, day);
        value.localDay = current;
        value.nowUtc = current + 'T18:00:00Z';
        value.nextLocalMidnightUtc = addCivilDays(current, 1) + 'T00:00:00Z';
        value.day = { ...value.day, localDay: current, goalMet, streakExtendedToday: true };
        value.history = history;
        value.dailyOccurrences = [
          {
            localDay: current,
            atUtc: current + 'T19:00:00Z',
            calendar: {
              year: 2026,
              month: Number(current.slice(5, 7)),
              day: Number(current.slice(8, 10)),
              hour: 19,
              minute: 0,
            },
          },
        ];
        const request = daily(value),
          prior = seen.get(request.templateId);
        if (prior !== undefined) expect(day - prior).toBeGreaterThanOrEqual(7);
        seen.set(request.templateId, day);
        history.push({ ...request, deliveredAtUtc: request.atUtc, rewardedAtUtc: null });
      }
    }
  });
  it('[INV-NOT-01] wrong day boundaries and mismatched UTC/calendar evidence fail before scheduling', () => {
    const value = input();
    expect(() =>
      buildNotificationPlan({ ...value, nextLocalMidnightUtc: '2026-09-14T01:00:00Z' }),
    ).toThrow(/boundary/i);
    expect(() =>
      buildNotificationPlan({
        ...value,
        dailyOccurrences: [{ ...value.dailyOccurrences[0]!, atUtc: '2026-09-13T20:00:00Z' }],
      }),
    ).toThrow(/join/i);
  });
  it('[INV-NOT-02] revoking native expiry proof also refuses a previously armed discretionary payload', () => {
    const value = input(),
      request = buildNotificationPlan(value).find((n) => n.slot === 'discretionary')!;
    expect(
      notificationMayPresent(request, {
        input: {
          ...value,
          nowUtc: request.atUtc,
          native: { ...value.native, expirationCapable: false },
        },
        clock: { bootId: 'A', monotonicMs: 1000 },
        session: null,
      }),
    ).toBe(false);
  });
  it('[INV-NOT-06] future reservations rotate seven evergreen bodies without writing usage or claiming future goal facts', () => {
    const value = input();
    value.day = { ...value.day, goalMet: true, streakExtendedToday: true };
    value.dailyOccurrences = Array.from({ length: 8 }, (_, i) => {
      const day = addCivilDays(localDay, i);
      return {
        localDay: day,
        atUtc: day + 'T19:00:00Z',
        calendar: { year: 2026, month: 9, day: 13 + i, hour: 19, minute: 0 },
      };
    });
    const before = JSON.stringify(value.history),
      plan = buildNotificationPlan(value);
    expect(plan).toHaveLength(7);
    expect(new Set(plan.map((n) => n.templateId)).size).toBe(7);
    expect(plan.slice(1).every((n) => n.family === 'habit')).toBe(true);
    expect(JSON.stringify(value.history)).toBe(before);
  });
  it('[INV-NOT-16] repeated unresolved discretionary states still rotate rather than repeat one urgent line', () => {
    for (const family of [
      'danger',
      'revive',
      'freeze_used',
      'comeback',
      'mistakes_due',
      'target_practice',
    ]) {
      const history: NotificationDelivery[] = [],
        seen = new Map<string, number>();
      for (let day = 0; day < (family === 'revive' || family === 'freeze_used' ? 2 : 30); day++) {
        const value = input(),
          current = addCivilDays(localDay, day);
        value.localDay = current;
        value.nowUtc = current + 'T18:00:00Z';
        value.nextLocalMidnightUtc = addCivilDays(current, 1) + 'T00:00:00Z';
        value.dailyOccurrences = [];
        value.history = history;
        value.day = {
          ...value.day,
          localDay: current,
          streakCount: family === 'danger' ? 5 : 0,
          previousDayDisposition: family === 'freeze_used' ? 'frozen' : 'missed',
          recoveryUntilUtc: family === 'revive' ? value.nextLocalMidnightUtc : null,
        };
        value.courses = [
          {
            ...value.courses[0]!,
            lastSessionLocalDay: family === 'comeback' ? toLocalDay('2026-09-01') : current,
            mistakesDue: family === 'mistakes_due' ? 5 : 0,
            recentWeakItems: family === 'target_practice' ? 8 : 0,
          },
        ];
        const request = buildNotificationPlan(value).find((n) => n.slot === 'discretionary')!;
        expect(request.family).toBe(family);
        const prior = seen.get(request.templateId);
        if (prior !== undefined) expect(day - prior).toBeGreaterThanOrEqual(7);
        seen.set(request.templateId, day);
        history.push({ ...request, deliveredAtUtc: request.atUtc, rewardedAtUtc: null });
      }
    }
  });
  it('[INV-NOT-17] every declared template can win in a reachable state without bypassing eligibility', () => {
    const seen = new Set<string>();
    for (const template of NOTIFICATION_TEMPLATES) {
      const value = input();
      value.day = { ...value.day, streakCount: 0 };
      if (template.family === 'goal_met')
        value.day = { ...value.day, goalMet: true, streakExtendedToday: true };
      if (template.family === 'danger' || template.family === 'streak_alive')
        value.day = { ...value.day, streakCount: 5 };
      if (template.family === 'revive')
        value.day = { ...value.day, recoveryUntilUtc: value.nextLocalMidnightUtc };
      if (template.family === 'freeze_used')
        value.day = { ...value.day, previousDayDisposition: 'frozen' };
      value.courses = [
        {
          ...value.courses[0]!,
          lastSessionLocalDay: template.family === 'comeback' ? toLocalDay('2026-09-09') : localDay,
          mistakesDue: template.family === 'mistakes_due' ? 8 : 0,
          recentWeakItems: template.family === 'target_practice' ? 9 : 0,
        },
      ];
      value.history = NOTIFICATION_TEMPLATES.filter((t) => t.id !== template.id).map((t) => ({
        id: t.id,
        templateId: t.id,
        courseId: 'en-es',
        localDay: addCivilDays(localDay, -1),
        slot: t.slot,
        deliveredAtUtc: '2026-09-12T19:00:00Z',
        rewardedAtUtc: null,
      }));
      const winner = chooseTemplate(value, template.slot, value.localDay);
      expect(winner?.template.id).toBe(template.id);
      if (winner) seen.add(winner.template.id);
    }
    expect([...seen].sort()).toEqual(NOTIFICATION_TEMPLATES.map((t) => t.id).sort());
    expect(NOTIFICATION_CONFIG.rollingDays).toBe(7);
  });
});
