import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLAVOUR_MATRIX,
  TestMonotonicClock,
  step,
  items,
  type StepDeps,
  type SessionEvent,
  EXERCISE_TYPES,
  INPUT_MODES,
  ITEM_FAMILIES,
  RESUME_FIELDS,
  SESSION_FLAVOURS,
  SESSION_KINDS,
  SESSION_ROW_FIELDS,
  SHELL_STATES,
  VERDICT_KINDS,
  freshSession,
  serialiseSession,
  type SessionState,
} from '@freelingo/core/session';
import { isSessionState, parseSessionState, SessionCodecError } from './sessionCodec';

function richSession(): SessionState {
  const base = freshSession();
  const item = base.core.queue[0]!;
  return {
    ...base,
    core: {
      ...base.core,
      index: 1,
      hearts: { kind: 'pips', total: 3, remaining: 2 },
      answers: [
        {
          exerciseIndex: 0,
          slotId: item.id,
          itemId: item.itemId,
          type: item.type,
          verdict: 'wrong',
          softCorrected: false,
          wrong: true,
          costPaid: 1,
          skipped: false,
          scorable: true,
          queue: 'main',
          note: null,
        },
      ],
    },
    inFlight: {
      text: '¡Hola! 🦜',
      caret: 4,
      audioHeardToEnd: true,
      partialState: {
        strokes: [[1.25, 2]],
        matched: [null, false, 'uno'],
        strange: { custom: true },
      },
    },
    mistakes: [
      {
        itemId: item.itemId,
        slotId: item.id,
        originalType: item.type,
        servesRemaining: 2,
        recyclesServed: 1,
        queuedAtMainAnswers: 1,
      },
    ],
    progress: { denominator: base.core.queue.length, numerator: 1, finalSegmentConsumed: false },
    checkpointMonotonicMs: 42.25,
    startedMonotonicMs: 0.125,
    lastVerdict: { kind: 'softCorrect', note: 'Accent note' },
    currentReplay: {
      item: { ...item, id: `${item.id}#replay1`, degraded: 'noAudio' },
      phase: 'end',
    },
    mistakeRows: [
      {
        itemId: item.itemId,
        courseId: base.courseId,
        conceptId: item.conceptId,
        createdInSessionId: base.sessionId,
        reviewStreak: 1,
      },
    ],
    weakItemRows: [{ itemId: item.itemId, courseId: base.courseId, rejections: 2 }],
  };
}

type JsonObject = Record<string, unknown>;
function changed(path: string, value: unknown, remove = false): unknown {
  const state = JSON.parse(serialiseSession(richSession())) as JsonObject;
  const keys = path.split('.');
  let parent = state;
  for (const key of keys.slice(0, -1)) parent = parent[key] as JsonObject;
  const key = keys.at(-1)!;
  if (remove) delete parent[key];
  else parent[key] = value;
  return state;
}

