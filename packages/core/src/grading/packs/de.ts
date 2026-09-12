/**
 * The German grading fixture — the only pack with an `orthographic_equivalences` table.
 *
 * It exists for one invariant. INV-GRD-13's falsifier is "a shared or hard-coded
 * equivalence map, or `heisst` failing while `ano` passes against `año`", and BOTH halves
 * need two packs to be observable at all: one where `ss` is the same string as `ß`, and one
 * where a missing tilde is a different word. With only es and ja in the tree the invariant
 * would be asserted against a table nobody had ever filled in.
 *
 * EC-GRD-23: "Make `ß→ss` and umlaut→`ae/oe/ue` a **tier-1** normalisation for the German
 * pack: silent accept, no accent note, no combo reset. Declared as a per-pack
 * `orthographic_equivalences` table so it never leaks into Spanish, where `ñ` is
 * contrastive."
 *
 * Tier 1, not tier 2, and that is the whole point: a learner on an English keyboard typing
 * `heisst` has not made a mistake worth a note.
 */
import {
  TYPO_GUARD_MIN_LENGTH_CHARACTERS,
  TYPO_GUARD_REJECT_EDIT_ON_TARGET_LEXEME,
  TYPO_GUARD_REJECT_REAL_TARGET_WORD,
} from '../config.js';
import type { GradingPack, GradingUnit } from '../types.js';

/** A small German word list, for typo guard one. */
export const DE_WORDS: ReadonlySet<string> = new Set([
  'das',
  'der',
  'die',
  'heisst',
  'heißt',
  'mädchen',
  'maedchen',
  'schreibt',
  'und',
  'wie',
]);

export const DE_PACK: GradingPack = {
  packId: 'de-fixture',
  label: 'German (fixture)',

  // Longest source first is handled by `applyOrthographicEquivalences`; the order here is
  // the order a pack author would write it.
  orthographicEquivalences: [
    ['ß', 'ss'],
    ['ä', 'ae'],
    ['ö', 'oe'],
    ['ü', 'ue'],
    ['Ä', 'Ae'],
    ['Ö', 'Oe'],
    ['Ü', 'Ue'],
  ],
  spaceless: false,
  noWordBoundaries: false,
  noWordDelimiter: false,
  readingsBySurface: new Map(),
  japaneseNormalisation: false,
  diacriticsContrastive: false,
  contrastiveDiacritics: [],

  typoGuards: {
    rejectRealTargetWord: TYPO_GUARD_REJECT_REAL_TARGET_WORD,
    rejectEditOnTargetLexeme: TYPO_GUARD_REJECT_EDIT_ON_TARGET_LEXEME,
    minimumLength: TYPO_GUARD_MIN_LENGTH_CHARACTERS,
    lengthUnit: 'characters',
    preserveMoraCount: false,
  },
  targetLanguageWords: DE_WORDS,
  functionClassTokens: new Set(['das', 'der', 'die', 'und']),

  targetScriptRanges: [
    [0x41, 0x5a],
    [0x61, 0x7a],
    [0xc0, 0x17f],
  ],
  scriptOnlyAnswers: false,
  wordBankJoinDelimiter: ' ',

  openResponseLengthUnit: 'tokens',
  registerSlot: null,
};

export const DE_UNIT: GradingUnit = {
  unitId: 'de-u1',
  register: null,
  punctuationEquivalenceClass: ['.', '!', '?'],
  gradedPunctuation: [],
  taughtInflections: { heissen: ['heißt', 'heisst'] },
  openResponseMinimumLength: 4,
};
