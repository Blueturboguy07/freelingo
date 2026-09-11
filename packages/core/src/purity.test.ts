/**
 * packages/core must stay a pure headless engine.
 *
 * This test is deliberately independent of eslint: it greps every source file for an
 * import of React, React Native or Expo. eslint can be disabled inline; this cannot.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Named config: module specifiers packages/core may never import. */
const FORBIDDEN_MODULE_PATTERNS: readonly RegExp[] = [
  /^react$/,
  /^react\//,
  /^react-dom/,
  /^react-native$/,
  /^react-native[/-]/,
  /^@react-native[/-]/,
  /^expo$/,
  /^expo-/,
  /^@expo\//,
  /^@shopify\/react-native-skia/,
];

const IMPORT_SPECIFIER = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
const REQUIRE_SPECIFIER = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
const BARE_IMPORT = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function specifiersIn(source: string): string[] {
  const found: string[] = [];
  for (const re of [IMPORT_SPECIFIER, REQUIRE_SPECIFIER, BARE_IMPORT]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      if (match[1]) found.push(match[1]);
    }
  }
  return found;
}

describe('packages/core purity', () => {
  const files = walk(SRC_DIR);

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('imports no React, React Native or Expo module anywhere', () => {
    const offenders: string[] = [];
    for (const file of files) {
      // Skip this file: the patterns above are string literals, not imports.
      if (file.endsWith('purity.test.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const specifier of specifiersIn(source)) {
        if (FORBIDDEN_MODULE_PATTERNS.some((p) => p.test(specifier))) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
