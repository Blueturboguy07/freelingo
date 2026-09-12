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
 *
 * ## The retry EC-CER-02 asks for
 *
 * `SQLITE_FULL` is a distinct read-only mode where `integrity_check` passes, so the
 * corruption ladder never fires and the session stays resumable. The catalogue row is
 * explicit: *"Retry once after a WAL checkpoint, then a 'Couldn't save this session'
 * sheet naming the shortfall, ceremony suppressed."* A `wal_checkpoint(TRUNCATE)` plus
 * shedding the re-fetchable audio pack frees real bytes — the WAL of a long session is
 * megabytes and the pack is tens — so the single retry is not decoration: it is the
 * difference between a learner losing the session they just did and not.
 *
 * **Exactly once**, and only for the disk-full class. A retry loop on a genuinely full
 * disk is a spinner, and a retry on any other error is a retry on something the
 * checkpoint cannot have fixed.
 *
 * ## The sanitiser's storage-time call site (INV-SEC-01)
 *
 * This is the write path for typed answers and the tier-3 diff, so this is where
 * `sanitiseUserText` runs — **before** the row reaches the writer, not when a surface
 * renders it. The writer is handed a `StoredCommitInput` and there is no way to hand it
 * anything else: `commitSession` takes the raw input and the writer's type does not
 * accept it.
 */
import { sanitiseUserText, type UserTextField } from '../security/sanitise.js';

/** The write groups, in the only order they may run. */
export const COMMIT_WRITE_ORDER = ['attempts', 'mistakes', 'rewards'] as const;
export type CommitWriteGroup = (typeof COMMIT_WRITE_ORDER)[number];

/**
 * SQLite result codes that mean the write could not land for want of space, by the
 * symbolic name a driver reports and by the numeric primary result code where it reports
 * one (13 `SQLITE_FULL`, 10 `SQLITE_IOERR`).
 */
export const DISK_FULL_ERROR_CODES: readonly string[] = [
  'SQLITE_FULL',
  'SQLITE_IOERR_WRITE',
] as const;
export const DISK_FULL_RESULT_CODES: readonly number[] = [13] as const;
export const DISK_FULL_MESSAGE_FRAGMENTS: readonly string[] = [
  'database or disk is full',
  'disk i/o error',
] as const;

/** What a failed group write reports. `shortfallBytes` is what S150's sheet names. */
export interface CommitWriteFailure {
  readonly code: string;
  /** The numeric primary result code, when the driver surfaces one. */
  readonly resultCode?: number;
  readonly message?: string;
  /** Bytes the write still needed. 0 when the driver cannot say. */
  readonly shortfallBytes?: number;
}

export function isDiskFullFailure(failure: CommitWriteFailure): boolean {
  if (DISK_FULL_ERROR_CODES.includes(failure.code)) return true;
  if (
    typeof failure.resultCode === 'number' &&
    DISK_FULL_RESULT_CODES.includes(failure.resultCode & 0xff)
  ) {
    return true;
  }
  const text = (failure.message ?? '').toLowerCase();
  return DISK_FULL_MESSAGE_FRAGMENTS.some((fragment) => text.includes(fragment));
}

export interface Reward {
  readonly kind: 'xp' | 'gems' | 'chest' | 'freeze' | 'boost' | 'tier' | 'badge';
  readonly id: string;
  readonly amount: number;
}

/** An attempt as the session hands it over: `typedAnswer` and `diff` are raw user text. */
export interface CommitAttempt {
  readonly exerciseIndex: number;
  readonly correct: boolean;
  /** What the learner typed, exactly as typed. Sanitised before it is written. */
  readonly typedAnswer?: string;
  /** The tier-3 wrong-answer diff, which embeds the learner's own words. */
  readonly tier3Diff?: string;
}

/** A report note the learner wrote on S045, committed with the session. */
export interface CommitReport {
  readonly itemId: string;
  readonly note: string;
}

export interface CommitInput {
  readonly sessionId: string;
  readonly attempts: readonly CommitAttempt[];
  readonly mistakes: readonly { readonly itemId: string }[];
  readonly rewards: readonly Reward[];
  readonly reports?: readonly CommitReport[];
}

/** An attempt as it is stored: every user-text field has been through the sanitiser. */
export interface StoredCommitAttempt {
  readonly exerciseIndex: number;
  readonly correct: boolean;
  readonly typedAnswer: string | null;
  readonly tier3Diff: string | null;
}

export interface StoredCommitReport {
  readonly itemId: string;
  readonly note: string;
}

/**
 * Exactly what goes to the writer. The writer's signature takes this and not `CommitInput`,
 * so "sanitise at storage time" is enforced by the type rather than by remembering.
 */
export interface StoredCommitInput {
  readonly sessionId: string;
  readonly attempts: readonly StoredCommitAttempt[];
  readonly mistakes: readonly { readonly itemId: string }[];
  readonly rewards: readonly Reward[];
  readonly reports: readonly StoredCommitReport[];
}

