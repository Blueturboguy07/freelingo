import { setAudioModeAsync } from 'expo-audio';
import type { LessonMediaCapabilities, LessonMediaPort } from '../lesson/ports';
import { createExpoLessonPlayback } from './expoLessonPlayback';
import { createExpoSpeechCapture } from './expoSpeech';
import { createLessonAudioMode } from './lessonAudioMode';
import { createLessonMediaOwner } from './lessonMedia';
import type { SpeechCallbacks, SpeechCapability } from './speechCapture';

export type LessonPlaybackRequest = Parameters<LessonMediaPort['play']>[0];
type PlaybackRequest = LessonPlaybackRequest;
/** Both requests are authored by the verified active-challenge bridge. The
 * compositor never derives a slow asset from an arbitrary pack reference. */
export interface LessonMediaActivation {
  readonly normal: LessonPlaybackRequest;
  readonly slow: LessonPlaybackRequest;
}
function validateActivation(value: LessonMediaActivation): LessonMediaActivation {
  const { normal, slow } = value;
  for (const request of [normal, slow]) {
    if (
      !request ||
      typeof request.itemId !== 'string' ||
      !request.itemId.trim() ||
      typeof request.text !== 'string' ||
      typeof request.locale !== 'string' ||
      !request.locale.trim() ||
      typeof request.slow !== 'boolean' ||
      (request.assetRef !== undefined &&
        (typeof request.assetRef !== 'string' || !request.assetRef.trim())) ||
      (request.assetIsSlow !== undefined && typeof request.assetIsSlow !== 'boolean') ||
      (request.assetIsSlow === true && request.assetRef === undefined)
    )
      throw new Error('Invalid lesson media activation request.');
  }
  if (
    normal.slow !== false ||
    normal.assetIsSlow === true ||
    slow.slow !== true ||
    normal.itemId !== slow.itemId ||
    normal.text !== slow.text ||
    normal.locale !== slow.locale
  )
    throw new Error('Normal and slow activation must share the exact source.');
  return Object.freeze({ normal: Object.freeze({ ...normal }), slow: Object.freeze({ ...slow }) });
}
function sameRequest(a: PlaybackRequest, b: PlaybackRequest): boolean {
  return (
    a.itemId === b.itemId &&
    a.text === b.text &&
    a.locale === b.locale &&
    a.assetRef === b.assetRef &&
    a.slow === b.slow &&
    !!a.assetIsSlow === !!b.assetIsSlow
  );
}
type Accessibility = Pick<LessonMediaCapabilities, 'screenReaderActive' | 'announcementInFlight'>;
export interface MicrophoneSignal {
  /** Resolves when the actual earcon finishes, rejects on a real playback failure. */
  readonly finished: Promise<void>;
  /** Idempotent native stop/release; must not depend on finished resolving. */
  stop(): Promise<void>;
}
export interface ExpoLessonMediaBindings {
  /** Active verified repository only; no URL synthesis, downloads or fallback source. */
  readonly resolveAudio: (assetRef: string) => string | null;
  /** Persist and stop Radio before lesson playback or microphone signals take audio. */
  readonly beforeLessonAudio: () => Promise<void>;
  readonly remediate: LessonMediaPort['remediate'];
  readonly accessibility: {
    /** Unknown observations throw. announcementInFlight is actual native/provider state. */
    read(): Accessibility;
    subscribe(changed: () => void): () => void;
    /** Must mark its own announcement in flight before starting native speech. No timer approximation. */
    announce(text: string): void;
  };
  /** Required accessibility signals from deep/08 §12/EC-A11Y-06. This provider is
   * independent of decorative Sound Effects. Background/disposal cancels all cues. */
  readonly microphoneSignals: { play(kind: 'start' | 'stop'): MicrophoneSignal };
}
interface OwnedSignal {
  readonly kind: 'start' | 'stop';
  readonly handle: MicrophoneSignal;
  readonly released: Promise<void>;
  resolveReleased(): void;
  rejectReleased(error: unknown): void;
  stopping: Promise<void> | null;
}
const UNKNOWN_SPEECH: SpeechCapability = Object.freeze({
  permission: 'undetermined',
  canRecognize: false,
  recognizerLocale: null,
});
async function drainAll(work: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(work);
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Lesson media cleanup failed.');
}
function validSpeech(value: SpeechCapability): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    ['granted', 'denied', 'undetermined'].includes(value.permission) &&
    typeof value.canRecognize === 'boolean' &&
    (value.recognizerLocale === null || typeof value.recognizerLocale === 'string') &&
    (!value.canRecognize || (value.permission === 'granted' && !!value.recognizerLocale?.trim()))
  );
}

