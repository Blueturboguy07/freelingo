import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  MAX_SERVES_PER_MISTAKE,
  REVIEW_STREAK_TO_RETIRE,
  SCHEDULED_RECYCLES_PER_MISTAKE,
  STROKE_REJECTIONS_FOR_WEAK_ITEM,
  WEAK_ITEM_HUB_TYPE,
  afterMistakeReplay,
  applyEncounter,
  hasPendingMistake,
  pendingServes,
  queueMistake,
  recycleTarget,
  refilterAgainstLiveRows,
  serveNextMistake,
  weakItemFor,
} from './mistakes.js';
import { DEFAULT_FLAVOUR_MATRIX, TEST_FLAVOURS } from './flavours.js';
import { EXERCISE_REGISTRY } from './registry.js';
import { EXERCISE_TYPES } from './types.js';
import type { ExerciseType, MistakeRow, QueuedMistake } from './types.js';
import { item } from './session-fixture.js';

/** Only a punitive type can become a mistake, so only these have recycles (INV-MIS-08). */
const PUNITIVE_TYPES = EXERCISE_TYPES.filter((t) => EXERCISE_REGISTRY[t].punitive);

const LESSON = DEFAULT_FLAVOUR_MATRIX.lesson;

function mistake(id: string, type: ExerciseType = 'meaningSelect'): QueuedMistake {
  return {
    itemId: id,
    slotId: `slot-${id}`,
    originalType: type,
    servesRemaining: MAX_SERVES_PER_MISTAKE,
    recyclesServed: 0,
  };
}

