import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  COMMIT_WRITE_ORDER,
  DISK_FULL_ERROR_CODES,
  commitSession,
  type CommitInput,
  type CommitWriteGroup,
  type CommitWriter,
  type Reward,
} from './commit.js';

/**
 * INV-PER-04 — write order is attempts + mistakes → rewards, `SQLITE_FULL` suppresses the
 * ceremony, and the property that makes the order matter:
 *
 *   **THE CEREMONY NEVER DISPLAYS A REWARD THAT IS NOT IN THE DB.**
 */

const arbReward: fc.Arbitrary<Reward> = fc.record({
  kind: fc.constantFrom<Reward['kind']>('xp', 'gems', 'chest', 'freeze', 'boost', 'tier', 'badge'),
  id: fc.string({ minLength: 1, maxLength: 8 }),
  amount: fc.integer({ min: 1, max: 500 }),
});

const arbInput: fc.Arbitrary<CommitInput> = fc.record({
  sessionId: fc.string({ minLength: 1, maxLength: 10 }),
  attempts: fc.array(fc.record({ exerciseIndex: fc.nat({ max: 40 }), correct: fc.boolean() }), {
    maxLength: 20,
  }),
  mistakes: fc.array(fc.record({ itemId: fc.string({ maxLength: 8 }) }), { maxLength: 8 }),
  rewards: fc.array(arbReward, { maxLength: 6 }),
});

/** A writer that fails at a chosen group with a chosen code, and records what landed. */
interface RecordingWriter extends CommitWriter {
  readonly landed: CommitWriteGroup[];
}

function failingWriter(at: CommitWriteGroup | null, code: string): RecordingWriter {
  const landed: CommitWriteGroup[] = [];
  return {
    landed,
    write(group) {
      if (group === at) return code;
      landed.push(group);
      return null;
    },
  };
}

describe('INV-PER-04 commit write order', () => {
  it('[INV-PER-04] the order is attempts, then mistakes, then rewards', () => {
    expect([...COMMIT_WRITE_ORDER]).toEqual(['attempts', 'mistakes', 'rewards']);
  });

  it('[INV-PER-04] the ceremony never displays a reward that is not in the DB', () => {
    fc.assert(
      fc.property(
        arbInput,
        fc.option(fc.constantFrom<CommitWriteGroup>(...COMMIT_WRITE_ORDER), { nil: null }),
        fc.constantFrom('SQLITE_FULL', 'SQLITE_IOERR_WRITE', 'SQLITE_BUSY'),
        (input, failAt, code) => {
          const writer = failingWriter(failAt, code);
          const result = commitSession(input, writer);

          // The DB holds the rewards only if the `rewards` group landed.
          const rewardsInDb = writer.landed.includes('rewards') ? input.rewards : [];
          const persistedIds = new Set(rewardsInDb.map((r) => `${r.kind}:${r.id}:${r.amount}`));
          for (const reward of result.ceremonyRewards) {
            expect(persistedIds.has(`${reward.kind}:${reward.id}:${reward.amount}`)).toBe(true);
          }
          // ...and the suppressed ceremony shows nothing at all.
          if (result.ceremonySuppressed) expect(result.ceremonyRewards).toEqual([]);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PER-04] a failure at any group stops the commit there, in order', () => {
    fc.assert(
      fc.property(
        arbInput,
        fc.constantFrom<CommitWriteGroup>(...COMMIT_WRITE_ORDER),
        (input, failAt) => {
          const result = commitSession(input, failingWriter(failAt, 'SQLITE_FULL'));
          const stopAt = COMMIT_WRITE_ORDER.indexOf(failAt);
          expect(result.written).toEqual(COMMIT_WRITE_ORDER.slice(0, stopAt));
          expect(result.ceremonySuppressed).toBe(true);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PER-04] on SQLITE_FULL the ceremony is suppressed, not degraded', () => {
    const input: CommitInput = {
      sessionId: 's1',
      attempts: [{ exerciseIndex: 0, correct: true }],
      mistakes: [],
      rewards: [
        { kind: 'xp', id: 'lesson', amount: 15 },
        { kind: 'chest', id: 'goal', amount: 1 },
      ],
    };
    for (const code of DISK_FULL_ERROR_CODES) {
      const result = commitSession(input, failingWriter('rewards', code));
      expect(result.ceremonySuppressed).toBe(true);
      // Not "show the XP but not the chest": a partial ceremony leaves the learner with
      // no way to tell which rewards they actually have.
      expect(result.ceremonyRewards).toEqual([]);
      expect(result.persistedRewards).toEqual([]);
      expect(result.noticeKey).toBe('data.lowDisk.progressMayNotBeSaved');
    }
  });

  it('[INV-PER-04] a clean commit writes every group and shows exactly what it wrote', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const result = commitSession(input, failingWriter(null, 'unused'));
        expect(result.written).toEqual([...COMMIT_WRITE_ORDER]);
        expect(result.ceremonySuppressed).toBe(false);
        expect(result.ceremonyRewards).toEqual(input.rewards);
        expect(result.persistedRewards).toEqual(input.rewards);
        expect(result.errorCode).toBeNull();
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
