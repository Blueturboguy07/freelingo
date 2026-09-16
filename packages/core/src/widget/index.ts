import { isLocalDay, localDayOf } from '../day/civil.js';
import { WIDGET_POLICY } from './config.js';
import { localHour, localHourBoundary, nextBoundary } from './clock.js';
import type { ReloadBudget, WidgetRender, WidgetSnapshot, WidgetTimelineEntry } from './types.js';
export * from './config.js';
export * from './types.js';

function validSnapshot(input: unknown): input is WidgetSnapshot {
  if (input === null || typeof input !== 'object') return false;
  const value = input as Record<string, unknown>;
  if (
    value['initialized'] !== true ||
    typeof value['local_day'] !== 'string' ||
    !isLocalDay(value['local_day'])
  )
    return false;
  for (const field of ['streak', 'freezes_owned', 'earned_xp', 'goal_xp', 'lifetime_sessions']) {
    const n = value[field];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return false;
  }
  if (value['goal_xp'] === 0) return false;
  for (const field of ['computed_at_utc', 'day_boundary_utc']) {
    if (typeof value[field] !== 'string' || !Number.isFinite(Date.parse(value[field])))
      return false;
  }
  if (
    typeof value['tz_id'] !== 'string' ||
    value['tz_id'].length === 0 ||
    typeof value['active_course_id'] !== 'string' ||
    value['active_course_id'].length === 0
  )
    return false;
  for (const field of ['streak_extended_today', 'goal_met', 'has_resumable_session']) {
    if (typeof value[field] !== 'boolean') return false;
  }
  for (const field of ['active_node_id', 'equipped_cosmetic_id']) {
    if (value[field] !== null && typeof value[field] !== 'string') return false;
  }
  if (
    ![null, 'completed', 'frozen', 'missed'].includes(
      value['previous_day_disposition'] as string | null,
    )
  )
    return false;
  const last = value['last_completed_local_day'];
  return (
    last === null || (typeof last === 'string' && isLocalDay(last) && last <= value['local_day'])
  );
}

/** Pure routing only. No dependency on live state and no session mutations. */
export function widgetDeepLink(snapshot: WidgetSnapshot): string {
  const course = encodeURIComponent(snapshot.active_course_id);
  if (snapshot.has_resumable_session) return `freelingo://resume?course=${course}`;
  if (snapshot.goal_met) return `freelingo://practice?course=${course}`;
  const node =
    snapshot.active_node_id === null ? '' : `&node=${encodeURIComponent(snapshot.active_node_id)}`;
  return `freelingo://path?course=${course}${node}`;
}

const UNKNOWN: WidgetRender = {
  state: 'UNKNOWN',
  copy: 'Open Freelingo',
  streak: null,
  flame: 'none',
  goalMet: false,
  remainingMinutes: null,
  deepLink: 'freelingo://open',
  cosmeticId: null,
};

