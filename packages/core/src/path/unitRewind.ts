/**
 * Unit Rewind - a session with two entry points and **no path node**.
 *
 * `deep/03` listed a "Rewind arrow" path node; its own adversarial pass (M4) showed the
 * surrounding strings are the practice-session picker, and EC-PTH-41 rules it out of the
 * path in v1: no placed node points backwards. It is one session object keyed
 * `(unit_id, local_day)`, homed in the Practice Hub and reachable from the path only
 * through the section list.
 *
 * INV-PATH-23, second half: it pays at most once per unit per `local_day` **regardless of
 * entry point**. Falsifier: run the hub recommendation, then tap the path entry the same
 * day, and observe a second XP commit.
 */

export type UnitRewindEntry = 'hub-hero' | 'switch-session' | 'section-list';

export interface UnitRewindKey {
  readonly unitId: string;
  readonly localDay: number;
}

export interface UnitRewindLedger {
  /** `${unitId}@${localDay}` for every rewind already paid. */
  readonly paid: readonly string[];
}

export const EMPTY_UNIT_REWIND_LEDGER: UnitRewindLedger = { paid: [] };

function keyOf(key: UnitRewindKey): string {
  return `${key.unitId}@${key.localDay}`;
}

export interface UnitRewindAward {
  readonly key: string;
  /** The practice award. Paid once per unit per local day, from any entry point. */
  readonly payAward: boolean;
}

/**
 * Plan the award. `entry` is recorded for analytics only: it never changes the answer,
 * which is the whole content of "regardless of entry point".
 */
export function planUnitRewind(
  ledger: UnitRewindLedger,
  key: UnitRewindKey,
  _entry: UnitRewindEntry,
): { readonly ledger: UnitRewindLedger; readonly award: UnitRewindAward } {
  const id = keyOf(key);
  if (ledger.paid.includes(id)) {
    return { ledger, award: { key: id, payAward: false } };
  }
  return { ledger: { paid: [...ledger.paid, id] }, award: { key: id, payAward: true } };
}
