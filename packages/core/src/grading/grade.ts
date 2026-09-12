/**
 * The three-tier checker (`deep/01` §S5's implementation ruling).
 *
 *  - **Tier 1, exact**: the tier-1-normalised answer equals a tier-1-normalised AUTHORED
 *    accepted form. Silent; if the match is a non-preferred alternate the banner adds
 *    `Another correct solution:` (INV-GRD-03, INV-GRD-27).
 *  - **Tier 2, soft correct**: accepted with a green note, no heart, combo unbroken. Six
 *    ordered classes (`tier2.ts`, INV-GRD-01) plus the ja reading-vs-surface channel
 *    (INV-GRD-17), whose note is authored on the item rather than pooled.
 *  - **Tier 3, wrong**: everything else. Red banner, one heart, combo reset, one mistake
 *    row.
 *
 * Plus two verdicts that are not tiers:
 *
 *  - **`register`** (INV-GRD-20) carries tier-3 cost under its own headline, because the
 *    lexeme was right and `You used the wrong word.` would be a lie.
 *  - **tier 0** (INV-GRD-14) is "CHECK was never armed": an answer with zero
 *    target-script characters produces no verdict, no attempt row, no heart, no combo
 *    change, and offers the word bank instead.
 *
 * Every function here is pure and total. The grader reads the ACTIVE pack passed to it
 * and holds no state between calls, which is what makes INV-GRD-17's "on **every**
 * occurrence … no stateful escalation" true by construction rather than by test.
 */
import { alternateSolutionFor } from './alternates.js';
import {
  HEART_COST_SOFT_CORRECT,
  HEART_COST_WRONG,
  WRONG_HEADLINE,
  WRONG_WORD_HEADLINE,
} from './config.js';
import { highlightRanges } from './highlight.js';
import { hasTargetScript, tier1Normalise, tokenise, trivialNormalise } from './normalise.js';
import { isRegisterMismatch } from './register.js';
import { TIER2_CLASS_ORDER } from './config.js';
import { classifyTier2, type Tier2Result } from './tier2.js';
import type {
  AcceptedForm,
  GradableItem,
  GradingPack,
  GradingUnit,
  LearnerSurfaceState,
  Verdict,
} from './types.js';

/** Everything one grading call needs. No ambient state, no registry, no language switch. */
export interface GradeRequest {
  readonly pack: GradingPack;
  readonly unit: GradingUnit;
  readonly item: GradableItem;
  /** The learner's raw text, exactly as typed. */
  readonly answer: string;
  readonly learner: LearnerSurfaceState;
}

/** The empty learner state, for items with no ranked alternates. */
export const NO_SURFACES_INTRODUCED: LearnerSurfaceState = {
  introducedSurfaceIds: new Set<string>(),
};

/** A verdict with every consequence at its neutral value. Each branch overrides what it owns. */
function baseVerdict(item: GradableItem): Verdict {
  return {
    tier: 3,
    verdictClass: 'wrong',
    channel: null,
    note: null,
    alternateSolution: null,
    advisories: [],
    softCorrected: false,
    wrong: true,
    heartCost: HEART_COST_WRONG,
    comboReset: true,
    mistakeLexemeIds: item.targetLexemeId === undefined ? [] : [item.targetLexemeId],
    matchedSurfaceId: null,
    highlights: [],
    schedulerTargets: [{ itemId: item.itemId, facet: item.schedulerFacet ?? 'meaning' }],
    writesAttemptRow: true,
    notArmedReason: null,
    escape: null,
  };
}

/**
 * Grade a typed production answer.
 *
 * The order of the branches IS the tier order, and it is not an optimisation: tier 1 must
 * be tried against every accepted form before tier 2 is tried against any of them, or an
 * answer that exactly matches the second alternate could be reported as a typo of the
 * first.
 */
