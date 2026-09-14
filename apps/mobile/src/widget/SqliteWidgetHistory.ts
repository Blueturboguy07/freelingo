import type { Db, DbRow } from '@freelingo/schema';
import {
  addCivilDays,
  toLocalDay,
  localDayOfStamp,
  sameZone,
  secondsPastLocalMidnight,
  DAY_CONFIG,
  type ZoneStamp,
} from '@freelingo/core/day';
import { flavourRow } from '@freelingo/core/economy';
import { SESSION_FLAVOURS, SESSION_OUTCOMES } from '@freelingo/core/types';
import type { WidgetHistoryRead } from './SqliteWidgetSource';

function requireFact(value: unknown): asserts value {
  if (!value) throw new Error('Widget lifetime history is unavailable.');
}
function timestamp(value: unknown): number {
  requireFact(typeof value === 'number' && Number.isSafeInteger(value));
  requireFact(Number.isFinite(new Date(value).getTime()));
  return value;
}
function day(value: unknown) {
  requireFact(typeof value === 'string');
  return toLocalDay(value);
}

function zone(row: DbRow, prefix: 'start' | 'completion'): ZoneStamp {
  const tzId = row[prefix + '_tz_id'];
  const utcOffsetMinutes = row[prefix + '_utc_offset_minutes'];
  const tzSource = row[prefix + '_tz_source'];
  requireFact(typeof tzId === 'string' && tzId.trim());
  requireFact(
    typeof utcOffsetMinutes === 'number' &&
      Number.isSafeInteger(utcOffsetMinutes) &&
      Math.abs(utcOffsetMinutes) <= 1440,
  );
  requireFact(tzSource === 'iana' || tzSource === 'fixed_offset' || tzSource === 'unknown');
  return { tzId, utcOffsetMinutes, tzSource };
}

/** INV-WID-01/05/08/10. App-only, read after the serialized day/reward chain.
 * account_word_state is used ONLY for its existing native fresh-file origin proof:
 * its initializer forbids any prior course or global committed receipt. A generic
 * word-history flag, migrated zero counters, or a subset restore cannot replace it.
 * Whole-database restore must preserve this header AND the entire global ledger.
 * Course removal deliberately does not remove either. No course links are required.
 * This reader validates the receipt fields needed for count and civil-day identity;
 * it does not re-grade attempts or recompute rewards from incomplete source history.
 */
export function readSqliteWidgetHistory(
  db: Pick<Db, 'get' | 'all'>,
  observedLocalDay: string,
): WidgetHistoryRead {
  try {
    const observed = day(observedLocalDay);
    const origin = db.get('SELECT initialized_at_utc_ms FROM account_word_state WHERE id=1');
    if (!origin) return { kind: 'unavailable' };
    timestamp(origin.initialized_at_utc_ms);
    let lifetimeSessions = 0;
    let lastCompletedLocalDay: string | null = null;
    for (const row of db.all(`SELECT session_id,committed_at,flavour,outcome,graded_attempts,
      derived_completion_utc_ms,started_at_utc_ms,started_local_day,start_tz_id,start_utc_offset_minutes,start_tz_source,completed_at_utc_ms,completion_tz_id,completion_utc_offset_minutes,completion_tz_source,completed_local_day,credited_local_day,reward_local_day,
      credited_by_grace,day_keying_deferred FROM committed_session ORDER BY session_id`)) {
      requireFact(typeof row.session_id === 'string' && row.session_id.trim());
      const flavour = SESSION_FLAVOURS.find((value) => value === row.flavour);
      const outcome = SESSION_OUTCOMES.find((value) => value === row.outcome);
      requireFact(flavour && outcome);
      requireFact(
        typeof row.graded_attempts === 'number' &&
          Number.isSafeInteger(row.graded_attempts) &&
          row.graded_attempts > 0,
      );
      const at = timestamp(row.derived_completion_utc_ms);
      requireFact(row.committed_at === new Date(at).toISOString());
      const startAt = timestamp(row.started_at_utc_ms);
      timestamp(row.completed_at_utc_ms);
      requireFact(at >= startAt);
      const startZone = zone(row, 'start');
      const completionZone = zone(row, 'completion');
      const started = day(row.started_local_day);
      const completed = day(row.completed_local_day);
      requireFact(localDayOfStamp(new Date(startAt), startZone) === started);
      requireFact(localDayOfStamp(new Date(at), completionZone) === completed);
      const zoneChanged = !sameZone(startZone, completionZone);
      requireFact(row.credited_by_grace === 0 || row.credited_by_grace === 1);
      requireFact(row.day_keying_deferred === 0 || row.day_keying_deferred === 1);
      let credited: string | null = null;
      if (row.day_keying_deferred === 1) {
        requireFact(
          row.credited_local_day === null &&
            row.reward_local_day === null &&
            row.credited_by_grace === 0,
        );
      } else {
        credited = day(row.credited_local_day);
        requireFact(day(row.reward_local_day) === completed);
        if (row.credited_by_grace === 1) {
          requireFact(
            !zoneChanged && credited === started && addCivilDays(started, 1) === completed,
          );
          requireFact(
            secondsPastLocalMidnight(new Date(at), completionZone.utcOffsetMinutes) <=
              DAY_CONFIG.graceSeconds,
          );
        } else {
          // INV-DAY-04 credits either captured civil day after travel. The prior
          // satisfied-day set is historical; never replace the stored decision.
          requireFact(credited === completed || (zoneChanged && credited === started));
        }
        requireFact(credited <= observed);
      }
      const mode = flavourRow(flavour, outcome);
      if (mode.countsAsLesson) lifetimeSessions++;
      // Grace credits the preceding streak date. Frozen/recovered days and failed
      // or quit receipts cannot replace an actual streak-satisfying completion.
      if (
        mode.extendsStreak &&
        credited !== null &&
        (lastCompletedLocalDay === null || credited > lastCompletedLocalDay)
      )
        lastCompletedLocalDay = credited;
    }
    requireFact(Number.isSafeInteger(lifetimeSessions));
    return { kind: 'known', observedLocalDay: observed, lifetimeSessions, lastCompletedLocalDay };
  } catch {
    return { kind: 'unavailable' };
  }
}
