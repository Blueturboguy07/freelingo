/**
 * The golden-migration test. `pnpm test:golden-migrations` runs exactly this file
 * (`vitest run --project schema -t golden`), and CI runs it as its own job so a migration
 * failure is never buried in a 200-test summary.
 *
 * Three things are proved here:
 *  1. every shipped `user_version` has a committed fixture with real rows in it;
 *  2. migrating each fixture forward produces the committed expectation, ROW BY ROW;
 *  3. a pack major-version bump leaves every completed node complete and the whole
 *     account region bit-identical (INV-PACK-35).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeDb } from '@freelingo/testkit';
import type { Db } from './db.js';
import { LATEST_USER_VERSION, MIGRATIONS, currentUserVersion, migrate } from './migrations.js';
import {
  FIXTURE_DIR,
  V0_FIXTURE,
  buildFixtures,
  copyDb,
  expectationName,
  fixtureName,
} from './build-golden-fixtures.js';
import {
  applyPackMajorVersion,
  completedNodes,
  dumpAccountRegion,
  dumpProgress,
  type ProgressDump,
} from './golden.js';
import { regionViolations } from './progress-schema.js';

const FIXTURES = [V0_FIXTURE, ...MIGRATIONS.map((m) => fixtureName(m.userVersion))];

/**
 * The maintainer command that writes the corpus, run through vitest because Node's
 * type-stripping loader will not resolve this package's `.js` specifiers onto `.ts`
 * files. It is not registered at all unless the environment variable is set, so CI can
 * never regenerate the expectations it is supposed to be checking.
 */
if (process.env.FREELINGO_REBUILD_GOLDEN === '1') {
  it('rebuild the golden fixtures (maintainer command)', () => {
    const written = buildFixtures();
    expect(written.length).toBe(MIGRATIONS.length + 1);
  });
}

/** Open a scratch copy, so the committed fixture is never migrated in place. */
function openCopy(fixture: string): { db: Db; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'freelingo-golden-'));
  const path = join(dir, fixture);
  copyDb(join(FIXTURE_DIR, fixture), path);
  return { db: createNodeDb({ location: path }), dir };
}

function expectation(fixture: string): ProgressDump {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, expectationName(fixture)), 'utf8'),
  ) as ProgressDump;
}

