import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettingsSnapshot,
} from '@freelingo/core/notifications';
import { NotificationsScreen, type NotificationSettingsPorts } from './NotificationsScreen';

const snapshot = (): NotificationSettingsSnapshot => ({
  ...DEFAULT_NOTIFICATION_SETTINGS,
  platform: 'android',
  permission: 'granted',
  requestedPermission: true,
  undeterminedForegrounds: 0,
  channels: { daily: 'enabled', streak: 'enabled' },
  capabilities: { exactAlarmCapable: false, fireTimeRecheckCapable: false },
});
const ports = (): NotificationSettingsPorts => ({
  save: vi.fn().mockResolvedValue(undefined),
  requestPermission: vi.fn(),
  openSettings: vi.fn().mockResolvedValue(undefined),
  openExactAlarmSettings: vi.fn().mockResolvedValue(undefined),
  continueOnboarding: vi.fn(),
  done: vi.fn(),
});
it('[INV-NOT-13] onboarding Continue never waits for a permission callback', async () => {
  const p = ports();
  render(
    <NotificationsScreen
      snapshot={{ ...snapshot(), permission: 'undetermined', requestedPermission: false }}
      ports={p}
      onboarding
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'ALLOW NOTIFICATIONS' }));
  fireEvent.click(screen.getByRole('button', { name: 'CONTINUE' }));
  expect(p.continueOnboarding).toHaveBeenCalledOnce();
  await waitFor(() => expect(p.requestPermission).toHaveBeenCalledOnce());
});
it('[INV-NOT-13] after three undetermined foregrounds only OPEN SETTINGS is offered', () => {
  const p = ports();
  render(
    <NotificationsScreen
      snapshot={{ ...snapshot(), permission: 'undetermined', undeterminedForegrounds: 3 }}
      ports={p}
      onboarding
    />,
  );
  expect(screen.queryByRole('button', { name: 'ALLOW NOTIFICATIONS' })).toBeNull();
  expect(screen.getByText('Notifications are off for Freelingo')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'OPEN SETTINGS' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'CONTINUE' }));
  expect(p.continueOnboarding).toHaveBeenCalledOnce();
});
it('[INV-NOT-15] a blocked Streak channel has its own settings link and preserved disabled intent', async () => {
  const p = ports();
  render(
    <NotificationsScreen
      snapshot={{ ...snapshot(), channels: { daily: 'enabled', streak: 'blocked' } }}
      ports={p}
    />,
  );
  expect(screen.getByText('Blocked in Android settings')).toBeTruthy();
  expect(
    (screen.getByRole('switch', { name: 'Streak reminder' }) as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'OPEN STREAK SETTINGS' }));
  await waitFor(() => expect(p.openSettings).toHaveBeenCalledWith('streak'));
  expect(p.save).not.toHaveBeenCalled();
});
it('[INV-NOT-10] toggling stores intent through the injected action without optimistic fake success', async () => {
  const p = ports();
  render(<NotificationsScreen snapshot={snapshot()} ports={p} />);
  fireEvent.click(screen.getByRole('switch', { name: 'Practice reminder' }));
  await waitFor(() => expect(p.save).toHaveBeenCalledWith({ practiceEnabled: false }));
  expect(
    (screen.getByRole('switch', { name: 'Practice reminder' }) as HTMLInputElement).checked,
  ).toBe(true);
});
it('[INV-NOT-08] invalid time stays visible as an error and is never sent to storage', async () => {
  const p = ports();
  render(<NotificationsScreen snapshot={snapshot()} ports={p} />);
  const input = screen.getByRole('textbox', { name: 'Reminder time' });
  fireEvent.change(input, { target: { value: '24:99' } });
  fireEvent.blur(input);
  await screen.findByRole('alert');
  expect(p.save).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '08:30' } });
  fireEvent.blur(input);
  await waitFor(() => expect(p.save).toHaveBeenCalledWith({ hour: 8, minute: 30 }));
});
it('[INV-NOT-12] exact-alarm capability false renders the settings row without a permission modal', async () => {
  const p = ports();
  render(<NotificationsScreen snapshot={snapshot()} ports={p} />);
  expect(screen.getByText('Precise streak reminders are unavailable')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'ALLOW EXACT ALARMS' }));
  await waitFor(() => expect(p.openExactAlarmSettings).toHaveBeenCalledOnce());
  expect(p.requestPermission).not.toHaveBeenCalled();
});

it('[INV-NOT-13] failed permission initiation preserves a retry while Continue stays enabled', async () => {
  const p = ports();
  p.requestPermission = vi.fn(() => {
    throw new Error('Could not store permission intent');
  });
  render(
    <NotificationsScreen
      snapshot={{ ...snapshot(), permission: 'undetermined', requestedPermission: false }}
      ports={p}
      onboarding
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'ALLOW NOTIFICATIONS' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText('Could not store permission intent')).toBeTruthy();
  const retry = screen.getByRole('button', { name: 'ALLOW NOTIFICATIONS' });
  await waitFor(() => expect(retry.getAttribute('aria-disabled')).not.toBe('true'));
  fireEvent.click(retry);
  await waitFor(() => expect(p.requestPermission).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'CONTINUE' }));
  expect(p.continueOnboarding).toHaveBeenCalledOnce();
});
