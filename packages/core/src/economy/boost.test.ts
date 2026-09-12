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
