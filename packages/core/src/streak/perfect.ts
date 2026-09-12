/**
 * The weekly Perfect Streak, and EC-STK-19.
 *
 * EC-STK-19 had **no source anywhere** — does a frozen day preserve the week's Perfect
 * Streak or reset it? — and was carried as an open founder ruling. The ruling, recorded in
 * the plan's founder table: **a frozen day resets the weekly Perfect Streak; the main
 * streak survives.** That is the whole point of the two counters being different: a freeze
 * is insurance against losing the streak, not a substitute for practising, so the harder
 * counter is the one it cannot buy.
 *
 * A `recovered` day resets it too, for the same reason and more obviously. An `unlived`
 * day is neither practised nor missed — the clock jumped over it — so it is skipped, and a
 * week the device only partly lived is simply not a candidate for perfection.
 */
import { addCivilDays, weekKeyOf, type LocalDay } from '../day/civil.js';
import type { DayLedger } from '../day/dispositions.js';

export type PerfectWeekVerdict = 'perfect' | 'broken' | 'incomplete';

/**
 * Was the week beginning `weekKey` (a Monday) perfect?
 *
 * - `perfect` — every one of its seven civil dates was lived and completed.
 * - `broken` — at least one lived date was frozen, missed or recovered.
 * - `incomplete` — at least one date has no decision yet (the current week, or a week
 *   before the engine started). Neither perfect nor a reset.
 */
export function perfectWeekVerdict(ledger: DayLedger, weekKey: LocalDay): PerfectWeekVerdict {
  let sawUndecided = false;
  for (let i = 0; i < 7; i += 1) {
    const disposition = ledger.get(addCivilDays(weekKey, i));
    if (disposition === undefined) {
      sawUndecided = true;
      continue;
    }
    if (disposition === 'unlived') continue;
    if (disposition !== 'completed') return 'broken';
  }
  return sawUndecided ? 'incomplete' : 'perfect';
}

/**
 * Consecutive perfect weeks ending with the last COMPLETE week before `today`'s week.
 * The current week is still in progress and never counts for or against.
 */
export function perfectStreakWeeks(ledger: DayLedger, today: LocalDay): number {
  let cursor = addCivilDays(weekKeyOf(today), -7);
  let weeks = 0;
  for (;;) {
    const verdict = perfectWeekVerdict(ledger, cursor);
    if (verdict !== 'perfect') return weeks;
    weeks += 1;
    cursor = addCivilDays(cursor, -7);
  }
}
