import { RADIO_MIN_CONTENT_TILES } from './config.js';
import { gradeStoryChallenge } from '../stories/runtime.js';
import type { NarrativeCompletion } from '../stories/types.js';
import type { NarrativeAnswer, RadioEpisode, RadioQuestion, RadioState } from './types.js';
export function selectionReady(count: number, selected: readonly string[]): boolean {
  return (
    Number.isInteger(count) &&
    count > 0 &&
    selected.length === count &&
    new Set(selected).size <= count
  );
}
export function toggleSelection(selected: readonly string[], id: string): readonly string[] {
  return selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
}
export function validateListenTiles(
  question: Extract<RadioQuestion, { kind: 'listenSelect' }>,
): readonly string[] {
  const errors: string[] = [];
  if (!selectionReady(question.count, question.correctTileIds))
    errors.push('Answer count does not match selection count.');
  if (question.tiles.length < RADIO_MIN_CONTENT_TILES)
    errors.push('Listen and Select needs at least two content tokens.');
  if (
    new Set(question.tiles.map((tile) => tile.id)).size !== question.tiles.length ||
    new Set(question.tiles.map((tile) => tile.tokenId)).size !== question.tiles.length
  )
    errors.push('Tile and source token ids must be unique.');
  if (question.tiles.some((tile) => !tile.contentToken || !tile.tokenId || !tile.itemIds.length))
    errors.push('Tiles must be flagged content tokens with morpheme targets.');
  if (question.correctTileIds.some((id) => !question.tiles.some((tile) => tile.id === id)))
    errors.push('Correct tile is missing.');
  return errors;
}
export function radioAnchors(episode: RadioEpisode): readonly RadioQuestion[] {
  const ends = episode.segments.map((segment) => segment.endMs).toSorted((a, b) => a - b);
  return episode.questions
    .map((question) => ({
      ...question,
      atMs: ends.find((end) => end >= question.atMs) ?? episode.audio.durationMs,
    }))
    .toSorted((a, b) => a.atMs - b.atMs);
}
export function recommendedEpisodes(
  episodes: readonly RadioEpisode[],
  unitIndex: number,
): readonly RadioEpisode[] {
  return episodes
    .filter((episode) => episode.unitIndex <= unitIndex)
    .toSorted((a, b) => b.unitIndex - a.unitIndex || a.id.localeCompare(b.id));
}
export function startRadio(episode: RadioEpisode, runId: string): RadioState {
  if (!episode.bakedAudioComplete) throw new Error('Repair audio before starting this episode.');
  return {
    episodeId: episode.id,
    revision: episode.revision,
    runId,
    positionMs: 0,
    playing: false,
    foreground: true,
    activeQuestionId: null,
    consumedIds: [],
    skippedIds: [],
    answers: [],
  };
}
function verify(episode: RadioEpisode, state: RadioState): void {
  if (episode.id !== state.episodeId || episode.revision !== state.revision)
    throw new Error('Radio checkpoint belongs to different content.');
}
/** Called for both audio ticks and scrubs; anchors cannot be bypassed by either. */
export function moveRadio(
  episode: RadioEpisode,
  state: RadioState,
  requestedMs: number,
): RadioState {
  verify(episode, state);
  if (!Number.isFinite(requestedMs)) return state;
  const positionMs = Math.max(0, Math.min(episode.audio.durationMs, requestedMs));
  if (state.activeQuestionId && state.foreground) return state;
  const crossed = radioAnchors(episode).filter(
    (question) => !state.consumedIds.includes(question.id) && question.atMs <= positionMs,
  );
  if (state.foreground && crossed.length) {
    const question = crossed[0]!;
    return {
      ...state,
      positionMs: question.atMs,
      playing: false,
      activeQuestionId: question.id,
      consumedIds: [...state.consumedIds, question.id],
    };
  }
  return {
    ...state,
    positionMs,
    playing: positionMs >= episode.audio.durationMs ? false : state.playing,
    consumedIds: [...state.consumedIds, ...crossed.map((q) => q.id)],
    skippedIds: [...new Set([...state.skippedIds, ...crossed.map((q) => q.id)])],
  };
}
export function answerRadio(
  episode: RadioEpisode,
  state: RadioState,
  answer: NarrativeAnswer,
): RadioState {
  verify(episode, state);
  const question = episode.questions.find((q) => q.id === state.activeQuestionId);
  if (!question || !state.foreground || state.answers.some((a) => a.questionId === question.id))
    return state;
  let correct: boolean;
  let itemIds: readonly string[];
  if (question.kind === 'listenSelect') {
    if (
      answer.kind !== 'tiles' ||
      !selectionReady(question.count, answer.tileIds) ||
      answer.tileIds.some((id) => !question.tiles.some((tile) => tile.id === id))
    )
      return state;
    correct = answer.tileIds.every((id) => question.correctTileIds.includes(id));
    itemIds = [
      ...new Set(
        question.tiles
          .filter((tile) => answer.tileIds.includes(tile.id))
          .flatMap((tile) => tile.itemIds),
      ),
    ];
  } else if (question.kind === 'comprehension') {
    if (
      answer.kind !== 'option' ||
      !question.options.some((option) => option.id === answer.optionId)
    )
      return state;
    correct = answer.optionId === question.correctOptionId;
    itemIds = question.itemIds;
  } else {
    correct = gradeStoryChallenge({ ...question, type: 'MATCH', lineIndex: 0 }, answer);
    itemIds = [...new Set(question.pairs.flatMap((pair) => pair.itemIds))];
  }
  const skippedIds = state.skippedIds.filter((id) => id !== question.id);
  return {
    ...state,
    activeQuestionId: skippedIds[0] ?? null,
    skippedIds,
    answers: [...state.answers, { questionId: question.id, answer, correct, itemIds }],
  };
}
export function setRadioForeground(state: RadioState, foreground: boolean): RadioState {
  if (!foreground && state.activeQuestionId)
    return {
      ...state,
      foreground,
      playing: true,
      activeQuestionId: null,
      skippedIds: [...new Set([...state.skippedIds, state.activeQuestionId])],
    };
  const activeQuestionId = foreground
    ? (state.activeQuestionId ?? state.skippedIds[0] ?? null)
    : null;
  return {
    ...state,
    foreground,
    activeQuestionId,
    playing: activeQuestionId ? false : state.playing,
  };
}
export function interruptRadio(state: RadioState): {
  readonly state: RadioState;
  readonly effects: readonly ['pauseAudio', 'persist', 'releaseLockScreen'];
} {
  return {
    state: { ...state, playing: false },
    effects: ['pauseAudio', 'persist', 'releaseLockScreen'],
  };
}
export function completeRadio(
  episode: RadioEpisode,
  state: RadioState,
  explicit: boolean,
): NarrativeCompletion {
  verify(episode, state);
  return {
    canCommit:
      explicit &&
      state.foreground &&
      state.positionMs >= episode.audio.durationMs &&
      state.activeQuestionId === null,
    rewardTier:
      episode.questions.length > 0 &&
      episode.questions.every((q) => state.answers.some((a) => a.questionId === q.id))
        ? 'completed'
        : 'plainReplay',
    answers: state.answers,
  };
}