const INVALID: readonly (readonly [string, unknown])[] = [
  ['sessionId', null],
  ['courseId', 1],
  ['nodeRef', []],
  ['sessionKind', 'video'],
  ['flavour', 'invented'],
  ['shellState', 'not-a-screen'],
  ['core', null],
  ['core.queue', {}],
  ['core.queue.0', { itemId: 'item-1' }],
  ['core.queue.0.id', false],
  ['core.queue.0.itemId', null],
  ['core.queue.0.type', 'unknown'],
  ['core.queue.0.family', 'unknown'],
  ['core.queue.0.conceptId', 4],
  ['core.queue.0.nodeRef', null],
  ['core.queue.0.requiresAudio', 'yes'],
  ['core.queue.0.degraded', 'whatever'],
  ['core.index', -1],
  ['core.index', 0.5],
  ['core.index', 999],
  ['core.answers', {}],
  ['core.answers.0', null],
  ['core.answers.0.exerciseIndex', -1],
  ['core.answers.0.slotId', null],
  ['core.answers.0.itemId', 4],
  ['core.answers.0.type', 'unknown'],
  ['core.answers.0.verdict', 'unknown'],
  ['core.answers.0.softCorrected', 1],
  ['core.answers.0.wrong', null],
  ['core.answers.0.costPaid', -1],
  ['core.answers.0.costPaid', 0.25],
  ['core.answers.0.skipped', 'no'],
  ['core.answers.0.scorable', 0],
  ['core.answers.0.queue', 'elsewhere'],
  ['core.answers.0.queue', 'mistakes'],
  ['core.answers.0.exerciseIndex', -0.5],
  ['core.answers.0.exerciseIndex', Number.MIN_SAFE_INTEGER - 1],
  ['core.answers.0.note', 1],
  ['core.hearts', null],
  ['core.hearts', { kind: 'finite' }],
  ['core.hearts', { kind: 'pips', total: 2, remaining: 3 }],
  ['core.hearts.total', -1],
  ['core.hearts.remaining', 0.5],
  ['core.combo', -1],
  ['core.combo', 1.5],
  ['core.usedInterstitialKeys', [null]],
  ['core.inputMode', 'voice'],
  ['core.hardMode', 0],
  ['core.optionSeeds', []],
  ['core.optionSeeds.invalid', 'seed'],
  ['core.optionSeeds.invalid', -1],
  ['core.optionSeeds.invalid', 1.25],
  ['inFlight', null],
  ['inFlight.text', []],
  ['inFlight.caret', -9],
  ['inFlight.caret', 0.5],
  ['inFlight.partialState', []],
  ['inFlight.partialState', null],
  ['inFlight.audioHeardToEnd', 'yes'],
  ['mistakes', {}],
  ['mistakes.0', null],
  ['mistakes.0.itemId', null],
  ['mistakes.0.slotId', 3],
  ['mistakes.0.originalType', 'unknown'],
  ['mistakes.0.servesRemaining', -1],
  ['mistakes.0.recyclesServed', 0.5],
  ['mistakes.0.queuedAtMainAnswers', -1],
  ['progress', null],
  ['progress.denominator', -1],
  ['progress.numerator', 0.5],
  ['progress.numerator', 999],
  ['progress.finalSegmentConsumed', 'yes'],
  ['checkpointMonotonicMs', '42'],
  ['startedMonotonicMs', null],
  ['pendingInterstitialKeys', [1]],
  ['stepUpFired', 0],
  ['motivationalMessages', 'true'],
  ['mistakeReviewCopyKey', false],
  ['endReviewIntroShown', 0],
  ['lastVerdict', {}],
  ['lastVerdict.kind', 'almost'],
  ['lastVerdict.note', 2],
  ['currentReplay', {}],
  ['currentReplay.item', null],
  ['currentReplay.phase', 'bogus'],
  ['inputModeExplicit', 0],
  ['mistakeRows', 'invalid'],
  ['mistakeRows.0', null],
  ['mistakeRows.0.itemId', false],
  ['mistakeRows.0.courseId', null],
  ['mistakeRows.0.conceptId', 1],
  ['mistakeRows.0.createdInSessionId', []],
  ['mistakeRows.0.reviewStreak', -1],
  ['weakItemRows', {}],
  ['weakItemRows.0', null],
  ['weakItemRows.0.itemId', 2],
  ['weakItemRows.0.courseId', false],
  ['weakItemRows.0.rejections', 0.1],
  ['packNonLatinScript', 0],
  ['exited', 'abandoned'],
];

const NESTED_OBJECTS = [
  'core.queue.0',
  'core.answers.0',
  'core.hearts',
  'inFlight',
  'mistakes.0',
  'progress',
  'lastVerdict',
  'currentReplay',
  'mistakeRows.0',
  'weakItemRows.0',
];

function atPath(value: unknown, path: string): JsonObject {
  let current = value;
  for (const key of path.split('.')) current = (current as JsonObject)[key];
  return current as JsonObject;
}

