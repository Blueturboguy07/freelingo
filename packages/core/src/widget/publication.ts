import { localDayOf } from '../day/civil.js';
import { planWidgetReload } from './index.js';
import { WIDGET_POLICY } from './config.js';
import type { WidgetDrawClock } from './snapshot.js';
import type { WidgetRender } from './types.js';

/** Conservative rolling-day accounting, adopted 2026-09-13. This also bounds reloads
 * across local midnight/timezone changes; platform exemptions are not assumed. */
export const WIDGET_PUBLICATION_POLICY = { reloadWindowMs: 24 * 60 * 60_000 } as const;
export interface WidgetPublication {
  readonly schemaVersion: 1;
  readonly snapshotJson: string | null;
  /** An attempted native call spends budget even if its completion is uncertain. */
  readonly attemptsMs: readonly number[];
  readonly lastRenderedKey: string | null;
  readonly pendingKey: string | null;
}
function check(previous: WidgetPublication): void {
  if (
    Object.keys(previous).sort().join(',') !==
      'attemptsMs,lastRenderedKey,pendingKey,schemaVersion,snapshotJson' ||
    previous.schemaVersion !== 1 ||
    (previous.snapshotJson !== null && typeof previous.snapshotJson !== 'string') ||
    !Array.isArray(previous.attemptsMs) ||
    previous.attemptsMs.length > WIDGET_POLICY.maximumReloadsPerDay ||
    previous.attemptsMs.some(
      (t, i) => !Number.isSafeInteger(t) || (i > 0 && t < previous.attemptsMs[i - 1]!),
    ) ||
    [previous.lastRenderedKey, previous.pendingKey].some((k) => k !== null && typeof k !== 'string')
  )
    throw new Error('Invalid persisted widget reload budget');
}
/** Remaining minutes and computation timestamps are deliberately excluded: the
 * native target recomputes them at draw; neither is a rendered-state transition. */
export function widgetRenderKey(render: WidgetRender): string {
  return JSON.stringify([
    render.state,
    render.copy,
    render.streak,
    render.flame,
    render.goalMet,
    render.deepLink,
    render.cosmeticId,
  ]);
}
export function prepareWidgetPublication(
  previous: WidgetPublication | null,
  snapshotJson: string | null,
  render: WidgetRender,
  clock: WidgetDrawClock,
): { readonly record: WidgetPublication; readonly reload: boolean; readonly renderKey: string } {
  if (!Number.isSafeInteger(clock.nowMs)) throw new Error('Invalid widget clock');
  if (previous !== null) check(previous);
  const attempts = (previous?.attemptsMs ?? []).filter(
    (t) => t > clock.nowMs - WIDGET_PUBLICATION_POLICY.reloadWindowMs,
  );
  const localDay = localDayOf(new Date(clock.nowMs), clock.zone);
  const renderKey = widgetRenderKey(render);
  const plan = planWidgetReload(
    {
      localDay,
      lastReloadAtMs: attempts.at(-1) ?? null,
      reloadCount: attempts.length,
      lastRenderedKey: previous?.lastRenderedKey ?? null,
      pendingKey: previous?.pendingKey ?? null,
    },
    renderKey,
    clock.nowMs,
    localDay,
  );
  return {
    reload: plan.reload,
    renderKey,
    record: Object.freeze({
      schemaVersion: 1,
      snapshotJson,
      attemptsMs: Object.freeze(plan.reload ? [...attempts, clock.nowMs] : attempts),
      // A durable reservation is not a successful platform delivery.
      lastRenderedKey: previous?.lastRenderedKey ?? null,
      pendingKey: renderKey === previous?.lastRenderedKey ? null : renderKey,
    }),
  };
}
export function confirmWidgetReload(
  record: WidgetPublication,
  deliveredKey: string,
): WidgetPublication {
  check(record);
  if (record.pendingKey !== deliveredKey || record.attemptsMs.length === 0)
    throw new Error('Widget reload receipt does not match its reserved state');
  return Object.freeze({ ...record, lastRenderedKey: deliveredKey, pendingKey: null });
}
