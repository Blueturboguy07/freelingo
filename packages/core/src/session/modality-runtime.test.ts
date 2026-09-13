import { describe, expect, it } from 'vitest';
import { isSessionModalityState } from '../modality/index.js';
import { DEFAULT_FLAVOUR_MATRIX } from './flavours.js';
import { freshSession, item } from './session-fixture.js';
import { step } from './machine.js';
import type { StepDeps, SessionEvent } from './machine.js';
import { deserialiseSession, serialiseSession } from './resume.js';
import type { SessionState } from './resume.js';
import type { QueuedItem } from './types.js';

const replacement = (source: QueuedItem): QueuedItem => ({
  ...source,
  itemId: `${source.itemId}-recognition`,
  type: 'meaningSelect',
  family: 'recognition',
  requiresAudio: false,
});
const deps: StepDeps = {
  config: DEFAULT_FLAVOUR_MATRIX.nodePractice,
  grading: { grade: () => ({ kind: 'correct' }) },
  clock: { nowMs: () => 10 },
  isTypeEligible: () => true,
  stepUpTripped: () => false,
  modalityReplacement: replacement,
};
function start(): SessionState {
  const state = freshSession({
    flavour: 'nodePractice',
    queue: [
      item(1, { type: 'speakSentence' }),
      item(2, { type: 'speakSentence' }),
      item(3, { type: 'meaningSelect' }),
    ],
  });
  return {
    ...state,
    shellState: 'challenge.idle',
    core: { ...state.core, combo: 4 },
    motivationalMessages: false,
  };
}
function signal(
  state: SessionState,
  id: string,
  kind: 'no_audio' | 'transient' | 'interrupted' | 'permission-denied' | 'speech' | 'skip',
): SessionEvent {
  const current = state.currentReplay?.item ?? state.core.queue[state.core.index]!;
  const key = { eventId: id, slotId: current.id, itemId: current.itemId };
  if (kind === 'skip') return { type: 'modalitySkip', ...key, family: 'speaking' };
  if (kind === 'no_audio' || kind === 'speech')
    return {
      type: 'speechResult',
      ...key,
      transcript: kind === 'speech' ? 'Hola.' : '',
      amplitude: kind === 'speech' ? 0.5 : 0,
    };
  return { type: 'speechError', ...key, error: kind };
}
function answer(state: SessionState): SessionState {
  let next = step(
    state,
    { type: 'input', text: 'correct', caret: 7, partialState: {}, gradeable: true },
    deps,
  ).state;
  next = step(next, { type: 'check' }, deps).state;
  next = step(next, { type: 'graded' }, deps).state;
  return step(next, { type: 'continue' }, deps).state;
}
describe('actual session modality replacement', () => {
  it('[INV-SESS-01] external speech event IDs cannot invalidate the following persisted grade observation', () => {
    const before = start();
    const wrongDeps: StepDeps = { ...deps, grading: { grade: () => ({ kind: 'wrong' }) } };
    let state = step(before, signal(before, 'speech-grade:slot-1:1', 'speech'), wrongDeps).state;
    state = step(state, { type: 'check' }, wrongDeps).state;
    state = step(state, { type: 'graded' }, wrongDeps).state;
    expect(state.modality.observations.map((o) => o.reviewKind)).toEqual([
      'speech_received',
      'pronunciation_failure',
    ]);
    expect(isSessionModalityState(state.modality)).toBe(true);
    expect(new Set(state.modality.observations.map((o) => o.id)).size).toBe(2);
    expect(isSessionModalityState(JSON.parse(serialiseSession(state)).modality)).toBe(true);
  });
  it('[INV-MOD-02] explicit skip replaces in place and completes the original number of graded slots', () => {
    const before = start();
    const result = step(before, signal(before, 'skip-1', 'skip'), deps);
    expect(result.state.core.queue).toHaveLength(before.core.queue.length);
    expect(result.state.core.index).toBe(0);
    expect(result.state.core.queue.map((q) => q.type)).toEqual([
      'meaningSelect',
      'meaningSelect',
      'meaningSelect',
    ]);
    expect(result.state.core.answers).toEqual([]);
    expect(result.state.core.combo).toBe(4);
    expect(result.state.core.hearts).toEqual(before.core.hearts);
    expect(result.state.progress).toEqual(before.progress);
    expect(result.state.mistakeRows).toEqual([]);
    expect(result.suspendFamily).toBe('speaking');
    let state = result.state;
    for (let n = 0; n < 3; n++) state = answer(state);
    expect(state.shellState).toBe('complete');
    expect(state.core.answers).toHaveLength(3);
    expect(state.core.answers.map((a) => a.exerciseIndex)).toEqual([0, 1, 2]);
    expect(state.progress.numerator).toBe(3);
  });
  it('[INV-MOD-10] two transient errors replace only the current item and never request a snooze', () => {
    const before = start();
    const first = step(before, signal(before, 'route-1', 'transient'), deps);
    expect(first.state.core.queue).toEqual(before.core.queue);
    expect(first.suspendFamily).toBeUndefined();
    const second = step(first.state, signal(first.state, 'route-2', 'transient'), deps);
    expect(second.state.core.queue.map((q) => q.type)).toEqual([
      'meaningSelect',
      'speakSentence',
      'meaningSelect',
    ]);
    expect(second.suspendFamily).toBeUndefined();
    expect(second.state.modality.blockedFamilies).toEqual([]);
    expect(second.state.core.answers).toEqual([]);
    expect(second.state.core.combo).toBe(4);
  });
  it('[INV-MOD-09] third no_audio result survives kill and removes remaining production without a wrong answer', () => {
    let state = start();
    const duplicate = signal(state, 'silent-1', 'no_audio');
    state = step(state, duplicate, deps).state;
    state = step(state, duplicate, deps).state;
    state = step(state, signal(state, 'silent-2', 'no_audio'), deps).state;
    state = deserialiseSession(serialiseSession(state));
    expect(state.modality.observations.filter((row) => row.reviewKind === 'no_audio')).toHaveLength(
      2,
    );
    const result = step(state, signal(state, 'silent-3', 'no_audio'), deps);
    expect(result.state.core.queue.every((q) => q.type !== 'speakSentence')).toBe(true);
    expect(result.state.core.index).toBe(0);
    expect(result.state.core.answers).toEqual([]);
    expect(result.state.core.combo).toBe(4);
    expect(result.suspendFamily).toBeUndefined();
  });
  it('[INV-MOD-09] nonempty sub-floor speech is no_audio and cannot arm Check', () => {
    const state = start();
    const event = signal(state, 'occluded', 'speech');
    const result = step(state, { ...event, amplitude: 0 } as SessionEvent, deps);
    expect(result.state.shellState).toBe('challenge.idle');
    expect(result.state.inFlight.text).toBe('');
    expect(result.state.modality.observations.at(-1)?.reviewKind).toBe('no_audio');
    expect(result.state.core.answers).toEqual([]);
  });
  it('[INV-PLAT-09] interruption does not count as a failure and a valid result resets the transient streak', () => {
    let state = start();
    state = step(state, signal(state, 'route-1', 'transient'), deps).state;
    state = step(state, signal(state, 'phone', 'interrupted'), deps).state;
    expect(state.core.queue[0]?.type).toBe('speakSentence');
    state = step(state, signal(state, 'heard', 'speech'), deps).state;
    expect(state.shellState).toBe('challenge.armed');
    state = step(state, signal(state, 'route-2', 'transient'), deps).state;
    expect(state.core.queue[0]?.type).toBe('speakSentence');
    expect(state.core.answers).toEqual([]);
  });
  it('[INV-MOD-05] permission loss converts every remaining speaking item with one suspension effect', () => {
    const state = start();
    const event = signal(state, 'permission', 'permission-denied');
    const result = step(state, event, deps);
    expect(result.suspendFamily).toBe('speaking');
    expect(result.state.core.queue.every((q) => q.type !== 'speakSentence')).toBe(true);
    const replay = step(result.state, event, deps);
    expect(replay.state).toBe(result.state);
    expect(replay.suspendFamily).toBeUndefined();
  });
  it('[INV-MOD-02] an unrelated or still-gated replacement cannot silently consume the slot', () => {
    const state = start();
    const result = step(state, signal(state, 'bad-source', 'skip'), {
      ...deps,
      modalityReplacement: (source) => ({ ...replacement(source), conceptId: 'unrelated' }),
    });
    expect(result.state.core.index).toBe(0);
    expect(result.state.core.answers).toEqual([]);
    expect(result.state.core.queue).toEqual(state.core.queue);
    expect(result.state.modality.unavailableSlotIds).toContain('slot-1');
    expect(result.state.shellState).not.toBe('complete');
  });
  it('[INV-GRD-06] failed pronunciation retries in place without an answer, accuracy, combo or heart change', () => {
    let state = start();
    const wrongDeps = { ...deps, grading: { grade: () => ({ kind: 'wrong' as const }) } };
    for (let n = 0; n < 2; n++) {
      state = step(state, signal(state, `heard-${n}`, 'speech'), wrongDeps).state;
      state = step(state, { type: 'check' }, wrongDeps).state;
      state = step(state, { type: 'graded' }, wrongDeps).state;
    }
    expect(state.shellState).toBe('challenge.idle');
    expect(state.core.index).toBe(0);
    expect(state.core.answers).toEqual([]);
    expect(state.mistakeRows).toEqual([]);
    expect(state.core.combo).toBe(4);
    expect(
      state.modality.observations.filter((row) => row.reviewKind === 'pronunciation_failure'),
    ).toHaveLength(2);
    const silent = step(state, signal(state, 'then-silent', 'no_audio'), wrongDeps).state;
    expect(
      silent.modality.observations.filter((row) => row.reviewKind === 'pronunciation_failure'),
    ).toHaveLength(2);
  });
  const invalidReplacements: readonly [string, NonNullable<StepDeps['modalityReplacement']>][] = [
    ['missing', () => null],
    ['wrong node', (source) => ({ ...replacement(source), nodeRef: 'different-node' })],
    ['still requires microphone', (source) => ({ ...source })],
    ['mismatched family', (source) => ({ ...replacement(source), family: 'speaking' })],
  ];
  it.each(invalidReplacements)(
    '[INV-MOD-02] rejects a %s replacement without progress credit',
    (_name, modalityReplacement) => {
      const state = start();
      const next = step(state, signal(state, 'reject', 'skip'), {
        ...deps,
        modalityReplacement,
      }).state;
      expect(next.core.queue).toEqual(state.core.queue);
      expect(next.core.index).toBe(0);
      expect(next.core.answers).toEqual([]);
      expect(next.progress).toEqual(state.progress);
      expect(next.modality.unavailableSlotIds.length).toBeGreaterThan(0);
    },
  );
  it('[INV-MOD-05] a recognition-side pronunciation variant stays playable when the microphone family is gated', () => {
    const state = start();
    const next = step(state, signal(state, 'recognition', 'skip'), {
      ...deps,
      modalityReplacement: (source) => ({
        ...source,
        type: 'pronunciationSelect',
        requiresAudio: false,
      }),
    }).state;
    expect(next.core.queue.map((q) => q.type)).toEqual([
      'pronunciationSelect',
      'pronunciationSelect',
      'meaningSelect',
    ]);
    expect(next.modality.unavailableSlotIds).toEqual([]);
  });
  it('[INV-MOD-09] transient failures never count toward the three no_audio observations', () => {
    let state = start();
    state = step(state, signal(state, 'route', 'transient'), deps).state;
    state = step(state, signal(state, 'silent-a', 'no_audio'), deps).state;
    state = step(state, signal(state, 'silent-b', 'no_audio'), deps).state;
    expect(state.core.queue[0]?.type).toBe('speakSentence');
    expect(state.modality.blockedFamilies).toEqual([]);
  });
});