describe('persisted session codec', () => {
  it('[INV-SESS-01] restores a complete rich checkpoint without normalizing any field', () => {
    for (const state of [freshSession(), richSession()]) {
      const raw = serialiseSession(state);
      const restored = parseSessionState(raw);
      expect(restored).toEqual(state);
      expect(serialiseSession(restored)).toBe(raw);
    }
  });

  it('[INV-SESS-01] restores every real miss/replay checkpoint including negative attempt indices', () => {
    let missed = false;
    const deps: StepDeps = {
      config: DEFAULT_FLAVOUR_MATRIX.lesson,
      clock: new TestMonotonicClock(),
      grading: {
        grade: () => {
          const kind = missed ? 'correct' : 'wrong';
          missed = true;
          return { kind };
        },
      },
      isTypeEligible: () => true,
      stepUpTripped: () => false,
    };
    let state = freshSession({ queue: items(1) });
    const checkpoints: SessionState[] = [state];
    const dispatch = (event: SessionEvent) => {
      state = step(state, event, deps).state;
      checkpoints.push(state);
    };
    dispatch({ type: 'rendered' });
    for (let guard = 0; guard < 100 && state.shellState !== 'complete'; guard += 1) {
      dispatch({ type: 'input', text: 'x', caret: 1, partialState: {}, gradeable: true });
      dispatch({ type: 'check' });
      dispatch({ type: 'graded' });
      dispatch({ type: 'continue' });
    }
    expect(state.shellState).toBe('complete');
    const replays = state.core.answers.filter((answer) => answer.queue === 'mistakes');
    expect(replays).toHaveLength(2);
    expect(replays.every((answer) => answer.exerciseIndex < 0)).toBe(true);
    for (const checkpoint of checkpoints) {
      expect(parseSessionState(serialiseSession(checkpoint))).toEqual(checkpoint);
    }
  });

  it.each(INVALID)('[INV-SESS-01] rejects malformed %s = %j before restoration', (path, value) => {
    const damaged = changed(path, value);
    expect(isSessionState(damaged)).toBe(false);
    expect(() => parseSessionState(JSON.stringify(damaged))).toThrow(SessionCodecError);
  });

  it.each(SESSION_ROW_FIELDS)(
    '[INV-SESS-06] refuses a missing declared session field %s',
    (key) => {
      expect(isSessionState(changed(key, null, true))).toBe(false);
    },
  );
  it.each(RESUME_FIELDS)('[INV-SESS-06] refuses a missing resume field %s', (key) => {
    expect(isSessionState(changed(`core.${key}`, null, true))).toBe(false);
  });
  it.each(NESTED_OBJECTS)('[INV-SESS-06] requires every nested field in %s', (path) => {
    for (const key of Object.keys(atPath(richSession(), path))) {
      expect(isSessionState(changed(`${path}.${key}`, null, true)), `${path}.${key}`).toBe(false);
    }
  });

  it('[INV-SESS-22] accepts every declared enum without inventing new shell/flavour constraints', () => {
    const enums = [
      ['shellState', SHELL_STATES],
      ['sessionKind', SESSION_KINDS],
      ['flavour', SESSION_FLAVOURS],
      ['core.inputMode', INPUT_MODES],
      ['core.queue.0.type', EXERCISE_TYPES],
      ['core.queue.0.family', ITEM_FAMILIES],
      ['lastVerdict.kind', VERDICT_KINDS],
      ['currentReplay.phase', ['midLesson', 'end']],
      ['exited', ['quit', 'complete', null]],
    ] as const;
    for (const [path, values] of enums)
      for (const value of values) {
        expect(isSessionState(changed(path, value)), `${path}: ${value}`).toBe(true);
      }
  });

  it('[INV-SESS-01] permits a drained queue and a fixed denominator after queue filtering', () => {
    const state = richSession();
    expect(isSessionState({ ...state, core: { ...state.core, queue: [], index: 0 } })).toBe(true);
    expect(
      isSessionState({ ...state, core: { ...state.core, index: state.core.queue.length } }),
    ).toBe(true);
  });

  it('[INV-SESS-01] rejects nonfinite clocks and unsafe or nonfinite counters', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      for (const path of [
        'checkpointMonotonicMs',
        'startedMonotonicMs',
        'core.combo',
        'core.optionSeeds.bad',
      ]) {
        expect(isSessionState(changed(path, value)), path).toBe(false);
      }
    }
    for (const path of [
      'core.combo',
      'progress.denominator',
      'inFlight.caret',
      'weakItemRows.0.rejections',
    ]) {
      expect(isSessionState(changed(path, Number.MAX_SAFE_INTEGER + 1)), path).toBe(false);
    }
  });

  it('[INV-SESS-15] treats arbitrary finite JSON partialState values as opaque', () => {
    const opaque = JSON.parse(
      '{"__proto__":{"prototype":"opaque"},"constructor":null,"unknown":[{"x":false},-1.5,"🦜"]}',
    );
    const state = changed('inFlight.partialState', opaque);
    expect(parseSessionState(JSON.stringify(state))).toEqual(state);
  });
  it('[INV-SESS-15] rejects partial state that cannot round-trip as JSON', () => {
    const cyclic: JsonObject = {};
    cyclic['cycle'] = cyclic;
    for (const value of [
      undefined,
      NaN,
      Infinity,
      () => 0,
      Symbol('x'),
      BigInt(2),
      cyclic,
      new Date(),
    ]) {
      expect(isSessionState(changed('inFlight.partialState', { value }))).toBe(false);
    }
  });

  it('[INV-SESS-15] rejects sparse arrays, hidden values and getters without invoking them', () => {
    const sparse: unknown[] = new Array(1);
    Object.assign(sparse, { extra: 'not an array index' });
    let read = false;
    const getter = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        read = true;
        return 1;
      },
    });
    const hidden = Object.defineProperty({}, 'value', { value: 1 });
    for (const value of [sparse, getter, hidden]) {
      expect(isSessionState(changed('inFlight.partialState', { value }))).toBe(false);
    }
    expect(read).toBe(false);
  });

  it('[INV-SESS-06] rejects extra declared-object fields while preserving opaque partial-state keys', () => {
    for (const path of ['', 'core', ...NESTED_OBJECTS]) {
      expect(isSessionState(changed(path ? `${path}.undeclared` : 'undeclared', 1)), path).toBe(
        false,
      );
    }
  });
  it('[INV-SESS-01] rejects invalid JSON and non-object roots with a stable error', () => {
    for (const raw of ['{', '', 'null', '[]', 'false', '4', '"checkpoint"']) {
      expect(() => parseSessionState(raw)).toThrow(SessionCodecError);
    }
  });
});