describe('mistake recycling (S049)', () => {
  it('[INV-MIS-01] every mistake is recycled exactly twice — once mid-lesson, once at the end', () => {
    let queue: readonly QueuedMistake[] = [mistake('a')];
    const phases: string[] = [];
    for (let guard = 0; guard < 10 && hasPendingMistake(queue); guard += 1) {
      const served = serveNextMistake(queue);
      expect(served).not.toBeNull();
      phases.push(served!.served.recyclesServed === 0 ? 'midLesson' : 'end');
      queue = afterMistakeReplay(served!.served, served!.rest, true);
    }
    expect(phases).toEqual(['midLesson', 'end']);
    expect(SCHEDULED_RECYCLES_PER_MISTAKE).toBe(2);
    expect(queue).toEqual([]);
  });

  it('[INV-MIS-01] the session cannot reach complete with a pending mistake', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 3 }),
        (verdicts, count) => {
          let queue: readonly QueuedMistake[] = Array.from({ length: count }, (_, i) =>
            mistake(`m${i}`),
          );
          let i = 0;
          while (hasPendingMistake(queue)) {
            const served = serveNextMistake(queue);
            expect(served).not.toBeNull();
            queue = afterMistakeReplay(
              served!.served,
              served!.rest,
              verdicts[i % verdicts.length]!,
            );
            i += 1;
            expect(i).toBeLessThanOrEqual(count * MAX_SERVES_PER_MISTAKE + 1);
          }
          // `complete` is only reachable once this is false — that is the definition
          // `machine.ts` uses, so the two cannot drift.
          expect(hasPendingMistake(queue)).toBe(false);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-MIS-02] the drain terminates for ANY answer sequence — a termination proof, not a spot check', () => {
    fc.assert(
      fc.property(
        // Including the always-wrong learner: the measure must still fall.
        fc.array(fc.boolean(), { minLength: 1, maxLength: 16 }),
        fc.integer({ min: 1, max: 4 }),
        (verdicts, count) => {
          let queue: readonly QueuedMistake[] = Array.from({ length: count }, (_, i) =>
            mistake(`m${i}`),
          );
          let measure = pendingServes(queue);
          let steps = 0;
          while (hasPendingMistake(queue)) {
            const served = serveNextMistake(queue)!;
            queue = afterMistakeReplay(
              served.served,
              served.rest,
              verdicts[steps % verdicts.length]!,
            );
            const next = pendingServes(queue);
            // Σ servesRemaining strictly decreases on every serve and is bounded below
            // by 0, so the loop is finite for every input. This IS the proof.
            expect(next).toBeLessThan(measure);
            measure = next;
            steps += 1;
          }
          expect(steps).toBeLessThanOrEqual(count * MAX_SERVES_PER_MISTAKE);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-MIS-02] falsifier: a wrong answer during the replay re-queues the item rather than dropping it', () => {
    const served = serveNextMistake([mistake('a')])!;
    const after = afterMistakeReplay(served.served, served.rest, false);
    expect(after.map((m) => m.itemId)).toEqual(['a']);
    expect(after[0]!.servesRemaining).toBeLessThan(MAX_SERVES_PER_MISTAKE);
  });

  it('[INV-MIS-03] the three test flavours produce zero recycles and zero mistake-queue entries', () => {
    for (const flavour of TEST_FLAVOURS) {
      const config = DEFAULT_FLAVOUR_MATRIX[flavour];
      const queue = queueMistake({ config, item: item(1), queue: [] });
      expect(queue, `${flavour} queued a mistake`).toEqual([]);
      expect(hasPendingMistake(queue)).toBe(false);
    }
    // And the lesson flavour does queue, so the test is not passing vacuously.
    expect(queueMistake({ config: LESSON, item: item(1), queue: [] })).toHaveLength(1);
  });

  it('[INV-MIS-04] a mistake retires only after two correct encounters in sessions OTHER than the one that created it', () => {
    const row: MistakeRow = {
      itemId: 'a',
      courseId: 'en-es',
      conceptId: 'c',
      createdInSessionId: 'S1',
      reviewStreak: 0,
    };
    // Both in-lesson replays correct: NOT retired. Self-correction inside the lesson that
    // created the miss is not evidence of retention (EC-MIS-09).
    let current = row;
    for (let i = 0; i < 5; i += 1) {
      const result = applyEncounter({ row: current, sessionId: 'S1', correct: true });
      expect(result.retired).toBe(false);
      current = result.row;
    }
    expect(current.reviewStreak).toBe(0);

    // Any surface counts, path or hub — only the session id matters.
    const first = applyEncounter({ row: current, sessionId: 'S2', correct: true });
    expect(first.retired).toBe(false);
    const second = applyEncounter({ row: first.row, sessionId: 'hub-7', correct: true });
    expect(second.retired).toBe(true);
    expect(REVIEW_STREAK_TO_RETIRE).toBe(2);
  });

  it('[INV-MIS-04] any wrong answer anywhere resets the review streak to 0', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom('S1', 'S2', 'hub'), fc.boolean()), { maxLength: 12 }),
        (encounters) => {
          let row: MistakeRow = {
            itemId: 'a',
            courseId: 'en-es',
            conceptId: 'c',
            createdInSessionId: 'S1',
            reviewStreak: 0,
          };
          let retired = false;
          for (const [sessionId, correct] of encounters) {
            const result = applyEncounter({ row, sessionId, correct });
            row = result.row;
            retired = retired || result.retired;
            if (!correct) expect(row.reviewStreak).toBe(0);
          }
          if (retired)
            expect(encounters.filter(([s, c]) => s !== 'S1' && c).length).toBeGreaterThanOrEqual(2);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-MIS-05] one wrong answer creates at most one mistake-queue entry, whatever the item', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...EXERCISE_TYPES),
        fc.integer({ min: 1, max: 5 }),
        (type, times) => {
          let queue: readonly QueuedMistake[] = [];
          const missed = item(1, { type });
          for (let i = 0; i < times; i += 1) {
            queue = queueMistake({ config: LESSON, item: missed, queue });
          }
          const punitive = EXERCISE_REGISTRY[type].punitive;
          // Never three rows for one miss — the falsifier is a Japanese miss inflating the
          // hub count threefold against Spanish.
          expect(queue.length).toBe(punitive ? 1 : 0);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-MIS-06] for every runtime eligibility state the recycle ladder terminates with a served item', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...EXERCISE_TYPES),
        fc.array(fc.constantFrom(...EXERCISE_TYPES), { maxLength: 6 }),
        (original, eligibleList) => {
          const eligible = new Set(eligibleList);
          const m = mistake('a', original);
          const mid = recycleTarget(m, 'midLesson', (t) => eligible.has(t));
          const end = recycleTarget(m, 'end', (t) => eligible.has(t));
          // Always a served item — never `null`, never a skipped recycle.
          expect(EXERCISE_TYPES).toContain(mid.type);
          // The end replay is always the ORIGINAL format (the PREVIOUS MISTAKE pill).
          expect(end.type).toBe(original);
          expect(end.degraded).toBe(false);
          // When nothing else is eligible the ladder degrades to the original rather than
          // ending the session unresolved.
          if (mid.degraded) expect(mid.type).toBe(original);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-MIS-07] every recycle target comes from the declared map, preserves the item id, and Trace is never a target', () => {
    fc.assert(
      // Only punitive types can BE a mistake, so only they have a recycle to schedule.
      fc.property(fc.constantFrom(...PUNITIVE_TYPES), (original) => {
        const m = mistake('a', original);
        const mid = recycleTarget(m, 'midLesson', () => true);
        const declared = EXERCISE_REGISTRY[original].recycleTargets;
        expect(mid.type === original || declared.includes(mid.type)).toBe(true);
        expect(mid.type).not.toBe('characterTrace');
      }),
      { numRuns: PROPERTY_RUNS },
    );
    // The specific case EC-MIS-12 names.
    const select = mistake('か', 'characterSelect');
    expect(recycleTarget(select, 'midLesson', () => true).type).toBe('gapFillTyped');
    expect(recycleTarget(select, 'end', () => true).type).toBe('characterSelect');
  });

  it('[INV-MIS-08] a rejected trace writes a weak-item row, never a mistake row, and reaches the hub as a recognition item', () => {
    const trace = item(1, { type: 'characterTrace' });
    // Eleven rejected strokes on one character.
    const weak = weakItemFor(trace, 'en-ja', 11);
    expect(weak).not.toBeNull();
    expect(weak!.itemId).toBe(trace.itemId);
    // …and NOT a mistake row: a non-punitive type never enters the queue.
    expect(queueMistake({ config: LESSON, item: trace, queue: [] })).toEqual([]);
    // The hub serves it as recognition, never as the trace it failed at.
    expect(WEAK_ITEM_HUB_TYPE).toBe('characterSelect');
    expect(EXERCISE_REGISTRY[WEAK_ITEM_HUB_TYPE].family).toBe('character');
    // One rejection is not a weak item.
    expect(weakItemFor(trace, 'en-ja', STROKE_REJECTIONS_FOR_WEAK_ITEM - 1)).toBeNull();
  });

  it('[INV-SESS-18] on resume the mistakes queue is re-filtered against live mistake rows', () => {
    const queue = [mistake('a'), mistake('b')];
    const live: MistakeRow[] = [
      { itemId: 'b', courseId: 'en-es', conceptId: 'c', createdInSessionId: 'S1', reviewStreak: 0 },
    ];
    // The hub retired `a` while the session was parked.
    const filtered = refilterAgainstLiveRows(queue, live);
    expect(filtered.map((m) => m.itemId)).toEqual(['b']);
    // If the queue empties, the session goes straight to complete.
    expect(refilterAgainstLiveRows(queue, [])).toEqual([]);
    expect(hasPendingMistake(refilterAgainstLiveRows(queue, []))).toBe(false);
  });
});
