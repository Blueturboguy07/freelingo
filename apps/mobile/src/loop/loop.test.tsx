import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { UiProvider } from '@freelingo/ui';
import { toLocalDay } from '@freelingo/core/day';
import {
  runCeremony,
  CEREMONY_SLOTS,
  ONE_TIME_SLOTS,
  EMPTY_BUNDLE,
  FRESH_STREAK_GOAL_STATE,
  type CeremonyState,
} from '@freelingo/core/ceremony';
import type { HubInput } from '@freelingo/core/hub';
import { PracticeHubScreen } from './PracticeHubScreen';
import { CeremonyScreen, nextCeremonyIndex, CEREMONY_COMBO_BEAT_MS } from './CeremonyScreen';
import { SettingsScreen } from './SettingsScreen';
import type { CeremonyPresentation, LoopPorts, SettingsSnapshot } from './contracts';

const day = toLocalDay('2026-09-13');
const hub = (): HubInput => ({
  courseId: 'en-es',
  courseLabel: 'Spanish',
  localDay: day,
  nowUtc: '2026-09-13T12:00:00Z',
  seed: 'a',
  items: [],
  mistakes: [],
  sharedReview: { localDay: day, itemIds: [], spentIds: [] },
  completedUnitIndices: [],
  currentUnitIndex: 1,
  unitLastOfferedDays: {},
  pathOffer: null,
  lastPathCompletedDay: day,
  preferences: {
    listening: false,
    speaking: true,
    listeningUntilUtc: null,
    speakingUntilUtc: null,
  },
  audioAvailable: true,
  microphoneAvailable: true,
  packReady: true,
  daily: null,
  activeBoost: null,
  ladders: {},
  otherCourseMistakes: [{ courseId: 'en-fr', courseLabel: 'French', count: 2 }],
});
const ports = (): LoopPorts => ({
  navigate: vi.fn(),
  launchHub: vi.fn().mockResolvedValue(undefined),
  saveHubDaily: vi.fn().mockResolvedValue(undefined),
  switchCourse: vi.fn().mockResolvedValue(undefined),
  setPreference: vi.fn().mockResolvedValue(undefined),
  setAppearance: vi.fn().mockResolvedValue(undefined),
  setGoal: vi.fn().mockResolvedValue(undefined),
  applyCourseAction: vi.fn().mockResolvedValue(undefined),
  advanceCeremony: vi.fn().mockResolvedValue(undefined),
  retryCommit: vi.fn().mockResolvedValue(undefined),
  launchLegendary: vi.fn().mockResolvedValue(undefined),
  shareCard: vi.fn().mockResolvedValue(undefined),
  playWord: vi.fn().mockResolvedValue(undefined),
});
const settings = (): SettingsSnapshot => ({
  courseId: 'en-es',
  nowUtc: '2026-09-13T12:00:00Z',
  importedAtUtc: null,
  preferences: {
    soundEffects: true,
    animations: true,
    motivationalMessages: true,
    listening: true,
    speaking: true,
  },
  suspensions: { listening: null, speaking: null },
  appearance: 'system',
  goalTier: 'regular',
  courses: [
    { courseId: 'en-es', name: 'Spanish', progressLabel: 'Section 1 · 10%', audioBytes: 1000 },
  ],
  appVersion: '0.0.0',
});
const ceremony = (flavour = 'practice', mistakes = 0): CeremonyPresentation => {
  const state: CeremonyState = {
    account: {
      streak: 1,
      streakBeat: 'already-extended',
      streakGoal: { ...FRESH_STREAK_GOAL_STATE, goal: 7 },
      streakGoalCheckpointCrossed: false,
      streakSocietyBeat: 'none',
      perfectStreakBeat: 'none',
      questsProgressed: 0,
      achievementCrossings: [],
      bundle: EMPTY_BUNDLE,
      dailyGoalReachedThisSession: false,
      consecutiveGoalMetDays: 0,
    },
    course: {
      courseId: 'en-es',
      scoreEntries: [],
      nodeCompletedThisSession: false,
      nodeIsComplete: false,
      nodeIsLegendary: false,
      legendaryAvailable: false,
      takeover: { consecutiveDeclines: 0 },
      unitCompleted: false,
      sectionCompleted: false,
      courseCompleted: false,
    },
    session: {
      sessionId: 's1',
      flavour,
      gradedItems: 10,
      mistakes,
      xp: 10,
      outcome: 'passed',
      gated: false,
    },
    milestoneDays: [7, 30, 100, 365, 1000],
  };
  return {
    status: 'committed',
    state,
    result: runCeremony(state),
    index: 0,
    facts: {
      courseName: 'Spanish',
      combo: 10,
      accuracy: 1,
      xpExplanation: '',
      unitIndex: 1,
      unitName: 'First words',
      sectionName: 'First steps',
      score: 1,
    },
    animations: false,
    reduceMotion: false,
  };
};
it('[INV-HUB-04] an empty Hub displays the cold state and exposes no START', () => {
  render(<PracticeHubScreen input={hub()} ports={ports()} />);
  expect(screen.queryByRole('button', { name: 'START' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Practice' })).toBeDefined();
});
it('[INV-HUB-01] an other-course footer invokes an explicit course switch', async () => {
  const p = ports();
  render(<PracticeHubScreen input={hub()} ports={p} />);
  fireEvent.click(screen.getByRole('button', { name: 'French · 2 mistakes' }));
  await waitFor(() => expect(p.switchCourse).toHaveBeenCalledWith('en-fr'));
  expect(screen.getByText('Spanish')).toBeDefined();
});
it('[INV-HUB-09] the disabled listening card offers persisted re-enable', async () => {
  const p = ports();
  render(<PracticeHubScreen input={hub()} ports={p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Turn on listening' }));
  await waitFor(() =>
    expect(p.setPreference).toHaveBeenCalledWith('en-es', {
      key: 'listening',
      value: true,
      clearSuspension: 'listening',
    }),
  );
});
it('[INV-CER-01] uncommitted or failed rewards are never displayed', () => {
  const p = ports();
  const { rerender } = render(<CeremonyScreen presentation={{ status: 'saving' }} ports={p} />);
  expect(screen.queryByText('TOTAL XP')).toBeNull();
  rerender(
    <CeremonyScreen presentation={{ status: 'failed', message: 'Storage is full' }} ports={p} />,
  );
  expect(screen.getByText("Couldn't save this session")).toBeDefined();
  expect(screen.queryByText('TOTAL XP')).toBeNull();
});
it('[INV-CER-05] practice at100 shows two resolved tiles; Perfect lesson keeps one COMBO', () => {
  const p = ports();
  const { rerender } = render(<CeremonyScreen presentation={ceremony()} ports={p} />);
  expect(screen.getByText('Practice Complete!')).toBeDefined();
  expect(screen.getByText('AMAZING')).toBeDefined();
  expect(screen.getByText('TOTAL XP')).toBeDefined();
  expect(screen.queryByText('COMBO')).toBeNull();
  rerender(<CeremonyScreen presentation={ceremony('lesson')} ports={p} />);
  expect(screen.getByText('Perfect lesson!')).toBeDefined();
  expect(screen.getByText('COMBO')).toBeDefined();
  expect(screen.queryByText('TOTAL XP')).toBeNull();
});
it('[INV-GRD-06] an undefined accuracy is omitted instead of shown as zero', () => {
  const data = ceremony();
  if (data.status !== 'committed') throw Error();
  render(
    <CeremonyScreen
      presentation={{ ...data, facts: { ...data.facts, accuracy: null } }}
      ports={ports()}
    />,
  );
  expect(screen.getByText('TOTAL XP')).toBeDefined();
  expect(screen.queryByText('0%')).toBeNull();
});
it('[INV-CER-02] double CONTINUE during persistence advances only once', async () => {
  const p = ports();
  p.advanceCeremony = vi.fn(() => new Promise<void>(() => {}));
  render(<CeremonyScreen presentation={ceremony()} ports={p} />);
  fireEvent.click(screen.getByRole('button', { name: 'CONTINUE' }));
  fireEvent.click(screen.getByRole('button', { name: 'CONTINUE' }));
  await waitFor(() => expect(p.advanceCeremony).toHaveBeenCalledTimes(1));
});
it('[INV-CER-16] every Score-chain CTA is macaw and the unchanged engine result is consumed', () => {
  const data = ceremony();
  if (data.status !== 'committed') throw Error();
  const state = {
    ...data.state,
    course: {
      ...data.state.course,
      scoreEntries: [{ slot: 'S068_scoreUnlock' as const, bandBeats: 0 }],
    },
  };
  const result = runCeremony(state);
  render(<CeremonyScreen presentation={{ ...data, state, result, index: 1 }} ports={ports()} />);
  expect(screen.getByTestId('ceremony-continue')).toBeDefined();
  expect(screen.getByText('You unlocked your Spanish Score!')).toBeDefined();
});
it('[INV-CRS-02] a course cannot be removed in the import undo window', () => {
  const data = { ...settings(), importedAtUtc: '2026-09-13T10:00:00Z' };
  render(<SettingsScreen route="courses" snapshot={data} ports={ports()} />);
  expect(screen.getByRole('button', { name: 'Remove Spanish' }).getAttribute('aria-disabled')).toBe(
    'true',
  );
  expect(
    screen
      .getAllByText(/course removal is paused for 24 hours/i)
      .some((node) => getComputedStyle(node).opacity !== '0'),
  ).toBe(true);
});
it('[INV-HUB-09] a failed preference save remains visible and never pretends the toggle changed', async () => {
  const p = ports();
  p.setPreference = vi.fn().mockRejectedValue(new Error('Could not save preference'));
  render(<SettingsScreen route="preferences" snapshot={settings()} ports={p} />);
  fireEvent.click(screen.getByRole('switch', { name: 'Listening exercises' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
  expect(
    (screen.getByRole('switch', { name: 'Listening exercises' }) as HTMLInputElement).checked,
  ).toBe(true);
});

it.each(CEREMONY_SLOTS)('[INV-CER-02] %s has a defined render with CONTINUE last', (slot) => {
  const data = ceremony();
  if (data.status !== 'committed') throw Error();
  render(
    <CeremonyScreen
      presentation={{ ...data, result: { ...data.result, chain: [slot] } }}
      ports={ports()}
    />,
  );
  expect(screen.getByRole('heading').textContent?.length).toBeGreaterThan(0);
  const buttons = screen.getAllByRole('button');
  expect(buttons[buttons.length - 1]?.textContent).toBe('CONTINUE');
  expect(document.body.textContent).not.toContain('undefined');
});
it('[INV-CER-13] skip repeated beats retains every subsequent one-time beat in canonical order', () => {
  const data = ceremony();
  if (data.status !== 'committed') throw Error();
  const result = { ...data.result, chain: [...CEREMONY_SLOTS] };
  const kept = [];
  let at = 0;
  while (at < result.chain.length) {
    at = nextCeremonyIndex(result, at, true);
    if (at < result.chain.length) kept.push(result.chain[at]);
  }
  expect(kept).toEqual(
    CEREMONY_SLOTS.filter((s) => ONE_TIME_SLOTS.includes(s) || s === 'S087_returnToPath'),
  );
});
it.each(['Not now', 'Skip all'])(
  '[INV-CER-08] %s records a deferred goal picker in the same CAS advancement',
  async (label) => {
    const data = ceremony();
    if (data.status !== 'committed') throw Error();
    const p = ports();
    render(
      <CeremonyScreen
        presentation={{
          ...data,
          result: {
            ...data.result,
            chain: ['S072_streakGoalPicker', 'S074_streakStartsTomorrow', 'S087_returnToPath'],
          },
        }}
        ports={p}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() =>
      expect(p.advanceCeremony).toHaveBeenCalledWith({
        sessionId: 's1',
        expectedIndex: 0,
        nextIndex: label === 'Skip all' ? 2 : 1,
        goalChoice: { kind: 'defer' },
      }),
    );
  },
);
it('[INV-CER-05] the animation beat resolves only the tiles and never advances a ceremony', () => {
  vi.useFakeTimers();
  try {
    const data = ceremony('lesson', 1);
    if (data.status !== 'committed') throw Error();
    const p = ports();
    render(<CeremonyScreen presentation={{ ...data, animations: true }} ports={p} />);
    expect(screen.getByText('COMBO')).toBeDefined();
    act(() => vi.advanceTimersByTime(CEREMONY_COMBO_BEAT_MS + 1));
    expect(screen.getByText('TOTAL XP')).toBeDefined();
    expect(p.advanceCeremony).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it('[INV-CER-16] the actual Score CTA paints macaw blue', () => {
  const data = ceremony();
  if (data.status !== 'committed') throw Error();
  render(
    <CeremonyScreen
      presentation={{ ...data, result: { ...data.result, chain: ['S069_scoreProgress'] } }}
      ports={ports()}
    />,
  );
  expect(getComputedStyle(screen.getByTestId('ceremony-continue-face')).backgroundColor).toBe(
    'rgb(73, 192, 248)',
  );
});
it('[INV-CER-07] the one achievement card shows highest tier plus all extra tiers without a second reward', () => {
  const data = ceremony();
  if (data.status !== 'committed') throw Error();
  const state = {
    ...data.state,
    account: {
      ...data.state.account,
      achievementCrossings: [1, 2, 3].map((tier) => ({
        achievementId: 'scholar',
        achievementName: 'Scholar',
        tier,
        gems: 10,
      })),
    },
  };
  const result = runCeremony(state);
  const index = result.chain.indexOf('S079_achievement');
  render(<CeremonyScreen presentation={{ ...data, state, result, index }} ports={ports()} />);
  expect(screen.getByText('Scholar · Level 3')).toBeDefined();
  expect(screen.getByText('+2 tiers')).toBeDefined();
  expect(screen.queryByText('+30 gems')).toBeNull();
});
it('[INV-CER-02] three progressed quests do not falsely claim all three completed', () => {
  const data = ceremony();
  if (data.status !== 'committed') throw Error();
  const state = { ...data.state, account: { ...data.state.account, questsProgressed: 3 } };
  const result = runCeremony(state);
  render(
    <CeremonyScreen
      presentation={{ ...data, state, result, index: result.chain.indexOf('S078_quests') }}
      ports={ports()}
    />,
  );
  expect(screen.queryByText('All Daily Quests complete!')).toBeNull();
  expect(screen.getByText('3 Daily Quests updated!')).toBeDefined();
});

it('[INV-TYP-04] loop typography follows both declared theme palettes rather than fixed dark ink', () => {
  const { rerender } = render(
    <UiProvider theme="light">
      <PracticeHubScreen input={hub()} ports={ports()} />
    </UiProvider>,
  );
  expect(getComputedStyle(screen.getByRole('heading', { name: 'Practice' })).color).toBe(
    'rgb(75, 75, 75)',
  );
  rerender(
    <UiProvider theme="dark">
      <PracticeHubScreen input={hub()} ports={ports()} />
    </UiProvider>,
  );
  expect(getComputedStyle(screen.getByRole('heading', { name: 'Practice' })).color).toBe(
    'rgb(241, 247, 251)',
  );
});

it('[INV-PACK-04] unknown installed audio size is never displayed as zero or the expected total', () => {
  const data = settings();
  render(
    <SettingsScreen
      route="courses"
      snapshot={{
        ...data,
        courses: data.courses.map((course) => ({ ...course, audioBytes: null })),
      }}
      ports={ports()}
    />,
  );
  expect(screen.getByText(/Audio size unavailable/)).toBeTruthy();
  expect(screen.queryByText(/0 MB audio/)).toBeNull();
});
