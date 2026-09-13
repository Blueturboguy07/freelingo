// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const rn = vi.hoisted(() => ({
  Platform: { OS: 'ios' },
  AccessibilityInfo: {
    isScreenReaderEnabled: vi.fn(),
    isReduceMotionEnabled: vi.fn(),
    isDarkerSystemColorsEnabled: vi.fn(),
    isHighTextContrastEnabled: vi.fn(),
    isBoldTextEnabled: vi.fn(),
    addEventListener: vi.fn(),
  },
  Appearance: { getColorScheme: vi.fn(), addChangeListener: vi.fn() },
}));
vi.mock('react-native', () => rn);
import { openExpoUiFacts } from './expoUiFacts';
const removals: ReturnType<typeof vi.fn>[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  removals.length = 0;
  rn.Platform.OS = 'ios';
  rn.Appearance.getColorScheme.mockReturnValue('dark');
  rn.Appearance.addChangeListener.mockImplementation(() => {
    const remove = vi.fn();
    removals.push(remove);
    return { remove };
  });
  rn.AccessibilityInfo.addEventListener.mockImplementation(() => {
    const remove = vi.fn();
    removals.push(remove);
    return { remove };
  });
  rn.AccessibilityInfo.isScreenReaderEnabled.mockResolvedValue(true);
  rn.AccessibilityInfo.isReduceMotionEnabled.mockResolvedValue(true);
  rn.AccessibilityInfo.isDarkerSystemColorsEnabled.mockResolvedValue(true);
  rn.AccessibilityInfo.isHighTextContrastEnabled.mockResolvedValue(true);
  rn.AccessibilityInfo.isBoldTextEnabled.mockResolvedValue(true);
});
it('[INV-A11Y-06][INV-A11Y-14] iOS binds observed screen reader, motion, Bold Text and darker system colors', async () => {
  const facts = await openExpoUiFacts();
  expect(facts.read()).toEqual({
    theme: 'dark',
    screenReaderActive: true,
    reduceMotion: true,
    highContrast: true,
    boldText: true,
  });
  expect(rn.AccessibilityInfo.isHighTextContrastEnabled).not.toHaveBeenCalled();
  expect(rn.AccessibilityInfo.addEventListener.mock.calls.map(([name]) => name)).toEqual([
    'reduceMotionChanged',
    'screenReaderChanged',
    'darkerSystemColorsChanged',
    'boldTextChanged',
  ]);
  facts.close();
  for (const remove of removals) expect(remove).toHaveBeenCalledOnce();
});
it('[INV-A11Y-06][INV-A11Y-14] Android observes high text contrast and never invokes iOS-only APIs', async () => {
  rn.Platform.OS = 'android';
  const facts = await openExpoUiFacts();
  expect(facts.read()).toMatchObject({
    highContrast: true,
    boldText: false,
    screenReaderActive: true,
  });
  expect(rn.AccessibilityInfo.isDarkerSystemColorsEnabled).not.toHaveBeenCalled();
  expect(rn.AccessibilityInfo.isBoldTextEnabled).not.toHaveBeenCalled();
  expect(rn.AccessibilityInfo.addEventListener.mock.calls.map(([name]) => name)).toEqual([
    'reduceMotionChanged',
    'screenReaderChanged',
    'highTextContrastChanged',
  ]);
  facts.close();
});
it('[INV-A11Y-06] failed native initialization cleans all listeners and returns no usable resource', async () => {
  rn.AccessibilityInfo.isScreenReaderEnabled.mockRejectedValue(new Error('native unavailable'));
  await expect(openExpoUiFacts()).rejects.toThrow(/screenReaderActive/);
  for (const remove of removals) expect(remove).toHaveBeenCalledOnce();
});
it('[INV-A11Y-06] unsupported hosts do not invent native accessibility facts', async () => {
  rn.Platform.OS = 'web';
  await expect(openExpoUiFacts()).rejects.toThrow(/iOS or Android/);
  expect(rn.AccessibilityInfo.addEventListener).not.toHaveBeenCalled();
});
