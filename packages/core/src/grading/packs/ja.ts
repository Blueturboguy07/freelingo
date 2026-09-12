/**
 * The Japanese grading fixture — spaceless, no word boundaries, contrastive diacritics.
 *
 * The adversarial pack. Every pack-parameterised rule the merge pass added exists because
 * Japanese broke a rule written for Spanish, so this fixture is what makes those rules
 * testable rather than merely declared:
 *
 *  - `spaceless` (INV-GRD-16): bunsetsu spaces are stripped in tier 1 and accepted
 *    silently; the two whitespace classes are unreachable.
 *  - `noWordBoundaries` (INV-GRD-28): the red banner bolds a character range snapped to
 *    ruby spans, and `You used the wrong word.` is unreachable.
 *  - `noWordDelimiter` (INV-GRD-26): listening is graded on baked readings.
 *  - `diacriticsContrastive` (INV-GRD-18): `かっこう` is not `がっこう`, and NFD must never
 *    get the chance to say otherwise.
 *  - mora-unit typo guards (INV-GRD-15): a five-CHARACTER guard can never fire here.
 *  - a `registerSlot` (INV-GRD-20/21).
 *
 * `readingsBySurface` is a baked lookup table, and it is the whole of this pack's ability
 * to answer "what does this read as?". There is no analyser here and there is none in the
 * app: INV-GRD-28's grep gate asserts it.
 */
import {
  TYPO_GUARD_MIN_LENGTH_MORA,
  TYPO_GUARD_REJECT_EDIT_ON_TARGET_LEXEME,
  TYPO_GUARD_REJECT_REAL_TARGET_WORD,
} from '../config.js';
import type { GradingPack, GradingUnit } from '../types.js';

/** A small taught-word list, for typo guard one. */
export const JA_WORDS: ReadonlySet<string> = new Set([
  'がっこう',
  'かっこう',
  '学校',
  'コーヒー',
  '帰る',
  '変える',
  'かえる',
  '橋',
  '箸',
  'はし',
  '食べる',
  '食べます',
  'すし',
]);

/**
 * Surface → baked reading. Built at pack build from the pack's own lexeme table; a
 * lookup, never an analysis (INV-GRD-17, INV-GRD-26).
 */
export const JA_READINGS: ReadonlyMap<string, string> = new Map([
  ['学校', 'がっこう'],
  ['がっこう', 'がっこう'],
  ['帰る', 'かえる'],
  ['変える', 'かえる'],
  ['かえる', 'かえる'],
  ['橋', 'はし'],
  ['箸', 'はし'],
  ['はし', 'はし'],
  ['橋を渡る', 'はしをわたる'],
  ['箸を渡る', 'はしをわたる'],
  ['コーヒー', 'こーひー'],
]);

export const JA_PACK: GradingPack = {
  packId: 'ja-fixture',
  label: 'Japanese (fixture)',

  orthographicEquivalences: [],
  spaceless: true,
  noWordBoundaries: true,
  noWordDelimiter: true,
  readingsBySurface: JA_READINGS,
  japaneseNormalisation: true,
  // INV-GRD-18: the tier-2 diacritic class is empty and unreachable for this pack. Dakuten
  // is not an accent; `かっこう` for `がっこう` is tier 3 (EC-GRD-29).
  diacriticsContrastive: true,
  contrastiveDiacritics: [],

  typoGuards: {
    rejectRealTargetWord: TYPO_GUARD_REJECT_REAL_TARGET_WORD,
    rejectEditOnTargetLexeme: TYPO_GUARD_REJECT_EDIT_ON_TARGET_LEXEME,
    minimumLength: TYPO_GUARD_MIN_LENGTH_MORA,
    lengthUnit: 'mora',
    // A dropped `ー` or `っ` changes the word by ear (EC-GRD-30): never a typo.
    preserveMoraCount: true,
  },
  targetLanguageWords: JA_WORDS,
  // No whitespace means no dropped-token class: there is no token to drop without a
  // tokenizer. The set is empty rather than absent so the field is still read from the
  // pack and the class is still total.
  functionClassTokens: new Set<string>(),

  targetScriptRanges: [
    [0x3041, 0x309f], // hiragana
    [0x30a0, 0x30ff], // katakana, including the chōonpu
    [0x4e00, 0x9fff], // CJK unified ideographs
    [0xff66, 0xff9d], // halfwidth katakana, before NFKC gets to it
  ],
  // EC-GRD-25: an answer with zero target-script characters never arms CHECK. `neko` is
  // not a fourth accepted class.
  scriptOnlyAnswers: true,
  // EC-GRD-34: tiles join with the empty string, "so the strip matches while the visual
  // gap remains".
  wordBankJoinDelimiter: '',

  openResponseLengthUnit: 'characters',
  registerSlot: {
    suffixesByRegister: {
      polite: ['ます', 'ました', 'です', 'でした'],
      plain: ['る', 'う', 'く', 'た', 'だ', 'い'],
    },
    advisoryNote: 'Try the polite form next time.',
  },
};

/** A masu-form unit: register is the lesson (EC-GRD-31). */
export const JA_UNIT: GradingUnit = {
  unitId: 'ja-u1',
  register: 'polite',
  // EC-GRD-42: terminal punctuation is one silent class over `。`, the period forms and
  // empty. Corner brackets are NOT here — this unit does not teach quotation.
  punctuationEquivalenceClass: ['。', '.', '！', '？', '、', '「', '」'],
  gradedPunctuation: [],
  taughtInflections: {
    いく: ['行く', '行きます', '行きました', 'いく', 'いきます'],
    たべる: ['食べる', '食べます', 'たべる', 'たべます'],
  },
  openResponseMinimumLength: 6,
};

/**
 * A quotation-teaching unit (INV-GRD-29's falsifier).
 *
 * `「` and `」` are GRADED CONTENT here, so they stay out of the equivalence class and
 * `はいと言いました` is tier 3 against `「はい」と言いました`. Declared per unit, "never by
 * a global regex" — which is why the same pack, one unit over, folds them.
 */
export const JA_QUOTATION_UNIT: GradingUnit = {
  ...JA_UNIT,
  unitId: 'ja-u-quote',
  register: null,
  gradedPunctuation: ['「', '」'],
};
