/**
 * The foreground boot sequence — INV-SESS-27.
 *
 * "rollover → FSRS recompute → snapshot+reload → notification re-arm", as ONE AWAITED
 * CHAIN, publishing no intermediate snapshot. EC-SES-32's failure is a post-gap fixture
 * observing a widget snapshot or an armed nudge carrying pre-rollover streak state, which
 * is what happens when four independent `useEffect`s race on first foreground.
 *
 * So the order is data (`BOOT_STEPS`), the chain awaits each step before starting the
 * next, and `observedOrder` records what actually ran — the property compares the record
 * to the declaration rather than trusting the `await`s to have been written correctly.
 */
import type { BootPort } from './ports.js';

export const BOOT_STEPS = [
  'rollover',
  'fsrsRecompute',
  'snapshotAndReload',
  'notificationRearm',
] as const;
export type BootStep = (typeof BOOT_STEPS)[number];

export interface BootResult {
  readonly completed: readonly BootStep[];
  /** The step that threw, if any. Everything after it did not run. */
  readonly failedAt: BootStep | null;
}

/**
 * Run the chain. Not `Promise.all`, not four fire-and-forgets: each step is awaited before
 * the next begins, and a throw stops the chain rather than letting the snapshot publish
 * over half-rolled-over state.
 */
export async function runForegroundBoot(port: BootPort): Promise<BootResult> {
  const completed: BootStep[] = [];
  const run: Readonly<Record<BootStep, () => Promise<void>>> = {
    rollover: () => port.rolloverTo(),
    fsrsRecompute: () => port.recomputeFsrs(),
    snapshotAndReload: () => port.publishSnapshotAndReload(),
    notificationRearm: () => port.rearmNotifications(),
  };
  for (const stepName of BOOT_STEPS) {
    try {
      await run[stepName]();
    } catch {
      return { completed, failedAt: stepName };
    }
    completed.push(stepName);
  }
  return { completed, failedAt: null };
}

/**
 * Until the chain completes the widget serves its LAST COMMITTED snapshot, never a
 * partially updated one. A publish is legal only once rollover and the recompute are done.
 */
export function mayPublishSnapshot(completed: readonly BootStep[]): boolean {
  return completed.includes('rollover') && completed.includes('fsrsRecompute');
}
