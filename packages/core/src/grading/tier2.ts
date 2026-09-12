/**
 * Tier 2 — the soft-correct ladder (INV-GRD-01).
 *
 * > "Tier-2 classification is total and ordered: whitespace-insertion →
 * > whitespace-omission → capitalisation/terminal punctuation → non-contrastive
 * > diacritics → single-edit typo. Each class maps to exactly one note string, and the
 * > pool contains **six** notes, not four."
 *
 * ## Total
 *
 * `classifyTier2` is defined for every pair of strings and returns a member of
 * `Tier2Class` or `null`. It never throws and never returns a class outside the pool.
 * `null` means tier 3 — "everything else" (`deep/01` §S5).
 *
 * ## Ordered, and what "ordered" buys
 *
 * Below the two whitespace classes the folds are CUMULATIVE: each class applies its own
 * fold on top of every fold above it, and the first class whose fold makes the two strings
 * equal wins. So the reported class is the least-permissive fold that explains the
 * difference.
 *
 * That is what makes the order load-bearing rather than decorative. Two examples where two
 * classes both match and the order decides:
 *
 *  - `Casa` for `casa` is a capitalisation slip AND a single substitution. The ladder calls
 *    it `capitalisation` and accepts it silently; a checker that tried the typo class first
 *    would run the three guards on a shift key.
 *  - `esta` for `está` is a dropped accent AND a single substitution. The ladder says
 *    `Pay attention to the accents.`, not `You have a typo.` — which is the whole point of
 *    EC-GRD-06 having its own note.
 *
 * A difference that NO class explains is `null`: tier 3, "everything else" (`deep/01` §S5).
 * A difference that mixes a word-boundary slip with a case or accent slip is one of those,
 * deliberately — the whitespace classes fold whitespace away and the classes below them
 * need the tokens, so nothing folds both at once, and an answer that got two different
 * things wrong is not soft-corrected on either.
 *
 * ## The sixth class
 *
 * The plan's EC-GRD-03 ruling adds `dropped-token` at the end of the ladder: "Soft-correct
 * `You missed a word.` when exactly one function-class token is missing; else hard wrong."
 * Six classes, six notes in `TIER2_NOTE_POOL`, "six notes, not four".
 */
import { TIER2_CLASS_ORDER, TIER2_NOTE_POOL } from './config.js';
import { droppedTokens, singleTokenEdit } from './distance.js';
import {
  foldAllWhitespace,
  foldCase,
  foldDiacritics,
  foldEquivalentPunctuation,
  tokenise,
  whitespaceCount,
} from './normalise.js';
import { applyTypoGuards, type TypoGuardOutcome } from './typo-guards.js';
import type { GradingPack, GradingUnit, Tier2Class } from './types.js';

/**
 * What the ladder needs to know about the accepted form it is comparing against, over
 * and above the string itself. Passed in rather than re-derived from the item, because
 * the strings reaching this module are already tier-1 normalised and the item's are not.
 */
export interface Tier2Context {
  /** The baked reading of this accepted form, when the pack bakes readings. */
  readonly targetReading: string | null;
  /** The surface of the lexeme the item teaches, tier-1 normalised, or `null`. */
  readonly targetLexemeSurface: string | null;
}

/** A classified tier-2 difference. */
export interface Tier2Result {
  readonly tier2Class: Tier2Class;
  /** The pooled note, or `null` for the silent capitalisation class. */
  readonly note: string | null;
  /** Present only for the typo class: which guards ran and which refused. */
  readonly guards: TypoGuardOutcome | null;
}

/**
 * The folds, in ladder order. Exported so a test can drive any one of them alone.
 *
 * The two whitespace classes fold whitespace AWAY entirely; every class below them keeps
 * single spaces, because they need tokens. Tier 1 has already collapsed runs and trimmed
 * (`trivialNormalise`), which is why "spaces collapsed" (`scope/09`) never reaches tier 2
 * at all: the only whitespace differences left here are an inserted or an omitted word
 * BOUNDARY, which is exactly what the two classes are named after.
 */