/** Safe total parser + renderer. Device time/zone are supplied at DRAW, not bake. */
export function renderWidget(input: unknown, nowMs: number, deviceZone: string): WidgetRender {
  if (!validSnapshot(input) || !Number.isFinite(nowMs)) return UNKNOWN;
  const snapshot = input;
  let hour: number;
  let remainingMinutes: number;
  try {
    if (
      snapshot.local_day !== localDayOf(new Date(nowMs), deviceZone) ||
      Date.parse(snapshot.computed_at_utc) > nowMs
    )
      return UNKNOWN;
    hour = localHour(nowMs, deviceZone);
    remainingMinutes = Math.ceil((nextBoundary(nowMs, deviceZone) - nowMs) / 60_000);
  } catch {
    return UNKNOWN;
  }
  const common = {
    streak: snapshot.streak,
    goalMet: snapshot.goal_met,
    remainingMinutes,
    deepLink: widgetDeepLink(snapshot),
    cosmeticId: snapshot.equipped_cosmetic_id,
  };
  if (snapshot.lifetime_sessions === 0)
    return { ...common, state: 'COLD', copy: 'Tap to start', streak: null, flame: 'none' };
  if (snapshot.streak_extended_today) {
    if (snapshot.goal_met)
      return { ...common, state: 'DONE', flame: 'lit', copy: `${snapshot.streak} day streak!` };
    return {
      ...common,
      state: 'STREAK_SAFE_GOAL_UNMET',
      flame: 'lit',
      copy: `Streak safe — ${Math.max(0, snapshot.goal_xp - snapshot.earned_xp)} XP to your goal`,
    };
  }
  if (snapshot.streak === 0)
    return { ...common, state: 'LOST', flame: 'unlit', copy: 'Revive your streak!' };
  // Current coverage and yesterday's consumed freeze are different facts (EC-WID10).
  if (snapshot.freezes_owned > 0)
    return { ...common, state: 'FROZEN', flame: 'frozen', copy: 'Your Streak Freeze is ready' };
  if (snapshot.previous_day_disposition === 'frozen' && hour < WIDGET_POLICY.afternoonHour)
    return {
      ...common,
      state: 'FROZEN',
      flame: 'frozen',
      copy: 'A Streak Freeze protected yesterday. Practice today!',
    };
  if (remainingMinutes <= WIDGET_POLICY.nudgeMinutes) {
    const limit =
      [...WIDGET_POLICY.ladderMinutes].reverse().find((minutes) => remainingMinutes <= minutes) ??
      WIDGET_POLICY.nudgeMinutes;
    const time =
      limit >= 60 ? `${limit / 60} ${limit === 60 ? 'hour' : 'hours'}` : `${limit} minutes`;
    const danger = remainingMinutes <= WIDGET_POLICY.dangerMinutes;
    return {
      ...common,
      state: danger ? 'DANGER' : 'NUDGE',
      flame: 'unlit',
      copy: danger
        ? `Less than ${time} until your ${snapshot.streak} day streak is lost!`
        : `Less than ${time} to extend your ${snapshot.streak} day streak!`,
    };
  }
  if (hour < WIDGET_POLICY.afternoonHour)
    return {
      ...common,
      state: 'IDLE_MORNING',
      flame: 'unlit',
      copy: 'Practice every day to build your streak.',
    };
  return {
    ...common,
    state: hour < WIDGET_POLICY.eveningHour ? 'IDLE_AFTERNOON' : 'IDLE_EVENING',
    flame: 'unlit',
    copy: "Practice each day so your streak won't reset!",
  };
}

export function widgetTimeline(
  snapshot: unknown,
  nowMs: number,
  deviceZone: string,
): readonly WidgetTimelineEntry[] {
  const first = { atMs: nowMs, render: renderWidget(snapshot, nowMs, deviceZone) };
  if (first.render.state === 'UNKNOWN') return [first];
  const boundary = nextBoundary(nowMs, deviceZone);
  const day = localDayOf(new Date(nowMs), deviceZone);
  const times = new Set([
    nowMs,
    boundary,
    localHourBoundary(day, WIDGET_POLICY.afternoonHour, deviceZone),
    localHourBoundary(day, WIDGET_POLICY.eveningHour, deviceZone),
    ...WIDGET_POLICY.ladderMinutes.map((minutes) => boundary - minutes * 60_000),
  ]);
  return [...times]
    .filter((time) => time >= nowMs)
    .sort((a, b) => a - b)
    .map((atMs) => ({ atMs, render: renderWidget(snapshot, atMs, deviceZone) }));
}

/** A blocked state transition is retained; a later tick can deliver the pending
 * latest state. Returning to the last rendered state cancels a stale pending reload.
 */
export function planWidgetReload(
  previous: ReloadBudget,
  renderKey: string,
  nowMs: number,
  localDay: string,
): {
  readonly reload: boolean;
  readonly budget: ReloadBudget;
} {
  const current =
    previous.localDay === localDay ? previous : { ...previous, localDay, reloadCount: 0 };
  if (renderKey === current.lastRenderedKey)
    return { reload: false, budget: { ...current, pendingKey: null } };
  const ready =
    Number.isFinite(nowMs) &&
    (current.lastReloadAtMs === null ||
      nowMs - current.lastReloadAtMs >= WIDGET_POLICY.minimumReloadIntervalMs);
  if (!ready || current.reloadCount >= WIDGET_POLICY.maximumReloadsPerDay) {
    return { reload: false, budget: { ...current, pendingKey: renderKey } };
  }
  return {
    reload: true,
    budget: {
      ...current,
      lastReloadAtMs: nowMs,
      reloadCount: current.reloadCount + 1,
      lastRenderedKey: renderKey,
      pendingKey: null,
    },
  };
}

export * from './snapshot.js';
export * from './route.js';
export * from './publication.js';