export function gradeTypedAnswer(request: GradeRequest): Verdict {
  const { pack, unit, item, answer, learner } = request;
  const base = baseVerdict(item);

  // Tier 0 — CHECK never armed (INV-GRD-14).
  const raw = trivialNormalise(answer);
  if (pack.scriptOnlyAnswers && !hasTargetScript(raw, pack)) {
    return {
      ...base,
      tier: 0,
      verdictClass: 'no-verdict',
      wrong: false,
      heartCost: HEART_COST_SOFT_CORRECT,
      comboReset: false,
      mistakeLexemeIds: [],
      schedulerTargets: [],
      writesAttemptRow: false,
      notArmedReason: 'no-target-script',
      escape: 'word-bank',
    };
  }

  const normalised = tier1Normalise(answer, pack);
  const accepted = item.accepted.map((form) => ({
    form,
    normalised: tier1Normalise(form.surface, pack),
  }));

  // Tier 1 — exact after normalisation, against the AUTHORED set and nothing else.
  for (const { form, normalised: target } of accepted) {
    if (target !== normalised) continue;
    return {
      ...base,
      tier: 1,
      verdictClass: 'correct',
      wrong: false,
      heartCost: HEART_COST_SOFT_CORRECT,
      comboReset: false,
      mistakeLexemeIds: [],
      matchedSurfaceId: form.surfaceId,
      alternateSolution: alternateSolutionFor(item, form, learner),
    };
  }

  // Tier 2 — the ja reading-vs-surface channel (INV-GRD-17), before the six-class ladder:
  // a homophone the IME committed is not a typo of the accepted surface, and classifying
  // it as one would put it under a pooled note instead of the item's authored one.
  const readingChannel = readingSurfaceChannel(normalised, accepted, pack, item);
  if (readingChannel !== null) return { ...base, ...readingChannel };

  // Tier 2 — the six-class ladder. Every accepted form is classified and the best class
  // (earliest in the ladder) wins, so a pack that authored two alternates cannot make the
  // verdict depend on the order it happened to list them in.
  const best = bestTier2(normalised, accepted, pack, unit, item);
  if (best !== null) {
    return {
      ...base,
      tier: 2,
      verdictClass: 'soft-correct',
      channel: best.result.tier2Class,
      note: best.result.note,
      softCorrected: true,
      wrong: false,
      heartCost: HEART_COST_SOFT_CORRECT,
      comboReset: false,
      mistakeLexemeIds: [],
      matchedSurfaceId: best.form.surfaceId,
      alternateSolution: alternateSolutionFor(item, best.form, learner),
    };
  }

  // Register — tier-3 cost, its own headline (INV-GRD-20).
  for (const { normalised: target } of accepted) {
    if (!isRegisterMismatch(normalised, target, pack, unit)) continue;
    return {
      ...base,
      verdictClass: 'register',
      highlights: highlightRanges(normalised, target, pack, item.rubySpans ?? []),
    };
  }

  // Tier 3.
  const nearest = accepted[0]?.normalised ?? '';
  return {
    ...base,
    highlights: highlightRanges(normalised, nearest, pack, item.rubySpans ?? []),
  };
}

/** The headline the banner renders for a verdict (INV-GRD-11 lives in `banner.ts`). */
export function isWrongWordCase(answer: string, target: string, pack: GradingPack): boolean {
  // Unreachable for a pack without word boundaries (INV-GRD-28): there is no "word" to
  // name without a tokenizer, and shipping one is forbidden.
  if (pack.noWordBoundaries) return false;
  const answerTokens = tokenise(answer, pack);
  const targetTokens = tokenise(target, pack);
  if (answerTokens.length !== targetTokens.length) return false;
  let differing: string | null = null;
  for (let i = 0; i < targetTokens.length; i += 1) {
    if (answerTokens[i] === targetTokens[i]) continue;
    if (differing !== null) return false;
    differing = answerTokens[i]!;
  }
  return differing !== null && pack.targetLanguageWords.has(differing);
}

/** `Correct solution:` or `You used the wrong word.` (`deep/01` §S13). */
export function wrongHeadline(answer: string, target: string, pack: GradingPack): string {
  return isWrongWordCase(answer, target, pack) ? WRONG_WORD_HEADLINE : WRONG_HEADLINE;
}

interface Tier2Best {
  readonly result: Tier2Result;
  readonly form: AcceptedForm;
}

