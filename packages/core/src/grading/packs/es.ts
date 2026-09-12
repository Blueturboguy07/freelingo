/**
 * The Spanish grading fixture — a Latin pack with ONE contrastive diacritic.
 *
 * Not a content pack: a fixture that exercises every pack-parameterised branch of the
 * grader from the es side, so the properties can be driven against a real configuration
 * instead of an invented one. `packs/ja.ts` is its opposite number and every property runs
 * against both.
 *
 * ## Why `diacriticsContrastive` is false here, with one exception
 *
 * The brief calls es "contrastive-diacritic", and EC-GRD-23 says the equivalence table
 * exists "so it never leaks into Spanish, where `ñ` is contrastive". But EC-GRD-06 records
 * a soft correct with `Pay attention to the accents.` for a missing accent, and INV-GRD-15
 * forbids a tier-2 channel that is structurally dead. Both are true at once only if
 * contrastiveness is PER MARK: the combining tilde is contrastive (`año` ≠ `ano`), the
 * acute is not (`está` ~ `esta`).
 *
 * So `diacriticsContrastive` — the whole-pack switch INV-GRD-18 is about — is false here
 * and true for `ja`, and `contrastiveDiacritics` carries the one mark Spanish keeps. That
 * is exactly INV-GRD-13's falsifier read forwards: `heisst` passes (de) and `ano` does not
 * (es).
 */
import {
  TYPO_GUARD_MIN_LENGTH_CHARACTERS,
  TYPO_GUARD_REJECT_EDIT_ON_TARGET_LEXEME,
  TYPO_GUARD_REJECT_REAL_TARGET_WORD,
} from '../config.js';
import type { GradingPack, GradingUnit } from '../types.js';

/** U+0303 COMBINING TILDE. The one mark Spanish grades (`año` is not `ano`). */
export const COMBINING_TILDE = '̃';

/**
 * A small Spanish word list, for typo guard one.
 *
 * A fixture, not the shipped lexicon: it carries `caso` (so the recorded `caso`/`casa`
 * failure reproduces), `ano` (so INV-GRD-13's falsifier reproduces) and deliberately NOT
 * `gatto`, which is Italian — that is why the second recorded failure needs a different
 * guard to explain it, and why INV-GRD-02's table is interesting rather than uniform.
 */
export const ES_WORDS: ReadonlySet<string> = new Set([
  'a',
  'ano',
  'año',
  'casa',
  'caso',
  'carta',
  'come',
  'de',
  'el',
  'ella',
  'en',
  'escribe',
  'esta',
  'está',
  'gato',
  'la',
  'las',
  'los',
  'niño',
  'perro',
  'que',
  'se',
  'un',
  'una',
  'y',
]);

/** Function-class tokens whose omission is soft (the plan's EC-GRD-03 ruling). */
export const ES_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'a',
  'de',
  'el',
  'en',
  'la',
  'las',
  'los',
  'que',
  'se',
  'un',
  'una',
  'y',
]);

export const ES_PACK: GradingPack = {
  packId: 'es-fixture',
  label: 'Spanish (fixture)',

  orthographicEquivalences: [],
  spaceless: false,
  noWordBoundaries: false,
  noWordDelimiter: false,
  readingsBySurface: new Map(),
  japaneseNormalisation: false,
  diacriticsContrastive: false,
  contrastiveDiacritics: [COMBINING_TILDE],

  typoGuards: {
    rejectRealTargetWord: TYPO_GUARD_REJECT_REAL_TARGET_WORD,
    rejectEditOnTargetLexeme: TYPO_GUARD_REJECT_EDIT_ON_TARGET_LEXEME,
    minimumLength: TYPO_GUARD_MIN_LENGTH_CHARACTERS,
    lengthUnit: 'characters',
    preserveMoraCount: false,
  },
  targetLanguageWords: ES_WORDS,
  functionClassTokens: ES_FUNCTION_WORDS,

  // Basic Latin plus Latin-1 Supplement and Latin Extended-A, which is where `ñ`, the
  // accented vowels and `ü` live.
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

/** An ordinary Spanish unit: terminal punctuation folds, nothing is graded punctuation. */
export const ES_UNIT: GradingUnit = {
  unitId: 'es-u1',
  register: null,
  punctuationEquivalenceClass: ['.', '!', '?'],
  gradedPunctuation: [],
  taughtInflections: {
    escribir: ['escribe', 'escribo', 'escribes'],
    comer: ['come', 'comes', 'como'],
  },
  openResponseMinimumLength: 4,
};
