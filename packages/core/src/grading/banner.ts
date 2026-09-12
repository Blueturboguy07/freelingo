/**
 * The result banner's contract (INV-GRD-11, INV-GRD-12).
 *
 * > "For every verdict class × every `Motivational messages` state the banner carries a
 * > non-empty headline from the verdict pool. Falsifier: a rendered banner with an empty
 * > headline under the toggle." (INV-GRD-11)
 *
 * EC-GRD-20 is the rule the toggle actually obeys: "**The toggle gates encouragement copy,
 * never verdict copy.**" So `Motivational messages` OFF removes the consolation line and
 * skill-specific encouragement, and removes nothing else. The headline survives in every
 * combination, including the two easy to miss:
 *
 *  - the SILENT tier-2 class (`capitalisation`) has no note, so its headline falls back to
 *    the correct pool rather than to the empty string;
 *  - `register` has its OWN headline and never borrows the wrong-word one, because the
 *    lexeme was right (EC-GRD-31).
 *
 * INV-GRD-12: the utility row renders exactly the snooze, report and EMA slots, the old
 * forum label appears nowhere, and a snoozed item appears in zero sessions for the rest of
 * that `local_day` while its `due_at` and `stability` are unchanged.
 */
import {
  BANNER_UTILITY_SLOTS,
  CONSOLATION_COPY,
  CORRECT_HEADLINES,
  REGISTER_HEADLINE,
} from './config.js';
import { wrongHeadline } from './grade.js';
import type { GradingLocalDay, GradingPack, Verdict } from './types.js';

/** Player preferences that reach the banner. Only one of them does anything here. */
export interface BannerOptions {
  /** `Motivational messages` (`scope/09`, ON by default). Gates encouragement only. */
  readonly motivationalMessages: boolean;
  /**
   * Which correct-pool headline to use, as an index. The pool is a pool; which member is
   * drawn is the session's business, not grading's, and passing it in keeps this function
   * pure and its test exhaustive.
   */
  readonly headlineIndex: number;
}

/** Everything the banner needs, derived from one verdict. */
export interface Banner {
  readonly headline: string;
  readonly note: string | null;
  readonly alternateSolution: Verdict['alternateSolution'];
  readonly advisories: readonly string[];
  /** Suppressed when Motivational messages is OFF. */
  readonly consolation: string | null;
  readonly utilitySlots: typeof BANNER_UTILITY_SLOTS;
  readonly tone: 'green' | 'red' | 'none';
}

/**
 * Build the banner.
 *
 * `answer` and `target` are the tier-1-normalised strings, used only to decide between
 * `Correct solution:` and `You used the wrong word.`.
 */
export function bannerFor(
  verdict: Verdict,
  answer: string,
  target: string,
  pack: GradingPack,
  options: BannerOptions,
): Banner {
  const fallback =
    CORRECT_HEADLINES[
      ((options.headlineIndex % CORRECT_HEADLINES.length) + CORRECT_HEADLINES.length) %
        CORRECT_HEADLINES.length
    ]!;

  let headline: string;
  let tone: Banner['tone'];
  switch (verdict.verdictClass) {
    case 'correct':
      headline = fallback;
      tone = 'green';
      break;
    case 'soft-correct':
      // "Soft correct — green, headline replaced by the S5 note" (`deep/01` §S13). The
      // silent class has no note, so the pool supplies one: a headline-less banner never
      // renders.
      headline = verdict.note ?? fallback;
      tone = 'green';
      break;
    case 'register':
      headline = REGISTER_HEADLINE;
      tone = 'red';
      break;
    case 'wrong':
      headline = wrongHeadline(answer, target, pack);
      tone = 'red';
      break;
    case 'no-verdict':
      // No verdict, but still a rendered surface: the reason the learner is seeing
      // something instead of a banner (INV-GRD-14's "show the reason").
      headline = verdict.notArmedReason ?? fallback;
      tone = 'none';
      break;
  }

  return {
    headline,
    note: verdict.note,
    alternateSolution: verdict.alternateSolution,
    advisories: verdict.advisories,
    consolation: verdict.wrong && options.motivationalMessages ? CONSOLATION_COPY : null,
    utilitySlots: BANNER_UTILITY_SLOTS,
    tone,
  };
}

// ---------------------------------------------------------------------------
// Snooze (INV-GRD-12)
// ---------------------------------------------------------------------------

/**
 * `don't show me this item again today` — an idempotent local suppression row.
 *
 * EC-GRD-21: "Wire snooze rather than shipping it unwired … consumed by the generator for
 * the rest of the local day, one toast, no FSRS or accuracy effect." Nothing in this
 * record touches `due_at` or `stability`, and nothing in this module can: they are not
 * fields it has.
 */
export interface SnoozeRow {
  readonly itemId: string;
  readonly day: GradingLocalDay;
}

/** Snooze an item for a civil day. Idempotent: the same call twice yields one row. */
export function snooze(
  rows: readonly SnoozeRow[],
  itemId: string,
  day: GradingLocalDay,
): readonly SnoozeRow[] {
  if (rows.some((row) => row.itemId === itemId && row.day === day)) return rows;
  return [...rows, { itemId, day }];
}

/** Is this item suppressed for this civil day? */
export function isSnoozed(
  rows: readonly SnoozeRow[],
  itemId: string,
  day: GradingLocalDay,
): boolean {
  return rows.some((row) => row.itemId === itemId && row.day === day);
}