export function foldThroughWhitespace(text: string): string {
  return foldAllWhitespace(text);
}
export function foldThroughCapitalisation(text: string, unit: GradingUnit): string {
  return foldEquivalentPunctuation(foldCase(text), unit);
}
export function foldThroughDiacritics(text: string, pack: GradingPack, unit: GradingUnit): string {
  return foldDiacritics(foldThroughCapitalisation(text, unit), pack);
}

/**
 * Classify the difference between a tier-1-normalised answer and a tier-1-normalised
 * accepted form. Returns `null` when no class explains it — that is tier 3.
 *
 * Call only when the two strings are NOT already equal; an equal pair is tier 1 and this
 * function would report `whitespace-insertion` for it, which is meaningless.
 */
export function classifyTier2(
  answer: string,
  target: string,
  pack: GradingPack,
  unit: GradingUnit,
  context: Tier2Context,
): Tier2Result | null {
  for (const tier2Class of TIER2_CLASS_ORDER) {
    const guards = matches(tier2Class, answer, target, pack, unit, context);
    if (guards === false) continue;
    return {
      tier2Class,
      note: TIER2_NOTE_POOL[tier2Class],
      guards: guards === true ? null : guards,
    };
  }
  return null;
}

/**
 * One class's predicate. `false` means "not this class"; `true` means it matched; a
 * `TypoGuardOutcome` means it matched and carries the guard table (typo only).
 */
function matches(
  tier2Class: Tier2Class,
  answer: string,
  target: string,
  pack: GradingPack,
  unit: GradingUnit,
  context: Tier2Context,
): boolean | TypoGuardOutcome {
  switch (tier2Class) {
    case 'whitespace-insertion':
    case 'whitespace-omission': {
      // Unreachable for a spaceless pack (INV-GRD-16): tier 1 already removed every
      // space, so the fold below is the identity and the strings would have matched at
      // tier 1. Stated explicitly as well as implied, because "unreachable" is the
      // invariant and an implication is not a statement.
      if (pack.spaceless) return false;
      if (foldThroughWhitespace(answer) !== foldThroughWhitespace(target)) return false;
      const extra = whitespaceCount(answer) >= whitespaceCount(target);
      return tier2Class === 'whitespace-insertion' ? extra : !extra;
    }

    case 'capitalisation':
      return foldThroughCapitalisation(answer, unit) === foldThroughCapitalisation(target, unit);

    case 'diacritic': {
      // INV-GRD-18: for a pack declaring contrastive diacritics the class is EMPTY and
      // unreachable through any normalisation path. `foldDiacritics` is already the
      // identity for such a pack; this line makes the emptiness a decision rather than a
      // consequence of one, so a future change to the fold cannot resurrect the class.
      if (pack.diacriticsContrastive) return false;
      return (
        foldThroughDiacritics(answer, pack, unit) === foldThroughDiacritics(target, pack, unit)
      );
    }

    case 'typo': {
      const a = foldThroughDiacritics(answer, pack, unit);
      const t = foldThroughDiacritics(target, pack, unit);
      const joinWidth = pack.spaceless ? 0 : 1;
      const edit = singleTokenEdit(tokenise(a, pack), tokenise(t, pack), joinWidth);
      if (edit === null) return false;
      const outcome = applyTypoGuards(
        {
          mistypedWord: edit.answerToken,
          targetWord: edit.targetToken,
          targetReading: context.targetReading,
          answerReading: null,
          editOffsetInTarget: edit.targetOffset,
          targetString: t,
          targetLexemeSurface:
            context.targetLexemeSurface === null
              ? null
              : foldThroughDiacritics(context.targetLexemeSurface, pack, unit),
          targetLanguageWords: pack.targetLanguageWords,
        },
        pack.typoGuards,
      );
      return outcome.forgiven ? outcome : false;
    }

    case 'dropped-token': {
      if (pack.spaceless) return false;
      const a = foldThroughDiacritics(answer, pack, unit);
      const t = foldThroughDiacritics(target, pack, unit);
      const dropped = droppedTokens(tokenise(a, pack), tokenise(t, pack));
      if (dropped === null || dropped.length !== 1) return false;
      return pack.functionClassTokens.has(dropped[0]!);
    }
  }
}
