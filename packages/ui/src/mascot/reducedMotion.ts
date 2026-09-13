import { useMemo, useSyncExternalStore } from 'react';
interface MotionMediaQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', notify: () => void): void;
  removeEventListener(type: 'change', notify: () => void): void;
}
const runtime = globalThis as typeof globalThis & {
  matchMedia?: (query: string) => MotionMediaQuery;
};
/** Offline web/SSR motion preference. Unknown means still until a real preference
 * is available; no timer or device API is called while rendering. */
export function useMascotReducedMotion(): boolean {
  const media = useMemo(
    () =>
      typeof runtime.matchMedia === 'function'
        ? runtime.matchMedia('(prefers-reduced-motion: reduce)')
        : null,
    [],
  );
  return useSyncExternalStore(
    (notify) => {
      media?.addEventListener('change', notify);
      return () => media?.removeEventListener('change', notify);
    },
    () => media?.matches ?? true,
    () => true,
  );
}
