import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { completionCommit, gradedAttemptCount, quitCommit, quitDecision } from './quit.js';
import { DEFAULT_FLAVOUR_MATRIX } from './flavours.js';
import { freshSession, items } from './session-fixture.js';
import { keyOf } from './resume.js';
import { EXIT_ROUTES } from './types.js';
import type { Answer, ExerciseType, MistakeRow, VerdictKind } from './types.js';
import { step } from './machine.js';
import type { StepDeps } from './machine.js';
import { ScriptedGrading, TestMonotonicClock } from './test-doubles.js';

const LESSON = DEFAULT_FLAVOUR_MATRIX.lesson;

function deps(over: Partial<StepDeps> = {}): StepDeps {
  return {
    config: LESSON,
    grading: new ScriptedGrading(),
    clock: new TestMonotonicClock(),
    isTypeEligible: () => true,
    stepUpTripped: () => false,
    ...over,
  };
}

function answer(
  i: number,
  verdict: VerdictKind = 'correct',
  skipped = false,
  type: ExerciseType = 'meaningSelect',
): Answer {
  return {
    exerciseIndex: i,
    slotId: `slot-${i + 1}`,
    itemId: `item-${i + 1}`,
    type,
    verdict,
    softCorrected: verdict === 'softCorrect',
    wrong: verdict === 'wrong',
    costPaid: verdict === 'wrong' ? 1 : 0,
    skipped,
    scorable: !skipped,
    queue: 'main',
    note: null,
  };
}

const mistakeRow: MistakeRow = {
  itemId: 'item-2',
  courseId: 'en-es',
  conceptId: 'c2',
  createdInSessionId: 'session-1',
  reviewStreak: 0,
};

