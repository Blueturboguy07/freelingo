import type { LessonMediaCapabilities, LessonMediaPort, MediaError } from '../lesson/ports';
import type { SpeechCallbacks, SpeechCapability } from './speechCapture';

type PlaybackRequest = Parameters<LessonMediaPort['play']>[0];
type PlaybackCallbacks = Parameters<LessonMediaPort['play']>[1];
export interface LessonMediaDrivers {
  playback: {
    /** Synchronous installed-file/locally available voice facts, refreshed at activation. */
    available(request: PlaybackRequest): boolean;
    play(request: PlaybackRequest, callbacks: PlaybackCallbacks): () => Promise<void>;
  };
  speech: {
    probe(locale: string): Promise<SpeechCapability>;
    begin(locale: string, callbacks: SpeechCallbacks): Promise<void>;
    cancel(): void;
    whenIdle(): Promise<void>;
  } | null;
  /** All native mode writes are serialized through this owner's lease. */
  enterLessonMode(): Promise<() => Promise<void>>;
  /** Persists and stops foreground Radio before any graded lesson takes audio. */
  beforeLessonAudio(): Promise<void>;
  announce(text: string): void;
  remediate(cause: Parameters<LessonMediaPort['remediate']>[0]): void;
  onCapabilitiesChanged?(value: LessonMediaCapabilities): void;
}
interface AudioLease {
  stop: (() => Promise<void>) | null;
  stopping: Promise<void> | null;
  onAnnouncement?: () => void;
  restore(): Promise<void>;
}
const INITIAL_CAPABILITIES: LessonMediaCapabilities = {
  canPlay: false,
  canRecognize: false,
  recognizerLocale: null,
  microphonePermission: 'undetermined',
  screenReaderActive: false,
  announcementInFlight: false,
};

/** One owner is created for the app, not per challenge/render. Native capture already
 * serializes its abort/end boundary; this adds playback, Radio and audio-mode ownership.
 * A stale callback or cancelled mode acquisition can never operate on the next item. */
