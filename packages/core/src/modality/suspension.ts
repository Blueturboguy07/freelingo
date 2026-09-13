import { SUSPENSION_MS } from './config.js';

export type ModalityFamily = 'listening' | 'speaking';

/** Supplied by a native boot-stable clock. Process-relative performance.now()
 * cannot meet the kill/relaunch contract. UTC is recorded, never used for age. */
export interface ModalityClock {
  readonly utcMs: number;
  readonly monotonicMs: number;
  readonly bootId: string;
}

export interface FamilySuspension {
  readonly bootId: string;
  readonly startedUtcMs: number;
  readonly expiresUtcMs: number;
  readonly startedMonotonicMs: number;
  readonly deadlineMonotonicMs: number;
}

/** One account JSON value; neither field belongs to an individual course. */
export interface ModalitySuspensions {
  readonly version: 1;
  readonly listening: FamilySuspension | null;
  readonly speaking: FamilySuspension | null;
}

function empty(): ModalitySuspensions {
  return { version: 1, listening: null, speaking: null };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function finiteClock(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
  );
}

function bootId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validClock(clock: ModalityClock): boolean {
  return (
    finiteClock(clock.utcMs) &&
    finiteClock(clock.monotonicMs) &&
    finiteClock(clock.utcMs + SUSPENSION_MS) &&
    finiteClock(clock.monotonicMs + SUSPENSION_MS) &&
    clock.monotonicMs >= 0 &&
    bootId(clock.bootId)
  );
}

function family(value: unknown): value is FamilySuspension | null {
  if (value === null) return true;
  if (
    !object(value) ||
    !exactKeys(value, [
      'bootId',
      'startedUtcMs',
      'expiresUtcMs',
      'startedMonotonicMs',
      'deadlineMonotonicMs',
    ])
  )
    return false;
  return (
    bootId(value['bootId']) &&
    finiteClock(value['startedUtcMs']) &&
    finiteClock(value['expiresUtcMs']) &&
    finiteClock(value['startedMonotonicMs']) &&
    value['startedMonotonicMs'] >= 0 &&
    finiteClock(value['deadlineMonotonicMs']) &&
    value['expiresUtcMs'] === value['startedUtcMs'] + SUSPENSION_MS &&
    value['deadlineMonotonicMs'] === value['startedMonotonicMs'] + SUSPENSION_MS
  );
}

/** Legacy UTC-only or corrupt values abstain. Reading this result must not
 * rewrite the database: the caller owns any explicit persistence transaction. */
export function parseModalitySuspensions(raw: string | null): ModalitySuspensions | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !object(value) ||
      !exactKeys(value, ['version', 'listening', 'speaking']) ||
      value['version'] !== 1 ||
      !family(value['listening']) ||
      !family(value['speaking'])
    )
      return null;
    return { version: 1, listening: value['listening'], speaking: value['speaking'] };
  } catch {
    return null;
  }
}

export function remainingSuspensionMs(
  record: ModalitySuspensions | null,
  selectedFamily: ModalityFamily,
  clock: ModalityClock,
): number {
  const entry = record?.[selectedFamily];
  if (
    !entry ||
    !validClock(clock) ||
    entry.bootId !== clock.bootId ||
    clock.monotonicMs < entry.startedMonotonicMs
  )
    return 0;
  return Math.max(0, entry.deadlineMonotonicMs - clock.monotonicMs);
}

/** Reboot/reset fails open, even when the new boot's uptime exceeds the old one. */
export function pruneExpiredSuspensions(
  record: ModalitySuspensions | null,
  clock: ModalityClock,
): ModalitySuspensions {
  return {
    version: 1,
    listening: remainingSuspensionMs(record, 'listening', clock) > 0 ? record!.listening : null,
    speaking: remainingSuspensionMs(record, 'speaking', clock) > 0 ? record!.speaking : null,
  };
}

export function suspendModality(
  record: ModalitySuspensions | null,
  selectedFamily: ModalityFamily,
  clock: ModalityClock,
): ModalitySuspensions {
  const current = pruneExpiredSuspensions(record, clock);
  if (!validClock(clock)) return current;
  return {
    ...current,
    [selectedFamily]: {
      bootId: clock.bootId,
      startedUtcMs: clock.utcMs,
      expiresUtcMs: clock.utcMs + SUSPENSION_MS,
      startedMonotonicMs: clock.monotonicMs,
      deadlineMonotonicMs: clock.monotonicMs + SUSPENSION_MS,
    },
  };
}

/** Used only by an explicit ON action. OFF does not create a snooze. */
export function clearModalitySuspension(
  record: ModalitySuspensions | null,
  selectedFamily: ModalityFamily,
): ModalitySuspensions {
  return { ...(record ?? empty()), [selectedFamily]: null };
}
