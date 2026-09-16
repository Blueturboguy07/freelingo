import { describe, expect, it, vi } from 'vitest';
import { createLessonAudioMode, LESSON_AUDIO_MODE_CONFIG } from './lessonAudioMode';
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const IDLE = LESSON_AUDIO_MODE_CONFIG.idle,
  LESSON = LESSON_AUDIO_MODE_CONFIG.lesson;
describe('the single lesson audio-mode writer', () => {
  it('[INV-PLAT-09] establishes an explicit app baseline before any lease, then restores that baseline', async () => {
    const write = vi.fn(async () => {}),
      mode = createLessonAudioMode(write);
    await expect(mode.enterLessonMode()).rejects.toThrow(/initial/i);
    expect(write).not.toHaveBeenCalled();
    await mode.initialize();
    expect(write).toHaveBeenNthCalledWith(1, IDLE);
    const restore = await mode.enterLessonMode();
    expect(write).toHaveBeenNthCalledWith(2, LESSON);
    await restore();
    await restore();
    expect(write).toHaveBeenNthCalledWith(3, IDLE);
    expect(write).toHaveBeenCalledTimes(3);
    await mode.close();
    expect(write).toHaveBeenCalledTimes(3);
  });
  it('[INV-PLAT-09] repeated initialization shares the actual pending write', async () => {
    const wait = deferred(),
      write = vi.fn(() => wait.promise),
      mode = createLessonAudioMode(write);
    const a = mode.initialize(),
      b = mode.initialize();
    expect(a).toBe(b);
    await Promise.resolve();
    expect(write).toHaveBeenCalledOnce();
    wait.resolve();
    await a;
    await mode.initialize();
    expect(write).toHaveBeenCalledOnce();
    await mode.close();
  });
  it('[INV-PLAT-09] a concurrent caller cannot steal an owned lesson mode', async () => {
    const write = vi.fn(async () => {}),
      mode = createLessonAudioMode(write);
    await mode.initialize();
    const restore = await mode.enterLessonMode();
    await expect(mode.enterLessonMode()).rejects.toThrow(/lease|owned/i);
    expect(write).toHaveBeenCalledTimes(2);
    await restore();
    const next = await mode.enterLessonMode();
    await next();
    await mode.close();
  });
  it('[INV-PLAT-09] close during an in-flight lesson write drains then restores, never returns a usable lease', async () => {
    const wait = deferred(),
      writes: unknown[] = [],
      mode = createLessonAudioMode(async (value) => {
        writes.push(value);
        if (value === LESSON) await wait.promise;
      });
    await mode.initialize();
    const entering = mode.enterLessonMode();
    const rejected = entering.catch((e) => e);
    await Promise.resolve();
    const closing = mode.close();
    expect(writes).toEqual([IDLE, LESSON]);
    wait.resolve();
    await closing;
    expect(await rejected).toBeInstanceOf(Error);
    expect(writes).toEqual([IDLE, LESSON, IDLE]);
    await expect(mode.enterLessonMode()).rejects.toThrow(/closed/);
  });
  it('[INV-PLAT-09] a failed restore quarantines new leases and close still attempts the known idle policy', async () => {
    let fail = false;
    const write = vi.fn(async () => {
        if (fail) {
          fail = false;
          throw new Error('native restore failed');
        }
      }),
      mode = createLessonAudioMode(write);
    await mode.initialize();
    const restore = await mode.enterLessonMode();
    fail = true;
    await expect(restore()).rejects.toThrow(/native restore/);
    await expect(mode.enterLessonMode()).rejects.toThrow(/unavailable|quarantin/i);
    await mode.close();
    expect(write).toHaveBeenCalledTimes(4);
  });
  it('[INV-PLAT-09] a partially failed native enter never permits another lease', async () => {
    const mode = createLessonAudioMode(async (value) => {
      if (value === LESSON) throw new Error('partial native set');
    });
    await mode.initialize();
    await expect(mode.enterLessonMode()).rejects.toThrow(/partial native/);
    await expect(mode.enterLessonMode()).rejects.toThrow(/unavailable|quarantin/i);
    await mode.close();
  });
  it('[INV-PLAT-09] failed initial state remains unknown and cannot be used as a fabricated saved mode', async () => {
    let first = true;
    const write = vi.fn(async () => {
        if (first) {
          first = false;
          throw new Error('initial native failure');
        }
      }),
      mode = createLessonAudioMode(write);
    await expect(mode.initialize()).rejects.toThrow(/initial native/);
    await expect(mode.enterLessonMode()).rejects.toThrow();
    await mode.close();
    expect(write.mock.calls).toEqual([[IDLE], [IDLE]]);
  });
  it('[INV-PLAT-09] old lease cleanup after close is idempotent and makes no new mode writes', async () => {
    const write = vi.fn(async () => {}),
      mode = createLessonAudioMode(write);
    await mode.initialize();
    const restore = await mode.enterLessonMode();
    const closed = mode.close();
    await closed;
    await restore();
    await mode.close();
    expect(write).toHaveBeenCalledTimes(3);
  });
  it('[INV-PLAT-09] closing an unopened owner makes no native write and cannot initialize it later', async () => {
    const write = vi.fn(async () => {}),
      mode = createLessonAudioMode(write);
    await mode.close();
    await expect(mode.initialize()).rejects.toThrow(/closed/);
    expect(write).not.toHaveBeenCalled();
  });
  it('[INV-PLAT-09] idle obeys silent mode and lesson speech is explicit foreground playback with no background recording', () => {
    expect(IDLE).toEqual({
      playsInSilentMode: false,
      interruptionMode: 'mixWithOthers',
      allowsRecording: false,
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
      allowsBackgroundRecording: false,
    });
    expect(LESSON).toEqual({ ...IDLE, playsInSilentMode: true, interruptionMode: 'doNotMix' });
    expect(Object.isFrozen(IDLE)).toBe(true);
    expect(Object.isFrozen(LESSON)).toBe(true);
  });
});
