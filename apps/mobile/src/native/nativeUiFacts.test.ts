import { describe, expect, it, vi } from 'vitest';
import { createNativeUiFacts, type NativeUiDriver, type NativeUiField } from './nativeUiFacts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function harness() {
  const values = {
    reduceMotion: false,
    screenReaderActive: false,
    highContrast: false,
    boldText: false,
  };
  const listeners = new Map<NativeUiField, (value: boolean) => void>();
  let theme: 'light' | 'dark' | null = 'dark';
  let appearance: (() => void) | undefined;
  const removals = Array.from({ length: 5 }, () => vi.fn());
  const driver: NativeUiDriver = {
    readTheme: () => theme,
    query: vi.fn(async (field: NativeUiField) => values[field]),
    onFact(field, listener) {
      listeners.set(field, listener);
      const remove = removals[Object.keys(values).indexOf(field)]!;
      return { remove };
    },
    onTheme(listener) {
      appearance = listener;
      return { remove: removals[4]! };
    },
  };
  return {
    driver,
    values,
    removals,
    emit: (field: NativeUiField, value: boolean) => listeners.get(field)!(value),
    theme: (value: 'light' | 'dark' | null) => {
      theme = value;
      appearance!();
    },
  };
}
describe('native UI observations', () => {
  it('[INV-A11Y-06][INV-A11Y-14] waits for real OS facts, then exposes observed accessibility and appearance', async () => {
    const h = harness(),
      pending = deferred<boolean>();
    h.values.highContrast = true;
    h.values.boldText = true;
    h.driver.query = vi.fn((field: NativeUiField) =>
      field === 'screenReaderActive' ? pending.promise : Promise.resolve(h.values[field]),
    );
    const facts = createNativeUiFacts(h.driver);
    expect(() => facts.read()).toThrow(/unavailable/i);
    const ready = facts.refresh();
    expect(() => facts.read()).toThrow(/unavailable/i);
    pending.resolve(true);
    await ready;
    expect(facts.read()).toEqual({
      theme: 'dark',
      highContrast: true,
      boldText: true,
      reduceMotion: false,
      screenReaderActive: true,
    });
    facts.close();
  });

  it('[INV-A11Y-06] a newer native event wins over an older in-flight query', async () => {
    const h = harness(),
      pending = deferred<boolean>();
    h.driver.query = (field) =>
      field === 'screenReaderActive' ? pending.promise : Promise.resolve(h.values[field]);
    const facts = createNativeUiFacts(h.driver),
      ready = facts.refresh();
    h.emit('screenReaderActive', true);
    pending.resolve(false);
    await ready;
    expect(facts.read().screenReaderActive).toBe(true);
    facts.close();
  });

  it('[INV-A11Y-06] a newer native event also supersedes a failed old query', async () => {
    const h = harness(),
      pending = deferred<boolean>();
    h.driver.query = (field) =>
      field === 'screenReaderActive' ? pending.promise : Promise.resolve(h.values[field]);
    const facts = createNativeUiFacts(h.driver),
      ready = facts.refresh();
    h.emit('screenReaderActive', true);
    pending.reject(new Error('old probe failed'));
    await ready;
    expect(facts.read().screenReaderActive).toBe(true);
    facts.close();
  });

  it('[INV-A11Y-06] foreground probe failure never presents a stale false screen-reader flag as current', async () => {
    const h = harness(),
      facts = createNativeUiFacts(h.driver);
    await facts.refresh();
    h.driver.query = async (field) => {
      if (field === 'screenReaderActive') throw new Error('native unavailable');
      return h.values[field];
    };
    await expect(facts.refresh()).rejects.toThrow(/screenReaderActive/);
    expect(() => facts.read()).toThrow(/screenReaderActive/);
    h.emit('screenReaderActive', true);
    expect(facts.read().screenReaderActive).toBe(true);
    facts.close();
  });

  it('[INV-A11Y-01][INV-A11Y-14] OS changes invalidate one detached current snapshot without mutating prior snapshots', async () => {
    const h = harness(),
      facts = createNativeUiFacts(h.driver);
    await facts.refresh();
    const original = facts.read(),
      changed = vi.fn(),
      unsubscribe = facts.subscribe(changed);
    h.emit('reduceMotion', true);
    h.emit('highContrast', true);
    h.emit('boldText', true);
    h.theme('light');
    expect(changed).toHaveBeenCalledTimes(4);
    expect(facts.read()).toEqual({
      ...original,
      theme: 'light',
      reduceMotion: true,
      highContrast: true,
      boldText: true,
    });
    expect(original.reduceMotion).toBe(false);
    expect(Object.isFrozen(original)).toBe(true);
    unsubscribe();
    h.theme(null);
    expect(facts.read().theme).toBe('light');
    expect(changed).toHaveBeenCalledTimes(4);
    facts.close();
  });

  it('[INV-A11Y-06] malformed events and probe values make their fact unavailable instead of coercing it', async () => {
    const h = harness(),
      facts = createNativeUiFacts(h.driver);
    await facts.refresh();
    h.emit('screenReaderActive', 'false' as unknown as boolean);
    expect(() => facts.read()).toThrow(/screenReaderActive/);
    h.driver.query = async (field) =>
      field === 'screenReaderActive' ? (null as unknown as boolean) : h.values[field];
    await expect(facts.refresh()).rejects.toThrow(/screenReaderActive/);
    h.driver.query = async (field) => h.values[field];
    await facts.refresh();
    expect(facts.read().screenReaderActive).toBe(false);
    facts.close();
  });

  it('[INV-A11Y-06] closing invalidates pending reads and removes every listener exactly once', async () => {
    const h = harness(),
      pending = deferred<boolean>();
    h.driver.query = () => pending.promise;
    const facts = createNativeUiFacts(h.driver),
      changed = vi.fn();
    facts.subscribe(changed);
    const ready = facts.refresh();
    facts.close();
    facts.close();
    pending.resolve(true);
    await expect(ready).rejects.toThrow(/closed/i);
    h.emit('screenReaderActive', true);
    expect(changed).not.toHaveBeenCalled();
    expect(() => facts.read()).toThrow(/closed/i);
    for (const remove of h.removals) expect(remove).toHaveBeenCalledOnce();
  });

  it('[INV-A11Y-06] partial subscription failure releases previously registered native listeners', () => {
    const h = harness(),
      original = h.driver.onFact;
    h.driver.onFact = (field, listener) => {
      if (field === 'highContrast') throw new Error('subscription failed');
      return original(field, listener);
    };
    expect(() => createNativeUiFacts(h.driver)).toThrow(/subscription failed/);
    expect(h.removals[0]).toHaveBeenCalledOnce();
    expect(h.removals[1]).toHaveBeenCalledOnce();
  });
});

it.each(['screenReaderActive', 'highContrast'] as const)(
  '[INV-A11Y-06][INV-A11Y-14] a failed %s observation invalidates immediately while a sibling probe is pending',
  async (field) => {
    const h = harness(),
      facts = createNativeUiFacts(h.driver);
    await facts.refresh();
    const sibling = deferred<boolean>();
    h.driver.query = async (requested) => {
      if (requested === field) throw new Error('native query failed');
      if (requested === 'boldText') return sibling.promise;
      return h.values[requested];
    };
    const refresh = facts.refresh(),
      outcome = refresh.catch((error: unknown) => error);
    await vi.waitFor(() => expect(() => facts.read()).toThrow(field));
    sibling.resolve(false);
    expect(await outcome).toBeInstanceOf(Error);
    facts.close();
  },
);
