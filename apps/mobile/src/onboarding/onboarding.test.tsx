import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GOAL_TIERS } from '@freelingo/core/economy';
import { PACK_STATES } from '@freelingo/core/packs';
import { OnboardingScreen } from './index.js';
import type { OnboardingCourse } from './ports.js';
const course: OnboardingCourse = {
  id: 'en-es',
  languageName: 'Spanish',
  language: 'es',
  packState: 'installed',
  sizeMb: 38,
  itemCount: 3000,
  alignment: 'cefr',
  levelLabel: 'A1',
  machineAuthoredPercent: 12,
  wrongItemPercent: 0.5,
  nativeReview: 'provisional',
  beta: true,
  download: { kind: 'idle' },
  validatorSummary: 'Content checks passed',
};

describe('onboarding S001–S009', () => {
  it('[INV-DAT-02] restore is reachable before choosing or installing the first course', () => {
    const onEvent = vi.fn();
    render(
      <OnboardingScreen
        state={{ screen: 'courses', courses: [course], selectedCourseId: null }}
        onEvent={onEvent}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import data' }));
    expect(onEvent).toHaveBeenCalledWith({ type: 'restore' });
    expect(screen.getByRole('button', { name: 'CONTINUE' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });
  it('[INV-PACK-01] all six pack states render distinct facts and only verified playable structure can continue', () => {
    const onEvent = vi.fn();
    const view = render(
      <OnboardingScreen
        state={{ screen: 'courses', courses: [course], selectedCourseId: course.id }}
        onEvent={onEvent}
      />,
    );
    const expected = [
      'Not downloaded',
      'Audio download incomplete',
      'Ready to learn',
      'Needs repair',
      'Could not verify this download',
      'Course withdrawn',
    ];
    for (const [index, packState] of PACK_STATES.entries()) {
      view.rerender(
        <OnboardingScreen
          state={{
            screen: 'courses',
            courses: [{ ...course, packState }],
            selectedCourseId: course.id,
          }}
          onEvent={onEvent}
        />,
      );
      expect(screen.getByText(expected[index]!)).toBeTruthy();
      const before = onEvent.mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: 'CONTINUE' }));
      expect(onEvent.mock.calls.length - before).toBe(
        packState === 'installed' || packState === 'partial' ? 1 : 0,
      );
    }
  });
  it('[INV-PACK-18] verification failure has a re-download action and no fabricated successful provenance', () => {
    const onEvent = vi.fn();
    render(
      <OnboardingScreen
        state={{
          screen: 'pack-detail',
          course: {
            ...course,
            packState: 'unverified',
            alignment: 'frequency',
            machineAuthoredPercent: null,
            wrongItemPercent: null,
            nativeReview: 'unreviewed',
          },
        }}
        onEvent={onEvent}
      />,
    );
    expect(screen.getByText('Beginner · frequency-ordered')).toBeTruthy();
    expect(screen.getByText('Wrong-item rate not yet measured')).toBeTruthy();
    expect(screen.queryByText(/0% machine-authored/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'DOWNLOAD AGAIN' }));
    expect(onEvent).toHaveBeenCalledWith({ type: 'download', courseId: course.id });
  });
  it('[INV-PACK-01] every measured unpaid rate carries the exact provisional disclosure', () => {
    render(
      <OnboardingScreen
        state={{ screen: 'pack-detail', course: { ...course, nativeReview: 'unreviewed' } }}
        onEvent={vi.fn()}
      />,
    );
    expect(screen.getByText('PROVISIONAL (unreviewed by a paid native speaker)')).toBeTruthy();
  });
  it('[INV-NOT-13] a permission callback that never returns cannot block Continue or retrigger permission', () => {
    const onEvent = vi.fn();
    const view = render(
      <OnboardingScreen
        state={{ screen: 'notifications', permission: 'never-asked' }}
        onEvent={onEvent}
      />,
    );
    expect(onEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ALLOW NOTIFICATIONS' }));
    expect(onEvent).toHaveBeenCalledWith({ type: 'requestNotifications' });
    view.rerender(
      <OnboardingScreen
        state={{ screen: 'notifications', permission: 'requesting' }}
        onEvent={onEvent}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'CONTINUE' }));
    expect(onEvent).toHaveBeenLastCalledWith({ type: 'continue' });
    expect(screen.queryByRole('button', { name: 'ALLOW NOTIFICATIONS' })).toBeNull();
    view.rerender(
      <OnboardingScreen
        state={{ screen: 'notifications', permission: 'blocked' }}
        onEvent={onEvent}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'OPEN SETTINGS' }));
    expect(onEvent).toHaveBeenLastCalledWith({ type: 'openNotificationSettings' });
  });
  it('[INV-ECO-01] goal picker uses the sole minutes table and emits its key, not an invented XP value', () => {
    const onEvent = vi.fn();
    render(<OnboardingScreen state={{ screen: 'goal', selected: 'regular' }} onEvent={onEvent} />);
    for (const tier of GOAL_TIERS) {
      const option = screen.getByRole('radio', {
        name: `${tier.key.charAt(0).toUpperCase() + tier.key.slice(1)}, ${tier.minutes} min / day`,
      });
      expect(option.getAttribute('aria-checked')).toBe(tier.key === 'regular' ? 'true' : 'false');
      fireEvent.click(option);
      expect(onEvent).toHaveBeenLastCalledWith({ type: 'chooseGoal', goal: tier.key });
    }
  });
  it('[INV-DAT-02] replacement shows both last days and session count and requires its explicit action', () => {
    const onEvent = vi.fn();
    render(
      <OnboardingScreen
        state={{
          screen: 'restore',
          restore: {
            kind: 'confirm-replace',
            currentLastDay: '2026-09-13',
            importedLastDay: '2026-09-10',
            sessionsSinceInstall: 3,
          },
        }}
        onEvent={onEvent}
      />,
    );
    expect(screen.getByText(/2026-09-13/)).toBeTruthy();
    expect(screen.getByText(/2026-09-10/)).toBeTruthy();
    expect(screen.getByText(/3 sessions completed/)).toBeTruthy();
    expect(onEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'REPLACE AND RESTORE' }));
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: 'confirmRestore' });
  });
  it('[INV-PACK-27] offline queued download stays visible with resume instead of presenting a failed course', () => {
    const onEvent = vi.fn();
    render(
      <OnboardingScreen
        state={{
          screen: 'pack-detail',
          course: { ...course, packState: 'not-downloaded', download: { kind: 'queued' } },
        }}
        onEvent={onEvent}
      />,
    );
    expect(screen.getByText(/Waiting for a connection/)).toBeTruthy();
    expect(screen.queryByText('Download failed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'RESUME DOWNLOAD' }));
    expect(onEvent).toHaveBeenCalledWith({ type: 'download', courseId: course.id });
  });
  it('[INV-ECO-09] choosing a placement test launches its real session, without a goal or reward event', () => {
    const onEvent = vi.fn();
    render(
      <OnboardingScreen
        state={{ screen: 'placement-choice', languageName: 'Spanish', choice: 'test' }}
        onEvent={onEvent}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'CONTINUE' }));
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: 'startPlacement' });
  });
  it('[INV-DAT-02] an active import cannot be left through a second destructive or navigation action', () => {
    const onEvent = vi.fn();
    render(
      <OnboardingScreen
        state={{ screen: 'restore', restore: { kind: 'importing' } }}
        onEvent={onEvent}
      />,
    );
    expect(screen.getByText('Restoring your progress…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'BACK' }));
    expect(onEvent).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'REPLACE AND RESTORE' })).toBeNull();
  });
});
