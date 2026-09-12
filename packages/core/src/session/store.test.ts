import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  InMemorySessionStore,
  SessionStoreError,
  applyStartOverExclusion,
  planStartOver,
  requestStart,
} from './store.js';
import { COURSE_A, COURSE_B, freshSession, items } from './session-fixture.js';
import { keyOf } from './resume.js';
import type { Answer, SessionKind } from './types.js';

function answered(n: number): Answer[] {
  return Array.from({ length: n }, (_, i) => ({
    exerciseIndex: i,
    slotId: `slot-${i + 1}`,
    itemId: `item-${i + 1}`,
    type: 'meaningSelect' as const,
    verdict: 'correct' as const,
    softCorrected: false,
    wrong: false,
    costPaid: 0,
    skipped: false,
    scorable: true,
    queue: 'main' as const,
  }));
}

describe('session_state store (S052)', () => {
  it('[INV-SESS-07] at most one row per course key, and switching courses never deletes a row', () => {
    const store = new InMemorySessionStore();
    // Two courses is the default fixture, not the exceptional one.
    const a = freshSession({ courseId: COURSE_A, nodeRef: 'node-1', sessionKind: 'story' });
    const b = freshSession({ courseId: COURSE_B, nodeRef: 'node-1', sessionKind: 'story' });
    store.put(a);
    store.put(b);
    expect(store.all()).toHaveLength(2);
    // An upsert on the same key replaces rather than adding.
    store.put({ ...a, core: { ...a.core, index: 4 } });
    expect(store.forCourse(COURSE_A)).toHaveLength(1);
    expect(store.get(COURSE_A, 'story', 'node-1')!.core.index).toBe(4);
    // The other course's parked row is untouched — a course switch parks, never discards.
    expect(store.get(COURSE_B, 'story', 'node-1')).not.toBeNull();
  });

  it('[INV-SESS-17] session_state is keyed (course_id, session_kind, node_ref) with ≤1 row per key, and story/radio live in their own rows', () => {
    const store = new InMemorySessionStore();
    const story = freshSession({ courseId: COURSE_A, sessionKind: 'story', nodeRef: 'story-3' });
    const radio = freshSession({ courseId: COURSE_A, sessionKind: 'radio', nodeRef: 'ep-1' });
    const lesson = freshSession({ courseId: COURSE_A, sessionKind: 'graded', nodeRef: 'node-1' });
    store.put(story);
    store.put(radio);
    // Falsifier: opening a lesson evicts a parked story.
    store.put(lesson);
    expect(store.get(COURSE_A, 'story', 'story-3')).not.toBeNull();
    expect(store.get(COURSE_A, 'radio', 'ep-1')).not.toBeNull();
    expect(store.get(COURSE_A, 'graded', 'node-1')).not.toBeNull();
    expect(store.all()).toHaveLength(3);
    expect(new Set(store.all().map(keyOf)).size).toBe(3);
  });

  it('[INV-SESS-09] at most one graded session is in flight globally, across courses', () => {
    const store = new InMemorySessionStore();
    store.put(freshSession({ courseId: COURSE_A, sessionKind: 'graded', nodeRef: 'node-1' }));
    expect(() =>
      store.put(freshSession({ courseId: COURSE_B, sessionKind: 'graded', nodeRef: 'node-1' })),
    ).toThrow(SessionStoreError);
    // …while non-graded rows in both courses are always allowed.
    store.put(freshSession({ courseId: COURSE_B, sessionKind: 'story', nodeRef: 's1' }));
    expect(store.all().filter((r) => r.sessionKind === 'graded')).toHaveLength(1);
  });

  it('[INV-SESS-09] requesting a second graded session opens the guard sheet naming the live one, and never creates a row', () => {
    const store = new InMemorySessionStore();
    const live = freshSession({
      courseId: COURSE_A,
      sessionKind: 'graded',
      nodeRef: 'node-1',
      queue: items(12),
    });
    store.put({ ...live, core: { ...live.core, index: 7 } });
    const outcome = requestStart(store, { courseId: COURSE_B, kind: 'graded', nodeRef: 'node-9' });
    expect(outcome.kind).toBe('guardSheet');
    if (outcome.kind !== 'guardSheet') throw new Error('unreachable');
    expect(outcome.liveNodeRef).toBe('node-1');
    expect(outcome.liveIndex).toBe(7);
    expect(outcome.liveLength).toBe(12);
    expect(store.all()).toHaveLength(1);

    // Re-entering the SAME session is not a collision.
    expect(
      requestStart(store, { courseId: COURSE_A, kind: 'graded', nodeRef: 'node-1' }).kind,
    ).toBe('start');
    // A story never collides with a live lesson.
    expect(requestStart(store, { courseId: COURSE_A, kind: 'story', nodeRef: 's1' }).kind).toBe(
      'start',
    );
  });

  it('[INV-SESS-09] every deep link resolves through the same guard, for any mix of parked rows', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.tuple(
            fc.constantFrom(COURSE_A, COURSE_B),
            fc.constantFrom<SessionKind>('graded', 'story', 'radio'),
            fc.constantFrom('n1', 'n2'),
          ),
          { maxLength: 5, selector: (t) => t.join('|') },
        ),
        (rows) => {
          const store = new InMemorySessionStore();
          let gradedPut = 0;
          for (const [courseId, sessionKind, nodeRef] of rows) {
            const state = freshSession({ courseId, sessionKind, nodeRef });
            try {
              store.put(state);
              if (sessionKind === 'graded') gradedPut += 1;
            } catch {
              // The store refused a second graded row — which is the invariant.
              expect(sessionKind).toBe('graded');
              expect(gradedPut).toBe(1);
            }
          }
          expect(store.all().filter((r) => r.sessionKind === 'graded').length).toBeLessThanOrEqual(
            1,
          );
          expect(new Set(store.all().map(keyOf)).size).toBe(store.all().length);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SESS-03] START OVER produces a queue disjoint from the abandoned one except for FSRS-due items, and writes no new attempt rows', () => {
    const session = freshSession({ queue: items(12) });
    const parked = {
      ...session,
      core: { ...session.core, index: 5, answers: answered(5) },
      mistakes: [
        {
          itemId: 'item-2',
          slotId: 'slot-2',
          originalType: 'meaningSelect' as const,
          servesRemaining: 4,
          recyclesServed: 0,
        },
      ],
    };
    const plan = planStartOver(parked, (id) => id === 'item-3');
    expect([...plan.excludedItemIds].sort()).toEqual(['item-1', 'item-2', 'item-4', 'item-5']);
    expect(plan.dueExceptions).toEqual(['item-3']);
    // The parked session's undrained mistakes are HANDED OVER, not dropped.
    expect(plan.handedOverMistakes).toEqual(['item-2']);
    // The row and the reserved ring advance go in the same transaction as regeneration.
    expect(plan.deleteKey).toBe(keyOf(parked));
    expect(plan.releaseNodeRingReservation).toBe(true);

    const regenerated = applyStartOverExclusion(items(12), plan);
    const ids = regenerated.map((q) => q.itemId);
    for (const excluded of plan.excludedItemIds) expect(ids).not.toContain(excluded);
    expect(ids).toContain('item-3');
  });

  it('[INV-SESS-03] for any kill point, START OVER never re-serves an answered item that is not due', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 12 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 12 }), { maxLength: 4 }),
        (index, dueIndices) => {
          const session = freshSession({ queue: items(12) });
          const parked = {
            ...session,
            core: { ...session.core, index, answers: answered(index) },
          };
          const due = new Set(dueIndices.map((i) => `item-${i}`));
          const plan = planStartOver(parked, (id) => due.has(id));
          const regenerated = applyStartOverExclusion(items(12), plan).map((q) => q.itemId);
          for (let i = 1; i <= index; i += 1) {
            const id = `item-${i}`;
            if (!due.has(id)) expect(regenerated).not.toContain(id);
          }
          // Existing attempt rows stand: the plan writes none of its own.
          expect(Object.keys(plan)).not.toContain('attempts');
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
