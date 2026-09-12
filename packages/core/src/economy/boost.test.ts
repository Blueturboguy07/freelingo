/**
 * Boost inventory properties (INV-ECO-03, INV-ECO-18).
 *
 * The two falsifiers these exist for: a second grant that makes the running boost 30
 * minutes long instead of 15, and a 400-day clock-tampered span that mints one Daily
 * Refresh boost per COMPLETION instead of per distinct local day.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import type { BoostGrant } from '../types/index.js';
import { BOOST_MULTIPLIER, MAX_BOOST_INVENTORY } from './config.js';
import {
  EMPTY_BOOST_STATE,
  activateBoost,
  activeBoostFrom,
  clampBoost,
  type BoostClockReading,
  type PersistedBoost,
  clearDailyRefreshLegendary,
  dailyRefreshBoostGrantCount,
  dailyRefreshBoostGrantDays,
  expireBoosts,
  grantBoost,
  startHeldBoost,
  type BoostState,
  type DailyRefreshCompletion,
} from './boost.js';

const RUNS = { numRuns: PROPERTY_RUNS } as const;
const EPOCH = Date.parse('2026-09-11T00:00:00Z');
const iso = (ms: number) => new Date(EPOCH + ms).toISOString();

function grant(durationMinutes: number): BoostGrant {
  return {
    kind: 'xpBoost',
    multiplier: BOOST_MULTIPLIER,
    durationMinutes,
    grantedAtUtc: iso(0),
  };
}

describe('boost grants', () => {
  it('[INV-ECO-03] falsifier: a grant during an active boost does not extend the running timer', () => {
    const first = grantBoost(EMPTY_BOOST_STATE, grant(15), iso(0));
    expect(first.started).toBe(true);
    const expiry = first.state.activeBoost?.expiresAtUtc;

    const second = grantBoost(first.state, grant(30), iso(60_000));
    expect(second.started).toBe(false);
    expect(second.state.activeBoost?.expiresAtUtc).toBe(expiry);
    expect(second.state.inventory).toHaveLength(1);
    // And it does not stack in multiplier either.
    expect(second.state.activeBoost?.multiplier).toBe(BOOST_MULTIPLIER);
  });

  it('[INV-ECO-03] starting a held grant while one runs is a no-op, so two grants are never one long boost', () => {
    const first = grantBoost(EMPTY_BOOST_STATE, grant(15), iso(0));
    const second = grantBoost(first.state, grant(30), iso(60_000));
    const attempt = startHeldBoost(second.state, 0, iso(120_000));
    expect(attempt.started).toBe(false);
    expect(attempt.state.inventory).toHaveLength(1);
    expect(attempt.state.activeBoost?.expiresAtUtc).toBe(first.state.activeBoost?.expiresAtUtc);
  });

  it('[INV-ECO-03] duration is per grant: a 30-minute grant started later runs 30 minutes', () => {
    const first = grantBoost(EMPTY_BOOST_STATE, grant(15), iso(0));
    const second = grantBoost(first.state, grant(30), iso(60_000));
    const afterExpiry = startHeldBoost(second.state, 0, iso(16 * 60_000));
    expect(afterExpiry.started).toBe(true);
    const active = afterExpiry.state.activeBoost;
    expect(active).not.toBeNull();
    expect(Date.parse(active!.expiresAtUtc) - Date.parse(active!.startedAtUtc)).toBe(30 * 60_000);
  });

  it('[INV-ECO-03] over any grant sequence: multiplier never stacks and inventory never exceeds the cap', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            atMinutes: fc.integer({ min: 0, max: 600 }),
            durationMinutes: fc.constantFrom(15, 30),
            start: fc.boolean(),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (events) => {
          let state: BoostState = EMPTY_BOOST_STATE;
          let clock = 0;
          for (const event of events) {
            clock += event.atMinutes * 60_000;
            const now = iso(clock);
            state = grantBoost(state, grant(event.durationMinutes), now).state;
            if (event.start) state = startHeldBoost(state, 0, now).state;
            state = expireBoosts(state, now);

            expect(state.inventory.length).toBeLessThanOrEqual(MAX_BOOST_INVENTORY);
            if (state.activeBoost !== null) {
              expect(state.activeBoost.multiplier).toBe(BOOST_MULTIPLIER);
              const runMs =
                Date.parse(state.activeBoost.expiresAtUtc) -
                Date.parse(state.activeBoost.startedAtUtc);
              // A running boost is exactly one grant long. Never two.
              expect([15 * 60_000, 30 * 60_000]).toContain(runMs);
            }
          }
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-03] a grant that arrives with inventory full is refused, not queued behind the cap', () => {
    let state: BoostState = grantBoost(EMPTY_BOOST_STATE, grant(15), iso(0)).state;
    for (let i = 0; i < MAX_BOOST_INVENTORY; i += 1) {
      const result = grantBoost(state, grant(15), iso(1_000));
      expect(result.accepted).toBe(true);
      state = result.state;
    }
    const overflow = grantBoost(state, grant(15), iso(1_000));
    expect(overflow.accepted).toBe(false);
    expect(overflow.state.inventory).toHaveLength(MAX_BOOST_INVENTORY);
  });
});

describe('Daily Refresh boost grants', () => {
  it('[INV-ECO-18] falsifier: 400 tampered days of completions grant one boost per DISTINCT local day', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            // A 400-day span with the clock wandering: the same day appears many times.
            dayOffset: fc.integer({ min: 0, max: 400 }),
            isFinalLevel: fc.boolean(),
          }),
          { minLength: 1, maxLength: 80 },
        ),
        (rows) => {
          const completions: DailyRefreshCompletion[] = rows.map((row) => ({
            localDay: new Date(EPOCH + row.dayOffset * 86_400_000).toISOString().slice(0, 10),
            isFinalLevel: row.isFinalLevel,
          }));
          const expected = new Set(
            completions.filter((c) => c.isFinalLevel).map((c) => c.localDay),
          );
          expect(dailyRefreshBoostGrantCount(completions)).toBe(expected.size);
          expect(dailyRefreshBoostGrantDays(completions)).toEqual([...expected].sort());
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-18] a non-final level grants nothing, however many times it is completed', () => {
    const completions: DailyRefreshCompletion[] = Array.from({ length: 50 }, () => ({
      localDay: '2026-09-11',
      isFinalLevel: false,
    }));
    expect(dailyRefreshBoostGrantCount(completions)).toBe(0);
  });

  it('[INV-ECO-18] legendary state on a Daily Refresh level clears with the set', () => {
    expect(clearDailyRefreshLegendary()).toEqual([]);
  });
});

/* ------------------------------------------------- INV-ECO-02 / EC-ECO-39 */

