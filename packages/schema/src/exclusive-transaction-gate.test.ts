/**
 * INV-PER-07 — "Every scheduler and reward write uses `withExclusiveTransactionAsync`.
 * Grep gate: `withTransactionAsync` appears in no scheduler or economy module."
 *
 * The two spellings differ by one word and by everything else. `withTransactionAsync`
 * takes a DEFERRED transaction: two writers can both be inside one, and the second one to
 * try to upgrade to a write lock gets `SQLITE_BUSY` — at which point expo-sqlite rolls
 * back a transaction the caller believed had committed. The reward commit is the one
 * place in the app where that is unrecoverable, because the ceremony has already been
 * shown.
 *
 * A grep is the right shape of test here: the failure is a name, and a behavioural test
 * would need two concurrent writers on a real device to see it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '@freelingo/testkit';

const SELF = fileURLToPath(import.meta.url);

/** Named config: the modules the gate covers, relative to the repo root. */
const GUARDED_DIRS = [
  'packages/core/src/economy',
  'packages/core/src/scheduler',
  'packages/core/src/ceremony',
  'packages/core/src/db',
  'packages/schema/src',
  'apps/mobile/src',
] as const;

/** The deferred-transaction spellings, in both the async and the sync `Db` naming. */
const FORBIDDEN = [/\bwithTransactionAsync\b/, /\bwithTransaction\b(?!al)/] as const;
const REQUIRED_EXCLUSIVE = /\bwithExclusiveTransaction(?:Async)?\b/;

function sources(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // a guarded directory that does not exist yet is not a violation
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(sources(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('exclusive transactions', () => {
  const root = repoRoot();
  const files = GUARDED_DIRS.flatMap((dir) => sources(join(root, dir)));

  it('the scan found the guarded modules (a scan that finds nothing passes for free)', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.includes('/economy/'))).toBe(true);
    expect(files.some((f) => f.includes('/schema/src/'))).toBe(true);
  });

  it('[INV-PER-07] withTransactionAsync appears in no scheduler, economy or reward module', () => {
    const offenders: string[] = [];
    for (const file of files) {
      // This gate file names the forbidden spelling in order to forbid it.
      if (file === SELF) continue;
      const source = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        if (pattern.test(source)) offenders.push(`${relative(root, file)}: ${pattern.source}`);
      }
    }
    expect(
      offenders,
      'use withExclusiveTransaction(Async); a deferred transaction can be rolled back under you',
    ).toEqual([]);
  });

  it('[INV-PER-07] the module that writes rewards does use the exclusive form', () => {
    // The gate above only forbids. Without this, deleting every transaction from the
    // commit path would pass it.
    const migrations = readFileSync(join(root, 'packages/schema/src/migrations.ts'), 'utf8');
    expect(REQUIRED_EXCLUSIVE.test(migrations)).toBe(true);
    const dbInterface = readFileSync(join(root, 'packages/schema/src/db.ts'), 'utf8');
    expect(REQUIRED_EXCLUSIVE.test(dbInterface)).toBe(true);
    // And the interface offers no deferred alternative to reach for.
    expect(/\bwithTransaction\b(?!al)/.test(dbInterface)).toBe(false);
  });
});