function bestTier2(
  normalised: string,
  accepted: readonly { form: AcceptedForm; normalised: string }[],
  pack: GradingPack,
  unit: GradingUnit,
  item: GradableItem,
): Tier2Best | null {
  let best: Tier2Best | null = null;
  for (const { form, normalised: target } of accepted) {
    const result = classifyTier2(normalised, target, pack, unit, {
      targetReading: form.reading ?? null,
      targetLexemeSurface: item.targetLexemeSurface ?? null,
    });
    if (result === null) continue;
    if (
      best === null ||
      TIER2_CLASS_ORDER.indexOf(result.tier2Class) <
        TIER2_CLASS_ORDER.indexOf(best.result.tier2Class)
    ) {
      best = { result, form };
    }
  }
  return best;
}

/**
 * The reading-vs-surface channel (INV-GRD-17, EC-GRD-28).
 *
 * "An answer whose reading equals an accepted form but whose surface does not is tier 2
 * on **every** occurrence, with zero mistake rows and no stateful escalation."
 *
 * The answer's reading comes from the pack's baked `readingsBySurface` table. An answer
 * that is not a surface the pack taught has no reading and never reaches this channel —
 * deriving one would need the tokenizer INV-GRD-28 forbids.
 */
function readingSurfaceChannel(
  normalised: string,
  accepted: readonly { form: AcceptedForm; normalised: string }[],
  pack: GradingPack,
  item: GradableItem,
): Partial<Verdict> | null {
  const answerReading = pack.readingsBySurface.get(normalised);
  if (answerReading === undefined) return null;
  for (const { form } of accepted) {
    const targetReading = form.reading ?? pack.readingsBySurface.get(form.surface);
    if (targetReading !== answerReading) continue;
    return {
      tier: 2,
      verdictClass: 'soft-correct',
      channel: 'reading-surface',
      note: item.readingSurfaceNote ?? null,
      softCorrected: true,
      wrong: false,
      heartCost: HEART_COST_SOFT_CORRECT,
      comboReset: false,
      mistakeLexemeIds: [],
      matchedSurfaceId: form.surfaceId,
    };
  }
  return null;
}

/**
 * Multi-gap grading (INV-GRD-05): "A multi-gap item is correct iff every gap is correct;
 * no partial credit anywhere."
 *
 * One item, one verdict, one heart, one mistake row — a two-gap item with one gap wrong
 * costs exactly what a one-gap item wrong costs (EC-GRD-09: "Whole item wrong, one heart,
 * all gaps shown corrected"). The per-gap verdicts come back too, because the banner
 * shows every gap corrected, but they are presentation and never a second charge.
 */
export interface MultiGapVerdict {
  readonly verdict: Verdict;
  readonly perGap: readonly Verdict[];
}

export function gradeMultiGap(
  request: Omit<GradeRequest, 'answer'> & { readonly answers: readonly string[] },
): MultiGapVerdict {
  const { pack, unit, item, learner, answers } = request;
  const gaps = item.gaps ?? [];
  const perGap = gaps.map((gap, index) =>
    gradeTypedAnswer({
      pack,
      unit,
      learner,
      answer: answers[index] ?? '',
      item: { ...item, itemId: `${item.itemId}#${gap.gapId}`, accepted: gap.accepted, gaps: [] },
    }),
  );

  const base = baseVerdict(item);
  const anyWrong = perGap.some((v) => v.wrong);
  const anyUnarmed = perGap.some((v) => v.tier === 0);
  if (anyUnarmed) {
    return {
      verdict: {
        ...base,
        tier: 0,
        verdictClass: 'no-verdict',
        wrong: false,
        heartCost: HEART_COST_SOFT_CORRECT,
        comboReset: false,
        mistakeLexemeIds: [],
        schedulerTargets: [],
        writesAttemptRow: false,
        notArmedReason: 'no-target-script',
        escape: 'word-bank',
      },
      perGap,
    };
  }
  if (anyWrong) return { verdict: base, perGap };

  const soft = perGap.find((v) => v.softCorrected) ?? null;
  return {
    verdict: {
      ...base,
      tier: soft === null ? 1 : 2,
      verdictClass: soft === null ? 'correct' : 'soft-correct',
      channel: soft?.channel ?? null,
      note: soft?.note ?? null,
      softCorrected: soft !== null,
      wrong: false,
      heartCost: HEART_COST_SOFT_CORRECT,
      comboReset: false,
      mistakeLexemeIds: [],
    },
    perGap,
  };
}
