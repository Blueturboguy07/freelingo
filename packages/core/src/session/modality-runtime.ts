import type { SpeechSegment } from '../grading/speech-types.js';
import { acceptsSpeechAmplitude, MODALITY_POLICY } from '../modality/index.js';
import type {
  ModalityFamily,
  ModalityObservation,
  ModalityReviewKind,
  SessionModalityState,
} from '../modality/index.js';
import type { StepDeps, StepResult } from './machine.js';
import type { SessionState } from './resume.js';
import { checkpoint } from './resume.js';
import { EXERCISE_TYPES, EMPTY_IN_FLIGHT } from './types.js';
import type { QueuedItem } from './types.js';
import { exerciseSpec } from './registry.js';
interface ObservationKey {
  readonly eventId: string;
  readonly slotId: string;
  readonly itemId: string;
}
export type SessionModalityEvent =
  | (ObservationKey & { readonly type: 'modalitySkip'; readonly family: ModalityFamily })
  | (ObservationKey & {
      readonly type: 'speechResult';
      readonly transcript: string;
      readonly amplitude: number;
      readonly segments?: readonly SpeechSegment[];
    })
  | (ObservationKey & {
      readonly type: 'speechError';
      readonly error: 'transient' | 'interrupted' | 'permission-denied';
    });