/** The fields this write path sanitises, and which cap each one takes. */
export const COMMIT_SANITISED_FIELDS: Readonly<Record<string, UserTextField>> = {
  typedAnswer: 'typed-answer',
  tier3Diff: 'tier3-diff',
  note: 'report-note',
} as const;

/** Raw input → the rows that may be written. The only producer of `StoredCommitInput`. */
export function storedCommitInput(input: CommitInput): StoredCommitInput {
  return {
    sessionId: input.sessionId,
    attempts: input.attempts.map((attempt) => ({
      exerciseIndex: attempt.exerciseIndex,
      correct: attempt.correct,
      typedAnswer:
        attempt.typedAnswer === undefined
          ? null
          : sanitiseUserText('typed-answer', attempt.typedAnswer),
      tier3Diff:
        attempt.tier3Diff === undefined ? null : sanitiseUserText('tier3-diff', attempt.tier3Diff),
    })),
    mistakes: input.mistakes.map((mistake) => ({ itemId: mistake.itemId })),
    rewards: [...input.rewards],
    reports: (input.reports ?? []).map((report) => ({
      itemId: report.itemId,
      note: sanitiseUserText('report-note', report.note),
    })),
  };
}

/** A writer that can fail. The shell implements it over `withExclusiveTransactionAsync`. */
export interface CommitWriter {
  /** Returns the failure on error, or `null` when the group landed. */
  write(group: CommitWriteGroup, input: StoredCommitInput): CommitWriteFailure | null;
  /**
   * `PRAGMA wal_checkpoint(TRUNCATE)` plus shedding the re-fetchable audio pack. Returns
   * the bytes it freed, or `null` when the checkpoint itself failed.
   */
  checkpointAndShed(): number | null;
}

/** The retry state S150 holds the ceremony in, rather than resolving to tiles. */
export const COMMIT_RETRY_OFFERS = ['free-up-space', 'try-again'] as const;
export type CommitRetryOffer = (typeof COMMIT_RETRY_OFFERS)[number];

export interface CommitResult {
  /** The groups that actually landed, in order. */
  readonly written: readonly CommitWriteGroup[];
  /** The failure that stopped the commit, if any. */
  readonly failure: CommitWriteFailure | null;
  /** Did the disk-full path run its one checkpoint-and-retry? */
  readonly retried: boolean;
  /** Bytes the failing write still needed, for the sheet's copy. */
  readonly shortfallBytes: number;
  /** Rewards that are in the DB. The ceremony may show these and nothing else. */
  readonly persistedRewards: readonly Reward[];
  /** Whether the ceremony runs at all. */
  readonly ceremonySuppressed: boolean;
  /** What the ceremony displays. Always a subset of `persistedRewards`. */
  readonly ceremonyRewards: readonly Reward[];
  /** S150's copy when the commit failed for space. */
  readonly noticeKey: string | null;
  /** `FREE UP SPACE` / `TRY AGAIN`, against the same `session_id`-keyed commit. */
  readonly offers: readonly CommitRetryOffer[];
  /** The rows the writer was handed. Every user-text field already sanitised. */
  readonly stored: StoredCommitInput;
}

/**
 * Run the commit. Pure apart from the injected writer, so the property can drive a writer
 * that fails at every group in turn — and one that fails once and then succeeds — and
 * assert the invariant for each.
 */
export function commitSession(input: CommitInput, writer: CommitWriter): CommitResult {
  const stored = storedCommitInput(input);
  const written: CommitWriteGroup[] = [];
  let retried = false;

  for (const group of COMMIT_WRITE_ORDER) {
    let failure = writer.write(group, stored);

    // EC-CER-02: one checkpoint-and-shed, then one retry, and only for disk-full.
    if (failure !== null && isDiskFullFailure(failure) && !retried) {
      retried = true;
      const freed = writer.checkpointAndShed();
      if (freed !== null) failure = writer.write(group, stored);
    }

    if (failure !== null) {
      const diskFull = isDiskFullFailure(failure);
      return {
        written,
        failure,
        retried,
        shortfallBytes: Math.max(0, failure.shortfallBytes ?? 0),
        persistedRewards: [],
        ceremonySuppressed: true,
        ceremonyRewards: [],
        noticeKey: diskFull ? 'data.commitFailed.couldntSaveThisSession' : 'data.commitFailed',
        offers: diskFull ? [...COMMIT_RETRY_OFFERS] : ['try-again'],
        stored,
      };
    }
    written.push(group);
  }

  return {
    written,
    failure: null,
    retried,
    shortfallBytes: 0,
    persistedRewards: stored.rewards,
    ceremonySuppressed: false,
    ceremonyRewards: stored.rewards,
    noticeKey: null,
    offers: [],
    stored,
  };
}
