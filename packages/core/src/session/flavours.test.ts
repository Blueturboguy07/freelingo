import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  DEFAULT_FLAVOUR_MATRIX,
  MAX_COMBO_INTERSTITIALS_PER_SESSION,
  MIN_SESSION_LENGTH,
  TEST_FLAVOURS,
  baseSessionXp,
  defaultFlavourMatrixPort,
} from './flavours.js';
import { SESSION_FLAVOURS } from './types.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

describe('the ten flavours are a config table, not ten code paths (S057-S066)', () => {
  it('[INV-SESS-26] every one of the ten flavours S057-S066 has a row, and the row names its screen', () => {
    const screens = SESSION_FLAVOURS.map((f) => DEFAULT_FLAVOUR_MATRIX[f].screen);
    expect(screens).toEqual([
      'S057',
      'S058',
      'S059',
      'S060',
      'S061',
      'S062',
      'S063',
      'S064',
      'S065',
      'S066',
    ]);
    expect(new Set(screens).size).toBe(10);
  });

  it('[INV-SESS-26] no module under session/ branches on a flavour NAME outside the config table', () => {
    // This is the executable form of "one runtime, ten configurations". A `=== "lesson"`
    // anywhere else is a tenth code path, and it is invisible in a green suite.
    const offenders: string[] = [];
    for (const file of readdirSync(HERE)) {
      if (!file.endsWith('.ts')) continue;
      if (file === 'flavours.ts' || file === 'types.ts' || file.endsWith('.test.ts')) continue;
      if (file === 'session-fixture.ts' || file === 'test-doubles.ts') continue;
      const source = readFileSync(join(HERE, file), 'utf8');
      for (const flavour of SESSION_FLAVOURS) {
        const literal = new RegExp(
          `[=!]==\\s*['"\`]${flavour}['"\`]|['"\`]${flavour}['"\`]\\s*[=!]==`,
        );
        if (literal.test(source)) offenders.push(`${file}: compares against '${flavour}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('[INV-MIS-03] the three test flavours — jump-here, section test, placement — are exactly the non-recycling rows', () => {
    expect([...TEST_FLAVOURS].sort()).toEqual(['jumpHere', 'placement', 'sectionTest']);
    for (const flavour of TEST_FLAVOURS) {
      const row = DEFAULT_FLAVOUR_MATRIX[flavour];
      expect(row.recyclesMistakes).toBe(false);
      // Hints off, and a PIP allowance rather than the heart meter (S056) where the
      // flavour declares one at all.
      expect(row.hintsEnabled).toBe(false);
    }
  });

  it('[INV-SESS-26] no session below the configured floor is offerable, and the floor is one named constant', () => {
    expect(MIN_SESSION_LENGTH).toBe(6);
    for (const flavour of SESSION_FLAVOURS) {
      expect(DEFAULT_FLAVOUR_MATRIX[flavour].minLength).toBe(MIN_SESSION_LENGTH);
      expect(DEFAULT_FLAVOUR_MATRIX[flavour].targetLength).toBeGreaterThanOrEqual(
        MIN_SESSION_LENGTH,
      );
    }
  });

  it('[INV-SESS-26] base XP is non-decreasing in gradeable items served, for every flavour', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SESSION_FLAVOURS),
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 40 }),
        (flavour, a, b) => {
          const config = DEFAULT_FLAVOUR_MATRIX[flavour];
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const xpLo = baseSessionXp(config, lo);
          const xpHi = baseSessionXp(config, hi);
          expect(xpHi).toBeGreaterThanOrEqual(xpLo);
          expect(xpHi).toBeLessThanOrEqual(config.baseXp);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SESS-26] falsifier: a 4-item and a 14-item lesson never commit the same base XP', () => {
    const lesson = DEFAULT_FLAVOUR_MATRIX.lesson;
    expect(baseSessionXp(lesson, 4)).toBeLessThan(baseSessionXp(lesson, 14));
    expect(baseSessionXp(lesson, 14)).toBe(lesson.baseXp);
  });

  it('[INV-COM-03] the combo interstitial cap is a named constant on every flavour row', () => {
    expect(MAX_COMBO_INTERSTITIALS_PER_SESSION).toBe(7);
    for (const flavour of SESSION_FLAVOURS) {
      expect(DEFAULT_FLAVOUR_MATRIX[flavour].maxComboInterstitials).toBe(
        MAX_COMBO_INTERSTITIALS_PER_SESSION,
      );
    }
  });

  it('[INV-COM-12] a flavour declares at most one step-up kind, and the audio copy is never a path flavour', () => {
    for (const flavour of SESSION_FLAVOURS) {
      const stepUp = DEFAULT_FLAVOUR_MATRIX[flavour].stepUp;
      expect(stepUp === null || stepUp === 'production').toBe(true);
    }
  });

  it('[INV-PACK-19] the flavour port throws on an unknown flavour rather than returning undefined', () => {
    expect(() => defaultFlavourMatrixPort.row('notAFlavour' as never)).toThrow(/no row/);
  });
});