/** Actual Expo bindings around the existing single media owner. Construct once,
 * then await initialize and prepare before generation/SQLite transactions. activate
 * publishes the exact visible challenge's facts; it never starts audio or the mic.
 * All externally unresolved native providers remain required constructor inputs. */
export function createExpoLessonMedia(bindings: ExpoLessonMediaBindings) {
  const mode = createLessonAudioMode(setAudioModeAsync);
  const playback = createExpoLessonPlayback(bindings.resolveAudio);
  let closed = false,
    initialized = false,
    foreground = true,
    prepared = false,
    broken = false;
  let initializing: Promise<void> | null = null,
    closing: Promise<void> | null = null;
  let preparation = 0,
    activation = 0,
    speechGeneration = 0;
  let activeRequest: PlaybackRequest | null = null;
  let allowedRequests: LessonMediaActivation | null = null;
  let activationPending = false;
  let unsubscribe: (() => void) | null = null;
  let signal: OwnedSignal | null = null,
    captureEngaged = false;
  let speechDrain: Promise<void> = Promise.resolve();
  const speechFacts = new Map<string, SpeechCapability>();
  const listeners = new Set<() => void>();
  function readAccessibility(): Accessibility | null {
    if (closed) return null;
    try {
      const value = bindings.accessibility.read();
      return typeof value.screenReaderActive === 'boolean' &&
        typeof value.announcementInFlight === 'boolean'
        ? value
        : null;
    } catch {
      return null;
    }
  }
  const speech = createExpoSpeechCapture(() => readAccessibility()?.announcementInFlight !== false);
  function notify() {
    if (!closed) for (const listener of listeners) listener();
  }
  function quarantine(error: unknown): never {
    broken = true;
    notify();
    throw error;
  }
  function releaseSignal(current: OwnedSignal): Promise<void> {
    if (current.stopping) return current.stopping;
    current.stopping = Promise.resolve()
      .then(() => current.handle.stop())
      .then(
        () => current.resolveReleased(),
        (error) => {
          current.rejectReleased(error);
          quarantine(error);
        },
      );
    // Both the signal race and its owner observe this same stop result.
    void current.stopping.catch(() => undefined);
    return current.stopping;
  }
  async function cue(kind: 'start' | 'stop'): Promise<void> {
    if (!foreground || closed) return;
    let resolveReleased!: () => void, rejectReleased!: (error: unknown) => void;
    const released = new Promise<void>((yes, no) => {
      resolveReleased = yes;
      rejectReleased = no;
    });
    const current: OwnedSignal = {
      kind,
      handle: bindings.microphoneSignals.play(kind),
      released,
      resolveReleased,
      rejectReleased,
      stopping: null,
    };
    signal = current;
    try {
      await Promise.race([current.handle.finished, released]);
    } catch (error) {
      quarantine(error);
    } finally {
      try {
        await releaseSignal(current);
      } finally {
        if (signal === current) signal = null;
      }
    }
  }
  function cancelSpeech() {
    const wasEngaged = captureEngaged;
    captureEngaged = false;
    speechGeneration++;
    speech?.cancel();
    const stoppingSignal =
      signal && (signal.kind === 'start' || !foreground || closed)
        ? releaseSignal(signal)
        : Promise.resolve();
    const previous = speechDrain;
    speechDrain = (async () => {
      await drainAll([previous, stoppingSignal, speech?.whenIdle() ?? Promise.resolve()]);
      if (wasEngaged && foreground && !closed) await cue('stop');
    })();
    void speechDrain.catch((error) => {
      broken = true;
      notify();
      return error;
    });
  }
  const owner = createLessonMediaOwner({
    playback: {
      available: (request) => !broken && playback.available(request),
      play(request, callbacks) {
        const stop = playback.play(request, callbacks);
        return async () => {
          try {
            await stop();
          } catch (error) {
            quarantine(error);
          }
        };
      },
    },
    speech:
      speech === null
        ? null
        : {
            probe: async (locale) => speechFacts.get(locale) ?? UNKNOWN_SPEECH,
            async begin(locale, callbacks: SpeechCallbacks) {
              const token = ++speechGeneration;
              await speechDrain;
              if (token !== speechGeneration || !foreground || closed) return;
              if (!canRecognize(locale)) {
                callbacks.onError('unavailable');
                return;
              }
              await cue('start');
              if (token !== speechGeneration || !foreground || closed) return;
              if (readAccessibility()?.announcementInFlight !== false) {
                callbacks.onError('interrupted');
                return;
              }
              captureEngaged = true;
              await speech.begin(locale, {
                onResult: (value) => {
                  if (token === speechGeneration) callbacks.onResult(value);
                },
                onError: (error) => {
                  if (error === 'unavailable' || error === 'permission-denied')
                    speechFacts.delete(locale);
                  if (token === speechGeneration) callbacks.onError(error);
                },
              });
            },
            cancel: cancelSpeech,
            whenIdle: () => drainAll([speechDrain, speech.whenIdle()]),
          },
    async enterLessonMode() {
      try {
        const restore = await mode.enterLessonMode();
        return async () => {
          try {
            await restore();
          } catch (error) {
            quarantine(error);
          }
        };
      } catch (error) {
        quarantine(error);
      }
    },
    beforeLessonAudio: bindings.beforeLessonAudio,
    announce: (text) => bindings.accessibility.announce(text),
    remediate: bindings.remediate,
    onCapabilitiesChanged: notify,
  });
  function synchronizeAccessibility() {
    const facts = readAccessibility();
    owner.setAccessibility(facts ?? { screenReaderActive: true, announcementInFlight: true });
  }
  function readyForActivation() {
    return initialized && foreground && prepared && !closed && !broken;
  }
  function available() {
    return readyForActivation() && !activationPending;
  }
  function canPlay(request: PlaybackRequest): boolean {
    return available() && playback.available(request);
  }
  function canRecognize(locale: string): boolean {
    return (
      available() &&
      readAccessibility()?.announcementInFlight === false &&
      speechFacts.get(locale)?.canRecognize === true
    );
  }
  function matches(itemId: string, locale: string, text?: string): boolean {
    return (
      activeRequest !== null &&
      activeRequest.itemId === itemId &&
      activeRequest.locale === locale &&
      (text === undefined || activeRequest.text === text)
    );
  }
  function matchesPlayback(request: PlaybackRequest): boolean {
    return (
      allowedRequests !== null &&
      (sameRequest(request, allowedRequests.normal) || sameRequest(request, allowedRequests.slow))
    );
  }
  const media: LessonMediaPort = {
    get capabilities() {
      const facts = readAccessibility();
      const capability = activeRequest
        ? (speechFacts.get(activeRequest.locale) ?? UNKNOWN_SPEECH)
        : UNKNOWN_SPEECH;
      return Object.freeze({
        canPlay: activeRequest !== null && canPlay(activeRequest),
        canRecognize: activeRequest !== null && canRecognize(activeRequest.locale),
        recognizerLocale: capability.recognizerLocale,
        microphonePermission: capability.permission,
        screenReaderActive: facts?.screenReaderActive ?? true,
        announcementInFlight: !foreground || facts?.announcementInFlight !== false,
      });
    },
    play(request, callbacks) {
      if (closed) return () => {};
      if (!matchesPlayback(request) || !canPlay(request)) {
        callbacks.onError('unavailable');
        return () => {};
      }
      return owner.play(request, callbacks);
    },
    recognize(request, callbacks) {
      if (closed) return () => {};
      if (!matches(request.itemId, request.locale) || !canRecognize(request.locale)) {
        callbacks.onError(
          speechFacts.get(request.locale)?.permission === 'denied'
            ? 'permission-denied'
            : 'unavailable',
        );
        return () => {};
      }
      return owner.recognize(request, callbacks);
    },
    announce(text) {
      if (initialized && foreground && !closed) owner.announce(text);
    },
    remediate(cause) {
      if (initialized && foreground && !closed) owner.remediate(cause);
    },
  };
  const resource = {
    media,
    canPlay,
    canRecognize,
    subscribe(listener: () => void): () => void {
      if (closed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    initialize(): Promise<void> {
      if (closed) return Promise.reject(new Error('Lesson media is closed.'));
      if (initializing) return initializing;
      initializing = (async () => {
        try {
          unsubscribe = bindings.accessibility.subscribe(synchronizeAccessibility);
          synchronizeAccessibility();
          await mode.initialize();
          if (closed) throw new Error('Lesson media is closed.');
          initialized = true;
          notify();
        } catch (error) {
          try {
            await resource.close();
          } catch (cleanup) {
            throw new AggregateError(
              [error, cleanup],
              'Lesson media initialization and cleanup failed.',
            );
          }
          throw error;
        }
      })();
      return initializing;
    },
    async prepare(locales: readonly string[]): Promise<void> {
      if (!initialized || closed) throw new Error('Lesson media must finish initialization.');
      if (broken) throw new Error('Lesson media is unavailable after native cleanup failure.');
      const token = ++preparation;
      foreground = true;
      prepared = false;
      speechFacts.clear();
      notify();
      await owner.stop();
      if (closed || !foreground || token !== preparation) return;
      const found = new Map<string, SpeechCapability>();
      await Promise.all([
        playback.refreshVoices(),
        ...[...new Set(locales)].map(async (locale) => {
          let value = UNKNOWN_SPEECH;
          try {
            const result = await speech?.probe(locale);
            if (result && validSpeech(result)) value = Object.freeze({ ...result });
          } catch {
            /* This locale remains unavailable; never request permission. */
          }
          found.set(locale, value);
        }),
      ]);
      if (closed || !foreground || token !== preparation) return;
      if (readAccessibility() === null) {
        synchronizeAccessibility();
        throw new Error('Native accessibility observations are unavailable.');
      }
      for (const [locale, fact] of found) speechFacts.set(locale, fact);
      prepared = true;
      synchronizeAccessibility();
      if (activeRequest) await owner.refresh(activeRequest);
      notify();
    },
    async activate(value: LessonMediaActivation | null): Promise<void> {
      // A null frame is a lifecycle disarm, including before preparation or after
      // background. It cannot make the resource foreground or prepared again.
      if (value === null && closed) return;
      if (value !== null && !readyForActivation()) throw new Error('Lesson media is not prepared.');
      const checked = value === null ? null : validateActivation(value);
      const token = ++activation;
      activationPending = true;
      allowedRequests = checked;
      activeRequest = checked?.normal ?? null;
      notify();
      try {
        await owner.stop();
        if (closed || !foreground || token !== activation) return;
        synchronizeAccessibility();
        if (checked) await owner.refresh(checked.normal);
      } catch (error) {
        quarantine(error);
      } finally {
        if (token === activation) {
          activationPending = false;
          notify();
        }
      }
    },
    async background(): Promise<void> {
      if (closed) return;
      foreground = false;
      prepared = false;
      preparation++;
      activation++;
      activationPending = false;
      activeRequest = null;
      allowedRequests = null;
      speechFacts.clear();
      notify();
      try {
        await owner.stop();
      } catch (error) {
        quarantine(error);
      }
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      foreground = false;
      prepared = false;
      preparation++;
      activation++;
      activationPending = false;
      activeRequest = null;
      allowedRequests = null;
      speechFacts.clear();
      listeners.clear();
      const errors: unknown[] = [];
      try {
        unsubscribe?.();
      } catch (error) {
        errors.push(error);
      }
      unsubscribe = null;
      closing = (async () => {
        for (const cleanup of [
          () => owner.dispose(),
          () => playback.dispose(),
          () => mode.close(),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Lesson media disposal failed.');
      })();
      return closing;
    },
  };
  return resource;
}
export type ExpoLessonMedia = ReturnType<typeof createExpoLessonMedia>;
