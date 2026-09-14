import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LessonMediaPort } from '../lesson/ports';
import type { SpeechCallbacks, SpeechCapability } from './speechCapture';
const native = vi.hoisted(() => ({
  mode: vi.fn(async (_mode: unknown) => {}),
  voices: vi.fn(async () => {}),
  available: vi.fn((_request: unknown) => true),
  play: vi.fn(),
  playbackStop: vi.fn(async () => {}),
  playbackDispose: vi.fn(async () => {}),
  probe: vi.fn(async (_locale: string): Promise<SpeechCapability> => ({
    permission: 'granted',
    recognizerLocale: 'es-ES',
    canRecognize: true,
  })),
  begin: vi.fn(async (_locale: string, _callbacks: SpeechCallbacks) => {}),
  cancel: vi.fn(),
  idle: vi.fn(async () => {}),
  playbackFactory: vi.fn(),
  speechFactory: vi.fn(),
}));
vi.mock('expo-audio', () => ({ setAudioModeAsync: native.mode }));
vi.mock('./expoLessonPlayback', () => ({ createExpoLessonPlayback: native.playbackFactory }));
vi.mock('./expoSpeech', () => ({ createExpoSpeechCapture: native.speechFactory }));
import { createExpoLessonMedia, type LessonPlaybackRequest } from './expoLessonMedia';

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const request = {
  itemId: 'item-a',
  assetRef: 'verified-a',
  text: 'Hola',
  locale: 'es-ES',
  slow: false,
};
function activation(normal: LessonPlaybackRequest) {
  return { normal, slow: { ...normal, assetRef: 'verified-slow', slow: true, assetIsSlow: true } };
}
const callbacks = () => ({ onComplete: vi.fn(), onInterrupted: vi.fn(), onError: vi.fn() });
const speechCallbacks = () => ({ onResult: vi.fn(), onError: vi.fn() });
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function fixture() {
  let facts = { screenReaderActive: false, announcementInFlight: false };
  let changed = () => {};
  const unsubscribe = vi.fn();
  const cueStops: ReturnType<typeof vi.fn>[] = [];
  const bindings = {
    resolveAudio: vi.fn((_ref: string): string | null => 'file:///verified/clip.ogg'),
    beforeLessonAudio: vi.fn(async () => {}),
    remediate: vi.fn(),
    accessibility: {
      read: vi.fn(() => facts),
      subscribe: vi.fn((listener: () => void) => {
        changed = listener;
        return unsubscribe;
      }),
      announce: vi.fn(),
    },
    microphoneSignals: {
      play: vi.fn((_kind: 'start' | 'stop') => {
        const stop = vi.fn(async () => {});
        cueStops.push(stop);
        return { finished: Promise.resolve(), stop };
      }),
    },
  };
  const resource = createExpoLessonMedia(bindings);
  return {
    resource,
    bindings,
    cueStops,
    unsubscribe,
    change(next: typeof facts) {
      facts = next;
      changed();
    },
    async ready() {
      await resource.initialize();
      await resource.prepare(['es-ES']);
      await resource.activate(activation(request));
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  native.mode.mockImplementation(async () => {});
  native.voices.mockImplementation(async () => {});
  native.available.mockReturnValue(true);
  native.playbackDispose.mockImplementation(async () => {});
  native.probe.mockImplementation(async (locale) => ({
    permission: 'granted',
    recognizerLocale: locale,
    canRecognize: true,
  }));
  native.begin.mockImplementation(async () => {});
  native.play.mockImplementation(() => native.playbackStop);
  native.playbackFactory.mockImplementation(() => ({
    available: native.available,
    play: native.play,
    refreshVoices: native.voices,
    dispose: native.playbackDispose,
  }));
  native.speechFactory.mockImplementation(() => ({
    probe: native.probe,
    begin: native.begin,
    cancel: native.cancel,
    whenIdle: native.idle,
  }));
});
describe('actual Expo lesson media composition', () => {
  it('[INV-AUD-06][INV-PLAT-09] initializes an explicit native mode and probes locales without playing or asking for permission', async () => {
    const f = fixture();
    expect(f.resource.media.capabilities.canPlay).toBe(false);
    await f.ready();
    expect(native.playbackFactory).toHaveBeenCalledWith(f.bindings.resolveAudio);
    expect(native.speechFactory).toHaveBeenCalledWith(expect.any(Function));
    expect(native.mode).toHaveBeenCalledTimes(1);
    expect(native.voices).toHaveBeenCalledOnce();
    expect(native.probe).toHaveBeenCalledExactlyOnceWith('es-ES');
    expect(native.play).not.toHaveBeenCalled();
    expect(native.begin).not.toHaveBeenCalled();
    expect(f.bindings.microphoneSignals.play).not.toHaveBeenCalled();
    expect(f.resource.canRecognize('es-ES')).toBe(true);
    expect(f.resource.canRecognize('fr-FR')).toBe(false);
    await f.resource.close();
  });
  it('[INV-AUD-01][INV-AUD-06] source-specific activation uses prepared facts and passes the exact slow asset through the real owner', async () => {
    const f = fixture();
    await f.ready();
    const done = callbacks(),
      slow = { ...request, assetRef: 'verified-slow', slow: true, assetIsSlow: true };
    f.resource.media.play(slow, done);
    await flush();
    expect(f.bindings.beforeLessonAudio).toHaveBeenCalledOnce();
    expect(native.play.mock.calls[0]?.[0]).toEqual(slow);
    expect(native.probe).toHaveBeenCalledOnce();
    (native.play.mock.calls[0]?.[1] as Parameters<LessonMediaPort['play']>[1]).onComplete();
    await flush();
    expect(done.onComplete).toHaveBeenCalledOnce();
    expect(native.playbackStop).toHaveBeenCalledOnce();
    await f.resource.close();
  });
  it('[INV-SND-02][INV-PLAT-09] mic cues bracket actual capture and remain required without an effects-setting provider', async () => {
    const f = fixture();
    await f.ready();
    const done = speechCallbacks();
    f.resource.media.recognize({ itemId: request.itemId, locale: request.locale }, done);
    await flush();
    expect(f.bindings.microphoneSignals.play.mock.calls.map((call) => call[0])).toEqual(['start']);
    expect(native.begin).toHaveBeenCalledOnce();
    native.begin.mock.calls[0]![1].onResult({ transcript: 'Hola', amplitude: 0.8 });
    await flush();
    expect(f.bindings.microphoneSignals.play.mock.calls.map((call) => call[0])).toEqual([
      'start',
      'stop',
    ]);
    expect(done.onResult).toHaveBeenCalledExactlyOnceWith({ transcript: 'Hola', amplitude: 0.8 });
    expect(f.cueStops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    await f.resource.close();
  });
  it('[INV-PLAT-09] background during a pending start earcon cancels it and never starts the microphone later', async () => {
    const f = fixture();
    await f.ready();
    const gate = deferred(),
      stop = vi.fn(async () => {});
    f.bindings.microphoneSignals.play.mockReturnValueOnce({ finished: gate.promise, stop });
    const done = speechCallbacks();
    f.resource.media.recognize({ itemId: request.itemId, locale: request.locale }, done);
    await flush();
    await f.resource.background();
    gate.resolve();
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(native.begin).not.toHaveBeenCalled();
    expect(done.onResult).not.toHaveBeenCalled();
    expect(done.onError).not.toHaveBeenCalled();
    expect(f.resource.canPlay(request)).toBe(false);
    expect(f.resource.canRecognize('es-ES')).toBe(false);
    await f.resource.close();
  });
  it('[INV-AUD-01][INV-SESS-21] changing the active source stops its media and refuses a delayed old-item request', async () => {
    const f = fixture();
    await f.ready();
    const old = callbacks();
    f.resource.media.play(request, old);
    await flush();
    await f.resource.activate(activation({ ...request, itemId: 'item-b', text: 'Adiós' }));
    const delayed = callbacks();
    f.resource.media.play(request, delayed);
    await flush();
    expect(native.play).toHaveBeenCalledOnce();
    expect(native.playbackStop).toHaveBeenCalledOnce();
    expect(delayed.onError).toHaveBeenCalledExactlyOnceWith('unavailable');
    (native.play.mock.calls[0]![1] as Parameters<LessonMediaPort['play']>[1]).onComplete();
    await flush();
    expect(old.onComplete).not.toHaveBeenCalled();
    await f.resource.close();
  });
  it('[INV-AUD-06] a backgrounded old probe cannot re-enable capability after it resolves', async () => {
    const f = fixture();
    await f.resource.initialize();
    const wait = deferred();
    native.probe.mockImplementationOnce(async () => {
      await wait.promise;
      return { permission: 'granted', recognizerLocale: 'es-ES', canRecognize: true };
    });
    const preparing = f.resource.prepare(['es-ES']);
    await flush();
    await f.resource.background();
    wait.resolve();
    await preparing;
    expect(f.resource.canRecognize('es-ES')).toBe(false);
    expect(f.resource.canPlay(request)).toBe(false);
    await f.resource.close();
  });
  it('[INV-A11Y-12][INV-PLAT-09] announcement state interrupts capture and is checked live before every new start', async () => {
    const f = fixture();
    await f.ready();
    const done = speechCallbacks();
    f.resource.media.recognize({ itemId: request.itemId, locale: request.locale }, done);
    await flush();
    f.change({ screenReaderActive: true, announcementInFlight: true });
    await flush();
    await vi.waitFor(() => expect(done.onError).toHaveBeenCalledExactlyOnceWith('interrupted'));
    const blocked = speechCallbacks();
    f.resource.media.recognize({ itemId: request.itemId, locale: request.locale }, blocked);
    await flush();
    expect(native.begin).toHaveBeenCalledOnce();
    expect(blocked.onError).toHaveBeenCalledExactlyOnceWith('unavailable');
    await f.resource.close();
  });
  it('[INV-AUD-06] failed and invalid native capability probes cannot manufacture readiness', async () => {
    const f = fixture();
    await f.resource.initialize();
    native.probe.mockRejectedValueOnce(Error('native unavailable'));
    await f.resource.prepare(['es-ES']);
    await f.resource.activate(activation(request));
    expect(f.resource.canRecognize('es-ES')).toBe(false);
    f.change({ screenReaderActive: undefined as unknown as boolean, announcementInFlight: false });
    expect(f.resource.media.capabilities.canRecognize).toBe(false);
    expect(f.resource.media.capabilities.announcementInFlight).toBe(true);
    await f.resource.close();
  });
  it('[INV-PLAT-09] close tries all resource cleanup after a subscription or playback failure', async () => {
    const f = fixture();
    await f.ready();
    f.unsubscribe.mockImplementation(() => {
      throw Error('subscription');
    });
    native.playbackDispose.mockRejectedValueOnce(Error('playback release'));
    await expect(f.resource.close()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'subscription' }),
        expect.objectContaining({ message: 'playback release' }),
      ],
    });
    expect(native.playbackDispose).toHaveBeenCalledOnce();
    expect(native.cancel).toHaveBeenCalled();
    expect(f.resource.canPlay(request)).toBe(false);
    const done = callbacks();
    f.resource.media.play(request, done);
    f.resource.media.announce('late');
    f.resource.media.remediate('mic-denied');
    expect(done.onError).not.toHaveBeenCalled();
    expect(f.bindings.accessibility.announce).not.toHaveBeenCalled();
    expect(f.bindings.remediate).not.toHaveBeenCalled();
  });
  it('[INV-PLAT-09] close during initialization drains the actual mode write without leaving an initialized resource', async () => {
    const f = fixture(),
      wait = deferred();
    native.mode.mockImplementationOnce(() => wait.promise);
    const initializing = f.resource.initialize();
    const observed = initializing.catch((error) => error);
    await flush();
    const closing = f.resource.close();
    wait.resolve();
    await closing;
    expect(await observed).toBeInstanceOf(Error);
    expect(f.resource.canPlay(request)).toBe(false);
  });
});

