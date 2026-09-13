import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { THEME } from '../tokens/index.js';
export interface UiPreferences {
  readonly theme?: 'light' | 'dark';
  readonly highContrast?: boolean;
  readonly boldText?: boolean;
}
const UiContext = createContext<UiPreferences>({ theme: 'dark' });
export function UiProvider({
  children,
  theme = 'dark',
  highContrast = false,
  boldText = false,
}: UiPreferences & { readonly children: ReactNode }) {
  return (
    <UiContext.Provider value={{ theme, highContrast, boldText }}>{children}</UiContext.Provider>
  );
}
export function useUiTheme() {
  const prefs = useContext(UiContext);
  return { ...prefs, colors: THEME[prefs.theme ?? 'dark'] };
}
