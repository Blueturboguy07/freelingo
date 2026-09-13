import { loadAsync } from 'expo-font';
import { Nunito_500Medium, Nunito_700Bold, Nunito_800ExtraBold } from '@expo-google-fonts/nunito';
import { NotoSansJP_500Medium } from '@expo-google-fonts/noto-sans-jp';
import { FONT } from '@freelingo/ui';
import type { AppFontPort } from './AppStartup';
/** Bundled files, not Google Fonts URLs. scope10/deep08 mapping verified2026-09-13. */
export const APP_FONT_ASSETS = {
  [FONT.body]: Nunito_500Medium,
  [FONT.strong]: Nunito_700Bold,
  [FONT.heading]: Nunito_800ExtraBold,
  [FONT.japanese]: NotoSansJP_500Medium,
} as const;
let pending: Promise<void> | null = null;
export const bundledFonts: AppFontPort = {
  load() {
    if (pending === null)
      pending = loadAsync(APP_FONT_ASSETS).catch((error: unknown) => {
        pending = null;
        throw error;
      });
    return pending;
  },
};
