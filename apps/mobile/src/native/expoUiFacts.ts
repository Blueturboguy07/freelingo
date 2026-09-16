import { AccessibilityInfo, Appearance, Platform } from 'react-native';
import { createNativeUiFacts, type NativeUiDriver, type NativeUiField } from './nativeUiFacts';

/** RN0.86 native read APIs and change events. No permission request or app preference
 * write occurs here. Android does not expose iOS Bold Text; its font scaling remains native. */
export async function openExpoUiFacts() {
  const platform = Platform.OS;
  if (platform !== 'ios' && platform !== 'android')
    throw new Error('Native UI observations require iOS or Android.');
  const query: NativeUiDriver['query'] = (field) => {
    switch (field) {
      case 'screenReaderActive':
        return AccessibilityInfo.isScreenReaderEnabled();
      case 'reduceMotion':
        return AccessibilityInfo.isReduceMotionEnabled();
      case 'highContrast':
        return platform === 'ios'
          ? AccessibilityInfo.isDarkerSystemColorsEnabled()
          : AccessibilityInfo.isHighTextContrastEnabled();
      case 'boldText':
        return platform === 'ios' ? AccessibilityInfo.isBoldTextEnabled() : Promise.resolve(false);
    }
  };
  const events = {
    screenReaderActive: 'screenReaderChanged',
    reduceMotion: 'reduceMotionChanged',
    highContrast: platform === 'ios' ? 'darkerSystemColorsChanged' : 'highTextContrastChanged',
    boldText: 'boldTextChanged',
  } as const satisfies Record<NativeUiField, string>;
  const facts = createNativeUiFacts({
    readTheme: () => {
      const theme = Appearance.getColorScheme();
      return theme === 'unspecified' ? null : theme;
    },
    query,
    onFact(field, listener) {
      if (field === 'boldText' && platform === 'android') return { remove() {} };
      return AccessibilityInfo.addEventListener(events[field], listener);
    },
    onTheme: (listener) => Appearance.addChangeListener(listener),
  });
  try {
    await facts.refresh();
    return facts;
  } catch (error) {
    try {
      facts.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Native UI initialization and cleanup failed.');
    }
    throw error;
  }
}
