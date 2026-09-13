import type { WidgetPublication } from '@freelingo/core/widget';
import type { WidgetPublicationStore, WidgetReloadPort } from './WidgetPublisher';
/** Native methods share one app-side lease, including across module/JS instances.
 * Native process death releases its lock. The OS target only reads snapshotJson. */
export interface WidgetPublicationNative {
  acquire(): Promise<string>;
  read(token: string): Promise<string | null>;
  write(token: string, publicationJson: string): Promise<void>;
  reload(token: string): Promise<void>;
  release(token: string): Promise<void>;
}
/** Named local transport policy, adopted 2026-09-13; no platform budget exemption. */
export const NATIVE_WIDGET_TRANSPORT = { maximumCodeUnits: 65536, maximumAttempts: 40 } as const;
function invalid(): never {
  throw new Error('Invalid native widget publication');
}
function publication(raw: string): WidgetPublication {
  if (raw.length > NATIVE_WIDGET_TRANSPORT.maximumCodeUnits) return invalid();
  let v: WidgetPublication;
  try {
    v = JSON.parse(raw) as WidgetPublication;
  } catch {
    return invalid();
  }
  if (
    v === null ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !==
      'attemptsMs,lastRenderedKey,pendingKey,schemaVersion,snapshotJson' ||
    v.schemaVersion !== 1 ||
    (v.snapshotJson !== null && typeof v.snapshotJson !== 'string') ||
    !Array.isArray(v.attemptsMs) ||
    v.attemptsMs.length > NATIVE_WIDGET_TRANSPORT.maximumAttempts ||
    v.attemptsMs.some((n, i) => !Number.isSafeInteger(n) || (i > 0 && n < v.attemptsMs[i - 1]!)) ||
    [v.lastRenderedKey, v.pendingKey].some((x) => x !== null && typeof x !== 'string')
  )
    return invalid();
  return Object.freeze({ ...v, attemptsMs: Object.freeze([...v.attemptsMs]) });
}
export function createNativeWidgetPorts(native: WidgetPublicationNative): {
  readonly store: WidgetPublicationStore;
  readonly reload: WidgetReloadPort;
} {
  let token: string | null = null;
  let tail = Promise.resolve();
  function lease(): string {
    if (token === null) throw new Error('Widget publication lease required');
    return token;
  }
  const store: WidgetPublicationStore = {
    async read() {
      const raw = await native.read(lease());
      return raw === null ? null : publication(raw);
    },
    async write(value) {
      const held = lease();
      const raw = JSON.stringify(value);
      publication(raw);
      await native.write(held, raw);
    },
    async exclusive<T>(action: () => Promise<T>): Promise<T> {
      const before = tail;
      let done!: () => void;
      tail = new Promise<void>((r) => {
        done = r;
      });
      await before;
      try {
        const held = await native.acquire();
        if (typeof held !== 'string' || !held.trim())
          throw new Error('Invalid widget publication lease');
        token = held;
        try {
          return await action();
        } finally {
          token = null;
          await native.release(held);
        }
      } finally {
        done();
      }
    },
  };
  return {
    store,
    reload: {
      async reload() {
        await native.reload(lease());
      },
    },
  };
}
