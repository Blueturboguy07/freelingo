// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { freshSession, item } from '@freelingo/core/session';
import type { LearningSessionView } from '../db/learningRuntimePorts';
const native = vi.hoisted(() => ({
  mode: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  play: vi.fn(),
  dispose: vi.fn(async () => {}),
}));
vi.mock('expo-audio', () => ({ setAudioModeAsync: native.mode }));
vi.mock('../native/expoLessonPlayback', () => ({
  createExpoLessonPlayback: () => ({
    refreshVoices: async () => {},
    available: (r: { assetRef?: string; text: string }) => !!r.assetRef || !!r.text,
    play: native.play,
    dispose: native.dispose,
  }),
}));
vi.mock('../native/expoSpeech', () => ({ createExpoSpeechCapture: () => null }));
import { createExpoLessonMedia } from '../native/expoLessonMedia';
import { createLessonMediaBinding } from './lessonMediaBinding';
beforeEach(() => {
  vi.clearAllMocks();
  native.play.mockImplementation(() => native.stop);
});
function fixture() {
  const q = item(1, { type: 'listenTypeWhatYouHear' });
  const frame: LearningSessionView = {
    exerciseId: 'first-variant',
    state: { ...freshSession({ queue: [q] }), shellState: 'challenge.idle' },
    challenge: {
      itemId: q.itemId,
      type: q.type,
      instruction: 'Listen',
      prompt: 'Hola',
      language: 'es',
      acceptedAnswers: ['hola'],
      audioRef: 'normal',
      slowAudioRef: 'slow',
    },
  };
  const media = createExpoLessonMedia({
    resolveAudio: () => null,
    beforeLessonAudio: async () => {},
    remediate: () => {},
    accessibility: {
      read: () => ({ screenReaderActive: false, announcementInFlight: false }),
      subscribe: () => () => {},
      announce: () => {},
    },
    microphoneSignals: {
      play: () => {
        throw Error('No microphone fixture');
      },
    },
  });
  const binding = createLessonMediaBinding(media.activate);
  return { frame, media, binding };
}
const callbacks = () => ({ onComplete: vi.fn(), onInterrupted: vi.fn(), onError: vi.fn() });
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
it('[INV-SESS-27][INV-AUD-06] saved binding drives the actual compositor, keeps typing audio and rejects an old variant after transition', async () => {
  const { frame, media, binding } = fixture();
  await media.initialize();
  await media.prepare(['es']);
  await binding.synchronize(frame);
  const first = {
    itemId: frame.challenge!.itemId,
    text: 'Hola',
    locale: 'es',
    slow: false,
    assetRef: 'normal',
  };
  media.media.play(first, callbacks());
  await flush();
  expect(native.play).toHaveBeenCalledOnce();
  await binding.synchronize({ ...frame, state: { ...frame.state, shellState: 'challenge.armed' } });
  expect(native.stop).not.toHaveBeenCalled();
  const next = {
    ...frame,
    exerciseId: 'second-variant',
    challenge: { ...frame.challenge!, audioRef: 'new-normal', slowAudioRef: 'new-slow' },
  };
  await binding.synchronize(next);
  expect(native.stop).toHaveBeenCalledOnce();
  const rejected = callbacks();
  media.media.play(first, rejected);
  expect(rejected.onError).toHaveBeenCalledWith('unavailable');
  const slow = { ...first, assetRef: 'new-slow', slow: true, assetIsSlow: true };
  media.media.play(slow, callbacks());
  await flush();
  expect(native.play.mock.calls.at(-1)?.[0]).toEqual(slow);
  await media.background();
  await binding.synchronize(null);
  expect(media.media.capabilities.canPlay).toBe(false);
  await media.prepare(['es']);
  await binding.synchronize(next);
  expect(media.media.capabilities.canPlay).toBe(true);
  await media.close();
});
it('[INV-AUD-06][INV-PACK-52] actual compositor receives no invented playback from a Japanese text-only binding', async () => {
  const { frame, media, binding } = fixture();
  const q = item(1, { type: 'meaningSelect' });
  const silent = {
    ...frame,
    state: { ...frame.state, core: { ...frame.state.core, queue: [q] } },
    challenge: {
      itemId: q.itemId,
      type: q.type,
      instruction: 'Choose',
      prompt: '猫',
      language: 'ja',
      acceptedAnswers: ['cat'],
    },
  };
  await media.initialize();
  await media.prepare(['ja']);
  await binding.synchronize(silent);
  expect(media.media.capabilities.canPlay).toBe(false);
  const rejected = callbacks();
  media.media.play({ itemId: q.itemId, text: '猫', locale: 'ja', slow: false }, rejected);
  expect(rejected.onError).toHaveBeenCalledWith('unavailable');
  expect(native.play).not.toHaveBeenCalled();
  await media.close();
});
