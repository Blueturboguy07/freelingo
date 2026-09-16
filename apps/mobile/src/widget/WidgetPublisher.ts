import {
  confirmWidgetReload,
  parseSharedWidgetSnapshot,
  prepareWidgetPublication,
  projectWidgetSnapshot,
  renderWidget,
  type WidgetAccountRead,
  type WidgetDrawClock,
  type WidgetPublication,
  type WidgetRender,
} from '@freelingo/core/widget';

/** App process only. The caller reads after the reward/rollover transaction commits;
 * readCommitted must not expose an in-progress Db transaction or inferred history. */
export interface WidgetAccountReadPort {
  readCommitted(clock: WidgetDrawClock): Promise<WidgetAccountRead>;
}
export interface WidgetPublicationStore {
  read(): Promise<WidgetPublication | null>;
  /** Replace the entire snapshot+budget atomically; resolve only after durable write. */
  write(value: WidgetPublication): Promise<void>;
  /** Serialize every app publisher against this shared storage, including new instances. */
  exclusive<T>(action: () => Promise<T>): Promise<T>;
}
export interface WidgetReloadPort {
  reload(): Promise<void>;
}
export type WidgetPublishResult = {
  readonly status:
    'stored' | 'reloaded' | 'reload-failed' | 'write-failed' | 'receipt-failed' | 'unavailable';
  readonly state?: WidgetRender['state'];
};

/** No SQLite dependency here: the app's real DB adapter is injected separately.
 * The target receives only readSnapshot, never this writer or the account source. */
export class WidgetPublisher {
  constructor(
    private readonly source: WidgetAccountReadPort,
    private readonly store: WidgetPublicationStore,
    private readonly platform: WidgetReloadPort,
    private readonly drawClock: () => WidgetDrawClock,
  ) {}
  publish(): Promise<WidgetPublishResult> {
    return this.store.exclusive(async () => {
      let previous: WidgetPublication | null;
      let facts: WidgetAccountRead;
      try {
        previous = await this.store.read();
      } catch {
        return { status: 'unavailable' };
      }
      try {
        facts = await this.source.readCommitted(this.drawClock());
      } catch {
        facts = { kind: 'unavailable', reason: 'unavailable' };
      }
      // The source read may cross midnight; projection obtains a fresh clock after it.
      const clock = this.drawClock();
      const projection = projectWidgetSnapshot(facts, clock);
      const snapshot = projection.kind === 'snapshot' ? projection.snapshot : null;
      const render = renderWidget(snapshot, clock.nowMs, clock.zone);
      let plan;
      try {
        plan = prepareWidgetPublication(
          previous,
          snapshot === null ? null : JSON.stringify(snapshot),
          render,
          clock,
        );
      } catch {
        return { status: 'unavailable' };
      }
      try {
        await this.store.write(plan.record);
      } catch {
        return { status: 'write-failed', state: render.state };
      }
      if (!plan.reload) return { status: 'stored', state: render.state };
      try {
        await this.platform.reload();
      } catch {
        return { status: 'reload-failed', state: render.state };
      }
      try {
        await this.store.write(confirmWidgetReload(plan.record, plan.renderKey));
      } catch {
        return { status: 'receipt-failed', state: render.state };
      }
      return { status: 'reloaded', state: render.state };
    });
  }
}
export interface WidgetSnapshotReadPort {
  readSnapshot(): Promise<string | null>;
}
/** Native provider/renderer boundary. Read a tiny shared snapshot and draw NOW,
 * not a previously baked timeline render; no database/account/session API exists. */
export async function drawStoredWidget(
  reader: WidgetSnapshotReadPort,
  drawClock: () => WidgetDrawClock,
): Promise<WidgetRender> {
  let raw: string | null;
  try {
    raw = await reader.readSnapshot();
  } catch {
    raw = null;
  }
  const clock = drawClock();
  return renderWidget(parseSharedWidgetSnapshot(raw), clock.nowMs, clock.zone);
}
