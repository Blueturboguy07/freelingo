import { describe, expect, it, vi } from 'vitest';
import { createLessonMediaOwner, type LessonMediaDrivers } from './lessonMedia';

const request = { itemId: 'item-1', text: 'Hola', locale: 'es-ES', slow: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const calls: string[] = [];
  let playbackCallbacks: Parameters<LessonMediaDrivers['playback']['play']>[1] | null = null;
  const drivers: LessonMediaDrivers = {
    playback: {
      available: () => true,
      play: (_request, callbacks) => {
        calls.push('play');
        playbackCallbacks = callbacks;
        return async () => {
          calls.push('stop-play');
        };
      },
    },
    speech: {
      probe: async () => ({ permission: 'granted', canRecognize: true, recognizerLocale: 'es-ES' }),
      begin: async () => {
        calls.push('recognize');
      },
      cancel: () => {
        calls.push('cancel-speech');
      },
      whenIdle: async () => {},
    },
    enterLessonMode: async () => {
      calls.push('lesson-mode');
      return async () => {
        calls.push('restore-mode');
      };
    },
    beforeLessonAudio: async () => {
      calls.push('stop-radio');
    },
    announce: vi.fn(),
    remediate: vi.fn(),
  };
  const owner = createLessonMediaOwner(drivers);
  return { calls, drivers, owner, playbackCallbacks: () => playbackCallbacks! };
}
const callbacks = () => ({ onComplete: vi.fn(), onInterrupted: vi.fn(), onError: vi.fn() });
const settled = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('the lesson owns one audio surface at a time', () => {
  it('[INV-PLAT-05] recognition waits for playback release and restoration before taking the mode', async () => {
    const { owner, calls } = setup();
    owner.play(request, callbacks());
    await settled();
    owner.recognize(request, { onResult: vi.fn(), onError: vi.fn() });
    await settled();
    expect(calls.filter((c) => c !== 'cancel-speech')).toEqual([
      'stop-radio',
      'lesson-mode',
      'play',
      'stop-play',
      'restore-mode',
      'stop-radio',
      'lesson-mode',
      'recognize',
    ]);
    await owner.stop();
    expect(calls.at(-1)).toBe('restore-mode');
  });
  it('[INV-AUD-04] leaving during mode acquisition prevents late playback and restores exactly once', async () => {
    const { owner, drivers, calls } = setup(),
      gate = deferred<() => Promise<void>>();
    const restore = vi.fn(async () => {});
    drivers.enterLessonMode = () => gate.promise;
    owner.play(request, callbacks());
    await settled();
    const stopping = owner.stop();
    gate.resolve(restore);
    await stopping;
    expect(calls).not.toContain('play');
    expect(restore).toHaveBeenCalledTimes(1);
  });
  it('[INV-PLAT-05] a superseded completion cannot cancel the next item or report it complete', async () => {
    const { owner, playbackCallbacks, calls } = setup(),
      first = callbacks(),
      second = callbacks();
    owner.play(request, first);
    await settled();
    const stale = playbackCallbacks();
    owner.play({ ...request, itemId: 'item-2' }, second);
    await settled();
    const before = [...calls];
    stale.onComplete();
    await settled();
    expect(calls).toEqual(before);
    expect(first.onComplete).not.toHaveBeenCalled();
    playbackCallbacks().onComplete();
    await settled();
    expect(second.onComplete).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)).toBe('restore-mode');
  });
  it('[INV-AUD-02] missing local audio is a visible unavailable result and cannot start a player', async () => {
    const { owner, drivers, calls } = setup(),
      events = callbacks();
    drivers.playback.available = () => false;
    owner.play(request, events);
    await settled();
    expect(calls).not.toContain('play');
    expect(events.onError).toHaveBeenCalledWith('unavailable');
  });
  it('[INV-A11Y-06] an announcement beginning during an awaited handoff prevents microphone start', async () => {
    const { owner, drivers, calls } = setup(),
      gate = deferred<void>(),
      error = vi.fn();
    drivers.beforeLessonAudio = () => gate.promise;
    owner.recognize(request, { onResult: vi.fn(), onError: error });
    await settled();
    owner.setAccessibility({ screenReaderActive: true, announcementInFlight: true });
    gate.resolve();
    await settled();
    expect(calls).not.toContain('recognize');
    expect(error).toHaveBeenCalledWith('unavailable');
  });
  it('[INV-MOD-04] a stale capability probe cannot overwrite the active course locale', async () => {
    const { owner, drivers } = setup(),
      old = deferred<{ permission: 'granted'; canRecognize: boolean; recognizerLocale: string }>();
    drivers.speech!.probe = (locale) =>
      locale === 'es-ES'
        ? old.promise
        : Promise.resolve({
            permission: 'denied',
            canRecognize: false,
            recognizerLocale: null,
          });
    const previous = owner.refresh(request);
    await owner.refresh({ ...request, locale: 'fr-FR' });
    old.resolve({ permission: 'granted', canRecognize: true, recognizerLocale: 'es-ES' });
    await previous;
    expect(owner.capabilities.microphonePermission).toBe('denied');
    expect(owner.capabilities.recognizerLocale).toBeNull();
  });
  it('[INV-PLAT-05] cleanup failure reports unavailable and prevents another audio start', async () => {
    const { owner, drivers, playbackCallbacks, calls } = setup(),
      events = callbacks();
    const original = drivers.playback.play;
    drivers.playback.play = (request, callbacks) => {
      original(request, callbacks);
      return async () => {
        throw new Error('native stop failed');
      };
    };
    owner.play(request, events);
    await settled();
    playbackCallbacks().onComplete();
    await settled();
    expect(events.onComplete).not.toHaveBeenCalled();
    expect(events.onError).toHaveBeenCalledWith('unavailable');
    const next = callbacks();
    owner.play(request, next);
    await settled();
    expect(calls.filter((c) => c === 'play')).toHaveLength(1);
    expect(next.onError).toHaveBeenCalledWith('unavailable');
  });

  it('[INV-A11Y-12] a new announcement stops an active microphone and reports interruption', async () => {
    const { owner, calls } = setup(),
      error = vi.fn();
    owner.recognize(request, { onResult: vi.fn(), onError: error });
    await settled();
    expect(calls).toContain('recognize');
    owner.setAccessibility({ screenReaderActive: true, announcementInFlight: true });
    await settled();
    expect(error).toHaveBeenCalledWith('interrupted');
    expect(calls.at(-1)).toBe('restore-mode');
  });
});