it('[INV-PLAT-09] stale accessibility callbacks and capability reads after close never query disposed providers', async () => {
  const f = fixture();
  await f.ready();
  await f.resource.close();
  f.bindings.accessibility.read.mockClear();
  f.change({ screenReaderActive: false, announcementInFlight: false });
  expect(f.resource.media.capabilities.canRecognize).toBe(false);
  expect(f.resource.media.capabilities.canPlay).toBe(false);
  expect(f.bindings.accessibility.read).not.toHaveBeenCalled();
});

it('[INV-AUD-01][INV-PLAT-09] keeps new controls unavailable until active-source cleanup has actually finished', async () => {
  const f = fixture();
  await f.ready();
  f.resource.media.play(request, callbacks());
  await flush();
  const wait = deferred();
  native.playbackStop.mockImplementationOnce(() => wait.promise);
  const next = { ...request, itemId: 'item-b', text: 'Adiós' };
  const activating = f.resource.activate(activation(next));
  await flush();
  expect(f.resource.media.capabilities.canPlay).toBe(false);
  expect(f.resource.canPlay(next)).toBe(false);
  expect(f.resource.canRecognize(next.locale)).toBe(false);
  const premature = callbacks();
  f.resource.media.play(next, premature);
  await flush();
  expect(premature.onError).toHaveBeenCalledExactlyOnceWith('unavailable');
  expect(native.play).toHaveBeenCalledOnce();
  wait.resolve();
  await activating;
  expect(f.resource.media.capabilities.canPlay).toBe(true);
  f.resource.media.play(next, callbacks());
  await flush();
  expect(native.play).toHaveBeenCalledTimes(2);
  await f.resource.close();
});

