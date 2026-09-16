/** S110 notification settings; injected OS facts and persisted local preferences only. */
export type NotificationPermission = 'undetermined' | 'denied' | 'granted';
export type NotificationChannel = 'daily' | 'streak';
export type ChannelAvailability = 'enabled' | 'blocked' | 'unknown';
export interface ReminderTime {
  readonly hour: number;
  readonly minute: number;
}
export interface NotificationPreferences extends ReminderTime {
  readonly practiceEnabled: boolean;
  readonly streakEnabled: boolean;
}
export interface NotificationSettingsSnapshot extends NotificationPreferences {
  readonly platform: 'ios' | 'android';
  readonly permission: NotificationPermission;
  /** Persist before opening the one OS prompt; a lost callback must not cause a second prompt. */
  readonly requestedPermission: boolean;
  readonly undeterminedForegrounds: number;
  readonly channels: Readonly<Record<NotificationChannel, ChannelAvailability>>;
  readonly capabilities: {
    /** False until a real native capability check succeeds. */
    readonly exactAlarmCapable: boolean;
    /** Timing permission does not prove that stale danger payloads can be suppressed. */
    readonly fireTimeRecheckCapable: boolean;
  };
}
/** Freelingo local defaults, 2026-09-13; deep07 S10/S13 and EC-NOT-15. No OS grant is inferred. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationPreferences = {
  practiceEnabled: true,
  streakEnabled: true,
  hour: 19,
  minute: 0,
};
export const NOTIFICATION_PERMISSION_FOREGROUND_LIMIT = 3;
export type NotificationRowState =
  | 'on'
  | 'off'
  | 'permissionBlocked'
  | 'permissionPending'
  | 'channelBlocked'
  | 'checkingChannel'
  | 'masterOff'
  | 'unavailable';
export interface NotificationSettingRow {
  readonly state: NotificationRowState;
  readonly storedEnabled: boolean;
  readonly canToggle: boolean;
  /** Eligibility only: actual delivery additionally requires the scheduler's current day checks. */
  readonly canSchedule: boolean;
}
export interface NotificationSettingsModel {
  readonly permissionAction: 'none' | 'request' | 'pending' | 'settings';
  readonly continueEnabled: true;
  readonly daily: NotificationSettingRow;
  readonly streak: NotificationSettingRow;
  readonly showExactAlarmRow: boolean;
  readonly canOpenExactAlarmSettings: boolean;
}

export function permissionRequested(
  state: NotificationSettingsSnapshot,
): NotificationSettingsSnapshot {
  return state.requestedPermission
    ? state
    : { ...state, requestedPermission: true, undeterminedForegrounds: 0 };
}
/** Foreground reconciliation is persisted by the caller even if the permission callback never ran. */
export function permissionForeground(
  state: NotificationSettingsSnapshot,
  permission: NotificationPermission,
): NotificationSettingsSnapshot {
  return {
    ...state,
    permission,
    undeterminedForegrounds:
      permission === 'undetermined' && state.requestedPermission
        ? Math.min(NOTIFICATION_PERMISSION_FOREGROUND_LIMIT, state.undeterminedForegrounds + 1)
        : 0,
  };
}

export function notificationSettingsModel(
  state: NotificationSettingsSnapshot,
): NotificationSettingsModel {
  const permissionAction =
    state.permission === 'granted'
      ? 'none'
      : state.permission === 'denied' ||
          state.undeterminedForegrounds >= NOTIFICATION_PERMISSION_FOREGROUND_LIMIT
        ? 'settings'
        : state.requestedPermission
          ? 'pending'
          : 'request';
  const row = (channel: NotificationChannel): NotificationSettingRow => {
    const storedEnabled = channel === 'daily' ? state.practiceEnabled : state.streakEnabled;
    const availability = state.channels[channel];
    const canToggle = state.permission === 'granted' && availability === 'enabled';
    const rowState: NotificationRowState =
      state.permission !== 'granted'
        ? permissionAction === 'settings'
          ? 'permissionBlocked'
          : 'permissionPending'
        : availability === 'blocked'
          ? 'channelBlocked'
          : availability === 'unknown'
            ? 'checkingChannel'
            : !storedEnabled
              ? 'off'
              : channel === 'streak' && !state.practiceEnabled
                ? 'masterOff'
                : channel === 'streak' &&
                    (!state.capabilities.exactAlarmCapable ||
                      !state.capabilities.fireTimeRecheckCapable)
                  ? 'unavailable'
                  : 'on';
    return { state: rowState, storedEnabled, canToggle, canSchedule: rowState === 'on' };
  };
  return {
    permissionAction,
    continueEnabled: true,
    daily: row('daily'),
    streak: row('streak'),
    showExactAlarmRow: state.permission === 'granted' && !state.capabilities.exactAlarmCapable,
    canOpenExactAlarmSettings:
      state.platform === 'android' && !state.capabilities.exactAlarmCapable,
  };
}

function validTime(time: ReminderTime): boolean {
  return (
    Number.isInteger(time.hour) &&
    time.hour >= 0 &&
    time.hour < 24 &&
    Number.isInteger(time.minute) &&
    time.minute >= 0 &&
    time.minute < 60
  );
}
export function parseReminderTime(value: string): ReminderTime {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  const time = { hour: Number(match?.[1]), minute: Number(match?.[2]) };
  if (match === null || !validTime(time)) throw new RangeError('Enter a time from 00:00 to 23:59.');
  return time;
}
export function formatReminderTime(time: ReminderTime): string {
  if (!validTime(time)) throw new RangeError('Enter a time from 00:00 to 23:59.');
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}