describe('the quit contract (S050)', () => {
  it('[INV-SESS-12] X on the first unanswered exercise writes ZERO rows of any kind', () => {
    const session = freshSession({ queue: items(12) });
    const decision = quitDecision(session);
    expect(decision.kind).toBe('exitImmediately');
    if (decision.kind !== 'exitImmediately') throw new Error('unreachable');
    expect(decision.writes).toEqual([]);

    // …and driving it through the machine writes nothing either.
    const d = deps();
    const rendered = step(session, { type: 'rendered' }, d).state;
    const result = step(rendered, { type: 'exit', route: 'closeButton' }, d);
    expect(result.writes).toEqual([]);
    expect(result.exit).toEqual({ route: 'closeButton', reason: 'immediate' });
  });

  it('[INV-SESS-12] one answered exercise is enough to earn the sheet, even with the bar still at zero', () => {
    const session = freshSession({ queue: items(12) });
    // A single WRONG answer: progress 0, but an attempt exists and must be committed.
    const touched = {
      ...session,
      core: { ...session.core, index: 1, answers: [answer(0, 'wrong')] },
    };
    expect(quitDecision(touched).kind).toBe('showQuitSheet');
  });

  it('[INV-SESS-14] every exit route resolves through one quit contract', () => {
    const d = deps();
    const session = freshSession({ queue: items(12) });
    const touched = {
      ...session,
      shellState: 'challenge.idle' as const,
      core: { ...session.core, index: 3, answers: [answer(0), answer(1), answer(2)] },
    };
    for (const route of EXIT_ROUTES) {
      const opened = step(touched, { type: 'exit', route }, d);
      // Never reaches the path without the sheet.
      expect(opened.state.shellState).toBe('quitDialog');
      expect(opened.exit).toBeNull();
      expect(opened.writes).toEqual([]);
      // …and ending from the sheet always commits the attempts.
      const ended = step(opened.state, { type: 'endSession', route }, d);
      expect(ended.writes.filter((w) => w.kind === 'attempt')).toHaveLength(3);
      expect(ended.exit).toEqual({ route, reason: 'quit' });
    }
  });

  it('[INV-SESS-14] falsifier: a back gesture at any index with progress > 0 reaches neither the path without the sheet nor a commit-free exit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 11 }),
        fc.constantFrom(...EXIT_ROUTES),
        (index, route) => {
          const session = freshSession({ queue: items(12) });
          const touched = {
            ...session,
            shellState: 'challenge.idle' as const,
            core: {
              ...session.core,
              index,
              answers: Array.from({ length: index }, (_, i) => answer(i)),
            },
          };
          const opened = step(touched, { type: 'exit', route }, deps());
          expect(opened.exit).toBeNull();
          expect(opened.state.shellState).toBe('quitDialog');
          const ended = step(opened.state, { type: 'endSession', route }, deps());
          expect(ended.writes.filter((w) => w.kind === 'attempt')).toHaveLength(index);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SESS-25] every player surface close control routes through the shared contract, awarding 0 XP while committing answered items', () => {
    const surfaces = ['storyCloseControl', 'radioCloseControl', 'hubCloseControl'] as const;
    for (const route of surfaces) {
      const session = freshSession({ queue: items(12) });
      const touched = {
        ...session,
        core: { ...session.core, index: 2, answers: [answer(0), answer(1)] },
      };
      const commit = quitCommit({
        state: touched,
        config: LESSON,
        route,
        mistakeRows: [mistakeRow],
        weakItemRows: [],
      });
      expect(commit.xpAwarded).toBe(0);
      expect(commit.advancesNodeRing).toBe(false);
      expect(commit.writes.filter((w) => w.kind === 'attempt')).toHaveLength(2);
      expect(commit.writes.filter((w) => w.kind === 'mistake')).toHaveLength(1);
      // Quitting and being killed land identically: the row is removed either way.
      expect(
        commit.writes.some((w) => w.kind === 'sessionStateDelete' && w.key === keyOf(touched)),
      ).toBe(true);
      // Never a session row, never a day-keyed reward.
      expect(commit.writes.some((w) => w.kind === 'session')).toBe(false);
      expect(commit.writes.some((w) => w.kind === 'dayReward')).toBe(false);
    }
  });

  it('[INV-SESS-11] End session and any abandonment commit every answered attempt and mistake while discarding session XP and the ring advance', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<VerdictKind>('correct', 'wrong', 'softCorrect'), {
          minLength: 1,
          maxLength: 12,
        }),
        fc.constantFrom(...EXIT_ROUTES),
        (verdicts, route) => {
          const session = freshSession({ queue: items(12) });
          const answers = verdicts.map((v, i) => answer(i, v));
          const rows = answers
            .filter((a) => a.wrong)
            .map((a) => ({ ...mistakeRow, itemId: a.itemId }));
          const touched = { ...session, core: { ...session.core, index: answers.length, answers } };
          const commit = quitCommit({
            state: touched,
            config: LESSON,
            route,
            mistakeRows: rows,
            weakItemRows: [],
          });
          expect(commit.writes.filter((w) => w.kind === 'attempt')).toHaveLength(answers.length);
          expect(commit.writes.filter((w) => w.kind === 'mistake')).toHaveLength(rows.length);
          expect(commit.xpAwarded).toBe(0);
          expect(commit.advancesNodeRing).toBe(false);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SESS-23] a session with zero graded attempts writes no session row and no day-keyed reward', () => {
    const session = freshSession({ queue: items(12) });
    // Ten `Can't speak now` taps in Perfect Pronunciation.
    const skips = Array.from({ length: 10 }, (_, i) =>
      answer(i, 'noVerdict', true, 'speakSentence'),
    );
    const skipped = { ...session, core: { ...session.core, index: 10, answers: skips } };
    expect(gradedAttemptCount(skipped)).toBe(0);
    const commit = completionCommit({
      state: skipped,
      config: LESSON,
      mistakeRows: [],
      weakItemRows: [],
    });
    expect(commit.writes.some((w) => w.kind === 'session')).toBe(false);
    expect(commit.writes.some((w) => w.kind === 'dayReward')).toBe(false);
    expect(commit.xpAwarded).toBe(0);
    // The attempts themselves still reach FSRS — the skip is a fact about the session.
    expect(commit.writes.filter((w) => w.kind === 'attempt')).toHaveLength(10);
  });

  it('[INV-SESS-23] one graded attempt is enough to write the session row and the day reward', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 14 }), (gradedFlags) => {
        const session = freshSession({ queue: items(12) });
        const answers = gradedFlags.map((graded, i) =>
          graded ? answer(i, 'correct') : answer(i, 'noVerdict', true, 'speakSentence'),
        );
        const touched = { ...session, core: { ...session.core, index: answers.length, answers } };
        const commit = completionCommit({
          state: touched,
          config: LESSON,
          mistakeRows: [],
          weakItemRows: [],
        });
        const anyGraded = gradedFlags.some(Boolean);
        expect(commit.writes.some((w) => w.kind === 'session')).toBe(anyGraded);
        expect(commit.writes.some((w) => w.kind === 'dayReward')).toBe(anyGraded);
        // A day reward never exists without its session row.
        if (commit.writes.some((w) => w.kind === 'dayReward')) {
          expect(commit.writes.some((w) => w.kind === 'session')).toBe(true);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SESS-22] X from the tips state persists no session_state row', () => {
    const session = { ...freshSession(), shellState: 'tips' as const };
    const decision = quitDecision(session);
    expect(decision.kind).toBe('exitImmediately');
    if (decision.kind !== 'exitImmediately') throw new Error('unreachable');
    expect(decision.writes).toEqual([]);
    const result = step(session, { type: 'exit', route: 'closeButton' }, deps());
    expect(result.writes).toEqual([]);
  });

  it('[INV-SESS-26] a completed session commits base XP prorated by gradeable items served', () => {
    const session = freshSession({ queue: items(12) });
    const four = {
      ...session,
      core: { ...session.core, answers: Array.from({ length: 4 }, (_, i) => answer(i)) },
    };
    const fourteen = {
      ...session,
      core: { ...session.core, answers: Array.from({ length: 14 }, (_, i) => answer(i)) },
    };
    const a = completionCommit({ state: four, config: LESSON, mistakeRows: [], weakItemRows: [] });
    const b = completionCommit({
      state: fourteen,
      config: LESSON,
      mistakeRows: [],
      weakItemRows: [],
    });
    expect(a.xpAwarded).toBeLessThan(b.xpAwarded);
    expect(b.xpAwarded).toBe(LESSON.baseXp);
  });
});
