import type { SessionEvent } from '@freelingo/core/session';
import type { SettingsRoute } from '../loop/contracts';
import type {
  AppDocument,
  AppRuntime,
  AppSnapshot,
  AppSurfaceRequest,
  AppTab,
  FreelingoServices,
} from './ports';

export type AppRoute =
  | AppTab
  | SettingsRoute
  | 'onboarding'
  | 'lesson'
  | 'ceremony'
  | 'notifications'
  | 'document'
  | 'data'
  | 'reports'
  | 'words';
export interface AppViewState {
  readonly status: 'opening' | 'ready' | 'failed' | 'closed';
  readonly snapshot: AppSnapshot | null;
  readonly route: AppRoute;
  readonly document: AppDocument | null;
  readonly documentOrigin: AppRoute | null;
  readonly error: string | null;
  readonly busy: boolean;
}
function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'The operation could not be completed.';
}
function routeAfter(snapshot: AppSnapshot, previous: AppRoute): AppRoute {
  if (snapshot.ceremony !== null) return 'ceremony';
  if (previous === 'document') return previous;
  if (
    snapshot.sessionOffer === null &&
    snapshot.lesson !== null &&
    snapshot.lesson.state.exited === null
  )
    return 'lesson';
  if (snapshot.onboarding !== null) return 'onboarding';
  return ['onboarding', 'lesson', 'ceremony'].includes(previous) ? 'path' : previous;
}
/** Owns transport ordering and view state only. Session rules and writes remain in the runtime. */
export function createAppController(services: FreelingoServices) {
  let state: AppViewState = {
    status: 'opening',
    snapshot: null,
    route: 'path',
    document: null,
    documentOrigin: null,
    error: null,
    busy: false,
  };
  let runtime: AppRuntime | null = null;
  let opening: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  let disposed = false;
  let invalidation = 0;
  let unsubscribe: (() => void) | null = null;
  let queue: Promise<void> = Promise.resolve();
  const pending = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  function publish(patch: Partial<AppViewState>) {
    if (disposed && patch.status !== 'closed') return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  async function refresh(active: AppRuntime) {
    const snapshot = await active.readSnapshot();
    publish({ snapshot, status: 'ready', route: routeAfter(snapshot, state.route) });
  }
  function perform(
    key: string,
    action: (active: AppRuntime) => Promise<void>,
    reload = true,
  ): Promise<void> {
    const duplicate = pending.get(key);
    if (duplicate !== undefined) return duplicate;
    if (disposed) return Promise.reject(new Error('The app runtime is closed.'));
    publish({ busy: true, error: null });
    const task = queue
      .then(async () => {
        const active = runtime;
        if (active === null) throw new Error('The app is still opening.');
        await action(active);
        if (reload) await refresh(active);
      })
      .catch((reason: unknown) => {
        publish({ error: message(reason) });
        throw reason;
      });
    const settled = task.then(
      () => finish(),
      () => finish(),
    );
    function finish() {
      pending.delete(key);
      publish({ busy: pending.size > 0 });
    }
    // Keep the transport usable after a failed write; callers still receive its rejection.
    queue = settled;
    pending.set(key, task);
    return task;
  }
  function open(): Promise<void> {
    if (disposed) return Promise.reject(new Error('The app runtime is closed.'));
    if (runtime !== null) return Promise.resolve();
    if (opening !== null) return opening;
    publish({ status: 'opening', error: null });
    opening = services
      .open()
      .then(async (active) => {
        if (disposed) {
          await active.close();
          return;
        }
        runtime = active;
        unsubscribe = active.subscribe(() => {
          invalidation += 1;
          void perform(
            'invalidation',
            async (current) => {
              let observed: number;
              do {
                observed = invalidation;
                await refresh(current);
              } while (observed !== invalidation);
            },
            false,
          ).catch(() => {});
        });
        await refresh(active);
      })
      .catch(async (reason: unknown) => {
        if (runtime !== null) {
          unsubscribe?.();
          unsubscribe = null;
          const failed = runtime;
          runtime = null;
          await failed.close();
        }
        publish({ status: 'failed', error: message(reason) });
        throw reason;
      })
      .finally(() => {
        opening = null;
      });
    return opening;
  }
  function dispose(): Promise<void> {
    if (closing !== null) return closing;
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
    publish({ status: 'closed' });
    closing = (async () => {
      await opening?.catch(() => {});
      await queue;
      const active = runtime;
      runtime = null;
      if (active !== null) await active.close();
      listeners.clear();
    })();
    return closing;
  }
  return {
    getState: () => state,
    runtime: () => runtime,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open,
    dispose,
    perform,
    dispatchLesson: (event: SessionEvent) =>
      perform(`lesson:${JSON.stringify(event)}`, (active) => active.dispatchLesson(event)),
    foreground: () => perform('foreground', (active) => active.foreground()),
    background: () => perform('background', (active) => active.background(), false),
    navigate(route: AppRoute) {
      publish({ route, document: null, documentOrigin: null, error: null });
    },
    leaveDocument() {
      const origin = state.documentOrigin ?? 'path';
      publish({
        route: state.snapshot === null ? origin : routeAfter(state.snapshot, origin),
        document: null,
        documentOrigin: null,
      });
    },
    showError(reason: unknown) {
      publish({ error: message(reason) });
    },
    clearError() {
      publish({ error: null });
    },
    showDocument(request: AppSurfaceRequest) {
      return perform(
        `surface:${JSON.stringify(request)}`,
        async (active) => {
          const document = await active.readSurface(request);
          publish({
            document,
            documentOrigin: state.route === 'document' ? state.documentOrigin : state.route,
            route: 'document',
          });
        },
        false,
      );
    },
  };
}
export type AppController = ReturnType<typeof createAppController>;
