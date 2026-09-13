import { expect, it } from 'vitest';
import { createNativeWidgetPorts, type WidgetPublicationNative } from './nativeWidgetPorts';
import type { WidgetPublication } from '@freelingo/core/widget';
const row: WidgetPublication = {
  schemaVersion: 1,
  snapshotJson: null,
  attemptsMs: [100],
  lastRenderedKey: null,
  pendingKey: 'state',
};
function nativeFixture() {
  let serial = Promise.resolve(),
    raw: string | null = null,
    active: string | null = null,
    next = 0;
  const events: string[] = [];
  const releases = new Map<string, () => void>();
  const native: WidgetPublicationNative = {
    async acquire() {
      const before = serial;
      let done!: () => void;
      serial = new Promise<void>((r) => (done = r));
      await before;
      const token = String(++next);
      active = token;
      releases.set(token, done);
      events.push('acquire' + token);
      return token;
    },
    async read(token) {
      expect(token).toBe(active);
      events.push('read' + token);
      return raw;
    },
    async write(token, value) {
      expect(token).toBe(active);
      events.push('write' + token);
      raw = value;
    },
    async reload(token) {
      expect(token).toBe(active);
      events.push('reload' + token);
    },
    async release(token) {
      expect(token).toBe(active);
      events.push('release' + token);
      active = null;
      releases.get(token)!();
    },
  };
  return {
    native,
    events,
    setRaw: (v: string | null) => {
      raw = v;
    },
  };
}
it('[INV-WID-01][INV-WID-04] native lease encloses durable whole-record write and reload across instances', async () => {
  const f = nativeFixture(),
    a = createNativeWidgetPorts(f.native),
    b = createNativeWidgetPorts(f.native);
  await Promise.all([
    a.store.exclusive(async () => {
      expect(await a.store.read()).toBeNull();
      await a.store.write(row);
      await a.reload.reload();
    }),
    b.store.exclusive(async () => {
      expect(await b.store.read()).toEqual(row);
    }),
  ]);
  expect(f.events).toEqual([
    'acquire1',
    'read1',
    'write1',
    'reload1',
    'release1',
    'acquire2',
    'read2',
    'release2',
  ]);
});
it('[INV-WID-04] lease is released after failed source/write work and retry does not inherit it', async () => {
  const f = nativeFixture(),
    p = createNativeWidgetPorts(f.native);
  await expect(
    p.store.exclusive(async () => {
      throw new Error('source fault');
    }),
  ).rejects.toThrow('source fault');
  await p.store.exclusive(() => p.store.write(row));
  expect(f.events).toEqual(['acquire1', 'release1', 'acquire2', 'write2', 'release2']);
  await expect(p.store.read()).rejects.toThrow(/lease/);
  await expect(p.store.write(row)).rejects.toThrow(/lease/);
  await expect(p.reload.reload()).rejects.toThrow(/lease/);
});
it('[INV-WID-04][INV-WID-10] malformed persisted budget refuses a silent fresh budget', async () => {
  const f = nativeFixture(),
    p = createNativeWidgetPorts(f.native);
  for (const raw of [
    '{}',
    JSON.stringify({ ...row, attemptsMs: [2, 1] }),
    JSON.stringify({ ...row, extra: true }),
    JSON.stringify({ ...row, attemptsMs: Array(41).fill(1) }),
  ]) {
    f.setRaw(raw);
    await expect(p.store.exclusive(() => p.store.read())).rejects.toThrow(/publication/);
  }
});
it('[INV-WID-01] source record mutations cannot escape serialization or alter decoded durable values', async () => {
  const f = nativeFixture(),
    p = createNativeWidgetPorts(f.native);
  f.setRaw(JSON.stringify(row));
  await p.store.exclusive(async () => {
    const got = (await p.store.read())!;
    expect(Object.isFrozen(got)).toBe(true);
    expect(Object.isFrozen(got.attemptsMs)).toBe(true);
  });
  await expect(
    p.store.exclusive(() => p.store.write({ ...row, attemptsMs: [NaN] })),
  ).rejects.toThrow(/publication/);
});
