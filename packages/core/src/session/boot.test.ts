import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { BOOT_STEPS, mayPublishSnapshot, runForegroundBoot } from './boot.js';
import type { BootPort } from './ports.js';

/**
 * A port that records the exact interleaving. Each step resolves on a later microtask, so
 * a `Promise.all` or four fire-and-forgets would produce `start start start start` before
 * any `end` — which is precisely the shape EC-SES-32 forbids.
 */
class RecordingBootPort implements BootPort {
  readonly log: string[] = [];
  #streak = 'pre-rollover';
  /** What the widget would serve if it published right now. */
  publishedSnapshots: string[] = [];
  armedNudges: string[] = [];

  async #run(name: string): Promise<void> {
    this.log.push(`${name}:start`);
    await Promise.resolve();
    await Promise.resolve();
    this.log.push(`${name}:end`);
  }

  async rolloverTo(): Promise<void> {
    await this.#run('rollover');
    this.#streak = 'post-rollover';
  }

  async recomputeFsrs(): Promise<void> {
    await this.#run('fsrsRecompute');
  }

  async publishSnapshotAndReload(): Promise<void> {
    await this.#run('snapshotAndReload');
    this.publishedSnapshots.push(this.#streak);
  }

  async rearmNotifications(): Promise<void> {
    await this.#run('notificationRearm');
    this.armedNudges.push(this.#streak);
  }
}

describe('the foreground boot sequence', () => {
  it('[INV-SESS-27] the boot sequence runs as one awaited chain — rollover → FSRS recompute → snapshot+reload → notification re-arm', async () => {
    const port = new RecordingBootPort();
    const result = await runForegroundBoot(port);
    expect(result.completed).toEqual([...BOOT_STEPS]);
    expect(result.failedAt).toBeNull();
    // Strictly serialised: every step ends before the next begins.
    expect(port.log).toEqual([
      'rollover:start',
      'rollover:end',
      'fsrsRecompute:start',
      'fsrsRecompute:end',
      'snapshotAndReload:start',
      'snapshotAndReload:end',
      'notificationRearm:start',
      'notificationRearm:end',
    ]);
  });

  it('[INV-SESS-27] falsifier: no intermediate snapshot and no armed nudge carries pre-rollover state', async () => {
    const port = new RecordingBootPort();
    await runForegroundBoot(port);
    expect(port.publishedSnapshots).toEqual(['post-rollover']);
    expect(port.armedNudges).toEqual(['post-rollover']);
    // Exactly one publish: an intermediate one would show up as a second entry.
    expect(port.publishedSnapshots).toHaveLength(1);
  });

  it('[INV-SESS-27] a failure stops the chain rather than publishing over half-rolled state', async () => {
    for (const failing of BOOT_STEPS) {
      const port = new RecordingBootPort();
      const wrapped: BootPort = {
        rolloverTo: () =>
          failing === 'rollover' ? Promise.reject(new Error('x')) : port.rolloverTo(),
        recomputeFsrs: () =>
          failing === 'fsrsRecompute' ? Promise.reject(new Error('x')) : port.recomputeFsrs(),
        publishSnapshotAndReload: () =>
          failing === 'snapshotAndReload'
            ? Promise.reject(new Error('x'))
            : port.publishSnapshotAndReload(),
        rearmNotifications: () =>
          failing === 'notificationRearm'
            ? Promise.reject(new Error('x'))
            : port.rearmNotifications(),
      };
      const result = await runForegroundBoot(wrapped);
      expect(result.failedAt).toBe(failing);
      expect(result.completed).toEqual(BOOT_STEPS.slice(0, BOOT_STEPS.indexOf(failing)));
      if (BOOT_STEPS.indexOf(failing) <= BOOT_STEPS.indexOf('snapshotAndReload')) {
        expect(port.publishedSnapshots).toEqual([]);
      }
    }
  });

  it('[INV-SESS-27] the widget serves its last committed snapshot until rollover and the recompute are done', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: BOOT_STEPS.length }), (done) => {
        const completed = BOOT_STEPS.slice(0, done);
        expect(mayPublishSnapshot(completed)).toBe(done >= 2);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
