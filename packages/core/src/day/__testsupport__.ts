/**
 * Builders shared by the day-engine tests. Not exported from the package barrel and not
 * scanned by `test:coverage-map` (which only reads `*.test.ts`): this file exists so the
 * five test files agree on what a session row and a stocked freeze ledger look like.
 */
import { addCivilDays, toLocalDay, type LocalDay } from './civil.js';
import { newDayEngineState, type DayEngineState } from './state.js';
import { commitSession, type SessionRow } from './session.js';
import { resolveZone, type ZoneStamp } from './zone.js';
import type { FreezeLedger } from './freeze.js';

export function zoneAt(tzId: string, instant: string | Date): ZoneStamp {
  return resolveZone(typeof instant === 'string' ? new Date(instant) : instant, tzId);
}

/** A committed row, with the completion instant read honestly off the monotonic clock. */
export function rowAt(options: {
  sessionId: string;
  startUtc: string;
  durationMs?: number;
  tzId?: string;
  completionTzId?: string;
  xp?: number;
  gems?: number;
  satisfied?: Iterable<LocalDay>;
  /** A wall clock that disagrees with the monotonic clock (an NTP correction). */
  wallClockSkewMs?: number;
  buildLocalDay?: string;
}): SessionRow {
  const duration = options.durationMs ?? 5 * 60_000;
  const startMs = new Date(options.startUtc).getTime();
  const startZone = zoneAt(options.tzId ?? 'Asia/Tokyo', options.startUtc);
  const completionInstant = new Date(startMs + duration);
  const completionZone = zoneAt(
    options.completionTzId ?? options.tzId ?? 'Asia/Tokyo',
    completionInstant,
  );
  return commitSession(
    {
      sessionId: options.sessionId,
      startedAtUtcMs: startMs,
      startedAtMonotonicMs: 0,
      startZone,
    },
    {
      completedAtUtcMs: startMs + duration + (options.wallClockSkewMs ?? 0),
      completedAtMonotonicMs: duration,
      completionZone,
      earnedXp: options.xp ?? 13,
      earnedGems: options.gems ?? 0,
    },
    options.buildLocalDay === undefined
      ? { satisfiedDays: new Set(options.satisfied ?? []) }
      : { satisfiedDays: new Set(options.satisfied ?? []), buildLocalDay: options.buildLocalDay },
  );
}

/** A ledger holding exactly `count` freezes, all owned from before `ownedFromDay`. */
export function ledgerWith(
  count: number,
  ownedFromDay: LocalDay,
  cap = Math.max(count, 2),
): FreezeLedger {
  return {
    cap,
    grants:
      count === 0
        ? []
        : [
            {
              grantKey: 'test-stock',
              channel: 'reward_chest',
              subtype: null,
              ownedFromDay: addCivilDays(ownedFromDay, -1),
              requested: count,
              applied: count,
            },
          ],
    consumptions: [],
    societyTierKeys: [],
  };
}

/**
 * A state that has already lived `streak` completed days ending on `lastDay`, holding
 * `freezes`. The shape almost every freeze and recovery case starts from.
 */
export function stateWithStreak(options: {
  lastDay: string;
  streak: number;
  freezes?: number;
  cap?: number;
}): DayEngineState {
  const lastDay = toLocalDay(options.lastDay);
  const first = addCivilDays(lastDay, -(options.streak - 1));
  const dispositions = new Map<LocalDay, 'completed'>();
  for (let i = 0; i < options.streak; i += 1) dispositions.set(addCivilDays(first, i), 'completed');
  const base = newDayEngineState();
  return {
    ...base,
    lastProcessedDay: lastDay,
    maxLocalDaySeen: lastDay,
    dispositions,
    ledger: ledgerWith(options.freezes ?? 0, first, options.cap ?? 2),
    settlements: [{ month: first.slice(0, 7), settledMonth: null, atDay: first }],
    lastProcessedMonth: first.slice(0, 7),
  };
}

/** Every distinct `YYYY-MM` in the inclusive civil-date range. */
export function distinctMonthsBetween(from: LocalDay, to: LocalDay): Set<string> {
  const months = new Set<string>();
  let cursor = from;
  while (cursor <= to) {
    months.add(cursor.slice(0, 7));
    cursor = addCivilDays(cursor, 1);
  }
  return months;
}
