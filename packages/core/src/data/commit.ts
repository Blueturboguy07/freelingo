/**
 * Commit write order, and the one property that makes it matter (INV-PER-04, EC-CER-02).
 *
 * **The ceremony never displays a reward that is not in the DB.**
 *
 * The order is attempts + mistakes → rewards, and it is that way round because the two
 * halves fail differently. Attempts are facts about what the learner did; rewards are
 * derived from them. If rewards land first and the disk fills, the learner keeps a chest
 * they did not earn and the counters cannot reproduce it. If attempts land first and the
 * disk fills, the session is recorded and no ceremony runs — which is recoverable, because
 * every counter is recomputable from the attempt rows.
 *
 * On `SQLITE_FULL` the ceremony is **suppressed**, not degraded: a partial ceremony is a
 * ceremony that shows some rewards and not others, and the learner has no way to tell
 * which of them they actually have.
 */

/** The write groups, in the only order they may run. */
export const COMMIT_WRITE_ORDER = ['attempts', 'mistakes', 'rewards'] as const;
export type CommitWriteGroup = (typeof COMMIT_WRITE_ORDER)[number];

/** SQLite result codes that mean the write could not land for want of space. */
export const DISK_FULL_ERROR_CODES: readonly string[] = ['SQLITE_FULL', 'SQLITE_IOERR_WRITE'];

export interface Reward {
  readonly kind: 'xp' | 'gems' | 'chest' | 'freeze' | 'boost' | 'tier' | 'badge';
  readonly id: string;
  readonly amount: number;
}

export interface CommitInput {
  readonly sessionId: string;
  readonly attempts: readonly { readonly exerciseIndex: number; readonly correct: boolean }[];
  readonly mistakes: readonly { readonly itemId: string }[];
  readonly rewards: readonly Reward[];
}

/** A writer that can fail. The shell implements it over `withExclusiveTransactionAsync`. */
export interface CommitWriter {
  /** Returns the SQLite error code on failure, or `null` when the group landed. */
  write(group: CommitWriteGroup, input: CommitInput): string | null;
}

export interface CommitResult {
  /** The groups that actually landed, in order. */
  readonly written: readonly CommitWriteGroup[];
  /** The error code that stopped the commit, if any. */
  readonly errorCode: string | null;
  /** Rewards that are in the DB. The ceremony may show these and nothing else. */
  readonly persistedRewards: readonly Reward[];
  /** Whether the ceremony runs at all. */
  readonly ceremonySuppressed: boolean;
  /** What the ceremony displays. Always a subset of `persistedRewards`. */
  readonly ceremonyRewards: readonly Reward[];
  /** S150's copy when the commit failed for space. */
  readonly noticeKey: string | null;
}

/**
 * Run the commit. Pure apart from the injected writer, so the property can drive a writer
 * that fails at every group in turn and assert the invariant for each.
 */
export function commitSession(input: CommitInput, writer: CommitWriter): CommitResult {
  const written: CommitWriteGroup[] = [];
  for (const group of COMMIT_WRITE_ORDER) {
    const errorCode = writer.write(group, input);
    if (errorCode !== null) {
      const diskFull = DISK_FULL_ERROR_CODES.includes(errorCode);
      return {
        written,
        errorCode,
        persistedRewards: [],
        ceremonySuppressed: true,
        ceremonyRewards: [],
        noticeKey: diskFull ? 'data.lowDisk.progressMayNotBeSaved' : 'data.commitFailed',
      };
    }
    written.push(group);
  }
  return {
    written,
    errorCode: null,
    persistedRewards: input.rewards,
    ceremonySuppressed: false,
    ceremonyRewards: input.rewards,
    noticeKey: null,
  };
}
