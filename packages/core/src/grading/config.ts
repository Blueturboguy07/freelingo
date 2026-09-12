/**
 * Every grading constant, named, in one file.
 *
 * Nothing in this package may inline one of these values. That is not a style rule:
 * INV-GRD-02 says "a build where the guards are inlined fails this test". Two gates in
 * `typo-guards.test.ts` enforce it, and this is exactly what they do — no more:
 *
 *  - "no threshold lives outside the config" strips the comments from `typo-guards.ts`
 *    (the ONLY file allowed to read a guard field) and fails on any numeric literal but
 *    `0`, on any comparison against a numeral, and on any other file in this directory
 *    reading `rejectRealTargetWord`, `rejectEditOnTargetLexeme` or `minimumLength`;
 *  - "no copy string lives outside the config" strips the comments from every non-test
 *    source in this directory and fails if any of them spells one of the note, banner or
 *    re-prompt strings below. Comments may quote them; executable code may not.
 *
 * If you need a number or a copy string anywhere in this package, it comes from here or
 * from the active pack.
 *
 * Sources: `deep/01-lesson-state-machine.md` §S5, §S13 and §Rules and constants;
 * `deep/00-EDGE-CASES.md` EC-GRD-01…EC-GRD-42; the plan's EC-GRD-03 ruling. Where `deep/01`
 * has been corrected by its own adversarial review, the correction wins and is cited at the
 * constant (see `CORRECT_HEADLINES`).
 */
import type { Tier2Class } from './types.js';

// ---------------------------------------------------------------------------
// The tier-2 note pool (INV-GRD-01)
// ---------------------------------------------------------------------------

/**
 * The six tier-2 notes, one per class, in classification order.
 *
 * "Each class maps to exactly one note string, and the pool contains **six** notes, not
 * four" (INV-GRD-01). The four are `deep/01` §S5's original ladder — whitespace,
 * capitalisation/terminal punctuation, diacritics, typo. The merge pass added
 * whitespace-OMISSION (EC-GRD-02: "a channel the three-tier checker has no branch for")
 * and the plan's EC-GRD-03 ruling added the dropped-token class.
 *
 * `capitalisation` maps to `null` on purpose and is still a member of the pool: the class
 * exists, is reachable, and is accepted SILENTLY (`deep/01` §S5: "capitalisation and
 * terminal punctuation (silent)"). A silent class with no pool entry would be a class the
 * banner has no contract for, which is the state INV-GRD-01 exists to forbid.
 *
 * Strings are verbatim from `strings@09-11` where the bundle has them. `You missed a
 * space.` and `You missed a word.` are Freelingo strings: the bundle has neither, and
 * both channels are Freelingo rulings (EC-GRD-02, EC-GRD-03).
 */
export const TIER2_NOTE_POOL: Readonly<Record<Tier2Class, string | null>> = Object.freeze({
  'whitespace-insertion': 'You have an extra space.',
  'whitespace-omission': 'You missed a space.',
  capitalisation: null,
  diacritic: 'Pay attention to the accents.',
  typo: 'You have a typo.',
  'dropped-token': 'You missed a word.',
});

/**
 * The classification ORDER (INV-GRD-01). The ladder is total and the first class whose
 * predicate holds wins; `tier2.ts` iterates this array and nothing else.
 *
 * The order is the invariant's, extended by the plan's ruling at the end. It is also the
 * order of increasing distance: a difference a whitespace fold explains is never reported
 * as a typo, even though deleting a space is one edit.
 */
export const TIER2_CLASS_ORDER: readonly Tier2Class[] = Object.freeze([
  'whitespace-insertion',
  'whitespace-omission',
  'capitalisation',
  'diacritic',
  'typo',
  'dropped-token',
] as const);

// ---------------------------------------------------------------------------
// The three typo guards (INV-GRD-02, INV-GRD-15)
// ---------------------------------------------------------------------------

/**
 * Guard 1 — the mistyped form must not itself be a target-language word.
 *
 * This is the guard that explains the recorded `caso`/`casa` failure: `caso` is Spanish
 * for *case*, so forgiveness routes to wrong-word handling instead (`deep/01` §S5).
 */
export const TYPO_GUARD_REJECT_REAL_TARGET_WORD = true;

