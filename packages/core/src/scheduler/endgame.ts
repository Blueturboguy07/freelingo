/**
 * The endgame session source (INV-SCH-06) and the overdue ordering everything else reuses.
 *
 * EC-SCH-06: "Course finished; the learner still wants 20 sessions. An explicit endgame
 * session source: an unbounded FSRS-due generator across the whole course, practice award,
 * NEVER a new item, returning `Come back later...` only when the due pool is genuinely
 * empty. Without it, session 7 of a completed-course day has no legal source."
 *
 * Three clauses, all of them the invariant's own words:
 *   - non-empty while any item is due
 *   - the `Come back later...` state when none is
 *   - never introduces an unseen item
 *
 * The third is the one that would be quiet if it broke: a generator that reaches for an
 * uncredited row to fill a short session hands the learner content nobody taught them
 * (INV-SCH-11) AND mints an introduction outside the daily budget (INV-SCH-10).
 */
import type { FsrsRow } from './fsrs.js';
import { isIntroduced, overdueMsAt } from './fsrs.js';
import type { HoldWindow } from './holds.js';
import { isHeldAt } from './holds.js';
import type { ItemId } from './types.js';

/** S066's two states. There is no third; an empty session is not a state. */
export type EndgameSession =
  | { readonly kind: 'session'; readonly rows: readonly FsrsRow[] }
  | { readonly kind: 'comeBackLater' };

/** The `Come back later...` copy slot lives in the product map; this is its state id. */
export const COME_BACK_LATER = 'comeBackLater';

export interface EndgameInput {
  readonly rows: Iterable<FsrsRow>;
  readonly at: Date;
  readonly sessionLength: number;
  readonly holds?: readonly HoldWindow[];
  /** Items already spent by another surface today (INV-SCH-05). */
  readonly excludeItemIds?: ReadonlySet<ItemId>;
}

/**
 * Every row that may legally be SERVED right now.
 *
 * Introduced (INV-SCH-11), not held (INV-SCH-07, INV-SCH-08), not already spent by the
 * other entry point today (INV-SCH-05), and due (INV-SCH-06).
 */
export function eligibleDueRows(input: EndgameInput): FsrsRow[] {
  const holds = input.holds ?? [];
  const excluded = input.excludeItemIds ?? new Set<ItemId>();
  const out: FsrsRow[] = [];
  for (const row of input.rows) {
    if (!isIntroduced(row)) continue;
    if (excluded.has(row.itemId)) continue;
    if (isHeldAt(row, holds, input.at)) continue;
    // Hold-aware: a row that spent three days with its modality off is exactly as overdue
    // as it was when the toggle flipped (INV-SCH-07, INV-SCH-08).
    if (overdueMsAt(row, input.at, holds) < 0) continue;
    out.push(row);
  }
  return orderByOverdue(out, input.at, holds);
}

/**
 * Most overdue first, ties broken by row key.
 *
 * Deterministic on purpose. Every other ordering in the app that needs to look shuffled
 * gets its shuffle from a `local_day`-seeded PRNG in `economy/`, so that the same day
 * always produces the same session (INV-ECO-11). A scheduler that reached for
 * `Math.random()` here would make its own properties untestable and would let a learner
 * reroll a session by leaving and coming back.
 */
export function orderByOverdue(
  rows: readonly FsrsRow[],
  at: Date,
  holds: readonly HoldWindow[] = [],
): FsrsRow[] {
  return [...rows].sort((a, b) => {
    const diff = overdueMsAt(b, at, holds) - overdueMsAt(a, at, holds);
    if (diff !== 0) return diff;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/**
 * S066. Non-empty while anything is due; `Come back later...` when nothing is.
 *
 * `sessionLength` caps the slice, not the pool: the pool is unbounded by design, and a
 * learner who wants a twentieth session gets a twentieth session as long as the algorithm
 * says something is due.
 */
export function generateEndgameSession(input: EndgameInput): EndgameSession {
  const eligible = eligibleDueRows(input);
  if (eligible.length === 0) return { kind: 'comeBackLater' };
  const take = Math.max(1, Math.floor(input.sessionLength));
  return { kind: 'session', rows: eligible.slice(0, take) };
}

/** How many items S066 could serve right now. The hub reads it for its cold state. */
export function dueCount(input: EndgameInput): number {
  return eligibleDueRows(input).length;
}
