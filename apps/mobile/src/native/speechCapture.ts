import type {
  ExpoSpeechRecognitionNativeEventMap,
  ExpoSpeechRecognitionOptions,
  SetCategoryOptions,
} from 'expo-speech-recognition';
import type { MediaError } from '../lesson/ports';
export type PermissionStatus = 'granted' | 'denied' | 'undetermined';
export interface SpeechDriver {
  getMicrophonePermissionsAsync(): Promise<{ status: PermissionStatus }>;
  getSpeechRecognizerPermissionsAsync(): Promise<{ status: PermissionStatus }>;
  getSupportedLocales(
    options: Record<string, never>,
  ): Promise<{ locales: string[]; installedLocales: string[] }>;
  supportsOnDeviceRecognition(): boolean;
  isRecognitionAvailable(): boolean;
  getAudioSessionCategoryAndOptionsIOS(): SetCategoryOptions;
  setCategoryIOS(options: SetCategoryOptions): void;
  addListener<E extends keyof ExpoSpeechRecognitionNativeEventMap>(
    name: E,
    listener: (event: ExpoSpeechRecognitionNativeEventMap[E]) => void,
  ): { remove(): void };
  start(options: ExpoSpeechRecognitionOptions): void;
  abort(): void;
}
export interface SpeechCapability {
  readonly canRecognize: boolean;
  readonly recognizerLocale: string | null;
  /** iOS combines microphone and recognizer permission. */
  readonly permission: PermissionStatus;
}
export interface SpeechCallbacks {
  onResult(result: { transcript: string; amplitude: number }): void;
  onError(error: MediaError): void;
}
/** Package57.0.0 reports volume in [-2,10]. Timing is Freelingo policy, 2026-09-13:
 * short prompted captures end after30s with a no-audio result if native never finishes. */
