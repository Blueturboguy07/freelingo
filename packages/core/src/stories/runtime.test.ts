import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  storyParts,
  startStory,
  advanceStory,
  answerStory,
  storyProgress,
  storyHints,
  storyTap,
  reviewSkippedStory,
  gradeStoryChallenge,
  karaokeRange,
  storyCompletion,
  storyAudio,
  storyRuby,
  setStoryForeground,
} from './index.js';
import type { StoryDocument, StoryElement, StoryText } from './index.js';

const text: StoryText = {
  text: 'Rosa toma café.',
  hints: [{ start: 10, end: 14, gloss: 'coffee' }],
  ruby: [],
  audio: {
    uri: 'audio/rosa.opus',
    text: 'Rosa toma café.',
    voiceVersion: 'rosa-v1',
    durationMs: 1400,
    keypoints: [
      { start: 0, end: 4, atMs: 0 },
      { start: 5, end: 9, atMs: 500 },
      { start: 10, end: 14, atMs: 900 },
    ],
  },
};
const elements: StoryElement[] = [
  { type: 'HEADER', id: 'cover', lineIndex: 0, content: text },
  {
    type: 'LINE',
    id: 'line',
    lineIndex: 1,
    kind: 'CHARACTER',
    characterId: 'adult_female',
    content: text,
  },
  {
    type: 'MULTIPLE_CHOICE',
    id: 'q',
    lineIndex: 1,
    prompt: 'What does Rosa drink?',
    options: [
      { id: 'coffee', text: 'Coffee' },
      { id: 'tea', text: 'Tea' },
    ],
    correctOptionId: 'coffee',
    itemIds: ['coffee'],
  },
  {
    type: 'MATCH',
    id: 'match',
    lineIndex: 2,
    pairs: [{ id: 'coffee', left: 'café', right: 'coffee', itemIds: ['coffee'] }],
  },
];
const story: StoryDocument = {
  schemaVersion: 1,
  id: 'coffee',
  revision: 'r1',
  language: 'es',
  unitIndex: 3,
  title: 'Coffee',
  targetTitle: 'El café',
  narratorRegister: 'tu',
  covers: { active: 'a.svg', locked: 'l.svg', gilded: 'g.svg' },
  elements,
  bakedAudioComplete: true,
  stitchedAudio: {
    uri: 'audio/story.opus',
    durationMs: 1400,
    parts: [
      { partId: 'cover', startMs: 0, endMs: 700 },
      { partId: 'line', startMs: 700, endMs: 1400 },
    ],
  },
};

