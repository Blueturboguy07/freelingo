import { describe, expect, it, vi } from 'vitest';
import type { AppRuntime, AppSnapshot, FreelingoServices } from './ports';
import { createAppController } from './controller';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const snapshot: AppSnapshot = {
    activeCourseId: null,
    ui: { theme: 'dark' },
    onboarding: { screen: 'courses', courses: [], selectedCourseId: null },
    path: { model: null, status: 'pack-missing' },
    hub: null,
    settings: null,
    notifications: null,
    lesson: null,
    ceremony: null,
    sessionOffer: null,
  };
  const unsubscribe = vi.fn();
  // Explicit host test double: the controller must retain, never inspect or replace, this handle.
  const opened = { retainedHandle: Symbol('database') } as unknown as AppRuntime['opened'];
  const runtime = {
    opened,
    readSnapshot: vi.fn(async () => snapshot),
    subscribe: vi.fn(() => unsubscribe),
    close: vi.fn(async () => {}),
    foreground: vi.fn(async () => {}),
    background: vi.fn(async () => {}),
    dispatchLesson: vi.fn(async () => {}),
    resolveSessionOffer: vi.fn(async () => {}),
  } as unknown as AppRuntime;
  const services: FreelingoServices = { open: vi.fn(async () => runtime) };
  return { services, runtime, snapshot, unsubscribe };
}
describe('retained App runtime controller', () => {
  it('[INV-MOD-01] rapid OFF then ON with the same mutation key preserves both durable actions', async () => {
    const f = fixture();
    const gate = deferred<void>();
    const seen: boolean[] = [];
    const app = createAppController(f.services);
    await app.open();
    const off = app.perform('preference:listening', async () => {
      seen.push(false);
      await gate.promise;
    });
    const on = app.perform('preference:listening', async () => {
      seen.push(true);
    });
    await Promise.resolve();
    expect(seen).toEqual([false]);
    gate.resolve();
    await Promise.all([off, on]);
    expect(seen).toEqual([false, true]);
    await app.dispose();
  });
  it('[INV-SESS-23] only an explicitly idempotent completion request coalesces while pending', async () => {
    const f = fixture();
    const gate = deferred<void>();
    const commit = vi.fn(() => gate.promise);
    const app = createAppController(f.services);
    await app.open();
    const first = app.perform('completion', commit, true, true);
    const duplicate = app.perform('completion', commit, true, true);
    await Promise.resolve();
    expect(commit).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([first, duplicate]);
    expect(f.runtime.readSnapshot).toHaveBeenCalledTimes(2);
    await app.dispose();
  });
  it('[INV-SESS-27] retains a second native invalidation arriving during an in-flight snapshot read', async () => {
    const f = fixture();
    const gate = deferred<AppSnapshot>();
    const app = createAppController(f.services);
    await app.open();
    const invalidate = vi.mocked(f.runtime.subscribe).mock.calls[0]![0];
    vi.mocked(f.runtime.readSnapshot).mockReturnValueOnce(gate.promise);
    invalidate();
    await Promise.resolve();
    invalidate();
    gate.resolve(f.snapshot);
    await vi.waitFor(() => expect(app.getState().busy).toBe(false));
    expect(f.runtime.readSnapshot).toHaveBeenCalledTimes(3);
    await app.dispose();
  });
  it('[INV-PER-06] opens one retained runtime, refreshes from that instance, and closes exactly once', async () => {
    const f = fixture();
    const app = createAppController(f.services);
    await Promise.all([app.open(), app.open()]);
    expect(f.services.open).toHaveBeenCalledTimes(1);
    expect(app.runtime()).toBe(f.runtime);
    expect(app.getState().snapshot).toBe(f.snapshot);
    await app.dispose();
    await app.dispose();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.runtime.close).toHaveBeenCalledTimes(1);
  });
  it('[INV-SESS-01] preserves repeated lesson input events in order without optimistic publication', async () => {
    const f = fixture();
    const gate = deferred<void>();
    vi.mocked(f.runtime.dispatchLesson).mockReturnValue(gate.promise);
    const app = createAppController(f.services);
    await app.open();
    const event = {
      type: 'input',
      text: 'hola',
      caret: 4,
      partialState: {},
      gradeable: true,
    } as const;
    const first = app.dispatchLesson(event);
    const duplicate = app.dispatchLesson(event);
    await Promise.resolve();
    expect(f.runtime.dispatchLesson).toHaveBeenCalledTimes(1);
    expect(f.runtime.readSnapshot).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([first, duplicate]);
    expect(f.runtime.dispatchLesson).toHaveBeenCalledTimes(2);
    expect(f.runtime.readSnapshot).toHaveBeenCalledTimes(3);
    expect(app.getState().busy).toBe(false);
    await app.dispose();
  });
  it('[INV-SESS-27] serializes background and ordered foreground completion before reading its snapshot', async () => {
    const f = fixture();
    const gate = deferred<void>();
    const seen: string[] = [];
    vi.mocked(f.runtime.background).mockImplementation(async () => {
      seen.push('background');
      await gate.promise;
    });
    vi.mocked(f.runtime.foreground).mockImplementation(async () => {
      seen.push('foreground');
    });
    const app = createAppController(f.services);
    await app.open();
    const bg = app.background();
    const fg = app.foreground();
    await Promise.resolve();
    expect(seen).toEqual(['background']);
    expect(f.runtime.readSnapshot).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([bg, fg]);
    expect(seen).toEqual(['background', 'foreground']);
    expect(f.runtime.readSnapshot).toHaveBeenCalledTimes(2);
    await app.dispose();
  });
  it('[INV-SESS-01] shows a failed durable action and retains the last committed snapshot', async () => {
    const f = fixture();
    vi.mocked(f.runtime.dispatchLesson).mockRejectedValue(
      new Error('Checkpoint could not be saved'),
    );
    const app = createAppController(f.services);
    await app.open();
    await expect(app.dispatchLesson({ type: 'check' })).rejects.toThrow('Checkpoint');
    expect(app.getState().error).toBe('Checkpoint could not be saved');
    expect(app.getState().snapshot).toBe(f.snapshot);
    expect(f.runtime.readSnapshot).toHaveBeenCalledTimes(1);
    await app.dispose();
  });
  it('[INV-PER-06] closes a late open after disposal without publishing it or leaking a database', async () => {
    const f = fixture();
    const gate = deferred<AppRuntime>();
    vi.mocked(f.services.open).mockReturnValue(gate.promise);
    const app = createAppController(f.services);
    const opening = app.open();
    const closing = app.dispose();
    gate.resolve(f.runtime);
    await Promise.all([opening, closing]);
    expect(f.runtime.close).toHaveBeenCalledTimes(1);
    expect(f.runtime.subscribe).not.toHaveBeenCalled();
    expect(app.getState().status).toBe('closed');
  });
  it('[INV-PER-06] exposes startup errors and an explicit retry without a fixture path fallback', async () => {
    const f = fixture();
    vi.mocked(f.services.open).mockRejectedValueOnce(new Error('Database migration failed'));
    const app = createAppController(f.services);
    await expect(app.open()).rejects.toThrow('migration');
    expect(app.getState().status).toBe('failed');
    expect(app.getState().snapshot).toBeNull();
    await app.open();
    expect(app.getState().status).toBe('ready');
    await app.dispose();
  });
});