it('[INV-AUD-01][INV-SESS-21] rejects another verified asset even when item text and locale match', async () => {
  const f = fixture();
  await f.ready();
  const done = callbacks();
  f.resource.media.play({ ...request, assetRef: 'another-verified-pack-clip' }, done);
  await flush();
  expect(done.onError).toHaveBeenCalledExactlyOnceWith('unavailable');
  expect(native.play).not.toHaveBeenCalled();
  await f.resource.close();
});

it.each(['itemId', 'text', 'locale'] as const)(
  '[INV-AUD-01] rejects mismatched normal/slow activation %s independently',
  async (field) => {
    const f = fixture();
    await f.ready();
    const slow = { ...request, slow: true, [field]: 'different-source' };
    await expect(f.resource.activate({ normal: request, slow })).rejects.toThrow(
      /activation|source|normal|slow/i,
    );
    expect(f.resource.media.capabilities.canPlay).toBe(true);
    await f.resource.close();
  },
);

it('[INV-AUD-01] accepts only the declared same-asset slow-rate request as well as its normal request', async () => {
  const f = fixture();
  await f.ready();
  const slow = { ...request, slow: true, assetIsSlow: false };
  await f.resource.activate({ normal: request, slow });
  const done = callbacks();
  f.resource.media.play(slow, done);
  await flush();
  expect(native.play.mock.calls[0]?.[0]).toEqual(slow);
  const wrongFlag = callbacks();
  f.resource.media.play({ ...slow, assetIsSlow: true }, wrongFlag);
  await flush();
  expect(wrongFlag.onError).toHaveBeenCalledExactlyOnceWith('unavailable');
  expect(native.play).toHaveBeenCalledOnce();
  await f.resource.close();
});

it('[INV-PLAT-09] null activation is safe cleanup after background and before preparation without rearming media', async () => {
  const f = fixture();
  await f.resource.activate(null);
  expect(f.resource.canPlay(request)).toBe(false);
  await f.ready();
  await f.resource.background();
  const probes = native.probe.mock.calls.length;
  await f.resource.activate(null);
  expect(f.resource.canPlay(request)).toBe(false);
  expect(f.resource.canRecognize(request.locale)).toBe(false);
  expect(native.probe).toHaveBeenCalledTimes(probes);
  await expect(f.resource.activate(activation(request))).rejects.toThrow(/prepared/i);
  await f.resource.close();
  await f.resource.activate(null);
});
