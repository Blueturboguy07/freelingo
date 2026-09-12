/**
 * The streak-goal picker: INV-CER-14.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  DECLINED,
  FRESH_STREAK_GOAL_STATE,
  MAX_UNPICKED_PRESENTATIONS,
  onStreakBroken,
  pickerScreen,
  pickerShouldRender,
  recordDeferred,
  recordPicked,
  STREAK_GOAL_OPTIONS,
  type StreakGoalState,
} from './streakGoal.js';
import { runCeremony } from './queue.js';
import { ceremonyState } from './__falsifiers__/fixtures.js';

function falsifier(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
}

describe('the streak-goal picker', () => {
  it('[INV-CER-14] falsifier: a 30-session trace never renders the picker a third time', () => {
    const input = falsifier('INV-CER-14');
    const expected = input.expect as Record<string, unknown>;
    let state = FRESH_STREAK_GOAL_STATE;
    let renders = 0;
    for (let i = 0; i < (input.sessions as number); i += 1) {
      const chain = runCeremony(ceremonyState({ streakGoal: state })).chain;
      if (chain.includes('S072_streakGoalPicker')) {
        renders += 1;
        // The learner backgrounds the app without picking: a defer, not a choice.
        state = recordDeferred(state);
      }
    }
    expect(renders).toBe(expected.presentations);
    expect(state.goal).toBe(DECLINED);
    // The sentinel is distinct from null, so "never asked" and "asked twice, declined"
    // cannot be confused.
    expect(state.goal).not.toBeNull();
    expect(pickerShouldRender(state)).toBe(false);
  });

  it('[INV-CER-14] the picker always has an exit that is not a disabled button', () => {
    const screen = pickerScreen(FRESH_STREAK_GOAL_STATE, null);
    expect(screen.ctaEnabled).toBe(false);
    expect(screen.dismissible).toBe(true);
    const picked = pickerScreen(FRESH_STREAK_GOAL_STATE, 7);
    expect(picked.ctaEnabled).toBe(true);
  });

  it('[INV-CER-14] the predicate is `goal == null`, never `streakBroken`', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.constant(DECLINED), fc.constantFrom(7, 14, 30, 50)),
        fc.nat({ max: 4 }),
        (goal, presentations) => {
          const state: StreakGoalState = { goal, presentations, lastPicked: null };
          expect(pickerShouldRender(state)).toBe(
            goal === null && presentations < MAX_UNPICKED_PRESENTATIONS,
          );
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-CER-14] the picker renders at most once per streak run, over generated traces', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('session' as const, 'break' as const, 'pick' as const), {
          minLength: 1,
          maxLength: 40,
        }),
        (events) => {
          let state = FRESH_STREAK_GOAL_STATE;
          let rendersThisRun = 0;
          let totalUnpicked = 0;
          for (const event of events) {
            if (event === 'break') {
              state = onStreakBroken(state);
              rendersThisRun = 0;
              continue;
            }
            if (event === 'pick') {
              if (pickerShouldRender(state)) state = recordPicked(state, 7);
              continue;
            }
            if (!pickerShouldRender(state)) continue;
            rendersThisRun += 1;
            totalUnpicked += 1;
            state = recordDeferred(state);
            expect(rendersThisRun).toBeLessThanOrEqual(MAX_UNPICKED_PRESENTATIONS);
          }
          if (totalUnpicked >= MAX_UNPICKED_PRESENTATIONS && state.goal === DECLINED) {
            expect(pickerShouldRender(state)).toBe(false);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-CER-14] a break nulls the goal, keeps the old pick pre-selected, and re-arms once', () => {
    let state = recordPicked(FRESH_STREAK_GOAL_STATE, 30);
    expect(pickerShouldRender(state)).toBe(false);
    state = onStreakBroken(state);
    expect(state.goal).toBeNull();
    expect(state.lastPicked).toBe(30);
    expect(pickerShouldRender(state)).toBe(true);
    expect(pickerScreen(state, null).preselected).toBe(30);
  });

  it('[INV-CER-14] a DECLINED sentinel survives a streak break: it is permanent', () => {
    let state = recordDeferred(recordDeferred(FRESH_STREAK_GOAL_STATE));
    expect(state.goal).toBe(DECLINED);
    state = onStreakBroken(state);
    expect(state.goal).toBe(DECLINED);
    expect(pickerShouldRender(state)).toBe(false);
  });

  it('[INV-CER-14] the four shipped options are 7 Good / 14 Great / 30 Incredible / 50 Unstoppable', () => {
    expect(STREAK_GOAL_OPTIONS).toEqual([
      { days: 7, qualifier: 'Good' },
      { days: 14, qualifier: 'Great' },
      { days: 30, qualifier: 'Incredible' },
      { days: 50, qualifier: 'Unstoppable' },
    ]);
  });
});
