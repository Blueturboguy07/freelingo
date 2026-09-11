import { addCivilDays, toLocalDay, type LocalDay } from '@freelingo/core';

/** `civilDayRange('2026-09-05', 3)` → 2026-09-05, -06, -07. */
export function civilDayRange(start: string, count: number): LocalDay[] {
  const first = toLocalDay(start);
  const days: LocalDay[] = [];
  for (let i = 0; i < count; i += 1) days.push(addCivilDays(first, i));
  return days;
}
