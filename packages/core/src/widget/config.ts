/** Widget policy, 2026-09-13. Freelingo v1; deep/07 S9 and EC-WID-02–15.
 * Hours/copy are the captured web-bundle ladder (2026-09-11); morning/evening
 * boundaries are the explicitly adopted inferred policy, not native measurements.
 */
export const WIDGET_POLICY = {
  afternoonHour: 12,
  eveningHour: 18,
  nudgeMinutes: 240,
  dangerMinutes: 60,
  ladderMinutes: [240, 180, 120, 60, 45, 30, 15],
  minimumReloadIntervalMs: 15 * 60_000,
  // Lower bound of the documented 40–70 reload budget; entries do not spend it.
  maximumReloadsPerDay: 40,
} as const;

export const WIDGET_STATES = [
  'UNKNOWN',
  'COLD',
  'DONE',
  'STREAK_SAFE_GOAL_UNMET',
  'IDLE_MORNING',
  'IDLE_AFTERNOON',
  'IDLE_EVENING',
  'NUDGE',
  'DANGER',
  'FROZEN',
  'LOST',
] as const;
export type WidgetState = (typeof WIDGET_STATES)[number];
