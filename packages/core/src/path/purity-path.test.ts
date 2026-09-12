/**
 * The path engine has no clock, no randomness and no I/O.
 *
 * INV-PATH-02 says node visual state depends on `(done, total, legendary)` and nothing
 * else - "no timer, no decay, no server input". INV-PATH-09 says an absence of any length
 * changes no path state. Both are statements about what the code is ALLOWED TO READ, and
 * the only way to assert that mechanically is to grep the sources: a property test can
 * only sample inputs a function accepts, and a function that secretly reads `Date.now()`
 * accepts none.
 *
 * Same discipline as `purity.test.ts` next door, which greps for React imports.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));

/** Named config: things the path engine may never read. */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /\bDate\s*\.\s*now\b/, what: 'Date.now()' },
  { pattern: /\bnew\s+Date\b/, what: 'new Date()' },
  { pattern: /\bMath\s*\.\s*random\b/, what: 'Math.random()' },
  { pattern: /\bperformance\s*\.\s*now\b/, what: 'performance.now()' },
  { pattern: /\bprocess\s*\.\s*hrtime\b/, what: 'process.hrtime()' },
  { pattern: /\bfetch\s*\(/, what: 'fetch()' },
  { pattern: /from\s+['"]node:/, what: 'a node: builtin' },
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('packages/core/src/path purity', () => {
  const files = sources(DIR).filter((f) => !f.includes('__falsifiers__'));

  it('finds the path sources to check (a scan that finds nothing passes for free)', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it('[INV-PATH-02] no path module reads a clock, a random source or the network', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const { pattern, what } of FORBIDDEN) {
        if (pattern.test(source)) offenders.push(`${file.slice(DIR.length)}: ${what}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