describe('golden migration corpus', () => {
  it('every shipped user_version has a committed fixture', () => {
    // The gate that makes the corpus grow with the schema. Ship migration 3 without a
    // v3 fixture and this is red before anyone's device sees it.
    for (const migration of MIGRATIONS) {
      const name = fixtureName(migration.userVersion);
      expect(existsSync(join(FIXTURE_DIR, name)), `missing fixture ${name}`).toBe(true);
      expect(existsSync(join(FIXTURE_DIR, expectationName(name)))).toBe(true);
    }
    expect(existsSync(join(FIXTURE_DIR, V0_FIXTURE))).toBe(true);
  });

  it('the fixtures carry rows, so migrating them is not migrating nothing', () => {
    const { db, dir } = openCopy(fixtureName(1));
    expect(currentUserVersion(db)).toBe(1);
    expect(db.get<{ xp: number }>('SELECT xp FROM account WHERE id = 1')?.xp).toBe(1830);
    db.close();
    rmSync(dir, { recursive: true, force: true });

    const v2 = openCopy(fixtureName(2));
    expect(currentUserVersion(v2.db)).toBe(2);
    expect(completedNodes(v2.db, 'en-es').length).toBe(40);
    v2.db.close();
    rmSync(v2.dir, { recursive: true, force: true });
  });

  for (const fixture of FIXTURES) {
    it(`golden: ${fixture} migrates forward to the committed end state, row for row`, () => {
      const { db, dir } = openCopy(fixture);
      migrate(db);
      expect(currentUserVersion(db)).toBe(LATEST_USER_VERSION);
      expect(regionViolations(db)).toEqual([]);
      expect(dumpProgress(db)).toEqual(expectation(fixture));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
  }

  it('golden: the v1 account row arrives at v2 with its XP under the new name, not reset', () => {
    // The single most expensive way this migration could be wrong, asserted on its own
    // rather than left to a row-level diff nobody reads: 1830 XP is 1830 XP afterwards.
    const { db, dir } = openCopy(fixtureName(1));
    migrate(db);
    const account = db.get<{ lifetime_xp: number; gems: number; nodes_completed: number }>(
      'SELECT lifetime_xp, gems, nodes_completed FROM account WHERE id = 1',
    );
    expect(account).toEqual({ lifetime_xp: 1830, gems: 515, nodes_completed: 0 });
    expect(db.all('SELECT session_id FROM committed_session').length).toBe(4);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('golden: migrating twice changes nothing (a relaunch is not a migration)', () => {
    const { db, dir } = openCopy(fixtureName(1));
    migrate(db);
    const once = dumpProgress(db);
    migrate(db);
    expect(dumpProgress(db)).toEqual(once);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('pack major-version migration', () => {
  it('[INV-PACK-35] golden: no completed node becomes incomplete and the account region is bit-identical', () => {
    const { db, dir } = openCopy(fixtureName(2));
    migrate(db);

    const nodesBefore = completedNodes(db, 'en-es');
    const accountBefore = dumpAccountRegion(db);
    const otherCourseBefore = db.get('SELECT * FROM course_progress WHERE course_id = ?', [
      'en-fr',
    ]);
    expect(nodesBefore.length).toBe(40);

    // The major bump: the new pack resolves only half of the old content-hashed ids.
    const all = db
      .all<{ item_id: string }>(
        'SELECT item_id FROM course_item WHERE course_id = ? ORDER BY item_id',
        ['en-es'],
      )
      .map((row) => row.item_id);
    const resolvable = all.filter((_, i) => i % 2 === 0);
    const result = applyPackMajorVersion(db, {
      courseId: 'en-es',
      newContentHash: 'hash_en-es_v2',
      resolvableItemIds: resolvable,
    });

    expect(result.quarantined).toBe(all.length - resolvable.length);
    expect(completedNodes(db, 'en-es')).toEqual(nodesBefore);
    expect(dumpAccountRegion(db)).toEqual(accountBefore);
    expect(db.get('SELECT * FROM course_progress WHERE course_id = ?', ['en-fr'])).toEqual(
      otherCourseBefore,
    );
    // Quarantined, never deleted: every row is still there.
    expect(
      db.get<{ c: number }>('SELECT COUNT(*) AS c FROM course_item WHERE course_id = ?', ['en-es'])
        ?.c,
    ).toBe(all.length);
    expect(
      db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM course_item WHERE course_id = ? AND quarantined = 1',
        ['en-es'],
      )?.c,
    ).toBe(result.quarantined);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('[INV-PACK-35] golden: reinstalling the old pack restores the quarantined rows', () => {
    // The other half of "quarantined, never deleted": the rows come back, with their FSRS
    // state intact, which is the only reason keeping them is worth the column.
    const { db, dir } = openCopy(fixtureName(2));
    migrate(db);
    const before = db.all('SELECT * FROM course_item WHERE course_id = ? ORDER BY item_id', [
      'en-es',
    ]);
    const all = before.map((row) => (row as { item_id: string }).item_id);
    applyPackMajorVersion(db, {
      courseId: 'en-es',
      newContentHash: 'hash_en-es_v2',
      resolvableItemIds: all.filter((_, i) => i % 2 === 0),
    });
    const restored = applyPackMajorVersion(db, {
      courseId: 'en-es',
      newContentHash: 'hash_en-es_v1',
      resolvableItemIds: all,
    });
    expect(restored.restored).toBe(Math.floor(all.length / 2));
    expect(
      db.all('SELECT * FROM course_item WHERE course_id = ? ORDER BY item_id', ['en-es']),
    ).toEqual(before);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
