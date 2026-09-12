import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  BIDI_CONTROLS,
  USER_TEXT_FIELDS,
  USER_TEXT_MAX_CODE_POINTS,
  ZERO_WIDTH_CHARACTERS,
  containsForbiddenCharacter,
  sanitiseUserText,
  sanitiseUserTextRecord,
  type UserTextField,
} from './sanitise.js';

/**
 * INV-SEC-01, as corrected by the plan: EVERY user-text field is bidi-stripped,
 * format-character-stripped, NFC-normalised and length-capped AT STORAGE TIME.
 *
 * Three claims, three properties:
 *   1. the stored value contains no bidi-control and no `Cf` character;
 *   2. grading is invariant under inserted zero-width characters;
 *   3. the surrounding UI order is unchanged — which, for a string, means the stored
 *      value carries none of the twelve characters that can reorder one.
 *
 * Every invisible character in this file is written as a `\uXXXX` escape on purpose. A
 * literal U+202E in a test source reorders the test source.
 */

/**
 * A tight generator. A uniform sample of code points would spend its budget on ordinary
 * letters, so the alphabet is weighted towards exactly the characters the invariant is
 * about: every bidi control, every zero-width, C0 controls, combining marks that compose
 * under NFC, an astral character (surrogate-pair splitting), CJK, and enough ordinary
 * text that the result still looks like something a learner typed.
 */
const HOSTILE_ALPHABET: readonly string[] = [
  ...BIDI_CONTROLS,
  ...ZERO_WIDTH_CHARACTERS,
  ' ',
  '\u0001',
  '\u001B',
  '\n',
  '\t',
  ' ',
  'a',
  'e',
  'o',
  'n\u0303', // n + COMBINING TILDE -> U+00F1 under NFC
  'é',
  'e\u0301', // e + COMBINING ACUTE -> U+00E9 under NFC
  'ü',
  '日',
  '本',
  '\u{1F99C}', // parrot, astral: two UTF-16 units
  '.',
  '¿',
];

const arbHostileText = fc.string({ unit: fc.constantFrom(...HOSTILE_ALPHABET), maxLength: 60 });
const arbField = fc.constantFrom<UserTextField>(...USER_TEXT_FIELDS);

/** Base text with nothing the sanitiser removes, for the insertion property. */
const CLEAN_ALPHABET: readonly string[] = [
  'a',
  'e',
  'o',
  'n\u0303',
  'é',
  'e\u0301',
  'ü',
  '日',
  '\u{1F99C}',
  ' ',
  '.',
];
const arbCleanText = fc.string({ unit: fc.constantFrom(...CLEAN_ALPHABET), maxLength: 40 });

function insertAll(base: string, inserts: readonly { at: number; ch: string }[]): string {
  const points = [...base];
  // Insert from the back so earlier indices stay valid.
  const ordered = [...inserts].sort((x, y) => y.at - x.at);
  for (const { at, ch } of ordered) {
    points.splice(at % (points.length + 1), 0, ch);
  }
  return points.join('');
}

describe('INV-SEC-01 storage-time sanitiser', () => {
  it('[INV-SEC-01] the stored value carries no bidi-control and no Cf character, for any input and any field', () => {
    fc.assert(
      fc.property(arbField, arbHostileText, (field, raw) => {
        const stored = sanitiseUserText(field, raw);
        expect(containsForbiddenCharacter(stored)).toBe(false);
        for (const control of [...BIDI_CONTROLS, ...ZERO_WIDTH_CHARACTERS]) {
          expect(stored.includes(control)).toBe(false);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SEC-01] grading is invariant under inserted zero-width characters', () => {
    fc.assert(
      fc.property(
        arbField,
        arbCleanText,
        fc.array(
          fc.record({
            at: fc.nat({ max: 200 }),
            ch: fc.constantFrom(...ZERO_WIDTH_CHARACTERS, ...BIDI_CONTROLS),
          }),
          { maxLength: 8 },
        ),
        (field, base, inserts) => {
          const withInvisibles = insertAll(base, inserts);
          expect(sanitiseUserText(field, withInvisibles)).toBe(sanitiseUserText(field, base));
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SEC-01] the cap is in code points, so it never stores half a surrogate pair', () => {
    fc.assert(
      fc.property(arbField, arbHostileText, (field, raw) => {
        const stored = sanitiseUserText(field, raw);
        expect([...stored].length).toBeLessThanOrEqual(USER_TEXT_MAX_CODE_POINTS[field]);
        // A lone surrogate is `Cs`, which the strip removes; a split pair re-introduces one.
        expect(/\p{Cs}/u.test(stored)).toBe(false);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SEC-01] sanitising is idempotent, so a re-save never changes a stored value', () => {
    fc.assert(
      fc.property(arbField, arbHostileText, (field, raw) => {
        const once = sanitiseUserText(field, raw);
        expect(sanitiseUserText(field, once)).toBe(once);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-SEC-01] every user-text field named by the invariant has a cap and a write path', () => {
    expect([...USER_TEXT_FIELDS].sort()).toEqual([
      'read-and-respond',
      'report-note',
      'roleplay',
      'tier3-diff',
      'typed-answer',
    ]);
    for (const field of USER_TEXT_FIELDS) {
      expect(USER_TEXT_MAX_CODE_POINTS[field]).toBeGreaterThan(0);
      expect(USER_TEXT_MAX_CODE_POINTS[field]).toBeLessThanOrEqual(500);
    }
  });

  it('[INV-SEC-01] the record says what was adjusted, so no surface claims the learner typed what is stored', () => {
    const record = sanitiseUserTextRecord('report-note', `x${'y'.repeat(900)}`);
    expect(record.truncated).toBe(true);
    expect([...record.stored].length).toBe(USER_TEXT_MAX_CODE_POINTS['report-note']);
    expect(record.removedCharacters).toBeGreaterThan(0);

    expect(sanitiseUserTextRecord('typed-answer', 'el gato')).toEqual({
      field: 'typed-answer',
      stored: 'el gato',
      truncated: false,
      removedCharacters: 0,
    });
  });

  it('[INV-SEC-01] whitespace controls become spaces rather than being deleted with the other Cc', () => {
    // Deleting them alongside the other controls would store "unodostres".
    expect(sanitiseUserText('report-note', 'uno\ndos\ttres')).toBe('uno dos tres');
  });

  it('[INV-SEC-01] NFC runs after the strip, not before', () => {
    // A ZWNJ between the base letter and the combining mark blocks composition.
    // Normalising first would store "e" + U+0301; stripping first stores U+00E9.
    expect(sanitiseUserText('typed-answer', 'e\u200C\u0301')).toBe('é');
    expect(sanitiseUserText('typed-answer', 'e\u0301')).toBe('é');
    expect(sanitiseUserText('typed-answer', 'é')).toBe('é');
  });
});
