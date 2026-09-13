import type { UiPreferences } from '@freelingo/ui';
export const NATIVE_UI_FIELDS = [
  'reduceMotion',
  'screenReaderActive',
  'highContrast',
  'boldText',
] as const;
export type NativeUiField = (typeof NATIVE_UI_FIELDS)[number];
export interface NativeUiDriver {
  readTheme(): 'light' | 'dark' | null | undefined;
  query(field: NativeUiField): Promise<boolean>;
  onFact(field: NativeUiField, listener: (value: boolean) => void): { remove(): void };
  onTheme(listener: () => void): { remove(): void };
}
export interface NativeUiSnapshot extends Required<UiPreferences> {
  readonly reduceMotion: boolean;
  readonly screenReaderActive: boolean;
}
/** Freelingo fallback when the OS declares no appearance preference; 2026-09-13.
 * Accessibility facts have no fallback: unknown cannot silently enable tracing/motion. */
export const NATIVE_UI_CONFIG = { unspecifiedTheme: 'light' } as const;
export function createNativeUiFacts(driver: NativeUiDriver) {
  const values: Partial<Record<NativeUiField, boolean>> = {};
  const versions = { reduceMotion: 0, screenReaderActive: 0, highContrast: 0, boldText: 0 };
  const listeners = new Set<() => void>();
  const subscriptions: { remove(): void }[] = [];
  let closed = false,
    pending: Promise<void> | null = null;
  function requireOpen() {
    if (closed) throw new Error('Native UI observations are closed.');
  }
  function publish() {
    if (!closed) for (const listener of listeners) listener();
  }
  function read(): NativeUiSnapshot {
    requireOpen();
    const missing = NATIVE_UI_FIELDS.filter((field) => typeof values[field] !== 'boolean');
    if (missing.length)
      throw new Error('Native UI observations unavailable: ' + missing.join(', '));
    const theme = driver.readTheme() ?? NATIVE_UI_CONFIG.unspecifiedTheme;
    if (theme !== 'light' && theme !== 'dark')
      throw new Error('Native UI appearance is unavailable.');
    return Object.freeze({
      theme,
      reduceMotion: values.reduceMotion!,
      screenReaderActive: values.screenReaderActive!,
      highContrast: values.highContrast!,
      boldText: values.boldText!,
    });
  }
  function close() {
    if (closed) return;
    closed = true;
    listeners.clear();
    const failures: unknown[] = [];
    for (const subscription of subscriptions.splice(0)) {
      try {
        subscription.remove();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Native UI listener cleanup failed.');
  }
  try {
    for (const field of NATIVE_UI_FIELDS) {
      subscriptions.push(
        driver.onFact(field, (value) => {
          if (closed) return;
          versions[field]++;
          if (typeof value === 'boolean') values[field] = value;
          else delete values[field];
          publish();
        }),
      );
    }
    subscriptions.push(driver.onTheme(publish));
  } catch (error) {
    try {
      close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Native UI listener setup and cleanup failed.');
    }
    throw error;
  }
  return {
    read,
    /** Called at startup and on foreground before any source generation. Subscribe first,
     * then query; per-field event revisions prevent delayed OS answers overwriting updates. */
    refresh(): Promise<void> {
      requireOpen();
      if (pending) return pending;
      const observedVersions = { ...versions };
      pending = Promise.all(
        NATIVE_UI_FIELDS.map(async (field) => {
          let result: unknown;
          try {
            result = await driver.query(field);
          } catch {
            result = undefined;
          }
          if (closed || versions[field] !== observedVersions[field]) return;
          if (typeof result === 'boolean') values[field] = result;
          else delete values[field];
          // Failure is visible immediately even if a sibling native query never resolves.
          publish();
        }),
      )
        .then(() => {
          read();
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    subscribe(listener: () => void): () => void {
      requireOpen();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close,
  };
}
