import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  RESUME_FIELDS,
  RESUME_OFFER_AGE_MS,
  SESSION_ROW_FIELDS,
  toSessionRow,
  checkpoint,
  coldStartRoute,
  deserialiseSession,
  monotonicAgeMs,
  resumeDecision,
  resumeOffered,
  seedsOnResume,
  serialiseSession,
  sessionStateKey,
} from './resume.js';
import { COURSE_A, COURSE_B, freshSession, items } from './session-fixture.js';
import { ScriptedGrading, TestMonotonicClock } from './test-doubles.js';
import { step } from './machine.js';
import type { RuntimeState, SessionEvent, StepDeps } from './machine.js';
import { DEFAULT_FLAVOUR_MATRIX } from './flavours.js';
import { SESSION_FLAVOURS } from './types.js';
import type { VerdictKind } from './types.js';

function deps(over: Partial<StepDeps> = {}): StepDeps {
  return {
    config: DEFAULT_FLAVOUR_MATRIX.lesson,
    grading: new ScriptedGrading(),
    clock: new TestMonotonicClock(),
    isTypeEligible: () => true,
    stepUpTripped: () => false,
    ...over,
  };
}

/** A realistic event script: render, type, check, grade, continue — over and over. */
const EVENT_SCRIPT: readonly SessionEvent[] = [
  { type: 'rendered' },
  { type: 'audioCompleted' },
  {
    type: 'input',
    text: 'una manzana',
    caret: 11,
    partialState: { tiles: [3, 1] },
    gradeable: true,
  },
  { type: 'check' },
  { type: 'graded' },
  { type: 'continue' },
];

/** Drive `n` events of the script and return every intermediate state. */
function drive(start: RuntimeState, n: number, d = deps()): RuntimeState[] {
  const states: RuntimeState[] = [start];
  let state = start;
  for (let i = 0; i < n; i += 1) {
    state = step(state, EVENT_SCRIPT[i % EVENT_SCRIPT.length]!, d).state;
    states.push(state);
  }
  return states;
}

