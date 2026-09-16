import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { freshSession, item, step, DEFAULT_FLAVOUR_MATRIX } from '@freelingo/core/session';
import type { SessionEvent } from '@freelingo/core/session';
import type { AppRuntime, AppSnapshot, FreelingoServices } from './ports';
import { FreelingoApp } from './FreelingoApp';
import type { AppLifecyclePort } from './lifecycle';
function fixture() {
  let snapshot: AppSnapshot = {
    activeCourseId: 'es',
    ui: { theme: 'dark' },
    onboarding: null,
    path: { model: null, status: 'pack-missing' },
    hub: null,
    settings: {
      courseId: 'es',
      nowUtc: '2026-09-13T12:00:00Z',
      importedAtUtc: null,
      preferences: {
        listening: true,
        speaking: true,
        animations: true,
        soundEffects: true,
        motivationalMessages: true,
      },
      suspensions: { listening: null, speaking: null },
      appearance: 'dark',
      goalTier: 'regular',
      courses: [],
      appVersion: 'test',
    },
    notifications: null,
    lesson: null,
    ceremony: null,
    sessionOffer: null,
  };
  const loop = Object.fromEntries(
    [
      'saveHubDaily',
      'switchCourse',
      'setPreference',
      'setAppearance',
      'setGoal',
      'applyCourseAction',
      'advanceCeremony',
      'retryCommit',
      'launchLegendary',
      'shareCard',
      'playWord',
    ].map((name) => [name, vi.fn(async () => {})]),
  ) as unknown as AppRuntime['loop'];
  const runtime: AppRuntime = {
    opened: {} as AppRuntime['opened'],
    persistence: {} as AppRuntime['persistence'],
    loop,
    media: {
      capabilities: {
        canPlay: true,
        canRecognize: true,
        recognizerLocale: 'es',
        microphonePermission: 'granted',
        screenReaderActive: false,
        announcementInFlight: false,
      },
      play: vi.fn(() => () => {}),
      recognize: vi.fn(() => () => {}),
      remediate: vi.fn(),
      announce: vi.fn(),
    },
    notifications: {
      save: vi.fn(async () => {}),
      requestPermission: vi.fn(),
      openSettings: vi.fn(async () => {}),
      openExactAlarmSettings: vi.fn(async () => {}),
    },
    readSnapshot: vi.fn(async () => snapshot),
    readWidgetPublication: () => null,
    handleOnboarding: vi.fn(async () => {}),
    launchLesson: vi.fn(async () => {}),
    resolveSessionOffer: vi.fn(async () => {}),
    dispatchLesson: vi.fn(async (event: SessionEvent) => {
      if (snapshot.lesson === null) return;
      const deps = {
        config: DEFAULT_FLAVOUR_MATRIX.lesson,
        grading: { grade: () => ({ kind: 'correct' as const }) },
        clock: { nowMs: () => 1 },
        isTypeEligible: () => true,
        stepUpTripped: () => false,
      };
      let state = step(snapshot.lesson.state, event, deps).state;
      if (state.shellState === 'grading') state = step(state, { type: 'graded' }, deps).state;
      snapshot = {
        ...snapshot,
        lesson: state.exited === null ? { ...snapshot.lesson, state } : null,
      };
    }),
    recordExposure: vi.fn(async () => {}),
    completeLesson: vi.fn(async () => {}),
    reportItem: vi.fn(async () => {}),
    snoozeItem: vi.fn(async () => {}),
    repairPack: vi.fn(async () => {}),
    readSurface: vi.fn(async () => ({
      title: 'About Freelingo',
      paragraphs: ['Local-only learning.'],
      rows: [],
    })),
    subscribe: vi.fn(() => () => {}),
    foreground: vi.fn(async () => {}),
    background: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const services: FreelingoServices = { open: vi.fn(async () => runtime) };
  let back: () => boolean = () => false;
  let appState: (active: boolean) => void = () => {};
  const lifecycle: AppLifecyclePort = {
    onBack(handler) {
      back = handler;
      return vi.fn();
    },
    subscribe(handler) {
      appState = handler;
      return vi.fn();
    },
  };
  return {
    runtime,
    services,
    lifecycle,
    back: () => back(),
    appState: (active: boolean) => appState(active),
    set(value: Partial<AppSnapshot>) {
      snapshot = { ...snapshot, ...value };
    },
  };
}
function lesson() {
  const state = freshSession({ queue: [item(1, { type: 'meaningSelect' })] });
  return {
    state,
    exerciseId: 'exercise-1',
    challenge: {
      itemId: 'item-1',
      type: 'meaningSelect' as const,
      instruction: 'Choose the correct meaning',
      prompt: 'hola',
      language: 'es',
      acceptedAnswers: ['hello'],
      options: [
        { id: 'hello', text: 'hello' },
        { id: 'bye', text: 'goodbye' },
      ],
    },
  };
}
describe('real App screen composition', () => {
  it('[INV-SESS-27] an inactive signal during startup is retained until the runtime opens', async () => {
    const f = fixture();
    let release!: (runtime: AppRuntime) => void;
    const opening = new Promise<AppRuntime>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.services.open).mockReturnValue(opening);
    render(<FreelingoApp services={f.services} lifecycle={f.lifecycle} />);
    act(() => {
      f.appState(false);
    });
    await act(async () => {
      release(f.runtime);
    });
    await waitFor(() => expect(f.runtime.background).toHaveBeenCalledTimes(1));
    expect(f.runtime.foreground).not.toHaveBeenCalled();
  });
  it('[INV-SESS-01] repeated actual typed edits while the checkpoint is pending reach the runtime in order', async () => {
    const f = fixture();
    const content = lesson();
    f.set({
      lesson: {
        ...content,
        state: {
          ...freshSession({ queue: [item(1, { type: 'typedTranslate' })] }),
          shellState: 'challenge.idle',
        },
        challenge: {
          ...content.challenge,
          type: 'typedTranslate',
          instruction: 'Write this in English',
        },
      },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatch = vi.mocked(f.runtime.dispatchLesson).getMockImplementation()!;
    vi.mocked(f.runtime.dispatchLesson).mockImplementation(async (event) => {
      if (event.type === 'input') await gate;
      return dispatch(event);
    });
    render(<FreelingoApp services={f.services} lifecycle={f.lifecycle} />);
    const field = await screen.findByRole('textbox', { name: 'Your answer' });
    fireEvent.change(field, { target: { value: 'hello' } });
    fireEvent.change(field, { target: { value: 'hello' } });
    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(
        vi.mocked(f.runtime.dispatchLesson).mock.calls.filter(([event]) => event.type === 'input'),
      ).toHaveLength(2),
    );
  });
  it('[INV-SESS-14] lesson credits return to the same player and expose no tab-based exit', async () => {
    const f = fixture();
    f.set({ lesson: lesson() });
    render(<FreelingoApp services={f.services} lifecycle={f.lifecycle} />);
    fireEvent.click(await screen.findByRole('button', { name: 'hello' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Check' }).getAttribute('aria-disabled')).not.toBe(
        'true',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await screen.findByText('Correct!');
    fireEvent.click(screen.getByRole('button', { name: 'Report exercise' }));
    fireEvent.click(screen.getByRole('button', { name: 'Source and credits' }));
    await screen.findByText('Local-only learning.');
    expect(screen.queryByRole('tab', { name: 'Learn' })).toBeNull();
    act(() => {
      expect(f.back()).toBe(true);
    });
    expect(await screen.findByText('Correct!')).toBeTruthy();
    expect(f.runtime.dispatchLesson).not.toHaveBeenCalledWith({
      type: 'exit',
      route: 'hardwareBack',
    });
  });
  it('[INV-PER-06] exposes failed startup and retries the actual service without fabricated path facts', async () => {
    const f = fixture();
    vi.mocked(f.services.open).mockRejectedValueOnce(new Error('Migration failed'));
    const view = render(<FreelingoApp services={f.services} lifecycle={f.lifecycle} />);
    expect(await screen.findByText('Migration failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Verify or download course' })).toBeTruthy();
    expect(f.services.open).toHaveBeenCalledTimes(2);
    view.unmount();
    await waitFor(() => expect(f.runtime.close).toHaveBeenCalledTimes(1));
  });
  it('[INV-MOD-01] actual settings controls call the durable preference port and refresh from storage', async () => {
    const f = fixture();
    render(<FreelingoApp services={f.services} lifecycle={f.lifecycle} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preferences' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Listening exercises' }));
    await waitFor(() =>
      expect(f.runtime.loop.setPreference).toHaveBeenCalledWith('es', {
        key: 'listening',
        value: false,
        clearSuspension: null,
      }),
    );
  });
  it('[INV-SESS-14] hardware back from an answered player reaches the real unified quit sheet', async () => {
    const f = fixture();
    const content = lesson();
    f.set({ lesson: content });
    render(<FreelingoApp services={f.services} lifecycle={f.lifecycle} />);
    fireEvent.click(await screen.findByRole('button', { name: 'hello' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Check' }).getAttribute('aria-disabled')).not.toBe(
        'true',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await screen.findByText('Correct!');
    act(() => {
      expect(f.back()).toBe(true);
    });
    expect(await screen.findByRole('button', { name: 'Keep learning' })).toBeTruthy();
    expect(f.runtime.dispatchLesson).toHaveBeenCalledWith({ type: 'exit', route: 'hardwareBack' });
    expect(screen.queryByRole('button', { name: 'Verify or download course' })).toBeNull();
  });
  it('[INV-SESS-15] collision choices call the explicit durable decision instead of clobbering the current lesson', async () => {
    const f = fixture();
    f.set({
      sessionOffer: {
        kind: 'collision',
        sessionId: 'live',
        lessonLabel: 'Spanish lesson',
        exerciseIndex: 3,
        exerciseCount: 12,
      },
    });
    render(<FreelingoApp services={f.services} lifecycle={f.lifecycle} />);
    expect(await screen.findByText('Exercise 4 of 12')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(f.runtime.resolveSessionOffer).toHaveBeenCalledWith('resume'));
    expect(f.runtime.launchLesson).not.toHaveBeenCalled();
  });
  it('[INV-SESS-27] lifecycle signals call one retained runtime without reopening SQLite', async () => {
    const f = fixture();
    render(<FreelingoApp services={f.services} lifecycle={f.lifecycle} />);
    await screen.findByRole('button', { name: 'Settings' });
    act(() => {
      f.appState(false);
      f.appState(true);
    });
    await waitFor(() => expect(f.runtime.foreground).toHaveBeenCalledTimes(1));
    expect(f.runtime.background).toHaveBeenCalledTimes(1);
    expect(f.services.open).toHaveBeenCalledTimes(1);
  });
});

it('[INV-SCH-11] App forwards exact visible source exposure to its durable runtime', async () => {
  const f = fixture();
  f.set({ lesson: lesson() });
  render(<FreelingoApp services={f.services} />);
  await waitFor(() =>
    expect(f.runtime.recordExposure).toHaveBeenCalledWith({
      sessionId: 'session-1',
      slotId: 'slot-1',
      itemId: 'item-1',
      exerciseId: 'exercise-1',
      when: 'prompt',
    }),
  );
});
