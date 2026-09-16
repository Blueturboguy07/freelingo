import type { WidgetState } from './config.js';

/** Written only AFTER the account transaction and on every cold foreground.
 * Additional disposition/XP fields preserve the latest split streak/goal ruling.
 * Targets read this JSON, never SQLite. A prior-day stamp is deliberately UNKNOWN:
 * EC-WID-15's later stale-state ruling takes precedence over stale projected streaks.
 */
export interface WidgetSnapshot {
  readonly initialized: boolean;
  readonly local_day: string;
  readonly computed_at_utc: string;
  readonly tz_id: string;
  readonly day_boundary_utc: string;
  readonly streak: number;
  readonly last_completed_local_day: string | null;
  readonly freezes_owned: number;
  readonly previous_day_disposition: 'completed' | 'frozen' | 'missed' | null;
  readonly streak_extended_today: boolean;
  readonly goal_met: boolean;
  readonly earned_xp: number;
  readonly goal_xp: number;
  readonly lifetime_sessions: number;
  readonly active_course_id: string;
  readonly active_node_id: string | null;
  readonly has_resumable_session: boolean;
  readonly equipped_cosmetic_id: string | null;
}

export interface WidgetRender {
  readonly state: WidgetState;
  readonly copy: string;
  readonly streak: number | null;
  readonly flame: 'none' | 'unlit' | 'lit' | 'frozen';
  readonly goalMet: boolean;
  readonly remainingMinutes: number | null;
  readonly deepLink: string;
  readonly cosmeticId: string | null;
}

export interface WidgetTimelineEntry {
  readonly atMs: number;
  readonly render: WidgetRender;
}
export interface ReloadBudget {
  readonly localDay: string;
  readonly lastReloadAtMs: number | null;
  readonly reloadCount: number;
  readonly pendingKey: string | null;
  readonly lastRenderedKey: string | null;
}
