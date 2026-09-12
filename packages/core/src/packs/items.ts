/**
 * Content-hashed item ids, the additive-only rule, and quarantine on a major bump
 * (INV-PACK-02; EC-PTH-16, EC-PACK-04).
 *
 * An item id is the hash of the item's *content*, not its position. A naive index
 * carry-over remaps a learner's twelve weeks of FSRS history onto whatever sentence now
 * occupies slot 413 — the rows keep working, the schedule keeps running, and the learner
 * is being tested on things they never saw. Nothing ever surfaces that as an error.
 *
 * So: ids are derived, additive **within** a major version, and on a major bump the rows
 * that no longer resolve are **quarantined, never deleted**. Deleting them is the other
 * silent failure: the export the learner takes today may be restored next year onto a
 * build that still has the old pack (EC-PACK-04), and a deleted row cannot come back.
 */
import { sha256Hex } from './hashing.js';

/** The prefix that makes a content hash recognisable in a stack trace and a dump. */
export const ITEM_ID_PREFIX = 'i_';
/**
 * Hex characters of SHA-256 kept. 16 hex = 64 bits: at the pack scale (tens of thousands
 * of items per language, four languages) the collision probability is ~1e-11, and a
 * shorter id keeps the FSRS table small enough to stay inside Android's 25 MB Auto Backup
 * quota (EC-PER-18) with room to spare.
 */
export const ITEM_ID_HEX_LENGTH = 16;

/**
 * Canonical JSON: keys sorted at every level, no insertion-order dependence. Two pack
 * builds that describe the same item must produce the same id, and `JSON.stringify` alone
 * does not promise that across generator versions.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function contentHashItemId(content: unknown): string {
  return `${ITEM_ID_PREFIX}${sha256Hex(canonicalJson(content)).slice(0, ITEM_ID_HEX_LENGTH)}`;
}

export function isContentHashItemId(id: string): boolean {
  return new RegExp(`^${ITEM_ID_PREFIX}[0-9a-f]{${ITEM_ID_HEX_LENGTH}}$`).test(id);
}

/** One FSRS row, reduced to what the update rule needs. */
export interface ScheduledItem {
  readonly itemId: string;
  /** Quarantined rows keep every field; they stop being *counted*, not being *kept*. */
  readonly quarantined: boolean;
  /** Whether the learner has met this item enough for it to count as a word learned. */
  readonly learned: boolean;
  readonly scoreContribution: number;
}

export interface PackVersionChange {
  readonly fromMajor: number;
  readonly toMajor: number;
  /** Every item id the new pack declares. */
  readonly itemIds: ReadonlySet<string>;
}

export interface PackUpdateResult {
  readonly rows: readonly ScheduledItem[];
  /** Newly quarantined in this update — the number the notice states. */
  readonly retired: number;
  /** Previously quarantined rows that this pack resolves again. */
  readonly restored: number;
  readonly notice: string | null;
}

/** S151 / EC-PACK-04: `{{n}} items retired in this update`. */
export function retiredNotice(count: number): string | null {
  return count === 0 ? null : `${count} items retired in this update`;
}

/**
 * Apply a pack version change to the scheduler rows.
 *
 * Within a major version the ids are additive, so nothing can stop resolving and nothing
 * is quarantined — if a row does not resolve there, the *pack* is wrong, which
 * `additiveOnlyViolations` reports as a build failure rather than quietly retiring a
 * learner's history.
 *
 * Across a major bump, unresolvable rows are quarantined and resolvable quarantined rows
 * come back.
 */
export function applyPackUpdate(
  rows: readonly ScheduledItem[],
  change: PackVersionChange,
): PackUpdateResult {
  const majorBump = change.toMajor !== change.fromMajor;
  let retired = 0;
  let restored = 0;
  const next = rows.map((row) => {
    const resolves = change.itemIds.has(row.itemId);
    if (resolves && row.quarantined) {
      restored += 1;
      return { ...row, quarantined: false };
    }
    if (!resolves && !row.quarantined && majorBump) {
      retired += 1;
      return { ...row, quarantined: true };
    }
    return row;
  });
  return { rows: next, retired, restored, notice: retiredNotice(retired) };
}

/**
 * The build gate: within a major version every id the previous pack declared must still
 * be declared. Returns the ids that vanished — empty means additive.
 */
export function additiveOnlyViolations(
  previous: Iterable<string>,
  next: ReadonlySet<string>,
  change: Pick<PackVersionChange, 'fromMajor' | 'toMajor'>,
): string[] {
  if (change.toMajor !== change.fromMajor) return [];
  return [...previous].filter((id) => !next.has(id)).sort();
}

/** Quarantined rows stop counting toward Score. */
export function scoreFrom(rows: readonly ScheduledItem[]): number {
  return rows.reduce((sum, row) => (row.quarantined ? sum : sum + row.scoreContribution), 0);
}

/** ...and toward words learned. */
export function wordsLearned(rows: readonly ScheduledItem[]): number {
  return rows.filter((row) => !row.quarantined && row.learned).length;
}
