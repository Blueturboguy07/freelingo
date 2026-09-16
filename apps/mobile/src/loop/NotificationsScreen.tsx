import { useEffect, useState } from 'react';
import { Switch, TextInput, View } from 'react-native';
import { CARD, FONT, TYPE, useUiTheme } from '@freelingo/ui';
import {
  formatReminderTime,
  notificationSettingsModel,
  parseReminderTime,
  type NotificationChannel,
  type NotificationPreferences,
  type NotificationSettingRow,
  type NotificationSettingsSnapshot,
} from '@freelingo/core/notifications';
import { Action, ErrorNotice, Label, Page, Panel, useLoopAction, useLoopUi } from './ui';

export interface NotificationSettingsPorts {
  /** Durable preference write plus cancel/dismiss/rearm reconciliation; reject on failure. */
  save(change: Partial<NotificationPreferences>): Promise<void>;
  /** Persist requestedPermission first, initiate the OS prompt, handle its callback separately.
   * Resolves after initiation, never after the OS callback; navigation stays independent. */
  requestPermission(): void | Promise<void>;
  openSettings(channel: NotificationChannel | 'app'): Promise<void>;
  openExactAlarmSettings(): Promise<void>;
  continueOnboarding(): void;
  done(): void;
}

function rowExplanation(row: NotificationSettingRow): string | null {
  switch (row.state) {
    case 'channelBlocked':
      return 'Blocked in Android settings';
    case 'checkingChannel':
      return 'Checking notification channel settings';
    case 'masterOff':
      return 'Practice reminders are off';
    case 'unavailable':
      return 'Streak nudges stay off until safe delivery is available.';
    default:
      return null;
  }
}

export function NotificationsScreen({
  snapshot,
  ports,
  onboarding = false,
}: {
  snapshot: NotificationSettingsSnapshot;
  ports: NotificationSettingsPorts;
  onboarding?: boolean;
}) {
  const { tokens, styles } = useLoopUi();
  const { boldText } = useUiTheme();
  const action = useLoopAction('notification-settings');
  const [promptStarted, setPromptStarted] = useState(false);
  const [timeText, setTimeText] = useState(() => formatReminderTime(snapshot));
  useEffect(() => {
    setTimeText(formatReminderTime(snapshot));
  }, [snapshot.hour, snapshot.minute]);
  const model = notificationSettingsModel({
    ...snapshot,
    requestedPermission: snapshot.requestedPermission || promptStarted,
  });
  const rows = [
    {
      channel: 'daily' as const,
      label: 'Practice reminder',
      key: 'practiceEnabled' as const,
      model: model.daily,
    },
    {
      channel: 'streak' as const,
      label: 'Streak reminder',
      key: 'streakEnabled' as const,
      model: model.streak,
    },
  ];
  return (
    <Page
      title="Notifications"
      footer={
        <Action
          label={onboarding ? 'CONTINUE' : 'DONE'}
          onPress={onboarding ? ports.continueOnboarding : ports.done}
        />
      }
    >
      {onboarding && <Label>I'll remind you to practice so it becomes a habit!</Label>}
      {model.permissionAction === 'settings' ? (
        <Panel>
          <Label>Notifications are off for Freelingo</Label>
          <Label muted>You can allow reminders in your device settings.</Label>
          <Action
            label="OPEN SETTINGS"
            tone="neutral"
            disabled={action.pending}
            onPress={() => action.run(() => ports.openSettings('app'))}
          />
        </Panel>
      ) : model.permissionAction !== 'none' ? (
        <Panel>
          <Label>
            {model.permissionAction === 'request'
              ? 'Allow notifications to get your practice reminder.'
              : 'Waiting for notification permission'}
          </Label>
          <Label muted>You can continue now and change reminders later.</Label>
          {model.permissionAction === 'request' && (
            <Action
              label="ALLOW NOTIFICATIONS"
              disabled={action.pending}
              onPress={() => {
                setPromptStarted(true);
                action.run(async () => {
                  try {
                    await ports.requestPermission();
                  } catch (error) {
                    setPromptStarted(false);
                    throw error;
                  }
                });
              }}
            />
          )}
        </Panel>
      ) : (
        <>
          <Panel>
            <Label>Daily reminders</Label>
            {rows.map((row) => (
              <View key={row.channel}>
                <View style={styles.row}>
                  <Label>{row.label}</Label>
                  <Switch
                    accessibilityLabel={row.label}
                    value={row.model.storedEnabled}
                    disabled={!row.model.canToggle || action.pending}
                    onValueChange={(value) => action.run(() => ports.save({ [row.key]: value }))}
                  />
                </View>
                {rowExplanation(row.model) !== null && (
                  <Label muted>{rowExplanation(row.model)}</Label>
                )}
                {row.model.state === 'channelBlocked' && (
                  <Action
                    label={row.channel === 'daily' ? 'OPEN DAILY SETTINGS' : 'OPEN STREAK SETTINGS'}
                    tone="neutral"
                    disabled={action.pending}
                    onPress={() => action.run(() => ports.openSettings(row.channel))}
                  />
                )}
              </View>
            ))}
          </Panel>
          <Panel>
            <Label>Reminder time</Label>
            <Label muted>We'll send you reminders so you don't forget to practice.</Label>
            <TextInput
              accessibilityLabel="Reminder time"
              value={timeText}
              onChangeText={setTimeText}
              editable={!action.pending && model.daily.canToggle}
              placeholder="19:00"
              returnKeyType="done"
              style={{
                color: tokens.text,
                borderColor: tokens.border,
                borderWidth: CARD.borderPx,
                borderRadius: tokens.radius,
                padding: tokens.space,
                fontFamily: boldText ? FONT.strong : FONT.body,
                fontSize: TYPE.body.fontSizePx,
              }}
              onBlur={() =>
                action.run(async () => {
                  const time = parseReminderTime(timeText);
                  if (time.hour !== snapshot.hour || time.minute !== snapshot.minute)
                    await ports.save(time);
                })
              }
            />
            <Label muted>24-hour time · your device's local time</Label>
          </Panel>
          {model.showExactAlarmRow && (
            <Panel>
              <Label>Precise streak reminders are unavailable</Label>
              <Label muted>
                Daily reminders can arrive later. Streak nudges stay off until the device supports
                safe, timely delivery.
              </Label>
              {model.canOpenExactAlarmSettings && (
                <Action
                  label="ALLOW EXACT ALARMS"
                  tone="neutral"
                  disabled={action.pending}
                  onPress={() => action.run(() => ports.openExactAlarmSettings())}
                />
              )}
            </Panel>
          )}
        </>
      )}
      <ErrorNotice message={action.error} />
      <Label muted>
        Freelingo sends at most 2 notifications a day and never sends anything over the network.
      </Label>
    </Page>
  );
}
