import { expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  prepareWidgetPublication,
  confirmWidgetReload,
  type WidgetPublication,
} from './publication.js';
import type { WidgetRender } from './types.js';
const render: WidgetRender = {
  state: 'DONE',
  copy: '12 day streak!',
  streak: 12,
  flame: 'lit',
  goalMet: true,
  remainingMinutes: 20,
  deepLink: 'freelingo://practice?course=en-es',
  cosmeticId: null,
};

it('[INV-WID-04] countdown-only changes do not force reloads; failed attempts reserve budget and retry later', () => {
  const first = prepareWidgetPublication(null, null, render, { nowMs: 1_000, zone: 'UTC' });
  expect(first.reload).toBe(true);
  expect(first.record.lastRenderedKey).toBeNull();
  const success = confirmWidgetReload(first.record, first.renderKey);
  expect(
    prepareWidgetPublication(
      success,
      null,
      { ...render, remainingMinutes: 1 },
      { nowMs: 1_800_000, zone: 'UTC' },
    ).reload,
  ).toBe(false);
  expect(
    prepareWidgetPublication(first.record, null, render, { nowMs: 899_999, zone: 'UTC' }).reload,
  ).toBe(false);
  expect(
    prepareWidgetPublication(first.record, null, render, { nowMs: 901_000, zone: 'UTC' }).reload,
  ).toBe(true);
});
it('[INV-WID-04] requests stay within a rolling day budget across midnight and clock reversal', () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 172_800_000 }), { minLength: 1, maxLength: 100 }),
      (offsets) => {
        let state: WidgetPublication | null = null;
        const requests: number[] = [];
        for (const [i, now] of offsets.sort((a, b) => a - b).entries()) {
          const plan = prepareWidgetPublication(
            state,
            null,
            { ...render, streak: i, copy: `${i} day streak!` },
            { nowMs: now, zone: 'UTC' },
          );
          state = plan.record;
          if (plan.reload) {
            requests.push(now);
            state = confirmWidgetReload(state, plan.renderKey);
          }
        }
        for (const [i, now] of requests.entries()) {
          expect(
            requests.filter((t) => now - t < 86_400_000 && t <= now).length,
          ).toBeLessThanOrEqual(40);
          if (i > 0) expect(now - requests[i - 1]!).toBeGreaterThanOrEqual(900_000);
        }
        if (state)
          expect(
            prepareWidgetPublication(
              state,
              null,
              { ...render, copy: 'new' },
              { nowMs: -1, zone: 'UTC' },
            ).reload,
          ).toBe(false);
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});
it('[INV-WID-04] a corrupt persisted budget is refused rather than reset to free reloads', () => {
  for (const bad of [
    {},
    {
      schemaVersion: 1,
      snapshotJson: null,
      attemptsMs: [-1, -2],
      lastRenderedKey: null,
      pendingKey: null,
    },
  ])
    expect(() =>
      prepareWidgetPublication(bad as WidgetPublication, null, render, {
        nowMs: 1_000,
        zone: 'UTC',
      }),
    ).toThrow();
});