describe('resume (S051)', () => {
  it('[INV-SESS-06] the persisted session row contains all nine fields — a schema with fewer fails by construction', () => {
    const session = freshSession();
    expect([...RESUME_FIELDS]).toEqual([
      'queue',
      'index',
      'answers',
      'hearts',
      'combo',
      'usedInterstitialKeys',
      'inputMode',
      'hardMode',
      'optionSeeds',
    ]);
    expect(Object.keys(session.core).sort()).toEqual([...RESUME_FIELDS].sort());
    expect(RESUME_FIELDS).toHaveLength(9);
    for (const field of RESUME_FIELDS) {
      expect(session.core[field], `missing field ${field}`).toBeDefined();
    }
  });

  it('[INV-SESS-01] a session killed at any point RESUMES where it left off: the restored run and the un-killed run end byte-identical', () => {
    // The previous form of this property was a tautology and a refuter said so: it drove
    // to a kill point and asserted `serialise(deserialise(bytes)) === bytes`, which holds
    // for ANY JSON value, then compared `canonicalJson(restored.core)` with
    // `canonicalJson(killed.core)` — the same object, sorted the same way. It proved
    // `JSON.parse ∘ stringify = id`, not that a restored session resumes.
    //
    // This is the RESUMPTION-EQUIVALENCE form. Drive n steps, kill, restore from the
    // BYTES of the DECLARED row, then run the SAME remaining script from the restored
    // state and from the un-killed state. If any field the machine reads stops being
    // checkpointed — `currentReplay`, `mistakeRows`, `lastVerdict`, `endReviewIntroShown`
    // — the two runs diverge and this fails. The clock is constant so the only thing
    // that can differ is state the kill dropped.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 26 }),
        fc.integer({ min: 1, max: 20 }),
        fc.constantFrom<VerdictKind>('correct', 'wrong', 'softCorrect'),
        (killAfter, thenRun, verdict) => {
          const build = (): StepDeps =>
            deps({
              grading: new ScriptedGrading({ 'item-2': verdict }),
              clock: { nowMs: () => 7_777 },
            });

          let live = freshSession({ queue: items(6) });
          for (let i = 0; i < killAfter; i += 1) {
            live = step(live, EVENT_SCRIPT[i % EVENT_SCRIPT.length]!, build()).state;
          }

          const bytes = serialiseSession(live);
          const restored = deserialiseSession(bytes);
          // The row is closed under serialisation: a writer round-trip is the identity…
          expect(serialiseSession(restored)).toBe(bytes);

          // …and, the part that can actually fail, the two runs stay in lockstep.
          let fromKill = restored;
          let uninterrupted = live;
          for (let i = 0; i < thenRun; i += 1) {
            const event = EVENT_SCRIPT[(killAfter + i) % EVENT_SCRIPT.length]!;
            fromKill = step(fromKill, event, build()).state;
            uninterrupted = step(uninterrupted, event, build()).state;
          }
          expect(serialiseSession(fromKill)).toBe(serialiseSession(uninterrupted));
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SESS-01] the serialiser projects through the DECLARED row, so a runtime-only field cannot hide', () => {
    // The gap a refuter found: `currentReplay`, `mistakeRows`, `weakItemRows`,
    // `inputModeExplicit` and `packNonLatinScript` lived on a runtime object the row type
    // did not mention, and the tests serialised the runtime object. There is now one type
    // and one declared list, and `toSessionRow` is the only way into the serialiser.
    const d = deps({ grading: new ScriptedGrading({ 'item-1': 'wrong' }) });
    let state = freshSession({ queue: items(6) });
    state = step(state, { type: 'rendered' }, d).state;
    state = step(
      state,
      { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
      d,
    ).state;
    state = step(state, { type: 'check' }, d).state;
    state = step(state, { type: 'graded' }, d).state;
    // A durable mistake row and a banner verdict both exist now…
    expect(state.mistakeRows).toHaveLength(1);
    expect(state.lastVerdict).not.toBeNull();

    // …and both survive the DECLARED row, because the declared row contains them.
    const restored = deserialiseSession(serialiseSession(state));
    expect(restored.mistakeRows).toHaveLength(1);
    expect(restored.lastVerdict).toEqual(state.lastVerdict);

    // Every key of the runtime state is a declared field, and vice versa.
    expect(Object.keys(toSessionRow(state)).sort()).toEqual([...SESSION_ROW_FIELDS].sort());
    expect(Object.keys(state).sort()).toEqual([...SESSION_ROW_FIELDS].sort());
  });

  it('[INV-SESS-01] an in-flight REPLAY is checkpointed: a kill during the replay restores the replay, not the main item', () => {
    // `currentReplay` used only to be documented as persisted. Now it is in the row, and
    // this is the behaviour that proves it: kill mid-replay and the restored session is
    // still showing the replay's item id, not `queue[index]`.
    const d = deps({ grading: new ScriptedGrading({ 'item-1': 'wrong' }) });
    let state = freshSession({ queue: items(6) });
    state = step(state, { type: 'rendered' }, d).state;
    let guard = 0;
    while (state.currentReplay === null && guard < 60) {
      state = step(
        state,
        { type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true },
        d,
      ).state;
      state = step(state, { type: 'check' }, d).state;
      state = step(state, { type: 'graded' }, d).state;
      state = step(state, { type: 'continue' }, d).state;
      guard += 1;
    }
    expect(state.currentReplay).not.toBeNull();
    const restored = deserialiseSession(serialiseSession(state));
    expect(restored.currentReplay?.item.itemId).toBe('item-1');
    expect(restored.currentReplay?.phase).toBe('midLesson');
  });

  it('[INV-SESS-01] the checkpoint is never older than one challenge boundary', () => {
    const clock = new TestMonotonicClock(0);
    const d = deps({ clock });
    let state = freshSession({ queue: items(8) });
    let boundaries = 0;
    for (let i = 0; i < 24; i += 1) {
      clock.advance(1_000);
      const before = state.shellState;
      state = step(state, EVENT_SCRIPT[i % EVENT_SCRIPT.length]!, d).state;
      if (state.shellState === before) continue;
      // Every boundary re-stamps the row, so it can never be more than one behind.
      boundaries += 1;
      expect(state.checkpointMonotonicMs).toBe(clock.nowMs());
    }
    expect(boundaries).toBeGreaterThan(4);
  });

  it('[INV-SESS-15] the checkpoint carries ungraded in-flight input and an opaque partial_state, and no heart is charged twice', () => {
    const d = deps({ grading: new ScriptedGrading({}, 'wrong') });
    let state = freshSession({ flavour: 'jumpHere', queue: items(8) });
    state = step(state, { type: 'rendered' }, d).state;
    state = step(
      state,
      {
        type: 'input',
        text: 'medi',
        caret: 4,
        partialState: { strokeIndex: 4, matched: ['a', 'b'] },
        gradeable: true,
      },
      d,
    ).state;

    // Kill mid-typing.
    const restored = deserialiseSession(serialiseSession(state)) as RuntimeState;
    expect(restored.inFlight.text).toBe('medi');
    expect(restored.inFlight.caret).toBe(4);
    expect(restored.inFlight.partialState).toEqual({ strokeIndex: 4, matched: ['a', 'b'] });

    // Grade once: one pip paid.
    const graded = step(step(restored, { type: 'check' }, d).state, { type: 'graded' }, d).state;
    const paid = graded.core.hearts;
    expect(paid.kind).toBe('pips');
    // Replaying the SAME grade event (a resume that re-issues it) charges nothing more.
    const replayed = step(graded, { type: 'graded' }, d).state;
    expect(replayed.core.hearts).toEqual(paid);
    expect(replayed.core.answers).toHaveLength(1);
  });

  it('[INV-SESS-02] resume is offered iff the monotonic age exceeds 24 h, and is never wall-clock-derived', () => {
    fc.assert(
      fc.property(fc.integer({ min: -5_000_000, max: 200_000_000 }), (elapsed) => {
        const state = checkpoint(freshSession(), 1_000_000);
        const offered = resumeOffered(state, 1_000_000 + elapsed);
        expect(offered).toBe(Math.max(0, elapsed) > RESUME_OFFER_AGE_MS);
      }),
      { numRuns: PROPERTY_RUNS },
    );
    expect(RESUME_OFFER_AGE_MS).toBe(24 * 60 * 60 * 1000);
    // `monotonicAgeMs` takes no Date and no zone: it cannot be wall-clock-derived.
    expect(monotonicAgeMs.length).toBe(2);
  });

  it('[INV-SESS-10] a backwards jump clamps age to 0 and resumes silently; a forwards jump offers the choice and never auto-discards', () => {
    const state = checkpoint(freshSession(), 10_000_000);
    // Clock set back a day while a session is in flight.
    expect(monotonicAgeMs(state, 10_000_000 - 86_400_000)).toBe(0);
    expect(resumeDecision({ state, nowMonotonicMs: 1, queueResolvesInPack: true })).toEqual({
      kind: 'silentResume',
    });
    // Clock jumped a year forward mid-session.
    const year = 10_000_000 + 365 * 86_400_000;
    expect(resumeDecision({ state, nowMonotonicMs: year, queueResolvesInPack: true })).toEqual({
      kind: 'offerChoice',
    });
  });

  it('[INV-SESS-21] a queue that no longer resolves offers START OVER alone, never RESUME', () => {
    const state = checkpoint(freshSession(), 0);
    expect(resumeDecision({ state, nowMonotonicMs: 0, queueResolvesInPack: false })).toEqual({
      kind: 'startOverOnly',
      reason: 'packChanged',
    });
  });

  it('[INV-SESS-05] the realised option order of an already-presented item is replayed verbatim; unreached items re-randomise', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8 }), (index) => {
        const session = freshSession({ queue: items(8) });
        const parked = { ...session, core: { ...session.core, index } };
        const seeds = seedsOnResume(parked.core, () => 999_999);
        parked.core.queue.forEach((q, position) => {
          if (position < index) expect(seeds[q.id]).toBe(parked.core.optionSeeds[q.id]);
          else expect(seeds[q.id]).toBe(999_999);
        });
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SESS-05] falsifier: re-entering a previously-quit lesson re-randomises so positions cannot be memorised', () => {
    const session = freshSession({ queue: items(6) });
    const fresh = seedsOnResume({ ...session.core, index: 0 }, (id) => id.length * 7);
    expect(Object.values(fresh).every((v) => v % 7 === 0)).toBe(true);
  });

  it('[INV-SESS-08] cold start sets active_course_id from the session row before resolving the node route', () => {
    const session = freshSession({ courseId: COURSE_B, nodeRef: 'node-4' });
    // Persisted active course disagrees with the session's course.
    const route = coldStartRoute(COURSE_A, session);
    expect(route).toEqual({ activeCourseId: COURSE_B, nodeRef: 'node-4', resolvedFrom: 'session' });
    // No session: fall back to the persisted active course.
    expect(coldStartRoute(COURSE_A, null)?.activeCourseId).toBe(COURSE_A);
    expect(coldStartRoute(null, null)).toBeNull();
  });

  it('[INV-SESS-17] the session_state key is (course_id, session_kind, node_ref)', () => {
    expect(sessionStateKey(COURSE_A, 'graded', 'node-1')).not.toBe(
      sessionStateKey(COURSE_A, 'story', 'node-1'),
    );
    expect(sessionStateKey(COURSE_A, 'graded', 'node-1')).not.toBe(
      sessionStateKey(COURSE_B, 'graded', 'node-1'),
    );
    expect(sessionStateKey(COURSE_A, 'graded', 'node-1')).not.toBe(
      sessionStateKey(COURSE_A, 'graded', 'node-2'),
    );
  });

  it('[INV-SESS-19] hardMode is false at every session start for every flavour', () => {
    for (const flavour of SESSION_FLAVOURS) {
      expect(freshSession({ flavour }).core.hardMode).toBe(false);
    }
  });

  it('[INV-COM-02] combo is in the session row and restores with it', () => {
    const states = drive(freshSession({ queue: items(8) }), 12);
    const killed = states[states.length - 1]!;
    expect(deserialiseSession(serialiseSession(killed)).core.combo).toBe(killed.core.combo);
  });
});
