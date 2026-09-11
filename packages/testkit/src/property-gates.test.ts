/**
 * The gate on the gate.
 *
 * Plan §Verification: "≥ 10,000 cases per property". That is easy to state and easy to
 * quietly undo — one `{ numRuns: 1000 }` left behind after a slow afternoon and the
 * property still passes, still reads green, and covers a tenth of what it claims. So the
 * floor is asserted mechanically over the whole tree rather than trusted to review.
 *
 * If a property is too slow at `PROPERTY_RUNS`, tighten its generator; do not lower this.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { repoRoot } from './repo.js';
import { PROPERTY_RUNS, PROPERTY_RUNS_PER_ZONE } from './config.js';

/** Named config: where property tests live, and the identifiers that stand for the floor. */
const TEST_ROOTS = ['packages', 'apps'];
const NAMED_RUN_COUNTS: Record<string, number> = {
  PROPERTY_RUNS,
  PROPERTY_RUNS_PER_ZONE,
};
const SELF = fileURLToPath(import.meta.url);

function testFiles(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(testFiles(full));
    else if (/\.test\.tsx?$/.test(entry) && full !== SELF) out.push(full);
  }
  return out;
}

/** `numRuns: 10_000`, `numRuns: PROPERTY_RUNS` — value as written, resolved to a number. */
function runCountsIn(source: string): { raw: string; value: number | null }[] {
  const pattern = /numRuns\s*:\s*([A-Za-z_$][\w$]*|[\d_]+)/g;
  return [...source.matchAll(pattern)].map((m) => {
    const raw = m[1]!;
    if (raw in NAMED_RUN_COUNTS) return { raw, value: NAMED_RUN_COUNTS[raw]! };
    const numeric = Number(raw.replaceAll('_', ''));
    return { raw, value: Number.isFinite(numeric) ? numeric : null };
  });
}

describe('property gates', () => {
  const root = repoRoot();
  const files = TEST_ROOTS.flatMap((r) => testFiles(join(root, r)));
  const found = files.flatMap((file) =>
    runCountsIn(readFileSync(file, 'utf8')).map((c) => ({ ...c, file: relative(root, file) })),
  );

  it('the floor itself is 10,000 cases (plan §Verification, P0 gate)', () => {
    expect(PROPERTY_RUNS).toBeGreaterThanOrEqual(10_000);
    // A zone-looped property runs the full count per zone, not a quarter of it each.
    expect(PROPERTY_RUNS_PER_ZONE).toBeGreaterThanOrEqual(PROPERTY_RUNS);
  });

  it('the scan actually found property tests (a scan that finds nothing passes for free)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(found.length).toBeGreaterThanOrEqual(3);
  });

  it('every fast-check property in the tree runs at least PROPERTY_RUNS cases', () => {
    const below = found
      .filter((c) => c.value === null || c.value < PROPERTY_RUNS)
      .map((c) => `${c.file}: numRuns: ${c.raw}`);
    expect(below, `raise these to PROPERTY_RUNS (${PROPERTY_RUNS}), never lower the floor`).toEqual(
      [],
    );
  });
});
