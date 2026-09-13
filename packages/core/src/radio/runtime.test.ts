import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  startRadio,
  moveRadio,
  answerRadio,
  setRadioForeground,
  interruptRadio,
  completeRadio,
  selectionReady,
  toggleSelection,
  recommendedEpisodes,
  radioAnchors,
  validateListenTiles,
} from './index.js';
import type { RadioEpisode } from './index.js';
const episode: RadioEpisode = {
  schemaVersion: 1,
  id: 'market',
  revision: 'r1',
  title: 'The market',
  show: {
    id: 'with-rosa',
    title: 'Un rato con Rosa',
    hostCharacterId: 'adult_female',
    introAsset: 'intro.opus',
    outroAsset: 'outro.opus',
  },
  language: 'es',
  unitIndex: 5,
  l1Ratio: 0.1,
  targetDurationMs: 240000,
  audio: { uri: 'market.opus', durationMs: 240000 },
  bakedAudioComplete: true,
  segments: [
    {
      id: 'intro',
      startMs: 0,
      endMs: 10000,
      characterId: 'adult_female',
      text: 'Hola.',
      language: 'es',
    },
    {
      id: 'main',
      startMs: 10000,
      endMs: 240000,
      characterId: 'adult_male',
      text: 'Quiero café.',
      language: 'es',
    },
  ],
  questions: [
    {
      id: 'q1',
      atMs: 8000,
      kind: 'comprehension',
      prompt: 'Does he want coffee?',
      options: [
        { id: 'yes', text: 'Yes' },
        { id: 'no', text: 'No' },
      ],
      correctOptionId: 'yes',
      itemIds: ['coffee'],
    },
    {
      id: 'q2',
      atMs: 240000,
      kind: 'listenSelect',
      prompt: 'Select words',
      count: 1,
      tiles: [
        { id: 'coffee', text: 'café', contentToken: true, tokenId: 't1', itemIds: ['coffee'] },
        { id: 'tea', text: 'té', contentToken: true, tokenId: 't2', itemIds: ['tea'] },
      ],
      correctTileIds: ['coffee'],
    },
  ],
};
describe('radio runtime', () => {
  it('[INV-STO-05] exactly the declared count arms selection for any count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 0, max: 15 }), (n, length) => {
        expect(
          selectionReady(
            n,
            Array.from({ length }, (_, i) => String(i)),
          ),
        ).toBe(n === length);
      }),
      { numRuns: PROPERTY_RUNS },
    );
    expect(toggleSelection(['a'], 'a')).toEqual([]);
    expect(selectionReady(2, ['a', 'a'])).toBe(false);
  });
  it('[INV-STO-06] anchors defer to the next segment boundary and recommendation respects position', () => {
    expect(radioAnchors(episode).map((q) => q.atMs)).toEqual([10000, 240000]);
    expect(
      recommendedEpisodes([episode, { ...episode, id: 'later', unitIndex: 20 }], 5).map(
        (e) => e.id,
      ),
    ).toEqual(['market']);
  });
  it('[INV-STO-08] forward scrub clamps at the next unconsumed anchor', () => {
    const state = moveRadio(episode, startRadio(episode, 'run'), 239000);
    expect(state.positionMs).toBe(10000);
    expect(state.activeQuestionId).toBe('q1');
    expect(state.playing).toBe(false);
  });
  it('[INV-STO-08] consumed anchors never refire or issue a second answer', () => {
    let state = moveRadio(episode, startRadio(episode, 'run'), 10000);
    state = answerRadio(episode, state, { kind: 'option', optionId: 'yes' });
    state = moveRadio(episode, state, 5000);
    state = moveRadio(episode, state, 12000);
    expect(state.activeQuestionId).toBeNull();
    expect(state.answers).toHaveLength(1);
    expect(answerRadio(episode, state, { kind: 'option', optionId: 'yes' }).answers).toHaveLength(
      1,
    );
  });
  it('[INV-STO-08] background reaches the end without stalling or committing rewards', () => {
    const state = moveRadio(episode, setRadioForeground(startRadio(episode, 'run'), false), 240000);
    expect(state.positionMs).toBe(240000);
    expect(state.skippedIds).toEqual(['q1', 'q2']);
    expect(state.activeQuestionId).toBeNull();
    expect(completeRadio(episode, state, true)).toEqual({
      canCommit: false,
      rewardTier: 'plainReplay',
      answers: [],
    });
  });
  it('[INV-STO-08] foreground exposes skipped questions without granting a second attempt', () => {
    let state = moveRadio(episode, setRadioForeground(startRadio(episode, 'run'), false), 240000);
    state = setRadioForeground(state, true);
    expect(state.activeQuestionId).toBe('q1');
    state = answerRadio(episode, state, { kind: 'option', optionId: 'yes' });
    expect(state.activeQuestionId).toBe('q2');
    state = answerRadio(episode, state, { kind: 'tiles', tileIds: ['coffee'] });
    expect(completeRadio(episode, state, true).rewardTier).toBe('completed');
    expect(state.answers).toHaveLength(2);
  });
  it('[INV-STO-08] backgrounding an open question continues audio, and foreground review pauses it', () => {
    let state = moveRadio(episode, { ...startRadio(episode, 'run'), playing: true }, 10000);
    expect(state.playing).toBe(false);
    state = setRadioForeground(state, false);
    expect(state.playing).toBe(true);
    state = setRadioForeground(state, true);
    expect(state.playing).toBe(false);
  });
  it('[INV-STO-07] graded-session interruption persists position, pauses and releases lock screen', () => {
    const result = interruptRadio({
      ...startRadio(episode, 'run'),
      positionMs: 5000,
      playing: true,
    });
    expect(result.state.playing).toBe(false);
    expect(result.state.positionMs).toBe(5000);
    expect(result.effects).toEqual(['pauseAudio', 'persist', 'releaseLockScreen']);
    expect(setRadioForeground(result.state, true).playing).toBe(false);
  });
  it('[INV-PACK-21] incomplete radio has no device-TTS escape hatch', () => {
    expect(() => startRadio({ ...episode, bakedAudioComplete: false }, 'run')).toThrow(/repair/i);
  });
  it('[INV-STO-10] particles, duplicate source tokens and empty morpheme tags reject', () => {
    const question = episode.questions[1]!;
    if (question.kind !== 'listenSelect') throw new Error('fixture');
    expect(validateListenTiles(question)).toEqual([]);
    expect(
      validateListenTiles({
        ...question,
        tiles: [{ ...question.tiles[0]!, contentToken: false }, question.tiles[1]!],
      }),
    ).not.toEqual([]);
    expect(
      validateListenTiles({
        ...question,
        tiles: [{ ...question.tiles[0]!, itemIds: [] }, question.tiles[1]!],
      }),
    ).not.toEqual([]);
  });
});
