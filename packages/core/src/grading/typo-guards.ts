/**
 * The three typo guards (INV-GRD-02, INV-GRD-15) — and nothing else.
 *
 * This file is the whole of the decision "may a single edit be forgiven?". It exists on
 * its own because INV-GRD-02 says "a build where the guards are inlined fails this test",
 * and the only way to assert that mechanically is to have ONE file that decides the
 * guards and to scan it. `guards-are-named.test.ts` fails if any threshold is compared
 * against a literal here or read anywhere else: every threshold arrives through `guards`,
 * which the caller resolved from the ACTIVE pack (INV-GRD-15 — "the three typo guards
 * resolve per pack").
 *
 * Why this matters beyond tidiness: the corpus does not know which guard Duolingo uses.
 * EC-GRD-05 calls it "the single highest-value untested question in the entire corpus" —
 * `You have a typo.` ships, yet both recorded one-letter tests failed hard. One signed-in
 * session settles it, and when it does, the fix must be a pack edit and not a code change.
 */
import { moraCount } from './ja.js';
import type { TypoGuards } from './types.js';

/** Which guard refused. The three names are the three guards, in the spec's order. */
export type TypoGuardName = 'real-target-word' | 'edit-on-target-lexeme' | 'minimum-length';

/** What a guard decision is taken over. Every field comes from the pack or the item. */
export interface TypoGuardInput {
  /** The learner's form of the token that differs. */
  readonly mistypedWord: string;
  /** The accepted form of that token. */
  readonly targetWord: string;
  /** The baked reading of the target word, when the pack bakes readings. */
  readonly targetReading: string | null;
  /** The baked (or typed) reading of the learner's word, for the mora-preserving check. */
  readonly answerReading: string | null;
  /** Code-point offset of the edit inside `targetString`. */
  readonly editOffsetInTarget: number;
  /** The whole accepted string the edit was measured against. */
  readonly targetString: string;
  /** The surface of the lexeme this item teaches, or `null` when it teaches none. */
  readonly targetLexemeSurface: string | null;
  /** The pack's word list, for guard one. */
  readonly targetLanguageWords: ReadonlySet<string>;
}

/** The decision, with every refusal named so a test can assert which guard fired. */
export interface TypoGuardOutcome {
  readonly forgiven: boolean;
  readonly rejectedBy: readonly TypoGuardName[];
}

/** Code-point length, or mora of the reading when the pack measures in mora. */
function measuredLength(word: string, reading: string | null, guards: TypoGuards): number {
  if (guards.lengthUnit === 'mora') return moraCount(reading ?? word);
  return [...word].length;
}

/**
 * Does `offset` fall inside an occurrence of `lexeme` in `targetString`?
 *
 * Guard two is "the edit is not on the item's target lexeme", and "on" is positional:
 * a slip elsewhere in the sentence is an ordinary typo; a slip on the very word the item
 * is teaching would teach the slip.
 */
function editLandsOnLexeme(targetString: string, lexeme: string, offset: number): boolean {
  const chars = [...targetString];
  const width = [...lexeme].length;
  if (width === 0) return false;
  let landed = false;
  chars.forEach((_, start) => {
    if (chars.slice(start, start + width).join('') !== lexeme) return;
    if (offset >= start && offset < start + width) landed = true;
  });
  return landed;
}

/**
 * Apply the three guards.
 *
 * They are independent: each is evaluated and each refusal recorded, so a test can show
 * the whole table rather than whichever guard happened to be checked first. INV-GRD-02's
 * two recorded failures are a golden row of that table.
 *
 * The mora-preserving check rides on guard three rather than being a fourth guard: it is
 * how "the word is long enough" is expressed in a language where length is contrastive.
 * EC-GRD-30: "A *missing* 長音符 is tier 3, because vowel length is contrastive."
 */
export function applyTypoGuards(input: TypoGuardInput, guards: TypoGuards): TypoGuardOutcome {
  const rejectedBy: TypoGuardName[] = [];

  if (guards.rejectRealTargetWord && input.targetLanguageWords.has(input.mistypedWord)) {
    rejectedBy.push('real-target-word');
  }

  if (
    guards.rejectEditOnTargetLexeme &&
    input.targetLexemeSurface !== null &&
    editLandsOnLexeme(input.targetString, input.targetLexemeSurface, input.editOffsetInTarget)
  ) {
    rejectedBy.push('edit-on-target-lexeme');
  }

  const tooShort =
    measuredLength(input.targetWord, input.targetReading, guards) < guards.minimumLength;
  const moraPreserved =
    !guards.preserveMoraCount ||
    moraCount(input.answerReading ?? input.mistypedWord) ===
      moraCount(input.targetReading ?? input.targetWord);
  if (tooShort || !moraPreserved) rejectedBy.push('minimum-length');

  return { forgiven: rejectedBy.length === 0, rejectedBy };
}
