import type { Db } from '@freelingo/schema';
import { activeBoostFrom, type PersistedBoost } from '@freelingo/core/economy';
import type { ActiveBoost } from '@freelingo/core/types';
import { LearningDataError } from './SqliteSchedulerStore';
export interface BoostProjection {
  readonly active: ActiveBoost | null;
  readonly updates: readonly {
    readonly grantId: string;
    readonly highWaterUtc: string;
    readonly expiresAtUtc: string;
  }[];
}
function fail(): never {
  throw new LearningDataError('Saved boost provenance is unavailable.');
}
function date(v: unknown): string {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) return fail();
  return v;
}
function integer(v: unknown, min = 0): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) return fail();
  return v;
}
function sequence(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return fail();
  return v;
}
/** Read-only current projection. The persisted deadline is a one-way latch: even
 * after a device clock/sequence reset it can shrink, never lengthen. Mutation owners
 * persist the returned updates in their existing exclusive transaction. */
export function readLearningBoosts(
  db: Db,
  clock: { readonly utcMs: number; readonly monotonicMs: number },
): BoostProjection {
  if (
    !Number.isSafeInteger(clock.utcMs) ||
    !Number.isFinite(new Date(clock.utcMs).getTime()) ||
    !Number.isFinite(clock.monotonicMs) ||
    clock.monotonicMs < 0
  )
    return fail();
  const nowUtc = new Date(clock.utcMs).toISOString();
  let active: ActiveBoost | null = null;
  const updates: { grantId: string; highWaterUtc: string; expiresAtUtc: string }[] = [];
  for (const r of db.all('SELECT * FROM account_boost WHERE activated_at_utc IS NOT NULL')) {
    if (
      typeof r.grant_id !== 'string' ||
      !r.grant_id.trim() ||
      !['xpBoost', 'timerBoost', 'happyHour', 'earlyBird'].includes(String(r.kind))
    )
      return fail();
    const persisted: PersistedBoost = {
      kind: r.kind as PersistedBoost['kind'],
      multiplier: integer(r.multiplier, 1),
      activatedAtUtc: date(r.activated_at_utc),
      activationSequenceMs: sequence(r.activation_sequence_ms),
      durationSeconds: integer(r.duration_seconds, 1),
      tamperHighWaterUtc: date(r.tamper_high_water_utc),
    };
    const found = activeBoostFrom(persisted, { nowUtc, sequenceMs: clock.monotonicMs });
    const expiry = Math.min(
      Date.parse(date(r.expires_at)),
      found.active === null ? clock.utcMs : Date.parse(found.active.expiresAtUtc),
    );
    const running =
      found.active !== null && expiry > clock.utcMs
        ? { ...found.active, expiresAtUtc: new Date(expiry).toISOString() }
        : null;
    updates.push({
      grantId: r.grant_id,
      highWaterUtc: found.clamp.boost.tamperHighWaterUtc,
      expiresAtUtc: new Date(expiry).toISOString(),
    });
    if (running) {
      if (active) throw new LearningDataError('Multiple active boosts require recovery.');
      active = running;
    }
  }
  return { active, updates };
}
export function persistLearningBoosts(db: Db, projection: BoostProjection): void {
  for (const row of projection.updates)
    db.run('UPDATE account_boost SET tamper_high_water_utc=?,expires_at=? WHERE grant_id=?', [
      row.highWaterUtc,
      row.expiresAtUtc,
      row.grantId,
    ]);
}
