/**
 * The golden-DB corpus: the machinery, not the fixtures.
 *
 * A migration is the one piece of code that runs exactly once per device and can never be
 * re-run if it was wrong. Unit tests on a fresh database do not exercise it — a fresh
 * database has no data to lose. So the corpus holds one committed `.db` per shipped
 * `user_version`, each with real rows in it, and `golden.test.ts` migrates every one of
 * them forward and compares the result ROW BY ROW against a committed expectation.
 *
 * The expectation files are generated once and then reviewed like source. That is the
 * whole contract: regenerating them is a diff a human approves, so a migration that
 * quietly changes somebody's streak shows up as a changed line in a pull request instead
 * of as a support message.
 *
 * Rebuild the fixtures (only when a new `user_version` ships):
 *
 *   node --experimental-strip-types packages/schema/src/build-golden-fixtures.ts
 *
 * Specs: plan §Phases P1 ("migration harness + golden-DB corpus"), INV-PER-03,
 * INV-PACK-35, INV-PACK-02.
 */
import type { Db } from './db.js';
import { PROGRESS_TABLES } from './progress-schema.js';

/** A row-level dump: table name -> rows, each row a plain object, deterministically ordered. */
export type ProgressDump = Record<string, Record<string, unknown>[]>;

/** Tables outside the two regions that still belong in a dump. */
const EXTRA_TABLES = ['committed_session'] as const;

/**
 * Every row of every table, ordered by the full row so the dump does not depend on
 * SQLite's physical order. `ORDER BY *` is not SQL, so the ordering is done in JS on the
 * serialised row — which is exactly as stable and has no SQL-injection surface.
 */
export function dumpProgress(db: Db): ProgressDump {
  const dump: ProgressDump = {};
  const tables = [...PROGRESS_TABLES.map((t) => t.name), ...EXTRA_TABLES].sort();
  for (const table of tables) {
    const exists = db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [
      table,
    ]);
    if (exists === undefined) continue;
    // The table name comes from this module's own constant list, never from input.
    const rows = db.all(`SELECT * FROM "${table}"`).map((row) => ({ ...row }));
    rows.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    dump[table] = rows;
  }
  return dump;
}

/** The account region alone: what INV-PACK-35 requires to be bit-identical. */
export function dumpAccountRegion(db: Db): ProgressDump {
  const full = dumpProgress(db);
  const accountTables = new Set(
    PROGRESS_TABLES.filter((t) => t.region === 'account').map((t) => t.name),
  );
  return Object.fromEntries(Object.entries(full).filter(([table]) => accountTables.has(table)));
}

export interface PackMajorBump {
  readonly courseId: string;
  readonly newContentHash: string;
  /** Item ids the NEW pack still resolves. Everything else is quarantined, never deleted. */
  readonly resolvableItemIds: readonly string[];
}

export interface PackMajorBumpResult {
  readonly quarantined: number;
  readonly restored: number;
}

/**
 * A pack major-version bump, at the schema level (INV-PACK-02, INV-PACK-35).
 *
 * Item ids are content-hashed, so a major bump can strand FSRS rows whose item no longer
 * exists. Those rows are QUARANTINED — flagged, kept, excluded from Score and from the
 * word counters — and never deleted, because a learner who reinstalls the old pack gets
 * their scheduling back. Nothing here touches `course_node` (a completed node stays
 * completed) or any account-region table (a streak is not a property of a pack).
 *
 * The write is one exclusive transaction: a bump interrupted halfway would otherwise
 * leave a course whose items belong to one pack version and whose hash claims another.
 */
export function applyPackMajorVersion(db: Db, bump: PackMajorBump): PackMajorBumpResult {
  const resolvable = new Set(bump.resolvableItemIds);
  const items = db.all<{ item_id: string; quarantined: number }>(
    'SELECT item_id, quarantined FROM course_item WHERE course_id = ?',
    [bump.courseId],
  );
  let quarantined = 0;
  let restored = 0;
  db.withExclusiveTransaction(() => {
    for (const item of items) {
      const shouldQuarantine = resolvable.has(item.item_id) ? 0 : 1;
      if (shouldQuarantine === item.quarantined) continue;
      db.run('UPDATE course_item SET quarantined = ? WHERE course_id = ? AND item_id = ?', [
        shouldQuarantine,
        bump.courseId,
        item.item_id,
      ]);
      if (shouldQuarantine === 1) quarantined += 1;
      else restored += 1;
    }
    db.run('UPDATE course_progress SET pack_content_hash = ? WHERE course_id = ?', [
      bump.newContentHash,
      bump.courseId,
    ]);
  });
  return { quarantined, restored };
}

/** Completed nodes, as the pair INV-PACK-35 compares across a bump. */
export function completedNodes(db: Db, courseId: string): { node_id: string }[] {
  return db.all<{ node_id: string }>(
    'SELECT node_id FROM course_node WHERE course_id = ? AND completed_at IS NOT NULL ORDER BY node_id',
    [courseId],
  );
}
