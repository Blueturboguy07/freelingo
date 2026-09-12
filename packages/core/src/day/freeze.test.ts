import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { addCivilDays, toLocalDay, type LocalDay } from './civil.js';
import { DAY_CONFIG } from './config.js';
import {
  FREEZE_CHANNELS,
  consumeFreezeFor,
  enterSocietyTier,
  freezesHeld,
  freezesOwnedBefore,
  grantFreezes,
  newFreezeLedger,
  type FreezeChannel,
  type FreezeLedger,
} from './freeze.js';

const falsifier = (id: string): Record<string, unknown> => {
  const file = JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__falsifiers__/${id}.json`, import.meta.url)), 'utf8'),
  ) as { id: string; falsifier: string; input: Record<string, unknown> };
  expect(file.id).toBe(id);
  expect(file.falsifier.length).toBeGreaterThan(0);
  return file.input;
};

const DAY = toLocalDay('2026-09-11');

describe('freeze ledger', () => {
  it('[INV-FRZ-03] three acquisition channels plus the one_time subtype, each idempotent on its key', () => {
    const input = falsifier('INV-FRZ-03') as {
      channels: string[];
      oneTimeKey: string;
      day: string;
      cap: number;
    };
    // Exactly three channels (EC-FRZ-06). `one_time` is a SUBTYPE, not a fourth channel.
    expect([...FREEZE_CHANNELS]).toEqual(input.channels);
    expect(FREEZE_CHANNELS).toHaveLength(3);

    let ledger: FreezeLedger = {
      cap: input.cap,
      grants: [],
      consumptions: [],
      societyTierKeys: [],
    };
    const keys: string[] = [];
    for (const channel of FREEZE_CHANNELS) {
      const key = `${channel}:${input.day}`;
      keys.push(key);
      const first = grantFreezes(ledger, { grantKey: key, channel, ownedFromDay: DAY, amount: 1 });
      expect(first.applied).toBe(1);
      expect(first.ceremony).toBe(true);
      ledger = first.ledger;
      // The same key again — a replayed ceremony, a re-entered screen — mints nothing.
      const replay = grantFreezes(ledger, { grantKey: key, channel, ownedFromDay: DAY, amount: 1 });
      expect(replay.applied).toBe(0);
      expect(replay.ceremony).toBe(false);
      expect(replay.ledger).toBe(ledger);
    }
    expect(freezesHeld(ledger)).toBe(3);

    // The one_time gift at a goal-met moment, on its own key.
    const gift = grantFreezes(ledger, {
      grantKey: input.oneTimeKey,
      channel: 'reward_chest',
      subtype: 'one_time',
      ownedFromDay: DAY,
      amount: 1,
    });
    expect(gift.applied).toBe(1);
    expect(gift.ledger.grants.at(-1)?.subtype).toBe('one_time');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('[INV-FRZ-03] the balance never exceeds the cap, however many grants arrive', () => {
    const arbChannel = fc.constantFrom<FreezeChannel>(...FREEZE_CHANNELS);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.array(
          fc.tuple(fc.integer({ min: 0, max: 40 }), arbChannel, fc.integer({ min: 1, max: 9 })),
          {
            minLength: 1,
            maxLength: 30,
          },
        ),
        (cap, grants) => {
          let ledger: FreezeLedger = { cap, grants: [], consumptions: [], societyTierKeys: [] };
          for (const [keyIndex, channel, amount] of grants) {
            const outcome = grantFreezes(ledger, {
              grantKey: `k${keyIndex}`,
              channel,
              ownedFromDay: DAY,
              amount,
            });
            ledger = outcome.ledger;
            expect(freezesHeld(ledger)).toBeLessThanOrEqual(cap);
            expect(freezesHeld(ledger)).toBeGreaterThanOrEqual(0);
            // A grant that changed nothing gets no screen and no copy (INV-FRZ-06).
            expect(outcome.ceremony).toBe(outcome.applied > 0);
            // No grant ever raises the cap.
            expect(ledger.cap).toBe(cap);
          }
          // Repeating every key changes nothing at all.
          const before = freezesHeld(ledger);
          for (const [keyIndex, channel, amount] of grants) {
            ledger = grantFreezes(ledger, {
              grantKey: `k${keyIndex}`,
              channel,
              ownedFromDay: DAY,
              amount,
            }).ledger;
          }
          expect(freezesHeld(ledger)).toBe(before);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-FRZ-04] Society tier entry grants freezes and is idempotent on society_tier_entered_at', () => {
    const input = falsifier('INV-FRZ-04') as {
      tier: string;
      enteredAt: string;
      startingCap: number;
      expectedCap: number;
      replayEnteredAt: string;
    };
    // EC-FRZ-07: 2/2 → 3/3. The cap rises AND the freeze is granted; a raised ceiling the
    // learner must then fill at 200 gems would be a non-event.
    let ledger = newFreezeLedger(addCivilDays(DAY, -1), input.startingCap);
    expect(freezesHeld(ledger)).toBe(input.startingCap);

    const entered = enterSocietyTier(ledger, input.tier, input.enteredAt, DAY);
    expect(entered.ledger.cap).toBe(input.expectedCap);
    expect(entered.applied).toBe(input.expectedCap - input.startingCap);
    expect(freezesHeld(entered.ledger)).toBe(input.expectedCap);
    expect(entered.ceremony).toBe(true);
    ledger = entered.ledger;

    // A clock-tamper replay of the SAME tier entry mints nothing.
    const replay = enterSocietyTier(ledger, input.tier, input.replayEnteredAt, DAY);
    expect(replay.applied).toBe(0);
    expect(replay.ceremony).toBe(false);
    expect(freezesHeld(replay.ledger)).toBe(input.expectedCap);
    expect(replay.ledger.cap).toBe(input.expectedCap);

    // The next tier is a different key and does raise the cap again.
    const next = DAY_CONFIG.societyTiers.find((t) => t.cap > input.expectedCap);
    if (next !== undefined) {
      const promoted = enterSocietyTier(replay.ledger, next.tier, '2027-03-01T00:00:00Z', DAY);
      expect(promoted.ledger.cap).toBe(next.cap);
      expect(freezesHeld(promoted.ledger)).toBe(next.cap);
    }
  });

  it('[INV-FRZ-06] falsifier: a day-1 account at 2/2 writes no third freeze, no cap rise, no copy', () => {
    const input = falsifier('INV-FRZ-06') as { cap: number; giftKey: string };
    const full = newFreezeLedger(addCivilDays(DAY, -1), input.cap);
    expect(freezesHeld(full)).toBe(input.cap);

    const gift = grantFreezes(full, {
      grantKey: input.giftKey,
      channel: 'reward_chest',
      subtype: 'one_time',
      ownedFromDay: DAY,
      amount: 1,
    });
    // Clamped to cap − held = 0: no balance change, no cap change, no ceremony screen.
    expect(gift.applied).toBe(0);
    expect(gift.ceremony).toBe(false);
    expect(freezesHeld(gift.ledger)).toBe(input.cap);
    expect(gift.ledger.cap).toBe(input.cap);
    // The clamp is auditable: the request is recorded even though nothing was added.
    expect(gift.ledger.grants.at(-1)?.requested).toBe(1);
    expect(gift.ledger.grants.at(-1)?.applied).toBe(0);
  });

  it('[INV-FRZ-01] a freeze owned only from the return day cannot rescue the gap behind it', () => {
    // EC-FRZ-01's schema half: the inventory is reconstructed as of each replayed day.
    const input = falsifier('INV-FRZ-01') as { gapDay: string; returnDay: string; amount: number };
    const gapDay = toLocalDay(input.gapDay);
    const returnDay = toLocalDay(input.returnDay);
    const ledger = grantFreezes(
      { cap: input.amount, grants: [], consumptions: [], societyTierKeys: [] },
      {
        grantKey: 'bought-on-return',
        channel: 'timed_refill',
        ownedFromDay: returnDay,
        amount: input.amount,
      },
    ).ledger;
    expect(freezesHeld(ledger)).toBe(input.amount);
    expect(freezesOwnedBefore(ledger, gapDay)).toBe(0);
    expect(consumeFreezeFor(ledger, gapDay, returnDay).consumed).toBe(false);
    // Owned before a later day, it works normally.
    expect(freezesOwnedBefore(ledger, addCivilDays(returnDay, 1))).toBe(input.amount);
    const spent = consumeFreezeFor(ledger, addCivilDays(returnDay, 1), returnDay);
    expect(spent.consumed).toBe(true);
    // And one consumption per covered day, ever: the second attempt is a no-op.
    expect(consumeFreezeFor(spent.ledger, addCivilDays(returnDay, 1), returnDay).consumed).toBe(
      false,
    );
  });

  it('[INV-FRZ-01] freezesOwnedBefore counts grants owned before the day and consumptions before it', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: -20, max: 20 }), fc.integer({ min: 1, max: 3 })), {
          minLength: 0,
          maxLength: 12,
        }),
        fc.array(fc.integer({ min: -20, max: 20 }), { minLength: 0, maxLength: 12 }),
        fc.integer({ min: -20, max: 20 }),
        (grants, consumptions, dayOffset) => {
          const dayOf = (offset: number): LocalDay => addCivilDays(DAY, offset);
          const ledger: FreezeLedger = {
            cap: 99,
            grants: grants.map(([offset, amount], i) => ({
              grantKey: `g${i}`,
              channel: 'reward_chest' as const,
              subtype: null,
              ownedFromDay: dayOf(offset),
              requested: amount,
              applied: amount,
            })),
            consumptions: [...new Set(consumptions)].map((offset) => ({
              consumedForDay: dayOf(offset),
              consumedOnDay: DAY,
            })),
            societyTierKeys: [],
          };
          const day = dayOf(dayOffset);
          const expected =
            grants.filter(([offset]) => offset < dayOffset).reduce((sum, [, a]) => sum + a, 0) -
            [...new Set(consumptions)].filter((offset) => offset < dayOffset).length;
          expect(freezesOwnedBefore(ledger, day)).toBe(expected);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
