import { describe, expect, it } from 'vitest';
import { SOCIETY_CHECKPOINTS } from '../economy/config.js';
import { toLocalDay } from './civil.js';
import { DAY_CONFIG } from './config.js';
import { consumeFreezeFor, enterSocietyTier, freezesHeld, newFreezeLedger } from './freeze.js';

const day = toLocalDay('2026-09-13');
describe('Society freeze checkpoint conformance', () => {
  it('[INV-FRZ-04] uses the approved seven-day entry and common checkpoint IDs', () => {
    expect(DAY_CONFIG.societyTiers.map(({ tier, streak }) => ({ tier, streak }))).toEqual(
      SOCIETY_CHECKPOINTS.map(({ id, streakDays }) => ({ tier: id, streak: streakDays })),
    );
    const entry = enterSocietyTier(newFreezeLedger(day), 'society-entry', 'entry', day);
    expect(entry.ledger.cap).toBe(5);
    expect(entry.applied).toBe(3);
    expect(freezesHeld(entry.ledger)).toBe(5);
    expect(enterSocietyTier(newFreezeLedger(day), 'ember', 'old', day).applied).toBe(0);
  });

  it('[INV-FRZ-04] pays exactly the checkpoint gift and never replays it after spending', () => {
    let empty = newFreezeLedger(toLocalDay('2026-09-10'));
    for (const date of ['2026-09-11', '2026-09-12'])
      empty = consumeFreezeFor(empty, toLocalDay(date), day).ledger;
    const entry = enterSocietyTier(empty, 'society-entry', 'entry', day);
    expect(entry.applied).toBe(3);
    expect(freezesHeld(entry.ledger)).toBe(3);
    const spent = consumeFreezeFor(
      entry.ledger,
      toLocalDay('2026-09-14'),
      toLocalDay('2026-09-14'),
    ).ledger;
    expect(enterSocietyTier(spent, 'society-entry', 'clock-replay', day).ledger).toEqual(spent);
    const second = enterSocietyTier(spent, 'society-second', 'second', toLocalDay('2026-10-01'));
    expect(second.ledger.cap).toBe(5);
    expect(second.applied).toBe(3);
    expect(freezesHeld(second.ledger)).toBe(5);
    expect(
      enterSocietyTier(second.ledger, 'society-third', 'third', toLocalDay('2027-09-13')).ceremony,
    ).toBe(false);
  });
});
