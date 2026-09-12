/**
 * The quit contract — S050.
 *
 * Owns INV-SESS-11, 12, 23, 25 and the whole of INV-SESS-14.
 *
 * ONE contract behind EVERY exit route. `ExitRoute` is an exhaustive union and
 * `quitContract` switches on nothing: X, Android system back, hardware back, the iOS
 * interactive pop, the slide-down dismiss and every player surface's close control reach
 * the same three lines of code. That is the only way EC-SES-19's falsifier — "a back
 * gesture at any index with progress > 0 that reaches the path without the sheet, or
 * without committing attempt rows" — can be tested rather than reviewed.
 */
import type { SessionFlavourConfig } from './flavours.js';
import { baseSessionXp } from './flavours.js';
import type { ExitRoute, MistakeRow, ProgressWrite, WeakItemRow } from './types.js';
import type { SessionState } from './resume.js';
import { keyOf } from './resume.js';
import { exerciseSpec } from './registry.js';

/* ============================================================ 1. the decision */

export type QuitDecision =
  /** Zero progress: exit immediately, no dialog, no rows (INV-SESS-12). */
  | { readonly kind: 'exitImmediately'; readonly writes: readonly ProgressWrite[] }
  /** Progress > 0: the bottom sheet. Nothing is written until it is answered. */
  | { readonly kind: 'showQuitSheet' };

/**
 * X on the FIRST UNANSWERED exercise exits immediately. "First unanswered" is
 * `index === 0 && answers.length === 0`, not `progress === 0`: a learner who answered one
 * item wrongly has progress 0 on the bar and a committed attempt, and must get the sheet.
 */
export function quitDecision(state: SessionState): QuitDecision {
  if (state.shellState === 'tips') {
    // INV-SESS-22: leaving `tips` writes ZERO rows of any kind — no session_state row
    // either, which is the falsifier ("X from the tips state persists a session_state row").
    return { kind: 'exitImmediately', writes: [] };
  }
  const untouched = state.core.index === 0 && state.core.answers.length === 0;
  if (untouched) return { kind: 'exitImmediately', writes: [] };
  return { kind: 'showQuitSheet' };
}

/* ============================================================ 2. the commit */

export interface QuitCommitInput {
  readonly state: SessionState;
  readonly config: SessionFlavourConfig;
  readonly route: ExitRoute;
  /** Mistake rows accumulated this session — durable, hub-visible. */
  readonly mistakeRows: readonly MistakeRow[];
  readonly weakItemRows: readonly WeakItemRow[];
}

export interface QuitCommit {
  readonly writes: readonly ProgressWrite[];
  /** Always 0. `End session` discards session XP (S050). */
  readonly xpAwarded: 0;
  /** Always false. The node ring never advances on an abandonment (INV-SESS-11). */
  readonly advancesNodeRing: false;
  readonly route: ExitRoute;
}

/**
 * `End session`, and every abandonment that reaches it.
 *
 * INV-SESS-11: commit EVERY answered attempt and EVERY mistake row to the scheduler,
 * while discarding session XP and the node-ring advance. Freelingo's documented
 * divergence from Duolingo — the attempts feed local FSRS either way.
 *
 * INV-SESS-23: a session with ZERO GRADED ATTEMPTS writes no session row and no
 * day-keyed reward. Ten `Can't speak now` taps can never mint a day, so `skipped` and
 * `noVerdict` answers do not count as graded.
 */
export function quitCommit(input: QuitCommitInput): QuitCommit {
  const { state, mistakeRows, weakItemRows, route } = input;
  const writes: ProgressWrite[] = [];

  for (const answer of state.core.answers) {
    writes.push({ kind: 'attempt', sessionId: state.sessionId, answer });
  }
  for (const row of mistakeRows) writes.push({ kind: 'mistake', row });
  for (const row of weakItemRows) writes.push({ kind: 'weakItem', row });

  // The row is always removed: quitting and being killed must land identically, and a
  // parked row that survives an explicit quit would offer RESUME on a session the learner
  // ended (EC-SES-30).
  writes.push({ kind: 'sessionStateDelete', key: keyOf(state) });

  return { writes, xpAwarded: 0, advancesNodeRing: false, route };
}

/** An answer that counts as GRADED for INV-SESS-23. */
export function isGradedAttempt(answer: { skipped: boolean; verdict: string }): boolean {
  return !answer.skipped && answer.verdict !== 'noVerdict';
}

export function gradedAttemptCount(state: SessionState): number {
  return state.core.answers.filter(isGradedAttempt).length;
}

/* ============================================================ 3. the completion */

export interface CompletionCommitInput {
  readonly state: SessionState;
  readonly config: SessionFlavourConfig;
  readonly mistakeRows: readonly MistakeRow[];
  readonly weakItemRows: readonly WeakItemRow[];
}

export interface CompletionCommit {
  readonly writes: readonly ProgressWrite[];
  readonly xpAwarded: number;
  readonly advancesNodeRing: boolean;
}

/**
 * The honest completion — the ONLY path that writes a session row and a day-keyed reward.
 *
 * INV-SESS-23's falsifier is a Perfect-Pronunciation session skipped ten times extending
 * the streak, so the graded-attempt count gates BOTH writes, not just the XP.
 * INV-SESS-26: base XP is prorated by gradeable items served and is non-decreasing in
 * them (`baseSessionXp`).
 */
export function completionCommit(input: CompletionCommitInput): CompletionCommit {
  const { state, config, mistakeRows, weakItemRows } = input;
  const writes: ProgressWrite[] = [];

  for (const answer of state.core.answers) {
    writes.push({ kind: 'attempt', sessionId: state.sessionId, answer });
  }
  for (const row of mistakeRows) writes.push({ kind: 'mistake', row });
  for (const row of weakItemRows) writes.push({ kind: 'weakItem', row });

  const graded = gradedAttemptCount(state);
  if (graded === 0) {
    writes.push({ kind: 'sessionStateDelete', key: keyOf(state) });
    return { writes, xpAwarded: 0, advancesNodeRing: false };
  }

  const gradeableServed = state.core.answers.filter(
    (a) => !a.skipped && exerciseSpec(a.type).punitive,
  ).length;
  const xp = baseSessionXp(config, gradeableServed);

  writes.push({
    kind: 'session',
    sessionId: state.sessionId,
    courseId: state.courseId,
    flavour: state.flavour,
    xp,
    advancesNodeRing: config.advancesNodeRing,
  });
  writes.push({ kind: 'dayReward', sessionId: state.sessionId, xp });
  writes.push({ kind: 'sessionStateDelete', key: keyOf(state) });

  return { writes, xpAwarded: xp, advancesNodeRing: config.advancesNodeRing };
}
