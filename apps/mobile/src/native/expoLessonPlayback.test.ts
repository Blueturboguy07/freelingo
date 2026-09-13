// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({
  freelingoLocalSpeechRevision: 1,
  getVoices: vi.fn(),
  speak: vi.fn(),
  stop: vi.fn(),
  addListener: vi.fn(),
}));
const audio = vi.hoisted(() => ({ createAudioPlayer: vi.fn() }));
vi.mock('expo', () => ({ requireNativeModule: () => native }));
vi.mock('expo-audio', () => audio);
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
import { createExpoLessonPlayback, LESSON_PLAYBACK_CONFIG } from './expoLessonPlayback';
const request = { itemId: 'one', text: 'Hola', locale: 'es', slow: false };
const callbacks = () => ({ onComplete: vi.fn(), onInterrupted: vi.fn(), onError: vi.fn() });
let events: Map<string, (event: { id: string }) => void>;
let status: (event: Record<string, unknown>) => void;
let player: {
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  setPlaybackRate: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
  shouldCorrectPitch: boolean;
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  events = new Map();
  native.freelingoLocalSpeechRevision = 1;
  native.getVoices.mockResolvedValue([
    { identifier: 'es-local', language: 'es-ES', name: 'Español', quality: 'Default' },
  ]);
  native.speak.mockResolvedValue(undefined);
  native.stop.mockResolvedValue(undefined);
  native.addListener.mockImplementation((name, callback) => {
    events.set(name, callback);
    return { remove: () => events.delete(name) };
  });
  player = {
    play: vi.fn(),
    pause: vi.fn(),
    remove: vi.fn(),
    setPlaybackRate: vi.fn(),
    addListener: vi.fn((_name, callback) => {
      status = callback;
      return { remove: vi.fn() };
    }),
    shouldCorrectPitch: false,
  };
  audio.createAudioPlayer.mockReturnValue(player);
});
afterEach(() => vi.useRealTimers());
it('[INV-AUD-01] availability is known before serving and never invents a voice', async () => {
  const driver = createExpoLessonPlayback(() => null);
  expect(driver.available(request)).toBe(false);
  await driver.refreshVoices();
  expect(driver.available(request)).toBe(true);
  expect(driver.available({ ...request, locale: 'fr' })).toBe(false);
  expect(driver.available({ ...request, locale: 'es-MX' })).toBe(false);
});
it('[INV-AUD-01] an unpatched binary cannot expose TTS fallback', async () => {
  native.freelingoLocalSpeechRevision = 0;
  const driver = createExpoLessonPlayback(() => null);
  await driver.refreshVoices();
  expect(driver.available(request)).toBe(false);
  expect(native.getVoices).not.toHaveBeenCalled();
  const cb = callbacks();
  await driver.play(request, cb)();
  expect(native.speak).not.toHaveBeenCalled();
  expect(cb.onError).toHaveBeenCalledWith('unavailable');
});
it('[INV-AUD-01] verified local file wins over TTS and slow playback preserves pitch', async () => {
  const driver = createExpoLessonPlayback(() => 'file:///verified/audio.opus');
  const cb = callbacks();
  const stop = driver.play({ ...request, assetRef: 'clip', slow: true }, cb);
  expect(audio.createAudioPlayer).toHaveBeenCalledWith(
    { uri: 'file:///verified/audio.opus' },
    expect.objectContaining({ downloadFirst: false }),
  );
  expect(player.setPlaybackRate).toHaveBeenCalledWith(0.75, 'high');
  expect(player.shouldCorrectPitch).toBe(true);
  expect(native.speak).not.toHaveBeenCalled();
  status({ didJustFinish: true });
  status({ didJustFinish: true });
  expect(cb.onComplete).toHaveBeenCalledTimes(1);
  await stop();
  await stop();
  expect(player.remove).toHaveBeenCalledTimes(1);
});
it('[INV-AUD-02] remote asset URLs never reach the audio player', () => {
  const driver = createExpoLessonPlayback(() => 'https://unexpected.example/audio.opus');
  const cb = callbacks();
  driver.play({ ...request, assetRef: 'clip' }, cb);
  expect(audio.createAudioPlayer).not.toHaveBeenCalled();
  expect(cb.onError).toHaveBeenCalledWith('unavailable');
});
it('[INV-AUD-01] fallback sends the exact installed voice and surfaces native promise rejection', async () => {
  const driver = createExpoLessonPlayback(() => null);
  await driver.refreshVoices();
  const cb = callbacks();
  native.speak.mockRejectedValue(Error('voice removed'));
  const stop = driver.play({ ...request, slow: true }, cb);
  await flush();
  expect(native.speak).toHaveBeenCalledWith(
    expect.any(String),
    'Hola',
    expect.objectContaining({
      voice: 'es-local',
      language: 'es-ES',
      rate: 0.75,
      useApplicationAudioSession: true,
    }),
  );
  expect(cb.onError).toHaveBeenCalledWith('unavailable');
  await stop();
});
it('[INV-AUD-04] stale TTS events and cancelled completion never count as hearing', async () => {
  const driver = createExpoLessonPlayback(() => null);
  await driver.refreshVoices();
  const cb = callbacks();
  const stop = driver.play(request, cb);
  const done = events.get('Exponent.speakingDone')!;
  const id = native.speak.mock.calls[0]![0];
  done({ id: 'another' });
  expect(cb.onComplete).not.toHaveBeenCalled();
  await stop();
  done({ id });
  expect(cb.onComplete).not.toHaveBeenCalled();
  expect(native.stop).toHaveBeenCalledTimes(1);
});
it('[INV-AUD-04] route interruption is distinct from successful completion', async () => {
  const driver = createExpoLessonPlayback(() => 'file:///verified/audio.opus');
  const cb = callbacks();
  const stop = driver.play({ ...request, assetRef: 'clip' }, cb);
  status({ playing: true });
  status({ playing: false, isBuffering: false, didJustFinish: false });
  expect(cb.onInterrupted).toHaveBeenCalledTimes(1);
  expect(cb.onComplete).not.toHaveBeenCalled();
  await stop();
});
it('[INV-AUD-02] player errors and stalled playback are observable', async () => {
  const driver = createExpoLessonPlayback(() => 'file:///verified/audio.opus');
  const cb = callbacks();
  const stop = driver.play({ ...request, assetRef: 'clip' }, cb);
  status({ error: 'decode failed' });
  expect(cb.onError).toHaveBeenCalledWith('unavailable');
  await stop();
  const next = callbacks();
  const stopNext = driver.play({ ...request, assetRef: 'clip' }, next);
  vi.advanceTimersByTime(LESSON_PLAYBACK_CONFIG.completionTimeoutMs);
  expect(next.onError).toHaveBeenCalledWith('unavailable');
  await stopNext();
});
it('[INV-PLAT-09] release failure remains observable to the serialized media owner', async () => {
  const driver = createExpoLessonPlayback(() => null);
  await driver.refreshVoices();
  const stop = driver.play(request, callbacks());
  native.stop.mockRejectedValue(Error('stop failed'));
  await expect(stop()).rejects.toThrow('stop failed');
  await expect(stop()).rejects.toThrow('stop failed');
});
it('[INV-MOD-04] late voice probe cannot overwrite a newer native capability snapshot', async () => {
  let resolve!: (v: unknown) => void;
  native.getVoices.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const driver = createExpoLessonPlayback(() => null);
  const first = driver.refreshVoices();
  native.getVoices.mockResolvedValueOnce([]);
  await driver.refreshVoices();
  resolve([{ identifier: 'old', language: 'es', quality: 'Default' }]);
  await first;
  expect(driver.available(request)).toBe(false);
});

it('[INV-AUD-01] separately baked slow audio is never slowed a second time and missing slow assets still use slow TTS', async () => {
  const resolve = vi.fn(() => 'file:///verified/slow.opus' as string | null);
  const driver = createExpoLessonPlayback(resolve);
  await driver.refreshVoices();
  const stop = driver.play(
    { ...request, assetRef: 'slow', slow: true, assetIsSlow: true },
    callbacks(),
  );
  expect(player.setPlaybackRate).toHaveBeenCalledWith(1, 'high');
  await stop();
  resolve.mockReturnValue(null);
  const second = driver.play(
    { ...request, assetRef: 'slow', slow: true, assetIsSlow: true },
    callbacks(),
  );
  expect(native.speak).toHaveBeenCalledWith(
    expect.any(String),
    'Hola',
    expect.objectContaining({ rate: 0.75 }),
  );
  await second();
});
