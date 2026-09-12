import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  COMMIT_RETRY_OFFERS,
  COMMIT_WRITE_ORDER,
  DISK_FULL_ERROR_CODES,
  commitSession,
  isDiskFullFailure,
  storedCommitInput,
  type CommitInput,
  type CommitWriteFailure,
  type CommitWriteGroup,
  type CommitWriter,
  type Reward,
  type StoredCommitInput,
} from './commit.js';
import {
  BIDI_CONTROLS,
  USER_TEXT_MAX_CODE_POINTS,
  ZERO_WIDTH_CHARACTERS,
  containsForbiddenCharacter,
} from '../security/sanitise.js';

/**
 * INV-PER-04 — write order is attempts + mistakes → rewards, `SQLITE_FULL` suppresses the
 * ceremony after one checkpoint-and-retry (EC-CER-02), and the property that makes the
 * order matter:
 *
 *   **THE CEREMONY NEVER DISPLAYS A REWARD THAT IS NOT IN THE DB.**
 *
 * Plus INV-SEC-01's storage-time clause at the one write path `packages/core` has: the
 * writer is handed sanitised rows or it is handed nothing.
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

const failure = (code: string, shortfallBytes = 0): CommitWriteFailure => ({
  code,
  shortfallBytes,
});

/** A writer that fails at a chosen group with a chosen code, and records what landed. */
interface RecordingWriter extends CommitWriter {
  readonly landed: CommitWriteGroup[];
  readonly seen: StoredCommitInput[];
  checkpoints(): number;
}

/**
 * `failsTimes` is the EC-CER-02 lever: a writer that fails once and then succeeds is what
 * a disk-full-then-checkpointed device looks like, and a retry that does not exist cannot
 * be told from one that does without it.
 */
