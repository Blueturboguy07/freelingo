/**
 * Named config for the two P0 build gates (INV-PLAT-01, INV-PLAT-02).
 */

/**
 * Modules whose version must come from `npx expo install`, i.e. must equal the entry in
 * the installed SDK's `bundledNativeModules.json`. Reanimated and worklets are the pair
 * that breaks first when someone reaches for `npm install`.
 */
export const EXPO_PINNED_MODULES: readonly string[] = [
  'react-native-reanimated',
  'react-native-worklets',
  'react-native-gesture-handler',
  '@shopify/react-native-skia',
  'expo-sqlite',
  'expo-file-system',
  'expo-audio',
  'expo-haptics',
  'expo-speech',
  'expo-dev-client',
] as const;

/** Generated native trees. `expo prebuild` owns them; the repo never commits them. */
export const GENERATED_NATIVE_DIRS: readonly string[] = [
  'apps/mobile/ios',
  'apps/mobile/android',
] as const;

/** expo-av is dead in SDK 57; expo-audio replaces it (deep/09). */
export const FORBIDDEN_DEPENDENCIES: readonly string[] = ['expo-av', 'detox'] as const;
