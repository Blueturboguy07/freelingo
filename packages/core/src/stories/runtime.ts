import { STORY_MATCH_RENDER_CAP } from './config.js';
import type {
  Hint,
  NarrativeAnswer,
  NarrativeAttempt,
  NarrativeCompletion,
  ResolvedStoryAudio,
  Ruby,
  Span,
  StoryChallenge,
  StoryDocument,
  StoryElement,
  StoryMode,
  StoryPart,
  StoryState,
  StoryText,
} from './types.js';

export function isStoryChallenge(element: StoryElement): element is StoryChallenge {
  return element.type !== 'HEADER' && element.type !== 'LINE' && element.type !== 'ERROR';
}
export function storyParts(story: StoryDocument, mode: StoryMode): readonly StoryPart[] {
  const parts: { id: string; elements: StoryElement[] }[] = [];
  let lastLine: number | undefined;
  for (const element of story.elements) {
    if (mode === 'listening' && element.type === 'MATCH') continue;
    const last = parts.at(-1);
    if (
      !last ||
      element.lineIndex !== lastLine ||
      element.type === 'MULTIPLE_CHOICE' ||
      element.type === 'POINT_TO_PHRASE' ||
      last.elements.some(isStoryChallenge)
    ) {
      parts.push({ id: element.id, elements: [element] });
    } else last.elements.push(element);
    lastLine = element.lineIndex;
  }
  return parts;
}
export function startStory(story: StoryDocument, mode: StoryMode, runId: string): StoryState {
  if (!story.elements.length) throw new Error('Story has no content.');
  if (mode === 'listening' && (!story.bakedAudioComplete || !story.stitchedAudio))
    throw new Error('Listening requires complete baked audio.');
  return {
    storyId: story.id,
    revision: story.revision,
    runId,
    mode,
    partIndex: 0,
    foreground: true,
    answers: [],
    skippedIds: [],
    progress: 0,
  };
}
function verify(story: StoryDocument, state: StoryState): readonly StoryPart[] {
  if (story.id !== state.storyId || story.revision !== state.revision)
    throw new Error('Story checkpoint belongs to different content.');
  return storyParts(story, state.mode);
}
export function currentStoryChallenge(
  story: StoryDocument,
  state: StoryState,
): StoryChallenge | undefined {
  return verify(story, state)[state.partIndex]?.elements.find(isStoryChallenge);
}
export function storyProgress(story: StoryDocument, state: StoryState): number {
  const count = verify(story, state).length;
  return Math.max(state.progress, Math.min(1, state.partIndex / count));
}
export function advanceStory(story: StoryDocument, state: StoryState): StoryState {
  const parts = verify(story, state);
  if (state.partIndex >= parts.length) return state;
  const question = currentStoryChallenge(story, state);
  const answered = question && state.answers.some((answer) => answer.questionId === question.id);
  const skip = question && !answered && (!state.foreground || state.mode === 'listening');
  if (question && !answered && !skip) return state;
  const partIndex = state.partIndex + 1;
  return {
    ...state,
    partIndex,
    skippedIds: skip ? [...new Set([...state.skippedIds, question.id])] : state.skippedIds,
    progress: Math.max(state.progress, partIndex / parts.length),
  };
}
const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);
export function gradeStoryChallenge(question: StoryChallenge, answer: NarrativeAnswer): boolean {
  switch (question.type) {
    case 'SELECT_PHRASE':
    case 'MULTIPLE_CHOICE':
      return answer.kind === 'option' && answer.optionId === question.correctOptionId;
    case 'POINT_TO_PHRASE':
      return answer.kind === 'range' && answer.rangeId === question.correctRangeId;
    case 'ARRANGE': {
      if (answer.kind !== 'tiles' || new Set(answer.tileIds).size !== answer.tileIds.length)
        return false;
      const labels = new Map(question.tiles.map((tile) => [tile.id, tile.text]));
      if (answer.tileIds.some((id) => !labels.has(id))) return false;
      return [question.correctTileIds, ...(question.acceptedTileOrders ?? [])].some((order) =>
        sameOrder(
          order.map((id) => labels.get(id) ?? ''),
          answer.tileIds.map((id) => labels.get(id)!),
        ),
      );
    }
    case 'MATCH': {
      const pairs = question.pairs.slice(0, STORY_MATCH_RENDER_CAP);
      return (
        answer.kind === 'matches' &&
        answer.pairs.length === pairs.length &&
        new Set(answer.pairs.map((pair) => pair.leftId)).size === pairs.length &&
        answer.pairs.every(
          (pair) => pair.leftId === pair.rightId && pairs.some((p) => p.id === pair.leftId),
        )
      );
    }
  }
}
export function storyChallengeItems(question: StoryChallenge): readonly string[] {
  return question.type === 'MATCH'
    ? [...new Set(question.pairs.slice(0, STORY_MATCH_RENDER_CAP).flatMap((pair) => pair.itemIds))]
    : question.itemIds;
}
export function answerStory(
  story: StoryDocument,
  state: StoryState,
  answer: NarrativeAnswer,
): StoryState {
  const question = currentStoryChallenge(story, state);
  if (!question || !state.foreground || state.answers.some((a) => a.questionId === question.id))
    return state;
  const attempt: NarrativeAttempt = {
    questionId: question.id,
    answer,
    correct: gradeStoryChallenge(question, answer),
    itemIds: storyChallengeItems(question),
  };
  return {
    ...state,
    answers: [...state.answers, attempt],
    skippedIds: state.skippedIds.filter((id) => id !== question.id),
  };
}
/** Offer deferred questions explicitly; high-water progress stays unchanged. */
export function reviewSkippedStory(story: StoryDocument, state: StoryState): StoryState {
  if (!state.foreground) return state;
  const parts = verify(story, state);
  const partIndex = parts.findIndex((part) =>
    part.elements.some((element) => state.skippedIds.includes(element.id)),
  );
  return partIndex < 0 ? state : { ...state, partIndex };
}
export function setStoryForeground(state: StoryState, foreground: boolean): StoryState {
  return { ...state, foreground };
}
/** Explicit foreground completion only; callers atomically persist reward once per runId. */
export function storyCompletion(
  story: StoryDocument,
  state: StoryState,
  explicit: boolean,
): NarrativeCompletion {
  const allQuestions = story.elements.filter(isStoryChallenge);
  const complete = state.partIndex >= verify(story, state).length;
  return {
    canCommit: explicit && state.foreground && complete,
    rewardTier:
      allQuestions.length > 0 &&
      allQuestions.every((q) => state.answers.some((a) => a.questionId === q.id))
        ? 'completed'
        : 'plainReplay',
    answers: state.answers,
  };
}
const intersects = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;
export function storyHints(
  content: StoryText,
  mode: StoryMode,
  hidden: readonly Span[],
): readonly Hint[] {
  return mode === 'legendary'
    ? []
    : content.hints.filter((hint) => !hidden.some((span) => intersects(hint, span)));
}
export function storyRuby(
  content: StoryText,
  hidden: readonly Span[],
  enabled: boolean,
): readonly Ruby[] {
  return enabled
    ? content.ruby.filter((ruby) => !hidden.some((span) => intersects(ruby, span)))
    : [];
}
export function storyTap(
  content: StoryText,
  offset: number,
  mode: StoryMode,
  hidden: readonly Span[],
  challenge: boolean,
): { type: 'answer'; offset: number } | { type: 'hint'; gloss: string } | { type: 'none' } {
  if (challenge) return { type: 'answer', offset };
  const hint = storyHints(content, mode, hidden).find((h) => h.start <= offset && offset < h.end);
  return hint ? { type: 'hint', gloss: hint.gloss } : { type: 'none' };
}
export function storyAudio(
  content: StoryText,
  assetPresent: boolean,
  systemVoice: { readonly language: string; readonly id: string } | null,
  language: string,
): ResolvedStoryAudio {
  if (assetPresent && content.audio?.text === content.text)
    return { kind: 'baked', uri: content.audio.uri, voiceVersion: content.audio.voiceVersion };
  if (systemVoice && systemVoice.language.split('-')[0] === language.split('-')[0])
    return { kind: 'tts', voiceId: systemVoice.id };
  return {
    kind: 'unavailable',
    reason:
      language === 'es' ? 'No Spanish audio is available.' : `No ${language} audio is available.`,
  };
}
export function karaokeRange(
  content: StoryText,
  playing: ResolvedStoryAudio,
  positionMs: number,
): Span | null {
  const audio = content.audio;
  if (
    !audio ||
    playing.kind !== 'baked' ||
    playing.uri !== audio.uri ||
    playing.voiceVersion !== audio.voiceVersion ||
    audio.text !== content.text ||
    positionMs < 0 ||
    positionMs >= audio.durationMs
  )
    return null;
  const keypoint = audio.keypoints.findLast((point) => point.atMs <= positionMs);
  return keypoint ? { start: keypoint.start, end: keypoint.end } : null;
}