/**
 * Guard 2 — the edit must not fall on the item's target lexeme.
 *
 * Candidate explanation for `gatto`/`gato`, which is not a Spanish word. Forgiving a slip
 * on the very word the item is teaching would teach the slip.
 */
export const TYPO_GUARD_REJECT_EDIT_ON_TARGET_LEXEME = true;

/** Guard 3, Latin packs — minimum word length in characters (`deep/01` §S5). */
export const TYPO_GUARD_MIN_LENGTH_CHARACTERS = 5;

/**
 * Guard 3, mora packs — minimum word length in mora of the reading.
 *
 * EC-GRD-26: `がっこう` is four characters, so a five-character guard can never fire in a
 * Japanese pack. "A tier-2 channel that is structurally dead in one language is a
 * regression, not a ruling."
 */
export const TYPO_GUARD_MIN_LENGTH_MORA = 4;

/** Edit distance a tier-2 typo may span. One. Not a tunable; the class is "single-edit". */
export const TYPO_MAX_EDIT_DISTANCE = 1;

// ---------------------------------------------------------------------------
// Open response (INV-GRD-08, INV-GRD-10, INV-GRD-22)
// ---------------------------------------------------------------------------

/**
 * Reject an open response whose token overlap with the prompt reaches this ratio
 * (EC-GRD-19). A verbatim paste is 1.0; a subsequence of the prompt is 1.0.
 */
export const PROMPT_OVERLAP_REJECT_RATIO = 0.7;

/** The re-prompt shown instead of a verdict when the prompt-copy guard fires. */
export const PROMPT_COPY_REPROMPT = 'try it in your own words';

/**
 * The re-prompt when the reply is simply too short or carries no required lexeme.
 *
 * A different string from the prompt-copy one on purpose: a learner who wrote three words
 * of their own and a learner who pasted the paragraph back have made different mistakes,
 * and telling both of them "try it in your own words" tells one of them nothing.
 */
export const BELOW_GATE_REPROMPT = 'Write a little more.';

// ---------------------------------------------------------------------------
// Banner copy (INV-GRD-11, INV-GRD-12)
// ---------------------------------------------------------------------------

/**
 * The EIGHT correct-verdict headlines. Never gated by Motivational messages.
 *
 * Source: `deep/00-PRODUCT-MAP.md:109` (S044), which lists exactly these eight. `deep/01`
 * §S13 listed a ninth, `Nice try!`, and its own adversarial review deleted it:
 * `deep/01-lesson-state-machine.md:369` (§A7) — "`Nice try!` listed in the **correct**-banner
 * headline pool (S13). **Unsupported and probably wrong.** … In-bundle, `Nice try!` (660) is
 * paired with `Nice try! You earned {{xp}} XP` (1208), the shape of a *failed* challenge/test
 * result screen … *Correction:* move `Nice try!` to the wrong/consolation pool."
 *
 * That correction supersedes §S13 and this pool follows it. It is load-bearing rather than
 * cosmetic: `bannerFor` indexes this pool modulo its length, so a ninth member is a string a
 * learner who answered CORRECTLY can be shown — and `Nice try!` is the failure headline of
 * S085 (`Nice try! You earned {{xp}} XP`). `banner.test.ts` pins the pool to these eight and
 * asserts the absence of `Nice try!` by name, so a re-read of the stale §S13 list cannot put
 * it back in silence.
 */
export const CORRECT_HEADLINES: readonly string[] = Object.freeze([
  'Nice!',
  'Nicely done!',
  'Awesome!',
  'Great job!',
  'Excellent!',
  'Correct!',
  'Great!',
  'Amazing!',
]);

/** The red banner's lead-in when the answer is simply wrong. */
export const WRONG_HEADLINE = 'Correct solution:';

/**
 * The red banner's headline when the learner's token is a real but wrong word.
 *
 * Unreachable for `noWordBoundaries` packs (INV-GRD-28): without a tokenizer there is no
 * "word" to name, and shipping one is forbidden (`deep/10` §S9).
 */
export const WRONG_WORD_HEADLINE = 'You used the wrong word.';

/** The register class's own headline (EC-GRD-31). Never the wrong-word headline. */
export const REGISTER_HEADLINE = 'Use the polite form here.';