describe('story runtime', () => {
  it('[INV-STO-02] comprehension starts a fresh part even after one line', () => {
    expect(storyParts(story, 'normal').map((p) => p.elements.map((e) => e.id))).toEqual([
      ['cover'],
      ['line'],
      ['q'],
      ['match'],
    ]);
  });
  it('[INV-STO-01] listening skips MATCH before computing its denominator', () => {
    expect(storyParts(story, 'listening')).toHaveLength(3);
    expect(storyParts(story, 'normal')).toHaveLength(4);
  });
  it('[INV-STO-01] progress is bounded and monotone over arbitrary advance events', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 35 }), (events) => {
        let state = startStory(story, 'normal', 'run');
        let previous = storyProgress(story, state);
        for (const answer of events) {
          state = answer
            ? answerStory(story, state, { kind: 'option', optionId: 'coffee' })
            : advanceStory(story, state);
          const progress = storyProgress(story, state);
          expect(progress).toBeGreaterThanOrEqual(previous);
          expect(progress).toBeLessThanOrEqual(1);
          previous = progress;
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
  it('[INV-STO-03] overlapping hidden hints never reveal an answer', () => {
    expect(storyHints(text, 'normal', [{ start: 11, end: 12 }])).toEqual([]);
    expect(storyHints(text, 'normal', [{ start: 0, end: 4 }])).toHaveLength(1);
    expect(storyTap(text, 11, 'normal', [{ start: 10, end: 14 }], true)).toEqual({
      type: 'answer',
      offset: 11,
    });
  });
  it('[INV-STO-04] legendary removes every hint including non-challenge lines', () => {
    expect(storyHints(text, 'legendary', [])).toEqual([]);
    expect(storyTap(text, 11, 'legendary', [], false)).toEqual({ type: 'none' });
  });
  it('[INV-STO-09] legendary preserves ruby while a hidden range hides intersecting ruby', () => {
    const rubyText = { ...text, ruby: [{ start: 0, end: 4, reading: 'ロサ' }] };
    expect(storyRuby(rubyText, [], true)).toEqual(rubyText.ruby);
    expect(storyRuby(rubyText, [{ start: 1, end: 2 }], true)).toEqual([]);
    expect(storyRuby(rubyText, [], false)).toEqual([]);
  });
  it('[INV-AUD-03] only the exact own aligned asset can highlight', () => {
    expect(
      karaokeRange(text, { kind: 'baked', uri: 'audio/rosa.opus', voiceVersion: 'rosa-v1' }, 950),
    ).toEqual({ start: 10, end: 14 });
    expect(karaokeRange(text, { kind: 'tts', voiceId: 'es-voice' }, 950)).toBeNull();
    expect(
      karaokeRange(text, { kind: 'baked', uri: 'other.opus', voiceVersion: 'rosa-v1' }, 950),
    ).toBeNull();
    expect(
      karaokeRange(
        { ...text, text: 'Rosa toma té.' },
        { kind: 'baked', uri: 'audio/rosa.opus', voiceVersion: 'rosa-v1' },
        950,
      ),
    ).toBeNull();
    expect(
      karaokeRange(text, { kind: 'baked', uri: 'audio/rosa.opus', voiceVersion: 'new' }, 950),
    ).toBeNull();
  });
  it('[INV-AUD-07] each 200ms aligned boundary is represented by 50ms playback ticks', () => {
    const dense = {
      ...text,
      audio: {
        ...text.audio!,
        keypoints: Array.from({ length: 7 }, (_, i) => ({ start: i, end: i + 1, atMs: i * 200 })),
      },
    };
    const spans = new Set(
      Array.from(
        { length: 28 },
        (_, i) =>
          karaokeRange(
            dense,
            { kind: 'baked', uri: 'audio/rosa.opus', voiceVersion: 'rosa-v1' },
            i * 50,
          )?.start,
      ),
    );
    expect(spans.size).toBe(7);
  });
  it('[INV-AUD-01] unavailable baked story lines use a matching resolved voice', () => {
    expect(storyAudio(text, false, { language: 'es', id: 'es-1' }, 'es')).toEqual({
      kind: 'tts',
      voiceId: 'es-1',
    });
    expect(storyAudio(text, false, { language: 'fr', id: 'fr-1' }, 'es')).toEqual({
      kind: 'unavailable',
      reason: 'No Spanish audio is available.',
    });
  });
  it('[INV-STO-08] listening cannot start without a complete baked bank', () => {
    expect(() => startStory({ ...story, bakedAudioComplete: false }, 'listening', 'run')).toThrow(
      /baked/i,
    );
  });
  it('[INV-STO-08] background skipped cards produce no attempts or completion credit', () => {
    let state = setStoryForeground(startStory(story, 'normal', 'run'), false);
    for (let i = 0; i < 5; i++) state = advanceStory(story, state);
    expect(state.answers).toEqual([]);
    expect(state.skippedIds).toEqual(['q', 'match']);
    expect(storyCompletion(story, state, true)).toEqual({
      canCommit: false,
      rewardTier: 'plainReplay',
      answers: [],
    });
    state = setStoryForeground(state, true);
    expect(storyCompletion(story, state, true).rewardTier).toBe('plainReplay');
  });
  it('[INV-STO-08] a repeated submit cannot mint another attempt', () => {
    let state = advanceStory(story, advanceStory(story, startStory(story, 'normal', 'run')));
    state = answerStory(story, state, { kind: 'option', optionId: 'tea' });
    state = answerStory(story, state, { kind: 'option', optionId: 'coffee' });
    expect(state.answers).toHaveLength(1);
    expect(state.answers[0]?.correct).toBe(false);
  });
  it('[INV-STO-08] foreground can answer skipped story questions without regressing progress', () => {
    let state = setStoryForeground(startStory(story, 'normal', 'run'), false);
    for (let i = 0; i < 5; i++) state = advanceStory(story, state);
    state = reviewSkippedStory(story, setStoryForeground(state, true));
    expect(state.partIndex).toBe(2);
    expect(storyProgress(story, state)).toBe(1);
    state = answerStory(story, state, { kind: 'option', optionId: 'coffee' });
    expect(state.answers).toHaveLength(1);
  });
  it('[INV-STO-03] ARRANGE accepts identical tile labels swapped without reusing one tile', () => {
    const q: StoryElement = {
      type: 'ARRANGE',
      id: 'a',
      lineIndex: 1,
      prompt: 'Tap',
      tiles: [
        { id: 'a', text: 'la' },
        { id: 'b', text: 'la' },
        { id: 'c', text: 'mesa' },
      ],
      correctTileIds: ['a', 'b', 'c'],
      itemIds: ['table'],
    };
    expect(gradeStoryChallenge(q, { kind: 'tiles', tileIds: ['b', 'a', 'c'] })).toBe(true);
    expect(gradeStoryChallenge(q, { kind: 'tiles', tileIds: ['a', 'a', 'c'] })).toBe(false);
  });
  it('[INV-STO-02] POINT_TO_PHRASE delivers its line before the challenge beat', () => {
    const point: StoryElement = {
      type: 'POINT_TO_PHRASE',
      id: 'point',
      lineIndex: 1,
      prompt: 'Select coffee',
      ranges: [{ id: 'coffee', start: 10, end: 14 }],
      correctRangeId: 'coffee',
      itemIds: ['coffee'],
    };
    expect(
      storyParts({ ...story, elements: [elements[1]!, point, elements[3]!] }, 'normal').map((p) =>
        p.elements.map((e) => e.id),
      ),
    ).toEqual([['line'], ['point'], ['match']]);
  });
});
