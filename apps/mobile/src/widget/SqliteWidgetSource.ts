import type { Db, DbRow } from '@freelingo/schema';
import { addCivilDays, localDayOf, toLocalDay } from '@freelingo/core/day';
import type { WidgetAccountRead, WidgetCourseRead, WidgetDrawClock } from '@freelingo/core/widget';

/** The current session/day stores must establish history; zero cached counters do
 * not prove it. Observed day binds the read to this completed foreground chain. */
export type WidgetHistoryRead =
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'known';
      readonly observedLocalDay: string;
      readonly lifetimeSessions: number;
      readonly lastCompletedLocalDay: string | null;
    };
const unavailable = (
  reason:
    | 'unknown-history'
    | 'unavailable'
    | 'rollover-pending'
    | 'no-active-course'
    | 'invalid-source'
    | 'unreliable-clock',
): WidgetAccountRead => ({ kind: 'unavailable', reason });
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new Error('Invalid widget source integer');
  return value;
}
function flag(value: unknown): boolean {
  if (value !== 0 && value !== 1) throw new Error('Invalid widget source flag');
  return value === 1;
}
function optionalText(value: unknown): string | null {
  if (value !== null && (typeof value !== 'string' || !value.trim()))
    throw new Error('Invalid widget source text');
  return value as string | null;
}
function one(rows: readonly DbRow[]): DbRow | null {
  if (rows.length > 1) throw new Error('Ambiguous widget source rows');
  return rows[0] ?? null;
}

/** App-only projection from actual v6/v7 columns; no schema writes or migrations.
 * Invoke within the caller's serialized, committed account read. Course/node/resume
 * comes from validated SqliteAppState/path/SqliteSessionStore, not the first DB row.
 * This reader is NOT included in WidgetKit/Glance target code or its dependency graph.
 */
export function readSqliteWidgetAccount(
  db: Pick<Db, 'get' | 'all'>,
  clock: WidgetDrawClock,
  history: WidgetHistoryRead,
  course: WidgetCourseRead | null,
): WidgetAccountRead {
  if (history.kind === 'unavailable') return unavailable('unknown-history');
  if (course === null) return unavailable('no-active-course');
  try {
    const day = localDayOf(new Date(clock.nowMs), clock.zone);
    if (history.observedLocalDay !== day) return unavailable('rollover-pending');
    const account = db.get(
      'SELECT streak,last_processed_day,clock_unreliable,equipped_cosmetic_id FROM account WHERE id=1',
    );
    if (!account) return unavailable('unknown-history');
    if (flag(account.clock_unreliable)) return unavailable('unreliable-clock');
    // DayEngine settles days strictly BEFORE today. Its marker is yesterday,
    // including after the first cold foreground; today's day is still open.
    const yesterday = addCivilDays(toLocalDay(day), -1);
    if (account.last_processed_day !== yesterday) return unavailable('rollover-pending');
    const active = one(
      db.all(
        'SELECT s.course_id FROM course_selection s JOIN course_progress p ON p.course_id=s.course_id WHERE s.is_active=1',
      ),
    );
    if (!active) return unavailable('no-active-course');
    if (active.course_id !== course.courseId) return unavailable('invalid-source');
    const today = db.get(
      'SELECT goal_xp,earned_xp,goal_met,streak_satisfied FROM account_day WHERE local_day=?',
      [day],
    );
    if (!today) return unavailable('rollover-pending');
    const previous = db.get('SELECT disposition FROM account_day WHERE local_day=?', [yesterday]);
    const disposition = previous?.disposition;
    if (
      disposition !== undefined &&
      disposition !== null &&
      !['completed', 'frozen', 'missed', 'unlived', 'recovered'].includes(disposition as string)
    )
      return unavailable('invalid-source');
    // Only a grant owned before THIS civil day can protect it. Full inventory stays
    // in the DB; a newly acquired, ineligible freeze cannot promise protection.
    const freezes = db.get(
      'SELECT COUNT(*) AS n FROM account_freeze WHERE consumed_for_day IS NULL AND acquired_on_day < ?',
      [day],
    );
    if (!freezes) return unavailable('invalid-source');
    return {
      kind: 'known',
      localDay: day,
      streak: integer(account.streak),
      lastCompletedLocalDay: history.lastCompletedLocalDay,
      freezesOwned: integer(freezes.n),
      previousDayDisposition:
        disposition === 'completed' || disposition === 'frozen' || disposition === 'missed'
          ? disposition
          : null,
      streakExtendedToday: flag(today.streak_satisfied),
      goalMet: flag(today.goal_met),
      earnedXp: integer(today.earned_xp),
      goalXp: integer(today.goal_xp, 1),
      lifetimeSessions: integer(history.lifetimeSessions),
      course,
      equippedCosmeticId: optionalText(account.equipped_cosmetic_id),
    };
  } catch {
    return unavailable('unavailable');
  }
}
