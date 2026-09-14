import type { WidgetPublicationNative } from '../widget/nativeWidgetPorts';
/** E2E transport fixture only, 2026-09-14. No learner/account values are fabricated.
 * The simulator harness saves the prior file (including absence) before seeding this. */
export const WIDGET_PROBE_BASELINE_JSON = JSON.stringify({
  schemaVersion: 1,
  snapshotJson: null,
  attemptsMs: [],
  lastRenderedKey: null,
  pendingKey: null,
});
export interface WidgetProbeResult {
  readonly status: 'bridge-passed';
  readonly priorRestored: true;
  readonly reloadRequested: true;
}
/** Explicit diagnostic only. Refuses an absent baseline so the native API never has
 * to pretend a null-filled record restores an absent file. The external E2E harness
 * owns exact file-presence restoration. A reload request is not an OS draw receipt. */
export async function runWidgetPublicationProbe(
  native: WidgetPublicationNative,
  nowMs: number,
): Promise<WidgetProbeResult> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('Invalid diagnostic time');
  const token = await native.acquire();
  let prior: string | null = null;
  let attemptedWrite = false;
  const failures: unknown[] = [];
  try {
    prior = await native.read(token);
    if (prior === null)
      throw new Error(
        'Widget diagnostic baseline unavailable; prepare the reversible simulator fixture first.',
      );
    const fixture = JSON.stringify({
      schemaVersion: 1,
      snapshotJson: null,
      attemptsMs: [nowMs],
      lastRenderedKey: null,
      pendingKey: 'e2e-widget-bridge-probe',
    });
    attemptedWrite = true;
    await native.write(token, fixture);
    if ((await native.read(token)) !== fixture) throw new Error('Widget native readback mismatch');
    await native.reload(token);
  } catch (error) {
    failures.push(error);
  } finally {
    if (attemptedWrite && prior !== null) {
      try {
        await native.write(token, prior);
        if ((await native.read(token)) !== prior)
          failures.push(new Error('Widget prior publication was not restored'));
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await native.release(token);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Widget diagnostic and cleanup failed');
  return { status: 'bridge-passed', priorRestored: true, reloadRequested: true };
}