const reviewRequest = { itemId: 'one', text: 'hola', locale: 'es', slow: false };
const reviewCallbacks = () => ({ onComplete: vi.fn(), onInterrupted: vi.fn(), onError: vi.fn() });
async function reviewSettled() {
  for (let n = 0; n < 40; n++) await Promise.resolve();
}
function reviewSetup() {
  const drivers: LessonMediaDrivers = {
    playback: { available: () => true, play: vi.fn(() => async () => {}) },
    speech: {
      probe: async () => ({ permission: 'granted', canRecognize: true, recognizerLocale: 'es' }),
      begin: vi.fn(async () => {}),
      cancel: vi.fn(),
      whenIdle: async () => {},
    },
    enterLessonMode: async () => async () => {},
    beforeLessonAudio: async () => {},
    announce: vi.fn(),
    remediate: vi.fn(),
  };
  return { drivers, owner: createLessonMediaOwner(drivers) };
}
it('[INV-PLAT-05] a canceled acquisition whose restore rejects must quarantine the owner before the next playback', async () => {
  const { drivers, owner } = reviewSetup();
  await owner.refresh(reviewRequest);
  let ready!: (restore: () => Promise<void>) => void;
  const acquisition = new Promise<() => Promise<void>>((resolve) => {
    ready = resolve;
  });
  drivers.enterLessonMode = vi
    .fn()
    .mockReturnValueOnce(acquisition)
    .mockResolvedValue(async () => {});
  owner.play(reviewRequest, reviewCallbacks());
  await reviewSettled();
  const stop = owner.stop();
  ready(async () => {
    throw new Error('restore failed after cancel');
  });
  await stop;
  const next = reviewCallbacks();
  owner.play({ ...reviewRequest, itemId: 'two' }, next);
  await reviewSettled();
  expect(drivers.playback.play).not.toHaveBeenCalled();
  expect(next.onError).toHaveBeenCalledWith('unavailable');
  expect(owner.capabilities.canPlay).toBe(false);
  await owner.dispose();
});
it('[INV-PLAT-05] control: successful canceled restoration permits a later playback', async () => {
  const { drivers, owner } = reviewSetup();
  let ready!: (restore: () => Promise<void>) => void;
  const acquisition = new Promise<() => Promise<void>>((resolve) => {
    ready = resolve;
  });
  drivers.enterLessonMode = vi
    .fn()
    .mockReturnValueOnce(acquisition)
    .mockResolvedValue(async () => {});
  owner.play(reviewRequest, reviewCallbacks());
  await reviewSettled();
  const stop = owner.stop();
  ready(async () => {});
  await stop;
  owner.play({ ...reviewRequest, itemId: 'two' }, reviewCallbacks());
  await reviewSettled();
  expect(drivers.playback.play).toHaveBeenCalledTimes(1);
  await owner.dispose();
});
it('[INV-AUD-04] calls through a disposed owner cannot cancel native work belonging to a later owner', async () => {
  const { drivers, owner } = reviewSetup();
  await owner.dispose();
  const next = createLessonMediaOwner(drivers);
  next.recognize(reviewRequest, { onResult: vi.fn(), onError: vi.fn() });
  await reviewSettled();
  const cancels = vi.mocked(drivers.speech!.cancel).mock.calls.length;
  owner.play(reviewRequest, reviewCallbacks());
  await reviewSettled();
  expect(drivers.speech!.cancel).toHaveBeenCalledTimes(cancels);
  await next.dispose();
});
