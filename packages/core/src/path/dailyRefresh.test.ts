/**
 * Daily Refresh: INV-PATH-08.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  courseComplete,
  DAILY_REFRESH_LEVELS,
  DAILY_REFRESH_LOCKED_COPY,
  dailyRefreshLocked,
  unlockDailyRefresh,
} from './dailyRefresh.js';
import { buildModel, linearModelArb } from './__falsifiers__/fixtures.js';
import type { NodeType } from './types.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

describe('Daily Refresh', () => {
  it('[INV-PATH-08] falsifier: locked while incomplete, and the unlock fires exactly once', () => {
    const input = falsifier('INV-PATH-08');
    const shape = input.shape as readonly (readonly (readonly NodeType[])[])[];
    const incomplete = buildModel(shape, 1);
    expect(dailyRefreshLocked(incomplete)).toBe(true);
    expect(unlockDailyRefresh(incomplete).screen).toBeNull();

    const complete = buildModel(shape, 2);
    const first = unlockDailyRefresh(complete);
    expect(first.screen).not.toBeNull();
    expect(first.model.dailyRefreshUnlocked).toBe(true);
    // Re-completing the course (a pack update, a re-import) never re-fires it.
    const second = unlockDailyRefresh(first.model);
    expect(second.screen).toBeNull();
    expect(second.model).toBe(first.model);
  });

  it('[INV-PATH-08] locked iff the course is incomplete, over generated paths', () => {
    fc.assert(
      fc.property(linearModelArb, ({ model }) => {
        expect(dailyRefreshLocked(model)).toBe(!courseComplete(model));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PATH-08] the locked copy is the shipped string and there are six levels', () => {
    expect(DAILY_REFRESH_LOCKED_COPY).toBe('Complete the course to unlock this section!');
    expect(DAILY_REFRESH_LEVELS).toBe(6);
  });

  it('[INV-PATH-08] an already-unlocked model is never locked again by an incomplete course', () => {
    const complete = buildModel([[['lesson', 'unitReview']]], 2);
    const unlocked = unlockDailyRefresh(complete).model;
    expect(unlocked.dailyRefreshUnlocked).toBe(true);
    expect(unlockDailyRefresh(unlocked).screen).toBeNull();
  });
});
