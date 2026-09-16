import { requireNativeModule } from 'expo';
import { createAudioPlayer, type AudioPlayer, type AudioStatus } from 'expo-audio';
import { Platform } from 'react-native';
import type { LessonMediaDrivers } from './lessonMedia';

type Request = Parameters<LessonMediaDrivers['playback']['play']>[0];
type Callbacks = Parameters<LessonMediaDrivers['playback']['play']>[1];
interface Voice {
  readonly identifier: string;
  readonly language: string;
}
interface Subscription {
  remove(): void;
}
interface NativeSpeech {
  readonly freelingoLocalSpeechRevision?: number;
  getVoices(): Promise<readonly Voice[]>;
  speak(
    id: string,
    text: string,
    options: {
      voice: string;
      language: string;
      rate: number;
      pitch: number;
      volume: number;
      useApplicationAudioSession: boolean;
    },
  ): Promise<void>;
  stop(): Promise<void>;
  addListener(name: string, callback: (event: { readonly id: string }) => void): Subscription;
}
/** Slow asset rate is the Freelingo ruling in deep/01 S9. Timing is a Freelingo
 * resource watchdog, 2026-09-13; it is not a measured Duolingo latency threshold. */
export const LESSON_PLAYBACK_CONFIG = {
  normalRate: 1,
  slowRate: 0.75,
  updateIntervalMs: 100,
  completionTimeoutMs: 120_000,
  localSpeechRevision: 1,
} as const;
function localeKey(value: string): string | null {
  try {
    return Intl.getCanonicalLocales(value)[0]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
function localUri(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'file:' && url.hostname === '' && url.pathname.startsWith('/')
      ? value
      : null;
  } catch {
    return null;
  }
}
/** The resolver must come from the active verified pack repository. Native audio is
 * given only a verified local URI; there is no network player or implicit download.
 * One instance belongs to createLessonMediaOwner, which serializes all starts/stops. */
export function createExpoLessonPlayback(resolveAudio: (assetRef: string) => string | null) {
  let native: NativeSpeech | null = null;
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    try {
      native = requireNativeModule<NativeSpeech>('ExpoSpeech');
    } catch {
      /* Installed pack audio is still usable when native TTS is absent. */
    }
  }
  let voices: readonly Voice[] = [];
  let probe = 0,
    sequence = 0;
  let active: { id: string; stop: () => Promise<void> } | null = null;
  let disposed = false;
  function voiceFor(locale: string): Voice | null {
    if (native?.freelingoLocalSpeechRevision !== LESSON_PLAYBACK_CONFIG.localSpeechRevision)
      return null;
    const key = localeKey(locale);
    if (key === null) return null;
    return (
      voices.find((voice) => localeKey(voice.language) === key) ??
      (!key.includes('-')
        ? voices.find((voice) => localeKey(voice.language)?.split('-')[0] === key)
        : undefined) ??
      null
    );
  }
  function asset(request: Request): string | null {
    if (!request.assetRef) return null;
    try {
      return localUri(resolveAudio(request.assetRef));
    } catch {
      return null;
    }
  }
  const driver = {
    async refreshVoices(): Promise<void> {
      const current = ++probe;
      voices = [];
      if (
        disposed ||
        native?.freelingoLocalSpeechRevision !== LESSON_PLAYBACK_CONFIG.localSpeechRevision
      )
        return;
      try {
        const found = await native.getVoices();
        if (current !== probe || disposed) return;
        voices = found
          .filter(
            (voice) =>
              typeof voice.identifier === 'string' &&
              voice.identifier.trim() !== '' &&
              localeKey(voice.language) !== null,
          )
          .map((voice) => ({ identifier: voice.identifier, language: voice.language }))
          .sort((a, b) =>
            a.identifier < b.identifier ? -1 : a.identifier === b.identifier ? 0 : 1,
          );
      } catch {
        if (current === probe) voices = [];
      }
    },
    available(request: Request): boolean {
      return (
        !disposed &&
        (asset(request) !== null ||
          (request.text.trim() !== '' && voiceFor(request.locale) !== null))
      );
    },
    play(request: Request, callbacks: Callbacks): () => Promise<void> {
      if (disposed || active !== null || !driver.available(request)) {
        callbacks.onError('unavailable');
        return async () => {};
      }
      const id = `freelingo-lesson-${++sequence}`;
      const uri = asset(request);
      const voice = uri === null ? voiceFor(request.locale) : null;
      let stopped = false,
        finished = false,
        started = false;
      let player: AudioPlayer | null = null;
      let startedSpeech = false;
      const subscriptions: Subscription[] = [];
      let stopping: Promise<void> | null = null;
      function finish(callback: () => void) {
        if (stopped || finished || active?.id !== id) return;
        finished = true;
        clearTimeout(timeout);
        callback();
      }
      const stop = (): Promise<void> => {
        if (stopping !== null) return stopping;
        stopped = true;
        clearTimeout(timeout);
        // Keep ownership until native release succeeds. Failure is observed by the
        // outer owner, which quarantines the channel instead of starting another.
        stopping = (async () => {
          let failed: unknown;
          for (const subscription of subscriptions.splice(0)) {
            try {
              subscription.remove();
            } catch (error) {
              failed ??= error;
            }
          }
          try {
            player?.pause();
          } catch (error) {
            failed ??= error;
          }
          try {
            player?.remove();
          } catch (error) {
            failed ??= error;
          }
          if (startedSpeech) {
            try {
              await native!.stop();
            } catch (error) {
              failed ??= error;
            }
          }
          if (failed !== undefined) throw failed;
          if (active?.id === id) active = null;
        })();
        return stopping;
      };
      active = { id, stop };
      const timeout = setTimeout(
        () => finish(() => callbacks.onError('unavailable')),
        LESSON_PLAYBACK_CONFIG.completionTimeoutMs,
      );
      try {
        if (uri !== null) {
          player = createAudioPlayer(
            { uri },
            {
              downloadFirst: false,
              updateInterval: LESSON_PLAYBACK_CONFIG.updateIntervalMs,
              keepAudioSessionActive: true,
            },
          );
          player.shouldCorrectPitch = true;
          player.setPlaybackRate(
            request.slow && !request.assetIsSlow
              ? LESSON_PLAYBACK_CONFIG.slowRate
              : LESSON_PLAYBACK_CONFIG.normalRate,
            'high',
          );
          subscriptions.push(
            player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
              if (status.error) finish(() => callbacks.onError('unavailable'));
              else if (status.mediaServicesDidReset) finish(callbacks.onInterrupted);
              else if (status.didJustFinish) finish(callbacks.onComplete);
              else if (status.playing) started = true;
              else if (started && !status.isBuffering) finish(callbacks.onInterrupted);
            }),
          );
          player.play();
        } else if (voice !== null && native !== null) {
          for (const [name, callback] of [
            ['Exponent.speakingDone', callbacks.onComplete],
            ['Exponent.speakingStopped', callbacks.onInterrupted],
            ['Exponent.speakingError', () => callbacks.onError('unavailable')],
          ] as const)
            subscriptions.push(
              native.addListener(name, (event) => {
                if (event.id === id) finish(callback);
              }),
            );
          startedSpeech = true;
          void native
            .speak(id, request.text, {
              voice: voice.identifier,
              language: voice.language,
              rate: request.slow
                ? LESSON_PLAYBACK_CONFIG.slowRate
                : LESSON_PLAYBACK_CONFIG.normalRate,
              pitch: 1,
              volume: 1,
              useApplicationAudioSession: true,
            })
            .catch(() => finish(() => callbacks.onError('unavailable')));
        } else finish(() => callbacks.onError('unavailable'));
      } catch {
        finish(() => callbacks.onError('unavailable'));
      }
      return stop;
    },
    async dispose(): Promise<void> {
      disposed = true;
      probe++;
      voices = [];
      await active?.stop();
    },
  };
  return driver;
}