/** Consolation copy, suppressed when Motivational messages is OFF (EC-GRD-20). */
export const CONSOLATION_COPY = "Don't worry! Mistakes help you learn.";

/** The label beside a correct verdict that matched a non-preferred alternate. */
export const ANOTHER_CORRECT_SOLUTION = 'Another correct solution:';

/**
 * The banner's utility row: exactly three slots (EC-GRD-21).
 *
 * The sentence-discussion forum is gone from the 2026 bundle — its label appears in none
 * of the 3,535 strings — and a local-only clone has no forum for it to open, so the third
 * slot is Explain My Answer and the icon that used to be there is not shipped at all.
 * INV-GRD-12 greps this package for that label; `banner.test.ts` owns the grep, and it is
 * the only file in the tree allowed to spell it.
 */
export const BANNER_UTILITY_SLOTS: readonly ['snooze', 'report', 'explain-my-answer'] =
  Object.freeze(['snooze', 'report', 'explain-my-answer'] as const);

// ---------------------------------------------------------------------------
// ja tier-1 normalisation (INV-GRD-19)
// ---------------------------------------------------------------------------

/**
 * The dash-fold set: every character that is folded to U+30FC KATAKANA-HIRAGANA
 * PROLONGED SOUND MARK before compare (EC-GRD-30).
 *
 * U+2010…U+2015 are the Unicode dashes an IME or a paste can produce; U+FF0D is the
 * fullwidth hyphen-minus, U+002D the ASCII one, U+2212 the minus sign. `一` (U+4E00) is
 * NOT in this set: it is folded only between two katakana, which `normaliseJa` handles
 * positionally, because folding it unconditionally would destroy the numeral one.
 */
export const JA_CHOONPU_CONFUSABLES: readonly string[] = Object.freeze([
  '‐',
  '‑',
  '‒',
  '–',
  '—',
  '―',
  '－',
  '-',
  '−',
]);

/** The character everything in `JA_CHOONPU_CONFUSABLES` folds to. */
export const JA_CHOONPU = 'ー';

/** U+4E00, folded to the chōonpu only when it sits between two katakana. */
export const JA_KANJI_ONE = '一';

/**
 * A suggested default for a unit's punctuation equivalence class (EC-GRD-42).
 *
 * A DEFAULT a pack author copies into a unit declaration, never a rule this package
 * applies: INV-GRD-29's falsifier is a global regex, and a constant the grader reached for
 * on its own would be one. `foldEquivalentPunctuation` reads the unit and only the unit.
 */
export const JA_DEFAULT_TERMINAL_PUNCTUATION: readonly string[] = Object.freeze([
  '。', // 。
  '！', // ！
  '？', // ？
  '.',
  '!',
  '?',
]);

/**
 * Iteration marks and what they repeat: `々` repeats the preceding kanji, `ゝ`/`ヽ` the
 * preceding kana, `ゞ`/`ヾ` the preceding kana voiced.
 */
export const JA_ITERATION_MARKS: readonly string[] = Object.freeze(['々', 'ゝ', 'ゞ', 'ヽ', 'ヾ']);

/** Small kana that do not carry a mora of their own (they ride the preceding one). */
export const JA_NON_MORAIC_SMALL_KANA: readonly string[] = Object.freeze([
  'ゃ', // ゃ
  'ゅ', // ゅ
  'ょ', // ょ
  'ャ', // ャ
  'ュ', // ュ
  'ョ', // ョ
  'ぁ', // ぁ
  'ぃ', // ぃ
  'ぅ', // ぅ
  'ぇ', // ぇ
  'ぉ', // ぉ
  'ァ', // ァ
  'ィ', // ィ
  'ゥ', // ゥ
  'ェ', // ェ
  'ォ', // ォ
]);

// ---------------------------------------------------------------------------
// Cost (stubbed; belongs to packages/core/economy — see the task's blockers)
// ---------------------------------------------------------------------------

/** `Each mistake costs 1 heart!` (`strings@09-11`). Tier 3 and `register` only. */
export const HEART_COST_WRONG = 1;

/** Tier 2 is free. "no heart, combo unbroken" (`deep/01` §S5). */
export const HEART_COST_SOFT_CORRECT = 0;