export function createLessonMediaOwner(drivers: LessonMediaDrivers) {
  let capabilities = INITIAL_CAPABILITIES;
  let generation = 0,
    probeGeneration = 0;
  let lease: AudioLease | null = null;
  let tail: Promise<void> = Promise.resolve();
  let unusable = false,
    disposed = false;
  function publish(value: LessonMediaCapabilities) {
    capabilities = value;
    drivers.onCapabilitiesChanged?.(value);
  }
  function enqueue(action: () => Promise<void>): Promise<void> {
    const pending = tail.then(action);
    tail = pending.catch(() => undefined);
    return pending;
  }
  function cancelNative() {
    // Immediate invalidation also cancels a speech permission/locale probe that is
    // still awaited by the serialized start operation; it must never start later.
    drivers.speech?.cancel();
    if (lease?.stop && !lease.stopping) {
      const active = lease;
      active.stopping = Promise.resolve().then(() => active.stop!());
      // release() observes the same failure; retain it without an unhandled rejection.
      void active.stopping.catch(() => undefined);
    }
  }
  function quarantine() {
    unusable = true;
    publish({ ...capabilities, canPlay: false, canRecognize: false });
  }
  async function release() {
    const active = lease;
    lease = null;
    try {
      if (active) {
        try {
          await (active.stopping ?? active.stop?.());
        } finally {
          await active.restore();
        }
      }
      await drivers.speech?.whenIdle();
    } catch (error) {
      quarantine();
      throw error;
    }
  }
  function stopOwned(): Promise<void> {
    generation++;
    cancelNative();
    return enqueue(release);
  }
  function stop(): Promise<void> {
    return disposed ? tail : stopOwned();
  }
  function finish(token: number, callback: () => void, onError: (error: MediaError) => void) {
    if (token !== generation || disposed) return;
    const ending = ++generation;
    cancelNative();
    void enqueue(async () => {
      await release();
      if (ending === generation && !disposed) callback();
    }).catch(() => {
      if (ending === generation && !disposed) onError('unavailable');
    });
  }
  function start(
    begin: (token: number, active: AudioLease) => Promise<void>,
    onError: (error: MediaError) => void,
  ): () => void {
    if (disposed) return () => {};
    const token = ++generation;
    cancelNative();
    void enqueue(async () => {
      await release();
      if (token !== generation || disposed) return;
      if (unusable) {
        onError('unavailable');
        return;
      }
      await drivers.beforeLessonAudio();
      if (token !== generation || disposed) return;
      const restore = await drivers.enterLessonMode();
      if (token !== generation || disposed) {
        try {
          await restore();
        } catch (error) {
          quarantine();
          throw error;
        }
        return;
      }
      const active: AudioLease = { restore, stop: null, stopping: null };
      lease = active;
      await begin(token, active);
    }).catch(() => {
      if (token === generation) finish(token, () => onError('unavailable'), onError);
    });
    return () => {
      if (token === generation) void stop().catch(() => undefined);
    };
  }
  const owner = {
    get capabilities() {
      return capabilities;
    },
    async refresh(request: PlaybackRequest): Promise<LessonMediaCapabilities> {
      if (disposed) return capabilities;
      const probe = ++probeGeneration;
      let speech: SpeechCapability = {
        permission: 'undetermined',
        canRecognize: false,
        recognizerLocale: null,
      };
      try {
        if (drivers.speech) speech = await drivers.speech.probe(request.locale);
      } catch {
        /* The unknown capability remains unavailable. */
      }
      if (probe === probeGeneration && !disposed)
        publish({
          ...capabilities,
          canPlay: !unusable && drivers.playback.available(request),
          canRecognize: !unusable && speech.canRecognize,
          recognizerLocale: speech.recognizerLocale,
          microphonePermission: speech.permission,
        });
      return capabilities;
    },
    play(request: PlaybackRequest, callbacks: PlaybackCallbacks): () => void {
      return start(async (token, active) => {
        if (!drivers.playback.available(request)) {
          finish(token, () => callbacks.onError('unavailable'), callbacks.onError);
          return;
        }
        active.stop = drivers.playback.play(request, {
          onComplete: () => finish(token, callbacks.onComplete, callbacks.onError),
          onInterrupted: () => finish(token, callbacks.onInterrupted, callbacks.onError),
          onError: (error) => finish(token, () => callbacks.onError(error), callbacks.onError),
        });
      }, callbacks.onError);
    },
    recognize(
      request: Parameters<LessonMediaPort['recognize']>[0],
      callbacks: SpeechCallbacks,
    ): () => void {
      return start(async (token, active) => {
        if (!drivers.speech || capabilities.announcementInFlight) {
          finish(token, () => callbacks.onError('unavailable'), callbacks.onError);
          return;
        }
        active.onAnnouncement = () =>
          finish(token, () => callbacks.onError('interrupted'), callbacks.onError);
        active.stop = async () => {
          drivers.speech!.cancel();
          await drivers.speech!.whenIdle();
        };
        await drivers.speech.begin(request.locale, {
          onResult: (result) => finish(token, () => callbacks.onResult(result), callbacks.onError),
          onError: (error) => finish(token, () => callbacks.onError(error), callbacks.onError),
        });
      }, callbacks.onError);
    },
    setAccessibility(
      value: Pick<LessonMediaCapabilities, 'screenReaderActive' | 'announcementInFlight'>,
    ) {
      if (disposed) return;
      publish({ ...capabilities, ...value });
      if (value.announcementInFlight) {
        drivers.speech?.cancel();
        lease?.onAnnouncement?.();
      }
    },
    announce(text: string) {
      if (!disposed) drivers.announce(text);
    },
    remediate(cause: Parameters<LessonMediaPort['remediate']>[0]) {
      if (!disposed) drivers.remediate(cause);
    },
    stop,
    async dispose() {
      if (disposed) return tail;
      disposed = true;
      probeGeneration++;
      await stopOwned();
    },
  } satisfies LessonMediaPort & {
    refresh(request: PlaybackRequest): Promise<LessonMediaCapabilities>;
    setAccessibility(
      value: Pick<LessonMediaCapabilities, 'screenReaderActive' | 'announcementInFlight'>,
    ): void;
    stop(): Promise<void>;
    dispose(): Promise<void>;
  };
  return owner;
}
