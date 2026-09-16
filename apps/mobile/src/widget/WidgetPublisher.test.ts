import { expect, it } from 'vitest';
import { WidgetPublisher, drawStoredWidget, type WidgetPublicationStore } from './WidgetPublisher';
import type { WidgetAccountRead, WidgetPublication } from '@freelingo/core/widget';

const source: WidgetAccountRead = {
  kind: 'known',
  localDay: '2026-09-13',
  streak: 12,
  lastCompletedLocalDay: '2026-09-13',
  freezesOwned: 0,
  previousDayDisposition: 'completed',
  streakExtendedToday: true,
  goalMet: false,
  earnedXp: 13,
  goalXp: 40,
  lifetimeSessions: 12,
  course: { courseId: 'en-es', activeNodeId: 'u1', hasResumableSession: true },
  equippedCosmeticId: null,
};
function memory() {
  let record: WidgetPublication | null = null;
  const events: string[] = [];
  let chain = Promise.resolve();
  const store: WidgetPublicationStore = {
    read: async () => record,
    write: async (value) => {
      events.push('snapshot');
      record = structuredClone(value);
    },
    exclusive: <T>(run: () => Promise<T>) => {
      const task = chain.then(run);
      chain = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
  };
  return { store, events, read: () => record };
}
it('[INV-WID-01][INV-SESS-27] awaits committed facts and durable snapshot before the platform reload', async () => {
  const m = memory();
  let resolve!: (value: WidgetAccountRead) => void;
  const pending = new Promise<WidgetAccountRead>((done) => {
    resolve = done;
  });
  const publisher = new WidgetPublisher(
    { readCommitted: () => pending },
    m.store,
    {
      reload: async () => {
        expect(m.read()?.snapshotJson).toContain('"earned_xp":13');
        m.events.push('reload');
      },
    },
    () => ({ nowMs: Date.parse('2026-09-13T23:00:00Z'), zone: 'UTC' }),
  );
  const publishing = publisher.publish();
  await Promise.resolve();
  expect(m.events).toEqual([]);
  resolve(source);
  const result = await publishing;
  expect(result.status).toBe('reloaded');
  expect(m.events).toEqual(['snapshot', 'reload', 'snapshot']);
});
it('[INV-WID-01][INV-WID-03] the target consumes JSON only and obtains time again at each draw', async () => {
  const m = memory();
  let now = Date.parse('2026-09-13T23:00:00Z');
  const clock = () => ({ nowMs: now, zone: 'UTC' });
  const p = new WidgetPublisher(
    { readCommitted: async () => ({ ...source, streakExtendedToday: false }) },
    m.store,
    { reload: async () => undefined },
    clock,
  );
  await p.publish();
  const readOnly = { readSnapshot: async () => m.read()?.snapshotJson ?? null };
  expect((await drawStoredWidget(readOnly, clock)).remainingMinutes).toBe(60);
  now += 86_400_000;
  expect((await drawStoredWidget(readOnly, clock)).state).toBe('UNKNOWN');
});
it('[INV-WID-04] concurrent publishers share the durable lock and a failed reload cannot bypass its budget after restart', async () => {
  const m = memory();
  let calls = 0;
  let now = Date.parse('2026-09-13T23:00:00Z');
  const create = () =>
    new WidgetPublisher(
      { readCommitted: async () => source },
      m.store,
      {
        reload: async () => {
          calls++;
          throw new Error('native failure');
        },
      },
      () => ({ nowMs: now, zone: 'UTC' }),
    );
  const results = await Promise.all([create().publish(), create().publish()]);
  expect(calls).toBe(1);
  expect(results.map((r) => r.status)).toEqual(['reload-failed', 'stored']);
  now += 900_000;
  await create().publish();
  expect(calls).toBe(2);
});
it('[INV-WID-10] failed snapshot writes do not reload, and unknown source history publishes a neutral null snapshot', async () => {
  const m = memory();
  let calls = 0;
  const publisher = new WidgetPublisher(
    { readCommitted: async () => ({ kind: 'unavailable', reason: 'unknown-history' }) },
    {
      ...m.store,
      write: async () => {
        throw new Error('disk full');
      },
    },
    {
      reload: async () => {
        calls++;
      },
    },
    () => ({ nowMs: Date.parse('2026-09-13T23:00:00Z'), zone: 'UTC' }),
  );
  expect((await publisher.publish()).status).toBe('write-failed');
  expect(calls).toBe(0);
  expect(
    (await drawStoredWidget({ readSnapshot: async () => null }, () => ({ nowMs: 0, zone: 'UTC' })))
      .streak,
  ).toBeNull();
});

it('[INV-WID-10] a failed authoritative read clears the old current-day snapshot to UNKNOWN', async () => {
  const m = memory();
  let failed = false;
  let now = Date.parse('2026-09-13T23:00:00Z');
  const p = new WidgetPublisher(
    {
      readCommitted: async () => {
        if (failed) throw new Error('day history unavailable');
        return source;
      },
    },
    m.store,
    { reload: async () => undefined },
    () => ({ nowMs: now, zone: 'UTC' }),
  );
  await p.publish();
  expect(m.read()?.snapshotJson).not.toBeNull();
  failed = true;
  now += 900_000;
  await p.publish();
  expect(m.read()?.snapshotJson).toBeNull();
});