export const SPEECH_CAPTURE_CONFIG = {
  volumeMaximum: 10,
  meterIntervalMs: 100,
  maximumCaptureMs: 30_000,
  stopTimeoutMs: 3_000,
} as const;
function canonicalLocale(locale: string): string {
  return locale.replaceAll('_', '-').toLowerCase();
}
function localeFor(requested: string, installed: readonly string[]): string | null {
  const wanted = canonicalLocale(requested);
  return (
    installed.find((locale) => canonicalLocale(locale) === wanted) ??
    (!wanted.includes('-')
      ? installed.find((locale) => canonicalLocale(locale).startsWith(wanted + '-'))
      : null) ??
    null
  );
}
export function createSpeechCapture(
  driver: SpeechDriver,
  options: { platform: 'ios' | 'android'; announcementInFlight: () => boolean },
) {
  let generation = 0;
  let stopCurrent: (() => Promise<void>) | null = null;
  let drained: Promise<void> = Promise.resolve();
  let stopFailed = false;
  const cancel = () => {
    generation++;
    const stop = stopCurrent;
    stopCurrent = null;
    if (stop)
      drained = stop().catch(() => {
        stopFailed = true;
      });
  };
  const probe = async (locale: string): Promise<SpeechCapability> => {
    let permission: PermissionStatus = 'undetermined';
    try {
      const [microphone, speech] = await Promise.all([
        driver.getMicrophonePermissionsAsync(),
        options.platform === 'ios'
          ? driver.getSpeechRecognizerPermissionsAsync()
          : Promise.resolve({ status: 'granted' as const }),
      ]);
      permission =
        microphone.status === 'granted' && speech.status === 'granted'
          ? 'granted'
          : microphone.status === 'denied' || speech.status === 'denied'
            ? 'denied'
            : 'undetermined';
      const locales = await driver.getSupportedLocales({});
      const recognizerLocale = localeFor(locale, locales.installedLocales);
      return {
        permission,
        recognizerLocale,
        canRecognize:
          !stopFailed &&
          permission === 'granted' &&
          recognizerLocale !== null &&
          driver.supportsOnDeviceRecognition() &&
          driver.isRecognitionAvailable(),
      };
    } catch {
      return { permission, recognizerLocale: null, canRecognize: false };
    }
  };
  const begin = async (locale: string, callbacks: SpeechCallbacks): Promise<void> => {
    cancel();
    const current = generation;
    await drained;
    if (current !== generation) return;
    if (stopFailed || options.announcementInFlight()) {
      callbacks.onError('unavailable');
      return;
    }
    const capability = await probe(locale);
    if (current !== generation) return;
    if (capability.permission !== 'granted') {
      callbacks.onError('permission-denied');
      return;
    }
    if (
      !capability.canRecognize ||
      !capability.recognizerLocale ||
      options.announcementInFlight()
    ) {
      callbacks.onError('unavailable');
      return;
    }
    let previous: SetCategoryOptions | null = null;
    let peak = 0,
      settled = false,
      started = false,
      nativeEnded = false,
      requestAbort = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cleanupPromise: Promise<void> | null = null;
    const subscriptions: { remove(): void }[] = [];
    // Native abort() returns before the Swift Task/Android handler has released the
    // microphone. Retain a dedicated end listener and serialize the next capture.
    const stopNative = () =>
      new Promise<void>((resolve, reject) => {
        const ending = driver.addListener('end', () => {
          clearTimeout(deadline);
          ending.remove();
          resolve();
        });
        const deadline = setTimeout(() => {
          ending.remove();
          reject(new Error('Native capture did not stop'));
        }, SPEECH_CAPTURE_CONFIG.stopTimeoutMs);
        try {
          if (requestAbort) driver.abort();
        } catch (error) {
          clearTimeout(deadline);
          ending.remove();
          reject(error);
        }
      });
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      for (const subscription of subscriptions) subscription.remove();
      cleanupPromise = (async () => {
        try {
          if (started && !nativeEnded) await stopNative();
        } finally {
          if (previous !== null) driver.setCategoryIOS(previous);
          if (stopCurrent === cleanup) stopCurrent = null;
        }
      })();
      return cleanupPromise;
    };
    const finish = (
      result: { transcript: string; amplitude: number } | MediaError,
      abortNative = false,
    ) => {
      if (settled || current !== generation) return;
      requestAbort = abortNative;
      const completion = cleanup();
      drained = completion.catch(() => {
        stopFailed = true;
      });
      void completion.then(
        () => {
          if (current !== generation) return;
          if (typeof result === 'string') callbacks.onError(result);
          else callbacks.onResult(result);
        },
        () => {
          if (current === generation) callbacks.onError('unavailable');
        },
      );
    };
    try {
      if (options.platform === 'ios') previous = driver.getAudioSessionCategoryAndOptionsIOS();
      subscriptions.push(
        driver.addListener('volumechange', (event) => {
          if (Number.isFinite(event.value))
            peak = Math.max(
              peak,
              Math.max(0, Math.min(1, event.value / SPEECH_CAPTURE_CONFIG.volumeMaximum)),
            );
        }),
      );
      subscriptions.push(
        driver.addListener('result', (event) => {
          if (event.isFinal)
            finish(
              { transcript: event.results[0]?.transcript ?? '', amplitude: peak },
              options.platform === 'android',
            );
        }),
      );
      subscriptions.push(
        driver.addListener('error', (event) => {
          if (event.error === 'no-speech' || event.error === 'speech-timeout')
            finish({ transcript: '', amplitude: 0 });
          else
            finish(
              event.error === 'interrupted' ||
                event.error === 'audio-capture' ||
                event.error === 'aborted'
                ? 'interrupted'
                : event.error === 'not-allowed'
                  ? 'permission-denied'
                  : 'unavailable',
            );
        }),
      );
      subscriptions.push(
        driver.addListener('end', () => {
          nativeEnded = true;
          finish({ transcript: '', amplitude: 0 });
        }),
      );
      stopCurrent = cleanup;
      started = true;
      driver.start({
        lang: capability.recognizerLocale,
        requiresOnDeviceRecognition: true,
        continuous: options.platform === 'android',
        interimResults: false,
        maxAlternatives: 1,
        recordingOptions: { persist: false },
        volumeChangeEventOptions: {
          enabled: true,
          intervalMillis: SPEECH_CAPTURE_CONFIG.meterIntervalMs,
        },
      });
      if (!settled)
        timer = setTimeout(
          () => finish({ transcript: '', amplitude: 0 }, true),
          SPEECH_CAPTURE_CONFIG.maximumCaptureMs,
        );
    } catch {
      nativeEnded = true;
      finish('unavailable');
    }
  };
  return { probe, begin, cancel, whenIdle: () => drained };
}