function makeWriter(options: {
  at: CommitWriteGroup | null;
  failure?: CommitWriteFailure;
  failsTimes?: number;
  checkpointFreesBytes?: number | null;
}): RecordingWriter {
  const landed: CommitWriteGroup[] = [];
  const seen: StoredCommitInput[] = [];
  let failuresLeft = options.failsTimes ?? Number.POSITIVE_INFINITY;
  let checkpointCalls = 0;
  return {
    landed,
    seen,
    checkpoints: () => checkpointCalls,
    write(group, input) {
      seen.push(input);
      if (group === options.at && failuresLeft > 0) {
        failuresLeft -= 1;
        return options.failure ?? failure('SQLITE_FULL');
      }
      landed.push(group);
      return null;
    },
    checkpointAndShed() {
      checkpointCalls += 1;
      return options.checkpointFreesBytes === undefined
        ? 12 * 1024 * 1024
        : options.checkpointFreesBytes;
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
        // EC-CER-02: the writer may fail once and then succeed after the checkpoint.
        fc.integer({ min: 1, max: 3 }),
        fc.option(fc.constant(null), { nil: 8_000_000 }),
        (input, failAt, code, failsTimes, checkpointFreesBytes) => {
          const writer = makeWriter({
            at: failAt,
            failure: failure(code, 4096),
            failsTimes,
            checkpointFreesBytes,
          });
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

  it('[INV-PER-04] a permanent failure at any group stops the commit there, in order', () => {
    fc.assert(
      fc.property(
        arbInput,
        fc.constantFrom<CommitWriteGroup>(...COMMIT_WRITE_ORDER),
        (input, failAt) => {
          const result = commitSession(input, makeWriter({ at: failAt }));
          const stopAt = COMMIT_WRITE_ORDER.indexOf(failAt);
          expect(result.written).toEqual(COMMIT_WRITE_ORDER.slice(0, stopAt));
          expect(result.ceremonySuppressed).toBe(true);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PER-04] on a permanent SQLITE_FULL the ceremony is suppressed, not degraded, and the sheet names the shortfall', () => {
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
      const result = commitSession(
        input,
        makeWriter({ at: 'rewards', failure: failure(code, 3_145_728) }),
      );
      expect(result.ceremonySuppressed).toBe(true);
      // Not "show the XP but not the chest": a partial ceremony leaves the learner with
      // no way to tell which rewards they actually have.
      expect(result.ceremonyRewards).toEqual([]);
      expect(result.persistedRewards).toEqual([]);
      expect(result.noticeKey).toBe('data.commitFailed.couldntSaveThisSession');
      // EC-CER-02: `FREE UP SPACE` / `TRY AGAIN`, against the same session_id-keyed commit.
      expect(result.offers).toEqual([...COMMIT_RETRY_OFFERS]);
      expect(result.shortfallBytes).toBe(3_145_728);
    }
  });

  it('[EC-CER-02][INV-PER-04] a disk-full write is retried ONCE after a WAL checkpoint, and the retry can save the session', () => {
    const input: CommitInput = {
      sessionId: 's-retry',
      attempts: [{ exerciseIndex: 0, correct: true }],
      mistakes: [],
      rewards: [{ kind: 'xp', id: 'lesson', amount: 15 }],
    };
    const writer = makeWriter({ at: 'rewards', failure: failure('SQLITE_FULL', 900), failsTimes: 1 });
    const result = commitSession(input, writer);

    expect(writer.checkpoints(), 'no wal_checkpoint(TRUNCATE) was attempted').toBe(1);
    expect(result.retried).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.written).toEqual([...COMMIT_WRITE_ORDER]);
    expect(result.ceremonySuppressed).toBe(false);
    expect(result.ceremonyRewards).toEqual(input.rewards);
  });

  it('[EC-CER-02][INV-PER-04] the retry happens exactly once, never in a loop', () => {
    const input: CommitInput = {
      sessionId: 's-loop',
      attempts: [],
      mistakes: [],
      rewards: [{ kind: 'gems', id: 'chest', amount: 20 }],
    };
    // Fails forever: a retry loop on a genuinely full disk is a spinner.
    const writer = makeWriter({ at: 'attempts', failure: failure('SQLITE_FULL', 7) });
    const result = commitSession(input, writer);
    expect(writer.checkpoints()).toBe(1);
    expect(result.retried).toBe(true);
    expect(result.ceremonySuppressed).toBe(true);
  });

  it('[EC-CER-02][INV-PER-04] a failed checkpoint means no retry, and nothing is written twice', () => {
    const writer = makeWriter({
      at: 'attempts',
      failure: failure('SQLITE_FULL', 7),
      failsTimes: 1,
      checkpointFreesBytes: null,
    });
    const result = commitSession(
      { sessionId: 's', attempts: [], mistakes: [], rewards: [] },
      writer,
    );
    expect(writer.checkpoints()).toBe(1);
    expect(result.failure?.code).toBe('SQLITE_FULL');
    expect(result.ceremonySuppressed).toBe(true);
  });

  it('[EC-CER-02][INV-PER-04] a non-disk-full error is never retried — a checkpoint cannot have fixed it', () => {
    const writer = makeWriter({ at: 'mistakes', failure: failure('SQLITE_BUSY'), failsTimes: 1 });
    const result = commitSession(
      { sessionId: 's', attempts: [], mistakes: [], rewards: [] },
      writer,
    );
    expect(writer.checkpoints()).toBe(0);
    expect(result.retried).toBe(false);
    expect(result.noticeKey).toBe('data.commitFailed');
    expect(result.offers).toEqual(['try-again']);
  });

  it('[EC-CER-02][INV-PER-04] disk-full is recognised by number and by message, not only by symbolic name', () => {
    // 13 is SQLITE_FULL; the drivers that surface a number surface that one, and the
    // driver that surfaces none (expo-sqlite) forwards sqlite3_errmsg.
    expect(isDiskFullFailure({ code: 'ERR_SQLITE_ERROR', resultCode: 13 })).toBe(true);
    expect(
      isDiskFullFailure({
        code: 'ERR_INTERNAL_SQLITE_ERROR',
        message: 'database or disk is full',
      }),
    ).toBe(true);
    expect(isDiskFullFailure({ code: 'ERR_SQLITE_ERROR', resultCode: 5 })).toBe(false);
  });

  it('[INV-PER-04] a clean commit writes every group and shows exactly what it wrote', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const result = commitSession(input, makeWriter({ at: null }));
        expect(result.written).toEqual([...COMMIT_WRITE_ORDER]);
        expect(result.ceremonySuppressed).toBe(false);
        expect(result.ceremonyRewards).toEqual(input.rewards);
        expect(result.persistedRewards).toEqual(input.rewards);
        expect(result.failure).toBeNull();
        expect(result.retried).toBe(false);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('INV-SEC-01 at STORAGE time: the commit write path', () => {
  /**
   * The invariant's load-bearing clause is "at storage time, not at render". This drives
   * hostile text through the real commit and asserts on what the **writer** was handed —
   * the value that reaches the DB, the export archive and any model prompt.
   */
  const hostile = fc
    .array(
      fc.oneof(
        fc.string({ maxLength: 6 }),
        fc.constantFrom(...BIDI_CONTROLS),
        fc.constantFrom(...ZERO_WIDTH_CHARACTERS),
        fc.constantFrom(' ', '', '', '﻿', '᠎'),
        fc.constantFrom('\n', '\t', '\r'),
      ),
      { maxLength: 40 },
    )
    .map((parts) => parts.join(''));

  it('[INV-SEC-01] the writer is never handed a bidi-control or Cf character, in any field', () => {
    fc.assert(
      fc.property(hostile, hostile, hostile, (typed, diff, note) => {
        const writer = makeWriter({ at: null });
        commitSession(
          {
            sessionId: 's',
            attempts: [{ exerciseIndex: 0, correct: false, typedAnswer: typed, tier3Diff: diff }],
            mistakes: [{ itemId: 'i_0123456789abcdef' }],
            rewards: [],
            reports: [{ itemId: 'i_0123456789abcdef', note }],
          },
          writer,
        );

        expect(writer.seen.length).toBeGreaterThan(0);
        for (const stored of writer.seen) {
          for (const attempt of stored.attempts) {
            expect(containsForbiddenCharacter(attempt.typedAnswer ?? '')).toBe(false);
            expect(containsForbiddenCharacter(attempt.tier3Diff ?? '')).toBe(false);
            expect([...(attempt.typedAnswer ?? '')].length).toBeLessThanOrEqual(
              USER_TEXT_MAX_CODE_POINTS['typed-answer'],
            );
            expect([...(attempt.tier3Diff ?? '')].length).toBeLessThanOrEqual(
              USER_TEXT_MAX_CODE_POINTS['tier3-diff'],
            );
          }
          for (const report of stored.reports) {
            expect(containsForbiddenCharacter(report.note)).toBe(false);
            expect([...report.note].length).toBeLessThanOrEqual(
              USER_TEXT_MAX_CODE_POINTS['report-note'],
            );
          }
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SEC-01] the sanitised rows are on the result too, so a caller cannot re-read the raw text', () => {
    const raw = `ho‮la${'​'.repeat(20)}`;
    const result = commitSession(
      {
        sessionId: 's',
        attempts: [{ exerciseIndex: 0, correct: true, typedAnswer: raw }],
        mistakes: [],
        rewards: [],
      },
      makeWriter({ at: null }),
    );
    expect(result.stored.attempts[0]!.typedAnswer).toBe('hola');
  });

  it('[INV-SEC-01] a field that was never typed stays null rather than becoming an empty string', () => {
    const stored = storedCommitInput({
      sessionId: 's',
      attempts: [{ exerciseIndex: 0, correct: true }],
      mistakes: [],
      rewards: [],
    });
    expect(stored.attempts[0]!.typedAnswer).toBeNull();
    expect(stored.attempts[0]!.tier3Diff).toBeNull();
    expect(stored.reports).toEqual([]);
  });
});
