import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { startStory } from '@freelingo/core/stories';
import { startRadio } from '@freelingo/core/radio';
import type { StoryDocument } from '@freelingo/core/stories';
import type { RadioEpisode } from '@freelingo/core/radio';
import type { RadioPlayerHandle } from './contracts';
const audio = vi.hoisted(() => ({
  player: {
    play: vi.fn(),
    pause: vi.fn(),
    replace: vi.fn(),
    seekTo: vi.fn().mockResolvedValue(undefined),
    setActiveForLockScreen: vi.fn(),
  },
  mode: vi.fn().mockResolvedValue(undefined),
  options: vi.fn(),
  status: { currentTime: 0, playing: false, didJustFinish: false, isLoaded: true, duration: 10 },
}));
vi.mock('expo-audio', () => ({
  useAudioPlayer: (_source: unknown, options: unknown) => {
    audio.options(options);
    return audio.player;
  },
  useAudioPlayerStatus: () => audio.status,
  setAudioModeAsync: audio.mode,
}));
vi.mock('expo-speech', () => ({ speak: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) }));
import { StoryPlayer } from './StoryPlayer';
import { RadioPlayer } from './RadioPlayer';
const story: StoryDocument = {
  schemaVersion: 1,
  id: 's',
  revision: '1',
  language: 'es',
  unitIndex: 1,
  title: 'A coffee',
  targetTitle: 'Un café',
  narratorRegister: 'tu',
  covers: { active: 'cover.png', gilded: 'cover.png', locked: 'cover.png' },
  bakedAudioComplete: false,
  elements: [
    {
      id: 'header',
      lineIndex: 0,
      type: 'HEADER',
      content: { text: 'Un café', hints: [{ start: 3, end: 7, gloss: 'coffee' }], ruby: [] },
    },
    {
      id: 'q',
      lineIndex: 1,
      type: 'MULTIPLE_CHOICE',
      prompt: 'What does café mean?',
      options: [
        { id: 'yes', text: 'Coffee' },
        { id: 'no', text: 'Tea' },
      ],
      correctOptionId: 'yes',
      itemIds: ['coffee'],
    },
    {
      id: 'm',
      lineIndex: 2,
      type: 'MATCH',
      pairs: [{ id: 'coffee', left: 'café', right: 'coffee', itemIds: ['coffee'] }],
    },
  ],
};
const episode: RadioEpisode = {
  schemaVersion: 1,
  id: 'r',
  revision: '1',
  title: 'At the café',
  language: 'es',
  unitIndex: 1,
  show: {
    id: 'rosa',
    title: 'Un rato con Rosa',
    hostCharacterId: 'adult_female',
    introAsset: 'intro.opus',
    outroAsset: 'outro.opus',
  },
  l1Ratio: 0,
  targetDurationMs: 10000,
  audio: { uri: 'episode.opus', durationMs: 10000 },
  bakedAudioComplete: true,
  segments: [
    {
      id: 'one',
      startMs: 0,
      endMs: 10000,
      characterId: 'adult_female',
      text: 'Quiero un café.',
      language: 'es',
    },
  ],
  questions: [
    {
      id: 'q',
      atMs: 10000,
      kind: 'listenSelect',
      prompt: 'Words',
      count: 1,
      tiles: [
        { id: 'cafe', tokenId: 't1', contentToken: true, text: 'café', itemIds: ['coffee'] },
        { id: 'tea', tokenId: 't2', contentToken: true, text: 'té', itemIds: ['tea'] },
      ],
      correctTileIds: ['cafe'],
    },
  ],
};
const ports = () => ({
  onSave: vi.fn(),
  onAttempt: vi.fn(),
  onComplete: vi.fn(),
  onClose: vi.fn(),
  onRepair: vi.fn(),
});
describe('production media players', () => {
  it('[INV-AUD-02] unavailable story audio stays visible with its reason', () => {
    render(
      <StoryPlayer
        story={story}
        initialState={startStory(story, 'normal', 'run')}
        characterNames={{}}
        audioByElementId={{ header: { kind: 'unavailable', reason: 'Download Spanish audio.' } }}
        {...ports()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Play Un café' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(screen.getByText('Download Spanish audio.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Listen to story' })).toBeNull();
  });
  it('[INV-STO-04] the real legendary reader suppresses tap hints', () => {
    render(
      <StoryPlayer
        story={story}
        initialState={startStory(story, 'legendary', 'run')}
        characterNames={{}}
        audioByElementId={{}}
        {...ports()}
      />,
    );
    fireEvent.click(screen.getByText('café'));
    expect(screen.queryByText('coffee')).toBeNull();
  });
  it('[INV-STO-08] answering a story emits one real attempt and completion needs an explicit press', () => {
    const callbacks = ports();
    render(
      <StoryPlayer
        story={story}
        initialState={startStory(story, 'normal', 'run')}
        characterNames={{}}
        audioByElementId={{}}
        {...callbacks}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Coffee' }));
    expect(callbacks.onAttempt).toHaveBeenCalledTimes(1);
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Match café' }));
    fireEvent.click(screen.getByRole('button', { name: 'With coffee' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check matches' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Story complete!')).toBeDefined();
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish story' }));
    expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
  });
  it('[INV-STO-03] POINT_TO_PHRASE is answered inside the delivered sentence', () => {
    const pointed: StoryDocument = {
      ...story,
      elements: [
        story.elements[0]!,
        {
          id: 'line',
          type: 'LINE',
          lineIndex: 1,
          kind: 'PROSE',
          content: {
            text: 'Quiero café.',
            hints: [{ start: 7, end: 11, gloss: 'coffee' }],
            ruby: [],
          },
        },
        {
          id: 'point',
          type: 'POINT_TO_PHRASE',
          lineIndex: 1,
          prompt: 'Select coffee',
          ranges: [{ id: 'p', start: 7, end: 11 }],
          correctRangeId: 'p',
          itemIds: ['coffee'],
        },
        story.elements[2]!,
      ],
    };
    const callbacks = ports();
    render(
      <StoryPlayer
        story={pointed}
        initialState={{ ...startStory(pointed, 'normal', 'run'), partIndex: 2 }}
        characterNames={{}}
        audioByElementId={{}}
        {...callbacks}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'café' }));
    expect(callbacks.onAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ correct: true }),
      expect.anything(),
    );
    expect(screen.queryByText('coffee')).toBeNull();
  });
  it('[INV-STO-07] Radio restores the saved native position before accepting zero-time ticks', async () => {
    audio.player.seekTo.mockClear();
    const callbacks = ports();
    render(
      <RadioPlayer
        episode={episode}
        initialState={{ ...startRadio(episode, 'run'), positionMs: 6000 }}
        audioAvailable
        {...callbacks}
      />,
    );
    await waitFor(() => expect(audio.player.seekTo).toHaveBeenCalledWith(6));
    expect(callbacks.onSave).not.toHaveBeenCalledWith(expect.objectContaining({ positionMs: 0 }));
  });
  it('[INV-PLAT-05] Radio activates the actual AudioPlayer lock-screen API with doNotMix', async () => {
    audio.mode.mockClear();
    audio.player.setActiveForLockScreen.mockClear();
    render(
      <RadioPlayer
        episode={episode}
        initialState={startRadio(episode, 'run')}
        audioAvailable
        {...ports()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Play episode' }));
    await waitFor(() =>
      expect(audio.player.setActiveForLockScreen).toHaveBeenCalledWith(true, {
        title: episode.title,
        artist: episode.show.title,
      }),
    );
    expect(audio.mode).toHaveBeenCalledWith(
      expect.objectContaining({ interruptionMode: 'doNotMix', shouldPlayInBackground: true }),
    );
    expect(audio.options).toHaveBeenCalledWith({ updateInterval: 50 });
  });
  it('[INV-STO-07] the native interruption handle pauses, persists and releases lock screen', async () => {
    const ref = createRef<RadioPlayerHandle>();
    const callbacks = ports();
    render(
      <RadioPlayer
        ref={ref}
        episode={episode}
        initialState={startRadio(episode, 'run')}
        audioAvailable
        {...callbacks}
      />,
    );
    await act(async () => ref.current?.interruptForGradedSession());
    expect(audio.player.pause).toHaveBeenCalled();
    expect(audio.player.setActiveForLockScreen).toHaveBeenCalledWith(false);
    expect(callbacks.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ playing: false, positionMs: 0 }),
    );
  });
  it('[INV-PACK-21] missing Radio audio exposes repair and does not create a TTS player', () => {
    const callbacks = ports();
    render(
      <RadioPlayer
        episode={episode}
        initialState={startRadio(episode, 'run')}
        audioAvailable={false}
        {...callbacks}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Play episode' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Repair audio' }));
    expect(callbacks.onRepair).toHaveBeenCalledOnce();
  });
});
