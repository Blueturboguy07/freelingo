import { expect, it } from 'vitest';
import type { WidgetPublicationNative } from '../widget/nativeWidgetPorts';
import { runWidgetPublicationProbe, WIDGET_PROBE_BASELINE_JSON } from './widgetPublicationProbe';
function fixture(
  initial:
    | string
    | null = ' {"schemaVersion":1,"snapshotJson":null,"attemptsMs":[],"lastRenderedKey":null,"pendingKey":null} ',
) {
  let raw = initial,
    held = false;
  const events: string[] = [];
  const native: WidgetPublicationNative = {
    async acquire() {
      held = true;
      events.push('acquire');
      return 'actual-token';
    },
    async read(token) {
      expect(held).toBe(true);
      expect(token).toBe('actual-token');
      events.push('read');
      return raw;
    },
    async write(token, value) {
      expect(held).toBe(true);
      expect(token).toBe('actual-token');
      events.push('write');
      raw = value;
    },
    async reload(token) {
      expect(held).toBe(true);
      expect(token).toBe('actual-token');
      events.push('reload');
    },
    async release(token) {
      expect(token).toBe('actual-token');
      events.push('release');
      held = false;
    },
  };
  return { native, events, raw: () => raw, initial };
}
it('[INV-WID-01][INV-WID-04] diagnostic uses actual lease calls and restores exact prior bytes before release', async () => {
  const f = fixture();
  await expect(runWidgetPublicationProbe(f.native, 123)).resolves.toEqual({
    status: 'bridge-passed',
    priorRestored: true,
    reloadRequested: true,
  });
  expect(f.raw()).toBe(f.initial);
  expect(f.events).toEqual([
    'acquire',
    'read',
    'write',
    'read',
    'reload',
    'write',
    'read',
    'release',
  ]);
});
it('[INV-WID-01] absent baseline refuses mutation and releases; simulator harness owns exact absence restoration', async () => {
  const f = fixture(null);
  await expect(runWidgetPublicationProbe(f.native, 123)).rejects.toThrow(/baseline/i);
  expect(f.events).toEqual(['acquire', 'read', 'release']);
  expect(f.raw()).toBeNull();
});
it('[INV-WID-01] readback mismatch fails and still restores original publication', async () => {
  const f = fixture();
  const read = f.native.read;
  let n = 0;
  f.native.read = async (t) => (++n === 2 ? 'mismatch' : read(t));
  await expect(runWidgetPublicationProbe(f.native, 123)).rejects.toThrow(/readback/i);
  expect(f.raw()).toBe(f.initial);
  expect(f.events).not.toContain('reload');
  expect(f.events.at(-1)).toBe('release');
});
it('[INV-WID-04] failed native reload preserves source and never reports success', async () => {
  const f = fixture();
  f.native.reload = async () => {
    throw Error('native reload failed');
  };
  await expect(runWidgetPublicationProbe(f.native, 123)).rejects.toThrow('native reload failed');
  expect(f.raw()).toBe(f.initial);
  expect(f.events.at(-1)).toBe('release');
});
it('[INV-WID-01] an atomic write failure still attempts source restoration', async () => {
  const f = fixture();
  const write = f.native.write;
  let n = 0;
  f.native.write = async (t, v) => {
    await write(t, v);
    if (++n === 1) throw Error('write acknowledgement lost');
  };
  await expect(runWidgetPublicationProbe(f.native, 123)).rejects.toThrow(
    'write acknowledgement lost',
  );
  expect(f.raw()).toBe(f.initial);
});
it('[INV-WID-01] restoration or release failure cannot be labelled a bridge pass', async () => {
  const f = fixture();
  const write = f.native.write;
  let n = 0;
  f.native.write = async (t, v) => {
    if (++n === 2) throw Error('restore failed');
    await write(t, v);
  };
  f.native.release = async () => {
    throw Error('release failed');
  };
  await expect(runWidgetPublicationProbe(f.native, 123)).rejects.toBeInstanceOf(AggregateError);
});
it('[INV-WID-04] diagnostic fixture carries no invented account snapshot and one explicit reload request', async () => {
  const f = fixture(WIDGET_PROBE_BASELINE_JSON);
  const write = f.native.write;
  const seen: string[] = [];
  f.native.write = async (t, v) => {
    seen.push(v);
    await write(t, v);
  };
  await runWidgetPublicationProbe(f.native, 123);
  expect(JSON.parse(seen[0]!)).toEqual({
    schemaVersion: 1,
    snapshotJson: null,
    attemptsMs: [123],
    lastRenderedKey: null,
    pendingKey: 'e2e-widget-bridge-probe',
  });
});
it('[INV-WID-04] invalid diagnostic time refuses all native work', async () => {
  const f = fixture();
  await expect(runWidgetPublicationProbe(f.native, NaN)).rejects.toThrow(/time/i);
  expect(f.events).toEqual([]);
});
