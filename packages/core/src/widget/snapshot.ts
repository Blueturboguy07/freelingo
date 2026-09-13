import { isLocalDay, localDayOf } from '../day/civil.js';
import { nextBoundary } from './clock.js';
import type { WidgetSnapshot } from './types.js';
import { validWidgetIdentifier } from './route.js';

/** Transport limits, Freelingo policy 2026-09-13; no native measurement claim. */
export const WIDGET_SNAPSHOT_POLICY = { maximumSnapshotCodeUnits: 8192 } as const;
export interface WidgetDrawClock {
  readonly nowMs: number;
  readonly zone: string;
}
export interface WidgetCourseRead {
  readonly courseId: string;
  readonly activeNodeId: string | null;
  /** From the validated session store; an arbitrary saved/legacy row is not resumable. */
  readonly hasResumableSession: boolean;
}
export type WidgetUnavailableReason =
  | 'unknown-history'
  | 'unavailable'
  | 'rollover-pending'
  | 'no-active-course'
  | 'invalid-source'
  | 'unreliable-clock';
/** App-side authority after its transaction commits. No zero/default history is inferred.
 * A known-empty account must be explicitly established by its account read adapter. */
export type WidgetAccountRead =
  | { readonly kind: 'unavailable'; readonly reason: WidgetUnavailableReason }
  | {
      readonly kind: 'known';
      readonly localDay: string;
      readonly streak: number;
      readonly lastCompletedLocalDay: string | null;
      readonly freezesOwned: number;
      readonly previousDayDisposition: 'completed' | 'frozen' | 'missed' | null;
      readonly streakExtendedToday: boolean;
      readonly goalMet: boolean;
      readonly earnedXp: number;
      readonly goalXp: number;
      readonly lifetimeSessions: number;
      readonly course: WidgetCourseRead;
      readonly equippedCosmeticId: string | null;
    };
export type WidgetProjection =
  | { readonly kind: 'unknown'; readonly reason: WidgetUnavailableReason }
  | { readonly kind: 'snapshot'; readonly snapshot: WidgetSnapshot };

const FIELDS = [
  'initialized',
  'local_day',
  'computed_at_utc',
  'tz_id',
  'day_boundary_utc',
  'streak',
  'last_completed_local_day',
  'freezes_owned',
  'previous_day_disposition',
  'streak_extended_today',
  'goal_met',
  'earned_xp',
  'goal_xp',
  'lifetime_sessions',
  'active_course_id',
  'active_node_id',
  'has_resumable_session',
  'equipped_cosmetic_id',
] as const;
const number = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const day = (v: unknown): v is string => typeof v === 'string' && isLocalDay(v);
const time = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** Closed wire parser. Only this tiny JSON object is exposed to a widget target. */
export function parseSharedWidgetSnapshot(raw: string | null): WidgetSnapshot | null {
  if (raw === null || raw.length > WIDGET_SNAPSHOT_POLICY.maximumSnapshotCodeUnits) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const v = parsed as Record<string, unknown>;
    if (Object.keys(v).length !== FIELDS.length || FIELDS.some((k) => !(k in v))) return null;
    if (
      v.initialized !== true ||
      !day(v.local_day) ||
      !time(v.computed_at_utc) ||
      !time(v.day_boundary_utc) ||
      typeof v.tz_id !== 'string'
    )
      return null;
    for (const key of ['streak', 'freezes_owned', 'earned_xp', 'goal_xp', 'lifetime_sessions'])
      if (!number(v[key])) return null;
    if (v.goal_xp === 0) return null;
    for (const key of ['streak_extended_today', 'goal_met', 'has_resumable_session'])
      if (typeof v[key] !== 'boolean') return null;
    if (!validWidgetIdentifier(v.active_course_id)) return null;
    for (const key of ['active_node_id', 'equipped_cosmetic_id'])
      if (v[key] !== null && !validWidgetIdentifier(v[key])) return null;
    if (
      ![null, 'completed', 'frozen', 'missed'].includes(v.previous_day_disposition as string | null)
    )
      return null;
    if (
      v.last_completed_local_day !== null &&
      (!day(v.last_completed_local_day) || v.last_completed_local_day > v.local_day)
    )
      return null;
    if (
      v.lifetime_sessions === 0 &&
      (v.streak !== 0 || v.streak_extended_today || v.last_completed_local_day !== null)
    )
      return null;
    const computed = Date.parse(v.computed_at_utc);
    if (
      localDayOf(new Date(computed), v.tz_id) !== v.local_day ||
      nextBoundary(computed, v.tz_id) !== Date.parse(v.day_boundary_utc)
    )
      return null;
    return Object.freeze(parsed) as WidgetSnapshot;
  } catch {
    return null;
  }
}

/** A projection is not a reward or rollover. Call after both have committed. */
export function projectWidgetSnapshot(
  source: WidgetAccountRead,
  clock: WidgetDrawClock,
): WidgetProjection {
  if (source.kind === 'unavailable') return { kind: 'unknown', reason: source.reason };
  try {
    if (!Number.isSafeInteger(clock.nowMs) || !Number.isFinite(new Date(clock.nowMs).getTime()))
      return { kind: 'unknown', reason: 'unreliable-clock' };
    if (source.localDay !== localDayOf(new Date(clock.nowMs), clock.zone))
      return { kind: 'unknown', reason: 'rollover-pending' };
    const snapshot: WidgetSnapshot = {
      initialized: true,
      local_day: source.localDay,
      computed_at_utc: new Date(clock.nowMs).toISOString(),
      tz_id: clock.zone,
      day_boundary_utc: new Date(nextBoundary(clock.nowMs, clock.zone)).toISOString(),
      streak: source.streak,
      last_completed_local_day: source.lastCompletedLocalDay,
      freezes_owned: source.freezesOwned,
      previous_day_disposition: source.previousDayDisposition,
      streak_extended_today: source.streakExtendedToday,
      goal_met: source.goalMet,
      earned_xp: source.earnedXp,
      goal_xp: source.goalXp,
      lifetime_sessions: source.lifetimeSessions,
      active_course_id: source.course.courseId,
      active_node_id: source.course.activeNodeId,
      has_resumable_session: source.course.hasResumableSession,
      equipped_cosmetic_id: source.equippedCosmeticId,
    };
    const checked = parseSharedWidgetSnapshot(JSON.stringify(snapshot));
    return checked
      ? { kind: 'snapshot', snapshot: checked }
      : { kind: 'unknown', reason: 'invalid-source' };
  } catch {
    return { kind: 'unknown', reason: 'invalid-source' };
  }
}
