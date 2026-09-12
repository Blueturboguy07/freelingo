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
import { buildModel, linearModelArb, node, unit } from './__falsifiers__/fixtures.js';
import type { NodeType, PathModel } from './types.js';

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

  it('[INV-PATH-08] a pack update that adds a unit re-locks the section but never re-fires the screen', () => {
    // The two halves of the invariant pull in opposite directions and both have to hold.
    // "Locked iff the course is incomplete" is a biconditional over the CURRENT model, so a
    // pack update that ships a new unit re-locks Daily Refresh - the course is not finished
    // any more. "Unlocks exactly once" is about the CEREMONY. The earlier version of this
    // test never built an incomplete model at all, so it asserted neither.
    const complete = buildModel([[['lesson', 'unitReview']]], 2);
    const first = unlockDailyRefresh(complete);
    expect(first.model.dailyRefreshUnlocked).toBe(true);
    expect(first.screen).not.toBeNull();
    expect(dailyRefreshLocked(first.model)).toBe(false);

    // The pack update: a second unit arrives, unplayed.
    const extended: PathModel = {
      ...first.model,
      sections: first.model.sections.map((s) => ({
        ...s,
        units: [...s.units, unit(1, [node('u1n0', 'lesson', 1), node('u1n1', 'unitReview', 1)])],
      })),
    };
    expect(dailyRefreshLocked(extended)).toBe(true);
    expect(unlockDailyRefresh(extended).screen).toBeNull();

    // Re-completed: unlocked again, and STILL no second unlock screen. Once, ever.
    const reCompleted: PathModel = {
      ...extended,
      sections: extended.sections.map((s) => ({
        ...s,
        units: s.units.map((u) => ({
          ...u,
          nodes: u.nodes.map((n) => ({ ...n, subLessonsDone: n.subLessonsTotal })),
        })),
      })),
    };
    expect(dailyRefreshLocked(reCompleted)).toBe(false);
    expect(unlockDailyRefresh(reCompleted).screen).toBeNull();
    expect(unlockDailyRefresh(reCompleted).model).toBe(reCompleted);
  });
});
