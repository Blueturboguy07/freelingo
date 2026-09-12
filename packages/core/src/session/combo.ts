/**
 * Combo and the gold bar — S030, S031.
 *
 * Owns INV-COM-01, INV-COM-02, INV-COM-04, INV-COM-11.
 *
 * Combo is a pure function of the ORDERED SEQUENCE OF GRADED ANSWERS in the session. Not
 * of the queue, not of the interstitial, not of the progress bar: `comboFromAnswers` takes
 * answers and nothing else, which is how INV-COM-11 ("an interstitial or a
 * main→mistakes transition that resets, freezes or fails to increment it") is falsifiable
 * rather than a hope about call order.
 */
import type { Answer } from './types.js';

/** `deep/01` §Rules: the `N IN A ROW` label first appears at **2**. */
export const COMBO_LABEL_THRESHOLD = 2;

/** `deep/01` §Rules: the fill flips green → gold at **exactly 6**, confirmed ×3. */
export const COMBO_GOLD_THRESHOLD = 6;

/** Combo at every session start, for every flavour including Practice/Story/Radio/Hub. */
export const COMBO_AT_SESSION_START = 0;

/**
 * One answer's effect on the combo.
 *
 * - `correct` / `accepted` → +1, **once per exercise**, never per pair, gap or stroke
 *   (INV-COM-01: the increment is applied by the caller once per answered index).
 * - `softCorrect` → +1. A soft-correct never breaks the combo (EC-COM-12).
 * - `wrong` → 0.
 * - a skip (`Can't speak now` / `Can't listen now`) → unchanged; it is not an error
 *   signal (EC-COM-13).
 * - `noVerdict` → unchanged; there was no answer to be right or wrong about.
 */
export function comboAfter(combo: number, answer: Answer): number {
  if (answer.skipped) return combo;
  switch (answer.verdict) {
    case 'correct':
    case 'softCorrect':
    case 'accepted':
      return combo + 1;
    case 'wrong':
      return 0;
    case 'noVerdict':
      return combo;
  }
}

/** The whole session's combo, from the answers alone. */
export function comboFromAnswers(answers: readonly Answer[]): number {
  let combo = COMBO_AT_SESSION_START;
  for (const answer of answers) combo = comboAfter(combo, answer);
  return combo;
}

/** INV-COM-04: a pure function of combo, with no animation dependency. */
export function barIsGold(combo: number): boolean {
  return combo >= COMBO_GOLD_THRESHOLD;
}

/** INV-COM-04: the accessible carrier of combo state (S030). Never animation-gated. */
export function comboLabelVisible(combo: number): boolean {
  return combo >= COMBO_LABEL_THRESHOLD;
}

export interface ComboView {
  readonly combo: number;
  readonly gold: boolean;
  readonly labelVisible: boolean;
  /** `{{n}} IN A ROW` — the caller supplies the localised frame. */
  readonly labelCount: number | null;
}

export function comboView(combo: number): ComboView {
  return {
    combo,
    gold: barIsGold(combo),
    labelVisible: comboLabelVisible(combo),
    labelCount: comboLabelVisible(combo) ? combo : null,
  };
}