export interface ModalityReplacementContext {
  readonly family: ModalityFamily;
  readonly reason: ModalityReviewKind;
  readonly excludedItemIds: readonly string[];
}
export function requiresModality(item: QueuedItem, family: ModalityFamily): boolean {
  return family === 'speaking'
    ? item.type === 'speakSentence' || item.type === 'listenRepeat'
    : item.requiresAudio || exerciseSpec(item.type).requiresAudio;
}
function current(state: SessionState): QueuedItem | undefined {
  return state.currentReplay?.item ?? state.core.queue[state.core.index];
}
function result(state: SessionState, deps: StepDeps, suspendFamily?: ModalityFamily): StepResult {
  return {
    state: checkpoint(state, deps.clock.nowMs()),
    writes: [],
    exit: null,
    ...(suspendFamily === undefined ? {} : { suspendFamily }),
  };
}
function clearSpeech(state: SessionState): SessionState {
  return {
    ...state,
    shellState: 'challenge.idle',
    inFlight: { ...state.inFlight, text: '', caret: 0, partialState: {} },
  };
}
function streak(state: SessionModalityState, slotId: string, itemId: string): number {
  let count = 0;
  for (const row of [...state.observations].reverse()) {
    if (row.slotId !== slotId || row.itemId !== itemId) continue;
    if (row.reviewKind === 'speech_received') break;
    if (row.reviewKind === 'transient') count++;
  }
  return count;
}
function replace(
  state: SessionState,
  family: ModalityFamily,
  reason: ModalityReviewKind,
  allRemaining: boolean,
  deps: StepDeps,
  suspendFamily?: ModalityFamily,
): StepResult {
  const source = current(state);
  if (source === undefined) return result(state, deps);
  const blocked = allRemaining
    ? [...new Set([...state.modality.blockedFamilies, family])]
    : state.modality.blockedFamilies;
  const required = allRemaining ? [...blocked] : [family, ...blocked];
  const picked = new Map<string, QueuedItem>();
  const missing: string[] = [];
  const excludedItemIds = state.core.answers.map((answer) => answer.itemId);
  const targets =
    state.currentReplay === null
      ? allRemaining
        ? state.core.queue.slice(state.core.index).filter((item) => requiresModality(item, family))
        : [source]
      : [
          source,
          ...(allRemaining
            ? state.core.queue
                .slice(state.core.index)
                .filter((item) => requiresModality(item, family))
            : []),
        ];
  for (const target of targets) {
    const proposed = deps.modalityReplacement?.(target, { family, reason, excludedItemIds });
    const replay = state.currentReplay?.item.id === target.id;
    if (
      proposed === undefined ||
      proposed === null ||
      typeof proposed.itemId !== 'string' ||
      proposed.itemId.trim() === '' ||
      !EXERCISE_TYPES.includes(proposed.type) ||
      proposed.conceptId !== target.conceptId ||
      proposed.nodeRef !== target.nodeRef ||
      proposed.family !== exerciseSpec(proposed.type).family ||
      !deps.isTypeEligible(proposed.type) ||
      required.some((block) => requiresModality(proposed, block)) ||
      (replay && proposed.itemId !== target.itemId) ||
      (excludedItemIds.includes(proposed.itemId) && proposed.itemId !== target.itemId)
    ) {
      missing.push(target.id);
      continue;
    }
    // Slot identity, position and option seed remain fixed; pack item/type identify the real replacement.
    picked.set(target.id, { ...proposed, id: target.id });
  }
  const modality = { ...state.modality, blockedFamilies: blocked, unavailableSlotIds: missing };
  if (missing.length > 0) return result({ ...clearSpeech(state), modality }, deps, suspendFamily);
  const queue = state.core.queue.map((item, index) =>
    index >= state.core.index ? (picked.get(item.id) ?? item) : item,
  );
  const replay = state.currentReplay;
  return result(
    {
      ...state,
      core: { ...state.core, queue },
      inFlight: EMPTY_IN_FLIGHT,
      shellState: 'challenge.idle',
      modality,
      currentReplay:
        replay === null ? null : { ...replay, item: picked.get(replay.item.id) ?? replay.item },
    },
    deps,
    suspendFamily,
  );
}
export function applyModalityEvent(
  state: SessionState,
  event: SessionModalityEvent,
  deps: StepDeps,
): StepResult {
  const none = { state, writes: [], exit: null } as const;
  const item = current(state);
  if (
    item === undefined ||
    (state.shellState !== 'challenge.idle' && state.shellState !== 'challenge.armed') ||
    event.slotId !== item.id ||
    event.itemId !== item.itemId ||
    event.eventId.trim() === '' ||
    state.modality.observations.some((row) => row.id === event.eventId)
  )
    return none;
  const family = event.type === 'modalitySkip' ? event.family : 'speaking';
  if (!requiresModality(item, family)) return none;
  const reviewKind: ModalityReviewKind =
    event.type === 'modalitySkip'
      ? 'skipped'
      : event.type === 'speechError'
        ? event.error === 'permission-denied'
          ? 'permission_denied'
          : event.error
        : event.transcript.trim() === '' || !acceptsSpeechAmplitude(event.amplitude)
          ? 'no_audio'
          : 'speech_received';
  const observation: ModalityObservation = {
    id: event.eventId,
    slotId: item.id,
    itemId: item.itemId,
    family,
    reviewKind,
  };
  const next = {
    ...state,
    modality: { ...state.modality, observations: [...state.modality.observations, observation] },
  };
  if (reviewKind === 'skipped' || reviewKind === 'permission_denied')
    return replace(next, family, reviewKind, true, deps, family);
  if (
    reviewKind === 'no_audio' &&
    next.modality.observations.filter((row) => row.reviewKind === 'no_audio').length >=
      MODALITY_POLICY.noAudioBeforeConversion
  )
    return replace(next, 'speaking', reviewKind, true, deps);
  if (
    reviewKind === 'transient' &&
    streak(next.modality, item.id, item.itemId) >= MODALITY_POLICY.transientBeforeReplacement
  )
    return replace(next, 'speaking', reviewKind, false, deps);
  if (event.type === 'speechResult' && reviewKind === 'speech_received') {
    const audioReady = !requiresModality(item, 'listening') || state.inFlight.audioHeardToEnd;
    return result(
      {
        ...next,
        shellState: audioReady ? 'challenge.armed' : 'challenge.idle',
        inFlight: {
          ...state.inFlight,
          text: event.transcript,
          caret: event.transcript.length,
          partialState: {
            transcript: event.transcript,
            amplitude: event.amplitude,
            ...(event.segments === undefined
              ? {}
              : {
                  segments: Object.freeze(
                    event.segments.map((segment) => Object.freeze({ ...segment })),
                  ),
                }),
          },
        },
      },
      deps,
    );
  }
  return result(clearSpeech(next), deps);
}

/** A failed spoken attempt is a retry, never a completed answer or a combo break. */
export function retrySpeechVerdict(
  state: SessionState,
  deps: StepDeps,
  failed: boolean,
): StepResult {
  const item = current(state);
  if (item === undefined) return result(state, deps);
  // External event IDs are opaque. A legal caller ID can resemble this internal prefix,
  // so select an unused persisted ID instead of assuming namespaces never overlap.
  const used = new Set(state.modality.observations.map((row) => row.id));
  let sequence = state.modality.observations.length;
  while (used.has(`speech-grade:${item.id}:${sequence}`)) sequence += 1;
  const observation: ModalityObservation = {
    id: `speech-grade:${item.id}:${sequence}`,
    slotId: item.id,
    itemId: item.itemId,
    family: 'speaking',
    reviewKind: failed ? 'pronunciation_failure' : 'speech_ungraded',
  };
  return result(
    clearSpeech({
      ...state,
      modality: { ...state.modality, observations: [...state.modality.observations, observation] },
    }),
    deps,
  );
}
