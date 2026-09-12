/**
 * Listening in a `no_word_delimiter` pack (INV-GRD-26).
 *
 * > "Listening answers in a `no_word_delimiter` pack are compared as baked readings with
 * > no runtime NLP, and a build gate rejects two same-reading taught lexemes in one unit."
 *
 * EC-GRD-38 states the three outcomes: `Type what you hear` plays `はしをわたる`, and
 *
 *  - reading match with the INTENDED kanji → tier 1;
 *  - reading match with ANOTHER real kanji (`箸を渡る` for `橋を渡る`) → tier 2, showing
 *    the intended orthography;
 *  - reading mismatch → tier 3.
 *
 * "With no runtime NLP" is why the second case is a set lookup rather than an analysis:
 * the pack bakes `sameReadingSurfaces` per item at build time. A runtime answer is
 * classified by membership, and the module never has to ask what the string means.
 *
 * The build gate is the other half. If a unit taught both `橋` and `箸`, a listening item
 * over either of them is unanswerable by ear and the learner would be punished for a
 * genuine ambiguity — so the gate refuses the unit at pack build, not the learner at
 * runtime.
 */
import { HEART_COST_SOFT_CORRECT, HEART_COST_WRONG } from './config.js';
import { gradeTypedAnswer, type GradeRequest } from './grade.js';
import { tier1Normalise } from './normalise.js';
import type { GradableItem, Verdict } from './types.js';

/** A taught lexeme as the build gate sees it. */
export interface TaughtLexeme {
  readonly lexemeId: string;
  readonly surface: string;
  readonly reading: string;
}

/** A collision: two taught lexemes in one unit that read identically. */
export interface ReadingCollision {
  readonly reading: string;
  readonly lexemeIds: readonly string[];
}

/**
 * The build gate (INV-GRD-26, `C`-kind).
 *
 * Returns every reading shared by two or more taught lexemes. A non-empty result fails
 * `coursekit validate`; it is not a warning, because the failure mode is a learner
 * losing a heart for hearing correctly.
 */
export function unitReadingCollisions(
  taught: readonly TaughtLexeme[],
): readonly ReadingCollision[] {
  const byReading = new Map<string, string[]>();
  for (const lexeme of taught) {
    const list = byReading.get(lexeme.reading) ?? [];
    list.push(lexeme.lexemeId);
    byReading.set(lexeme.reading, list);
  }
  const collisions: ReadingCollision[] = [];
  for (const [reading, lexemeIds] of byReading) {
    if (lexemeIds.length > 1) collisions.push({ reading, lexemeIds });
  }
  return collisions;
}

/**
 * Grade a listening answer.
 *
 * For a pack WITHOUT `noWordDelimiter` this is the ordinary three-tier checker — the
 * whole special case is Japanese, and a Spanish listening item must not take a different
 * code path for no reason.
 */
export function gradeListening(request: GradeRequest): Verdict {
  const { pack, item, answer } = request;
  if (!pack.noWordDelimiter) return gradeTypedAnswer(request);

  const normalised = tier1Normalise(answer, pack);

  // Tier 1: the intended orthography, or any authored accepted surface (which includes
  // the all-kana reading — the reading IS an accepted class, EC-GRD-16).
  const verdict = gradeTypedAnswer(request);
  if (verdict.tier === 1 || verdict.tier === 0) return verdict;

  // Tier 2: a real, taught orthography with the same baked reading.
  const sameReading = new Set(
    (item.sameReadingSurfaces ?? []).map((surface) => tier1Normalise(surface, pack)),
  );
  if (sameReading.has(normalised)) {
    return {
      ...verdict,
      tier: 2,
      verdictClass: 'soft-correct',
      channel: 'reading-surface',
      note: item.readingSurfaceNote ?? null,
      softCorrected: true,
      wrong: false,
      heartCost: HEART_COST_SOFT_CORRECT,
      comboReset: false,
      mistakeLexemeIds: [],
      highlights: [],
    };
  }

  // Tier 3: the reading itself was wrong.
  return { ...verdict, heartCost: verdict.wrong ? HEART_COST_WRONG : verdict.heartCost };
}

/** The orthography the tier-2 banner shows: the item's first authored surface. */
export function intendedOrthography(item: GradableItem): string {
  return item.accepted[0]?.surface ?? '';
}
