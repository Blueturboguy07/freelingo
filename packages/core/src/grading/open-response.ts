/**
 * Read and respond / Listen and respond (INV-GRD-08, INV-GRD-10, INV-GRD-21, INV-GRD-22).
 *
 * The family that never punishes. `deep/01` §S9: "Grading is deliberately **non-binary** —
 * over the minimum and containing at least one required lexeme passes — and **never costs
 * a heart**."
 *
 * > "Read/listen-and-respond grading is monotone in length and required-lexeme presence,
 * > never costs a heart, and degrades LLM → keyword+length → unconditional accept without
 * > changing the session's shape." (INV-GRD-08)
 *
 * Three paths, one SHAPE. `path` selects how the pass/fail is decided; it never selects
 * how much a verdict costs, whether an attempt row is written, or whether the combo
 * survives. That is what "without changing the session's shape" means, and it is why the
 * shape lives in `openResponseVerdict` below and the paths only supply a boolean.
 *
 * Two guards run BEFORE any model (EC-GRD-19), so a pasted prompt cannot be laundered
 * through an accept-all fallback:
 *
 *  1. reject an answer whose token overlap with the prompt reaches
 *     `PROMPT_OVERLAP_REJECT_RATIO`;
 *  2. require at least one token absent from the prompt.
 *
 * Neither costs a heart nor resets the combo, "so the worst case is a re-prompt in place".
 */
import {
  BELOW_GATE_REPROMPT,
  HEART_COST_SOFT_CORRECT,
  PROMPT_COPY_REPROMPT,
  PROMPT_OVERLAP_REJECT_RATIO,
} from './config.js';
import { isTokenSubsequence } from './distance.js';
import { trivialNormalise } from './normalise.js';
import { registerAdvisories } from './register.js';
import type { GradableItem, GradingPack, GradingUnit, Verdict } from './types.js';

/** Which grader decided. Degradation order is LLM → keyword+length → unconditional. */
export type OpenResponsePath = 'llm' | 'keyword-length' | 'accept-all';

export interface OpenResponseRequest {
  readonly pack: GradingPack;
  readonly unit: GradingUnit;
  readonly item: GradableItem;
  readonly reply: string;
  readonly path: OpenResponsePath;
  /** The on-device model's opinion, when `path === 'llm'`. Advisory only: see below. */
  readonly llmAccepts?: (reply: string) => boolean;
}

/** Whitespace tokens. Latin packs count these; `ja` counts characters. */
function tokensOf(text: string): readonly string[] {
  const trimmed = trivialNormalise(text);
  return trimmed.length === 0 ? [] : trimmed.split(' ');
}

/** The pack-declared length of a reply: characters for `ja`, tokens for es/fr/de. */
export function openResponseLength(reply: string, pack: GradingPack): number {
  if (pack.openResponseLengthUnit === 'characters') return [...trivialNormalise(reply)].length;
  return tokensOf(reply).length;
}

/**
 * Does the reply carry at least one required lexeme (INV-GRD-22)?
 *
 * Matched against the UNIT's taught inflections, never as a substring:
 * "`行きました` failing a `行く` gate on the fallback path" is the falsifier, and it fails
 * only if the gate looks for the dictionary form inside the reply. The pack ships every
 * inflected surface the unit taught, and any one of them satisfies the requirement.
 */
export function hasRequiredLexeme(
  reply: string,
  unit: GradingUnit,
  item: GradableItem,
  pack: GradingPack,
): boolean {
  const required = item.requiredLexemeIds ?? [];
  if (required.length === 0) return true;
  const normalised = trivialNormalise(reply);
  const tokens = new Set(tokensOf(reply));
  for (const lexemeId of required) {
    for (const surface of unit.taughtInflections[lexemeId] ?? []) {
      const hit =
        pack.openResponseLengthUnit === 'characters'
          ? normalised.includes(surface)
          : tokens.has(surface);
      if (hit) return true;
    }
  }
  return false;
}

/**
 * The deterministic gate: over the minimum length AND carrying a required lexeme.
 *
 * This is the function INV-GRD-08's monotonicity is about. It is monotone by
 * construction: length only grows as tokens are added, and the lexeme test is an
 * existential over a fixed set, so neither half can go from true to false when the reply
 * grows. `open-response.test.ts` asserts it as a property rather than reading it off the
 * source, because "monotone by construction" is exactly the claim a refactor breaks.
 */
export function lengthAndKeywordGate(
  reply: string,
  pack: GradingPack,
  unit: GradingUnit,
  item: GradableItem,
): boolean {
  return (
    openResponseLength(reply, pack) >= unit.openResponseMinimumLength &&
    hasRequiredLexeme(reply, unit, item, pack)
  );
}

/** Did the prompt-copy guard fire (INV-GRD-10)? */
export function isPromptCopy(reply: string, item: GradableItem): boolean {
  const promptTokens = tokensOf(item.prompt ?? '');
  const replyTokens = tokensOf(reply);
  if (promptTokens.length === 0) return false;
  if (replyTokens.length === 0) return false;
  // An answer equal to the prompt, or a subsequence of it, never passes "whatever its
  // length or lexeme coverage" — including the pathological case where every prompt token
  // is also a required lexeme.
  if (isTokenSubsequence(replyTokens, promptTokens)) return true;
  const prompt = new Set(promptTokens);
  const shared = replyTokens.filter((t) => prompt.has(t)).length;
  if (shared / replyTokens.length >= PROMPT_OVERLAP_REJECT_RATIO) return true;
  return !replyTokens.some((t) => !prompt.has(t));
}

/** The one shape every path produces. */
function openResponseVerdict(
  item: GradableItem,
  passed: boolean,
  advisories: readonly string[],
  notArmedReason: string | null,
): Verdict {
  return {
    tier: passed ? 1 : 0,
    verdictClass: passed ? 'correct' : 'no-verdict',
    channel: null,
    note: null,
    alternateSolution: null,
    advisories,
    softCorrected: false,
    // Never wrong, never a heart, never a mistake row: the family does not punish.
    wrong: false,
    heartCost: HEART_COST_SOFT_CORRECT,
    comboReset: false,
    mistakeLexemeIds: [],
    matchedSurfaceId: null,
    highlights: [],
    schedulerTargets: passed
      ? [{ itemId: item.itemId, facet: item.schedulerFacet ?? 'meaning' }]
      : [],
    // A re-prompt is not an attempt. EC-GRD-19: "the worst case is a re-prompt in place".
    writesAttemptRow: passed,
    notArmedReason,
    escape: null,
  };
}

/**
 * Grade an open response.
 *
 * The model can only ever ADD acceptance. `deep/01` §S9 makes the deterministic gate the
 * floor, and a model that refused a reply the gate accepted would turn "never punishes"
 * into "punishes when the on-device model is having a bad day" — untestable and, on the
 * accept-all fallback, not even reproducible.
 */
export function gradeOpenResponse(request: OpenResponseRequest): Verdict {
  const { pack, unit, item, reply, path } = request;
  const advisories = registerAdvisories(reply, pack, unit);

  if (isPromptCopy(reply, item)) {
    return openResponseVerdict(item, false, advisories, PROMPT_COPY_REPROMPT);
  }

  const gate = lengthAndKeywordGate(reply, pack, unit, item);
  const passed =
    path === 'accept-all'
      ? true
      : path === 'llm'
        ? gate || (request.llmAccepts?.(reply) ?? false)
        : gate;

  return openResponseVerdict(item, passed, advisories, passed ? null : BELOW_GATE_REPROMPT);
}
