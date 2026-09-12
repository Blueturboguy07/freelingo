/**
 * `unlived` dates — the corrected INV-DAY-03.
 *
 * A civil date is `unlived` **only when the device's local clock jumped over it via a
 * zone change**. Fly LA → Sydney across the date line and 2026-09-12 never existed for
 * this device: it is not a missed day, it consumes no freeze, it does not increment the
 * streak, and the calendar renders it as its own neutral cell rather than a hole the
 * learner reads as failure (EC-STK-03).
 *
 * The original wording — "zero device wall-clock presence" — failed on EC-STK-21 and was
 * corrected in place by the plan: a date a powered-off phone slept through is **lived and
 * missed**, covered by a freeze or breaking the streak like any other. The guard is
 * therefore keyed on zone transitions, never on observed uptime; a device that is off
 * emits no transition, so it can never manufacture an `unlived` day. The falsifier —
 * a three-date powered-off gap that comes back `unlived` — is committed under
 * `__falsifiers__/INV-DAY-03.json`.
 */
import { addCivilDays, civilDaysBetween, type LocalDay } from './civil.js';
import { localDayOfStamp, sameZone, type ZoneStamp } from './zone.js';

/**
 * A recorded change of zone. Written as a first-class rollover event the moment the
 * platform reports a different `tz_id`/offset (EC-STK-02: "`tz_id` transitions are
 * recorded as first-class rollover events").
 */
export interface ZoneTransition {
  /** The UTC instant the change was observed. Monotone across the log. */
  readonly atUtcMs: number;
  readonly from: ZoneStamp;
  readonly to: ZoneStamp;
}

/** Did this transition actually change the clock? */
export function isRealTransition(transition: ZoneTransition): boolean {
  return !sameZone(transition.from, transition.to);
}

/**
 * The civil dates the local clock jumped over, across a whole transition log.
 *
 * Eastward across the date line: the date before the hop is D, the date after is D+2 or
 * later, so every date strictly between them was jumped over. Westward: the date after is
 * the same or earlier, and nothing is unlived — that date is simply lived twice
 * (EC-STK-01, and the regression is a travel regression, INV-DAY-02).
 *
 * An empty log — the powered-off device — yields the empty set. That is the whole point.
 */
export function unlivedDaysFromTransitions(transitions: readonly ZoneTransition[]): Set<LocalDay> {
  const unlived = new Set<LocalDay>();
  for (const transition of transitions) {
    if (!isRealTransition(transition)) continue;
    const instant = new Date(transition.atUtcMs);
    const before = localDayOfStamp(instant, transition.from);
    const after = localDayOfStamp(instant, transition.to);
    const jumped = civilDaysBetween(before, after);
    for (let i = 1; i < jumped; i += 1) unlived.add(addCivilDays(before, i));
  }
  return unlived;
}

/**
 * Does a set of transitions make `day` unlived? The predicate a rollover step asks.
 * Lived days — including every day a powered-off device slept through — answer `false`.
 */
export function isUnlived(day: LocalDay, unlived: ReadonlySet<LocalDay>): boolean {
  return unlived.has(day);
}
