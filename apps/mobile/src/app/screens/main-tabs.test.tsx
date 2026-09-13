import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  achievementCounterColumns,
  ENABLED_SURFACES,
  questsForDay,
  toQuestRow,
} from '@freelingo/core/economy';
import { toLocalDay } from '@freelingo/core/day';
import type { DayCell } from '@freelingo/core/day';
import { QuestsScreen } from './QuestsScreen';
import { ShopScreen } from './ShopScreen';
import { ProfileScreen } from './ProfileScreen';
import type { MainTabsPorts, ProfileSnapshot, QuestsSnapshot, ShopSnapshot } from './contracts';
function ports(): MainTabsPorts {
  return {
    purchaseShopEntry: vi.fn(async () => {}),
    equipCosmetic: vi.fn(async () => {}),
    activateHeldBoost: vi.fn(async () => {}),
    shareWeeklyReport: vi.fn(async () => {}),
  };
}
const day = toLocalDay('2026-09-13');
function quests(): QuestsSnapshot {
  return {
    localDay: day,
    resetInSeconds: 10800,
    quests: questsForDay(day, 'device', { trailingDailyXp: [20], goalXp: 20 }).map((q) => ({
      ...toQuestRow(q),
      progress: q.target,
      completedAtUtc: '2026-09-13T10:00:00Z',
    })),
    badge: { monthKey: '2026-09', questsCompleted: 11, targetQuests: 30, tier: 'bronze' },
    badgeHistory: [{ monthKey: '2026-08', questsCompleted: 30, targetQuests: 30, tier: 'bronze' }],
  };
}
function shop(): ShopSnapshot {
  return {
    gems: 500,
    freezes: { held: 2, cap: 2, refillInDays: 5 },
    activeBoost: null,
    boostInventory: [
      { id: 'grant-30', multiplier: 2, durationMinutes: 30 },
      { id: 'grant-15', multiplier: 2, durationMinutes: 15 },
    ],
    ownedCosmeticIds: [],
    equippedCosmeticId: null,
  };
}
function profile(): ProfileSnapshot {
  return {
    joinedLabel: 'Joined September 2026',
    streak: 0,
    lifetimeXp: 0,
    societyBadge: null,
    counters: Object.fromEntries(achievementCounterColumns().map((key) => [key, 0])),
    counterMaximums: Object.fromEntries(achievementCounterColumns().map((key) => [key, null])),
    installedFeatures: { enabledSurfaces: ENABLED_SURFACES, packFeatures: [] },
    records: { longestStreak: 0, dailyMostXp: 0, perfectLessons: 0 },
    calendar: { monthLabel: 'September 2026', today: day, cells: [] },
    weeklyReport: {
      periodLabel: 'September 7–13',
      wordsStudied: 3,
      lessonsFinished: 2,
      streak: 0,
      studyMinutes: 7,
      previousStudyMinutes: 4,
      courseProgressLabel: 'Spanish · Unit 1',
    },
  };
}
describe('source-backed main tabs', () => {
  it('[S118] unfinished cards show exact persisted progress and selected tab semantics', () => {
    const value = quests();
    render(
      <QuestsScreen
        snapshot={{
          ...value,
          quests: value.quests.map((q) => ({ ...q, progress: 1, completedAtUtc: null })),
        }}
      />,
    );
    expect(screen.queryByText('Completed')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Daily' }).getAttribute('aria-selected')).toBe('true');
    for (const quest of value.quests)
      expect(
        screen.getByRole('progressbar', { name: quest.copy }).getAttribute('aria-valuenow'),
      ).toBe('1');
  });
  it('[S122] an available held boost activates its exact saved grant id', async () => {
    const action = ports();
    render(<ShopScreen snapshot={shop()} ports={action} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use 30-minute XP Boost' }));
    await waitFor(() => expect(action.activateHeldBoost).toHaveBeenCalledWith('grant-30'));
  });
  it('[INV-ECO-13] profile displays the supplied account lifetime total', () => {
    render(<ProfileScreen snapshot={{ ...profile(), lifetimeXp: 15342 }} ports={ports()} />);
    expect(screen.getByText('15342')).toBeTruthy();
  });
  it('[S125] missing counter evidence is visible rather than manufacturing a zero award', () => {
    render(<ProfileScreen snapshot={{ ...profile(), counters: {} }} ports={ports()} />);
    expect(screen.getByRole('alert').textContent).toContain('Some award progress is unavailable');
    expect(screen.queryByRole('button', { name: /Regal/ })).toBeNull();
  });

  it('[INV-ECO-10] three completed daily cards remain visible with the actual reset countdown', () => {
    const value = quests();
    render(<QuestsScreen snapshot={value} />);
    for (const quest of value.quests) expect(screen.getByText(quest.copy)).toBeTruthy();
    expect(screen.getAllByText('Completed')).toHaveLength(3);
    expect(screen.getByText('3 hours')).toBeTruthy();
    expect(screen.queryByText('More quests unlock soon')).toBeNull();
  });
  it('[INV-ECO-22] badge progress uses completed quests and preserves the separate month history', () => {
    render(<QuestsScreen snapshot={quests()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Badges' }));
    expect(screen.getByText('11 / 30 quests')).toBeTruthy();
    expect(screen.getByText('2026-08')).toBeTruthy();
    expect(screen.queryByText('11 XP')).toBeNull();
  });
  it('[INV-ECO-12] shop exposes only approved gem sinks and a full freeze cap is not purchasable', () => {
    const action = ports();
    render(<ShopScreen snapshot={shop()} ports={action} />);
    expect(screen.getByText('2 / 2 EQUIPPED')).toBeTruthy();
    expect(screen.getByText('Your Streak Freezes are at the 2-freeze limit')).toBeTruthy();
    expect(screen.getByText('Parrot wardrobe')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Equipped' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    for (const unsupported of [
      'Refill Hearts',
      'Legendary entry',
      'Timer Boost',
      'Double-or-Nothing',
      'Weekend Amulet',
    ])
      expect(screen.queryByText(unsupported)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Equipped' }));
    expect(action.purchaseShopEntry).not.toHaveBeenCalled();
  });
  it('[S120/S121] a failed purchase never changes visible balance or equips the item optimistically', async () => {
    const action = ports();
    let reject!: (reason: unknown) => void;
    const pending = new Promise<void>((_, no) => {
      reject = no;
    });
    vi.mocked(action.purchaseShopEntry).mockReturnValue(pending);
    render(
      <ShopScreen
        snapshot={{ ...shop(), freezes: { held: 1, cap: 2, refillInDays: 5 } }}
        ports={action}
      />,
    );
    const buy = screen.getByRole('button', { name: 'Get Streak Freeze for 100 gems' });
    fireEvent.click(buy);
    fireEvent.click(buy);
    await waitFor(() => expect(action.purchaseShopEntry).toHaveBeenCalledTimes(1));
    expect(screen.getByText('500 gems')).toBeTruthy();
    await act(async () => {
      reject(new Error('Purchase could not be saved'));
    });
    expect(await screen.findByText('Purchase could not be saved')).toBeTruthy();
    expect(screen.getByText('1 / 2 EQUIPPED')).toBeTruthy();
    expect(screen.getByText('500 gems')).toBeTruthy();
  });
  it('[S120/S121] insufficient gems disable the exact configured purchase with an explanation', () => {
    const action = ports();
    render(
      <ShopScreen
        snapshot={{ ...shop(), gems: 99, freezes: { held: 1, cap: 2, refillInDays: null } }}
        ports={action}
      />,
    );
    const buy = screen.getByRole('button', { name: 'Get Streak Freeze for 100 gems' });
    expect(buy.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByText('Not enough gems').length).toBeGreaterThan(0);
  });
  it('[INV-ECO-03] held boosts retain their own durations and cannot extend a running boost', () => {
    const action = ports();
    render(
      <ShopScreen
        snapshot={{ ...shop(), activeBoost: { multiplier: 2, remainingSeconds: 61 } }}
        ports={action}
      />,
    );
    expect(screen.getByText('2× XP · 1:01 remaining')).toBeTruthy();
    const buttons = [
      screen.getByRole('button', { name: 'Use 30-minute XP Boost' }),
      screen.getByRole('button', { name: 'Use 15-minute XP Boost' }),
    ];
    for (const button of buttons) {
      expect(button.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(button);
    }
    expect(action.activateHeldBoost).not.toHaveBeenCalled();
  });
  it('[S123] an owned cosmetic equips only through the durable cosmetic port', async () => {
    const action = ports();
    render(
      <ShopScreen
        snapshot={{ ...shop(), ownedCosmeticIds: ['cosmetic-explorer-outfit'] }}
        ports={action}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Equip Explorer outfit' }));
    await waitFor(() =>
      expect(action.equipCosmetic).toHaveBeenCalledWith('cosmetic-explorer-outfit'),
    );
    expect(action.purchaseShopEntry).not.toHaveBeenCalled();
  });
  it('[INV-ECO-26] a fresh profile shows real zero counters and hides unreachable pack-only awards without an account gate', () => {
    const value = profile();
    render(
      <ProfileScreen
        snapshot={{ ...value, counterMaximums: { ...value.counterMaximums, words_learned: 0 } }}
        ports={ports()}
      />,
    );
    expect(screen.getByText('Joined September 2026')).toBeTruthy();
    expect(screen.getByText('Day streak')).toBeTruthy();
    expect(screen.getByText('Total XP')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Page Turner/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Scholar/ })).toBeNull();
    expect(screen.queryByText('Sign up')).toBeNull();
    expect(screen.queryByText('How old are you?')).toBeNull();
    expect(screen.getByRole('button', { name: /Regal/ })).toBeTruthy();
  });
  it('[INV-ECO-28] actual award details use the fixed reachable threshold ladder', () => {
    render(<ProfileScreen snapshot={profile()} ports={ports()} />);
    fireEvent.click(screen.getByRole('button', { name: /Regal/ }));
    expect(screen.getByText('Earn 3 Legendary level(s)')).toBeTruthy();
    expect(screen.getByText('3 · 7 · 12 · 18 · 25 · 35 · 50 · 65 · 80 · 100')).toBeTruthy();
  });
  it('[INV-DAY-03] calendar renders every declared disposition and its source provenance distinctly', () => {
    const cells: DayCell[] = [
      'flame',
      'half-flame',
      'snowflake',
      'grey',
      'outline',
      'unlived',
      'recovered',
    ];
    const value = profile();
    render(
      <ProfileScreen
        snapshot={{
          ...value,
          calendar: {
            ...value.calendar,
            cells: cells.map((cell, index) => ({
              day: toLocalDay(`2026-09-0${index + 1}`),
              cell,
              provenance: cell === 'unlived' ? 'This date never happened here' : null,
            })),
          },
        }}
        ports={ports()}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Calendar' }));
    for (const cell of cells) expect(screen.getByTestId(`calendar-${cell}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('calendar-unlived'));
    expect(screen.getByText('This date never happened here')).toBeTruthy();
  });
  it('[INV-ECO-20] weekly report uses source active minutes and shares only on an explicit tap', async () => {
    const action = ports();
    render(<ProfileScreen snapshot={profile()} ports={action} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Weekly report' }));
    expect(screen.getByText('7 minutes studied')).toBeTruthy();
    expect(action.shareWeeklyReport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Share stats' }));
    await waitFor(() => expect(action.shareWeeklyReport).toHaveBeenCalledTimes(1));
  });
});