describe('the rewind clamp', () => {
  const DURATION_MINUTES = 15;

  function activated(): PersistedBoost {
    return activateBoost(grant(DURATION_MINUTES), { nowUtc: iso(0), sequenceMs: 1_000_000 });
  }

  it('[INV-ECO-02] falsifier: killed at 18:06, clock wound back 30 minutes, relaunched', () => {
    // EC-ECO-39, the exact scenario. Wall clock alone says 15 minutes are left again.
    const boost = activated();
    const sixMinutesIn: BoostClockReading = {
      nowUtc: iso(6 * 60_000),
      sequenceMs: 1_000_000 + 6 * 60_000,
    };
    const seen = clampBoost(boost, sixMinutesIn);
    expect(seen.running).toBe(true);
    expect(seen.remainingSeconds).toBeCloseTo(9 * 60, 3);

    // The relaunch: wall clock 30 minutes BEHIND the high-water mark, monotonic sequence
    // still moving forward because it is not the user's to set.
    const rewound: BoostClockReading = {
      nowUtc: iso(6 * 60_000 - 30 * 60_000),
      sequenceMs: 1_000_000 + 7 * 60_000,
    };
    const after = clampBoost(seen.boost, rewound);
    expect(after.running).toBe(false);
    expect(after.reason).toBe('clock-rewound');
    expect(after.remainingSeconds).toBe(0);
    // And the session that starts after it sees no boost at all.
    expect(activeBoostFrom(seen.boost, rewound).active).toBeNull();
  });

  it('[INV-ECO-02] remaining time never exceeds duration minus the MONOTONIC elapsed, over any interleaving', () => {
    fc.assert(
      fc.property(
        // A sequence of (wall-clock delta, monotonic delta) observations. Wall deltas may
        // be negative — that is the whole point; monotonic deltas may not.
        fc.array(
          fc.record({
            wallDeltaMs: fc.integer({ min: -3_600_000, max: 3_600_000 }),
            sequenceDeltaMs: fc.integer({ min: 0, max: 3_600_000 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (observations) => {
          let boost = activated();
          let wallMs = 0;
          let sequenceMs = 1_000_000;
          for (const step of observations) {
            wallMs += step.wallDeltaMs;
            sequenceMs += step.sequenceDeltaMs;
            const clock: BoostClockReading = { nowUtc: iso(wallMs), sequenceMs };
            const result = clampBoost(boost, clock);
            const sequenceElapsedSeconds = (sequenceMs - boost.activationSequenceMs) / 1_000;
            // The bound EC-ECO-39 asks for: never more than what the monotonic clock says
            // is left, and never more than the grant's own duration.
            expect(result.remainingSeconds).toBeLessThanOrEqual(
              Math.max(0, boost.durationSeconds - sequenceElapsedSeconds) + 1e-6,
            );
            expect(result.remainingSeconds).toBeLessThanOrEqual(boost.durationSeconds);
            expect(result.remainingSeconds).toBeGreaterThanOrEqual(0);
            if (result.running) expect(result.reason).toBe('running');
            boost = result.boost;
          }
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-02] a boost can only ever get shorter: the high-water mark is monotone', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -600_000, max: 600_000 }), { minLength: 1, maxLength: 10 }),
        (wallDeltas) => {
          let boost = activated();
          let previousHighWater = Date.parse(boost.tamperHighWaterUtc);
          let wallMs = 0;
          let sequenceMs = 1_000_000;
          for (const delta of wallDeltas) {
            wallMs += delta;
            sequenceMs += Math.abs(delta);
            const result = clampBoost(boost, { nowUtc: iso(wallMs), sequenceMs });
            const highWater = Date.parse(result.boost.tamperHighWaterUtc);
            expect(highWater).toBeGreaterThanOrEqual(previousHighWater);
            previousHighWater = highWater;
            boost = result.boost;
          }
        },
      ),
      RUNS,
    );
  });

  it('[INV-ECO-02] winding the clock FORWARD expires it early; it never extends it', () => {
    const boost = activated();
    const jumped = clampBoost(boost, {
      nowUtc: iso(60 * 60_000),
      sequenceMs: 1_000_000 + 60_000,
    });
    expect(jumped.running).toBe(false);
    expect(jumped.reason).toBe('elapsed');
  });

  it('[INV-ECO-02] a reboot resets the monotonic sequence, and the wall clock governs safely', () => {
    const boost = activated();
    // Sequence goes backwards across a reboot; `sequenceElapsed` clamps to 0 and the wall
    // clock — checked against the high-water mark — decides. Five minutes in, ten left.
    const afterReboot = clampBoost(boost, { nowUtc: iso(5 * 60_000), sequenceMs: 12 });
    expect(afterReboot.running).toBe(true);
    expect(afterReboot.remainingSeconds).toBeCloseTo(10 * 60, 3);
    // …and the same reboot an hour later is expired, not revived.
    expect(clampBoost(boost, { nowUtc: iso(60 * 60_000), sequenceMs: 12 }).running).toBe(false);
  });
});
