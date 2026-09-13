import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  notificationSettingsModel,
  permissionRequested,
  permissionForeground,
  parseReminderTime,
  formatReminderTime,
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettingsSnapshot,
} from './index.js';

const snapshot = (): NotificationSettingsSnapshot => ({
  ...DEFAULT_NOTIFICATION_SETTINGS,
  platform: 'android',
  permission: 'granted',
  requestedPermission: true,
  undeterminedForegrounds: 0,
  channels: { daily: 'enabled', streak: 'enabled' },
  capabilities: { exactAlarmCapable: false, fireTimeRecheckCapable: false },
});

describe('notification settings state', () => {
  it('[INV-NOT-13] defaults retain reminder intent without claiming OS permission or exact alarms', () => {
    const first = {
      ...snapshot(),
      permission: 'undetermined' as const,
      requestedPermission: false,
    };
    expect(DEFAULT_NOTIFICATION_SETTINGS).toMatchObject({
      practiceEnabled: true,
      streakEnabled: true,
      hour: 19,
      minute: 0,
    });
    const model = notificationSettingsModel(first);
    expect(model.permissionAction).toBe('request');
    expect(model.continueEnabled).toBe(true);
    expect(model.daily.canSchedule).toBe(false);
    expect(model.streak.canSchedule).toBe(false);
  });
  it('[INV-NOT-13] an interrupted one-time prompt reaches OPEN SETTINGS by the third foreground', () => {
    let state = permissionRequested({
      ...snapshot(),
      permission: 'undetermined',
      requestedPermission: false,
    });
    for (let count = 1; count <= 3; count++) {
      state = permissionForeground(state, 'undetermined');
      expect(state.undeterminedForegrounds).toBe(count);
      expect(notificationSettingsModel(state).permissionAction).toBe(
        count === 3 ? 'settings' : 'pending',
      );
      expect(notificationSettingsModel(state).continueEnabled).toBe(true);
      expect(state.practiceEnabled).toBe(true);
    }
    expect(permissionRequested(state)).toEqual(state);
    state = permissionForeground(state, 'granted');
    expect(state.undeterminedForegrounds).toBe(0);
    expect(notificationSettingsModel(state).daily.canSchedule).toBe(true);
  });
  it('[INV-NOT-15] app denial is distinct from a blocked channel and never overwrites intent', () => {
    const denied = notificationSettingsModel({ ...snapshot(), permission: 'denied' });
    expect(denied.permissionAction).toBe('settings');
    expect(denied.daily.state).toBe('permissionBlocked');
    const blocked = notificationSettingsModel({
      ...snapshot(),
      channels: { daily: 'enabled', streak: 'blocked' },
    });
    expect(blocked.permissionAction).toBe('none');
    expect(blocked.daily.canSchedule).toBe(true);
    expect(blocked.streak.state).toBe('channelBlocked');
    expect(blocked.streak.storedEnabled).toBe(true);
    expect(blocked.streak.canSchedule).toBe(false);
  });
  it('[INV-NOT-12] unavailable exact alarms are visible and never treated as a granted capability', () => {
    const model = notificationSettingsModel(snapshot());
    expect(model.showExactAlarmRow).toBe(true);
    expect(model.canOpenExactAlarmSettings).toBe(true);
    expect(model.streak.canSchedule).toBe(false);
    expect(model.daily.canSchedule).toBe(true);
    expect(
      notificationSettingsModel({ ...snapshot(), platform: 'ios' }).canOpenExactAlarmSettings,
    ).toBe(false);
  });
  it('[INV-NOT-02] exact timing alone cannot enable a nudge without a real fire-time check', () => {
    const model = notificationSettingsModel({
      ...snapshot(),
      capabilities: { exactAlarmCapable: true, fireTimeRecheckCapable: false },
    });
    expect(model.streak.canSchedule).toBe(false);
    expect(model.streak.state).toBe('unavailable');
  });
  it('[INV-NOT-15] every permission/channel/toggle/capability combination has a truthful total row state', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('granted' as const, 'denied' as const, 'undetermined' as const),
        fc.constantFrom('enabled' as const, 'blocked' as const, 'unknown' as const),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (
          permission,
          channel,
          practiceEnabled,
          streakEnabled,
          exactAlarmCapable,
          fireTimeRecheckCapable,
        ) => {
          const state = {
            ...snapshot(),
            permission,
            practiceEnabled,
            streakEnabled,
            channels: { daily: channel, streak: channel },
            capabilities: { exactAlarmCapable, fireTimeRecheckCapable },
          };
          const model = notificationSettingsModel(state);
          const daily = permission === 'granted' && channel === 'enabled' && practiceEnabled;
          expect(model.daily.canSchedule).toBe(daily);
          expect(model.streak.canSchedule).toBe(
            daily && streakEnabled && exactAlarmCapable && fireTimeRecheckCapable,
          );
          expect(model.daily.storedEnabled).toBe(practiceEnabled);
          expect(model.streak.storedEnabled).toBe(streakEnabled);
          expect(model.daily.state).toBeTypeOf('string');
          expect(model.streak.state).toBeTypeOf('string');
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
  it('[INV-NOT-08] parses only complete wall-clock times and never accepts rollover values', () => {
    expect(parseReminderTime('9:05')).toEqual({ hour: 9, minute: 5 });
    expect(formatReminderTime(parseReminderTime('9:05'))).toBe('09:05');
    for (const value of ['', '19:0', '24:00', '19:60', '-1:00', '1.5:00', '19:00 tomorrow']) {
      expect(() => parseReminderTime(value)).toThrow(RangeError);
    }
    for (const hour of [NaN, Infinity, -1, 24, 0.5])
      expect(() => formatReminderTime({ hour, minute: 0 })).toThrow(RangeError);
  });
});
