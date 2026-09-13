// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createSpeechCapture, type SpeechDriver } from './speechCapture';
function rig(over: Partial<SpeechDriver> = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const saved = { category: 'playback', categoryOptions: [], mode: 'default' };
  const driver = {
    getMicrophonePermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    getSpeechRecognizerPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    getSupportedLocales: vi.fn(async () => ({ locales: ['es-ES'], installedLocales: ['es-ES'] })),
    supportsOnDeviceRecognition: () => true,
    isRecognitionAvailable: () => true,
    getAudioSessionCategoryAndOptionsIOS: () => saved,
    setCategoryIOS: vi.fn(),
    addListener: vi.fn((name: string, fn: (event: unknown) => void) => {
      listeners.set(name, fn);
      return { remove: () => listeners.delete(name) };
    }),
    start: vi.fn(),
    abort: vi.fn(() => listeners.get('end')?.(null)),
    ...over,
  } as unknown as SpeechDriver;
  const callbacks = { onResult: vi.fn(), onError: vi.fn() };
  const capture = createSpeechCapture(driver, {
    platform: 'ios',
    announcementInFlight: () => false,
  });
  return {
    driver,
    capture,
    callbacks,
    saved,
    emit: (name: string, e: unknown) => listeners.get(name)?.(e),
  };
}
it('[INV-A11Y-05] gates microphone and speech grants together without prompting', async () => {
  const r = rig({ getSpeechRecognizerPermissionsAsync: async () => ({ status: 'denied' }) });
  expect((await r.capture.probe('es-ES')).canRecognize).toBe(false);
  await r.capture.begin('es-ES', r.callbacks);
  expect(r.driver.start).not.toHaveBeenCalled();
  expect(r.callbacks.onError).toHaveBeenCalledWith('permission-denied');
});
it('[INV-PLAT-04] unavailable locale or absent installed model remains skippable', async () => {
  const r = rig({
    getSupportedLocales: async () => ({ locales: ['es-ES'], installedLocales: [] }),
  });
  await r.capture.begin('es-ES', r.callbacks);
  expect(r.driver.start).not.toHaveBeenCalled();
  expect(r.callbacks.onError).toHaveBeenCalledWith('unavailable');
});
it('[INV-A11Y-12] never starts during an announcement', async () => {
  const r = rig();
  const capture = createSpeechCapture(r.driver, {
    platform: 'ios',
    announcementInFlight: () => true,
  });
  await capture.begin('es-ES', r.callbacks);
  expect(r.driver.start).not.toHaveBeenCalled();
});
it('[INV-PLAT-04][INV-PER-09] Android uses local continuous capture, no persistent recording, and aborts on its first final result', async () => {
  const r = rig();
  const capture = createSpeechCapture(r.driver, {
    platform: 'android',
    announcementInFlight: () => false,
  });
  await capture.begin('es-ES', r.callbacks);
  expect(r.driver.start).toHaveBeenCalledWith(
    expect.objectContaining({
      lang: 'es-ES',
      requiresOnDeviceRecognition: true,
      continuous: true,
      recordingOptions: { persist: false },
    }),
  );
  r.emit('volumechange', { value: 5 });
  r.emit('result', { isFinal: true, results: [{ transcript: 'Hola' }] });
  await capture.whenIdle();
  expect(r.callbacks.onResult).toHaveBeenCalledWith({ transcript: 'Hola', amplitude: 0.5 });
  expect(r.driver.abort).toHaveBeenCalledOnce();
  r.emit('result', { isFinal: true, results: [{ transcript: 'Otra' }] });
  expect(r.callbacks.onResult).toHaveBeenCalledOnce();
});
it('[INV-PLAT-09] interruption restores the pre-mic category and reports no graded result', async () => {
  const r = rig();
  await r.capture.begin('es-ES', r.callbacks);
  r.emit('error', { error: 'interrupted' });
  r.emit('end', null);
  await r.capture.whenIdle();
  await r.capture.whenIdle();
  expect(r.driver.setCategoryIOS).toHaveBeenCalledWith(r.saved);
  expect(r.callbacks.onError).toHaveBeenCalledWith('interrupted');
  expect(r.callbacks.onResult).not.toHaveBeenCalled();
});
it('[INV-MOD-09] silent and empty captures report no-audio input rather than a recognition failure', async () => {
  const r = rig();
  await r.capture.begin('es-ES', r.callbacks);
  r.emit('error', { error: 'no-speech' });
  r.emit('end', null);
  await r.capture.whenIdle();
  expect(r.callbacks.onResult).toHaveBeenCalledWith({ transcript: '', amplitude: 0 });
  expect(r.callbacks.onError).not.toHaveBeenCalled();
});
it('[INV-A11Y-12][INV-PER-09] cancellation during capability lookup never opens the microphone', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const r = rig({
    getSupportedLocales: async () => {
      await pending;
      return { locales: ['es-ES'], installedLocales: ['es-ES'] };
    },
  });
  const result = r.capture.begin('es-ES', r.callbacks);
  r.capture.cancel();
  release();
  await result;
  expect(r.driver.start).not.toHaveBeenCalled();
  expect(r.callbacks.onResult).not.toHaveBeenCalled();
  expect(r.callbacks.onError).not.toHaveBeenCalled();
});
it('[INV-PLAT-09] a synchronous native start failure restores the old mode', async () => {
  const r = rig({
    start: () => {
      throw new Error('device unavailable');
    },
  });
  await r.capture.begin('es-ES', r.callbacks);
  await r.capture.whenIdle();
  expect(r.driver.setCategoryIOS).toHaveBeenCalledWith(r.saved);
  expect(r.callbacks.onError).toHaveBeenCalledWith('unavailable');
});

it('[INV-PLAT-09] waits for asynchronous native stop before a second microphone start', async () => {
  const r = rig({ abort: vi.fn() });
  await r.capture.begin('es-ES', r.callbacks);
  r.capture.cancel();
  const next = r.capture.begin('es-ES', r.callbacks);
  await new Promise((resolve) => setImmediate(resolve));
  expect(r.driver.start).toHaveBeenCalledTimes(1);
  r.emit('end', null);
  await next;
  expect(r.driver.start).toHaveBeenCalledTimes(2);
  r.capture.cancel();
  r.emit('end', null);
});
it('[INV-MOD-12] locale lookup failure never changes a granted permission into mic-denied', async () => {
  const r = rig({
    getSupportedLocales: async () => {
      throw new Error('no locale service');
    },
  });
  await r.capture.begin('es-ES', r.callbacks);
  expect(r.callbacks.onError).toHaveBeenCalledWith('unavailable');
});

it('[INV-PLAT-09] native interruption already schedules shutdown and must not enqueue a second abort', async () => {
  const r = rig({ abort: vi.fn() });
  await r.capture.begin('es-ES', r.callbacks);
  r.emit('error', { error: 'interrupted' });
  expect(r.driver.abort).not.toHaveBeenCalled();
  expect(r.callbacks.onError).not.toHaveBeenCalled();
  r.emit('end', null);
  await r.capture.whenIdle();
  expect(r.callbacks.onError).toHaveBeenCalledWith('interrupted');
});

it('[INV-MOD-10] native audio-capture failure is a transient route error, distinct from interruption', async () => {
  const r = rig();
  await r.capture.begin('es-ES', r.callbacks);
  r.emit('error', { error: 'audio-capture' });
  r.emit('end', null);
  await r.capture.whenIdle();
  expect(r.callbacks.onError).toHaveBeenCalledWith('route');
  expect(r.callbacks.onResult).not.toHaveBeenCalled();
});
