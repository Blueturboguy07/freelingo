import type { AudioMode } from 'expo-audio';

/** Freelingo policy, 2026-09-13, deep/08 §12 (not a measured native default):
 * effects respect silent mode; lesson speech can play in silent mode. Lessons
 * never continue playback or recording in the background. Exclusive lesson focus
 * avoids another app's audio entering a prompted recording.
 *
 * Expo exposes no audio-mode getter. This owner establishes an explicit app idle
 * policy; it does not pretend to save an unknown prior OS mode. The speech capture
 * owner separately saves/restores the actual iOS pre-mic category and options. */
const idle: Readonly<AudioMode> = Object.freeze({
  playsInSilentMode: false,
  interruptionMode: 'mixWithOthers',
  allowsRecording: false,
  shouldPlayInBackground: false,
  shouldRouteThroughEarpiece: false,
  allowsBackgroundRecording: false,
});
export const LESSON_AUDIO_MODE_CONFIG = Object.freeze({
  idle,
  lesson: Object.freeze({
    ...idle,
    playsInSilentMode: true,
    interruptionMode: 'doNotMix' as const,
  }),
});
export type LessonAudioModeWriter = (mode: Readonly<AudioMode>) => Promise<void>;

/** One instance belongs to the native app resource owner. All app mode writes
 * must share this boundary; Radio hands off durably before a lesson enters it. */
export function createLessonAudioMode(writeNative: LessonAudioModeWriter) {
  let tail: Promise<void> = Promise.resolve();
  let initialization: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  let closed = false;
  let initialized = false;
  let unavailable = false;
  let attempted = false;
  let current: Readonly<AudioMode> | null = null;
  let active: number | null = null;
  let sequence = 0;
  function enqueue(work: () => Promise<void>): Promise<void> {
    const result = tail.then(work);
    tail = result.catch(() => undefined);
    return result;
  }
  async function write(mode: Readonly<AudioMode>): Promise<void> {
    attempted = true;
    current = null;
    try {
      await writeNative(mode);
      current = mode;
    } catch (error) {
      unavailable = true;
      throw error;
    }
  }
  const owner = {
    initialize(): Promise<void> {
      if (closed) return Promise.reject(new Error('Lesson audio mode is closed.'));
      if (initialization) return initialization;
      initialization = enqueue(async () => {
        if (closed) throw new Error('Lesson audio mode is closed.');
        await write(LESSON_AUDIO_MODE_CONFIG.idle);
        if (closed) throw new Error('Lesson audio mode is closed.');
        initialized = true;
      });
      return initialization;
    },
    async enterLessonMode(): Promise<() => Promise<void>> {
      if (closed) throw new Error('Lesson audio mode is closed.');
      if (unavailable) throw new Error('Lesson audio mode is unavailable after a native failure.');
      if (!initialized) throw new Error('Lesson audio mode must finish initialization.');
      const token = ++sequence;
      await enqueue(async () => {
        if (closed) throw new Error('Lesson audio mode is closed.');
        if (unavailable)
          throw new Error('Lesson audio mode is unavailable after a native failure.');
        if (active !== null) throw new Error('A lesson audio mode lease is already owned.');
        active = token;
        await write(LESSON_AUDIO_MODE_CONFIG.lesson);
        if (closed) throw new Error('Lesson audio mode is closed.');
      });
      let restoration: Promise<void> | null = null;
      return () => {
        if (restoration) return restoration;
        if (closing) return closing;
        restoration = enqueue(async () => {
          if (active !== token) return;
          await write(LESSON_AUDIO_MODE_CONFIG.idle);
          active = null;
        });
        return restoration;
      };
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = enqueue(async () => {
        // A failed write can partially alter native state. Attempt the declared
        // idle policy again, but never fabricate a saved mode from that failure.
        if (attempted && current !== LESSON_AUDIO_MODE_CONFIG.idle)
          await write(LESSON_AUDIO_MODE_CONFIG.idle);
        active = null;
        initialized = false;
      });
      return closing;
    },
  };
  return owner;
}
