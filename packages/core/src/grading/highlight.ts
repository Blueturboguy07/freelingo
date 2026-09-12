/**
 * What the red banner bolds (INV-GRD-28).
 *
 * > "For `no_word_boundaries` packs, no highlight range partially overlaps a ruby span
 * > and the wrong-word headline is unreachable. Grep gate: no Japanese tokenizer is
 * > linked into the app."
 *
 * Two strategies, chosen by a pack flag and never by a heuristic:
 *
 *  - packs WITH word boundaries bold the differing tokens, which is `deep/01` §S13's
 *    contract;
 *  - packs WITHOUT them fall back to a character-range diff over the longest differing
 *    run, with both edges snapped OUTWARD to the nearest ruby-span boundary (EC-GRD-40).
 *
 * The snap is the invariant. A range that starts in the middle of a ruby span would draw
 * furigana over half a word, and `deep/10` §S9 forbids the tokenizer that would otherwise
 * be the obvious fix while `deep/01`'s diff assumes one. Ruby spans are baked into the
 * pack, so snapping to them costs nothing at runtime and needs no NLP.
 */
import { longestDifferingRun } from './distance.js';
import type { GradingPack, HighlightRange, RubySpan } from './types.js';

/**
 * Snap a range outward until neither edge falls strictly inside a ruby span.
 *
 * Outward, never inward: a partially covered word is the failure, and widening can only
 * ever bold one extra character while narrowing can hide the actual difference.
 */
export function snapToRubySpans(range: HighlightRange, spans: readonly RubySpan[]): HighlightRange {
  let { start, end } = range;
  let moved = true;
  while (moved) {
    moved = false;
    for (const span of spans) {
      if (start > span.start && start < span.end) {
        start = span.start;
        moved = true;
      }
      if (end > span.start && end < span.end) {
        end = span.end;
        moved = true;
      }
    }
  }
  return { start, end };
}

/**
 * The ranges to bold in the learner's answer.
 *
 * Indices are CODE POINTS of the answer string, not UTF-16 units: the renderer walks the
 * same array the grader did.
 */
export function highlightRanges(
  answer: string,
  target: string,
  pack: GradingPack,
  rubySpans: readonly RubySpan[],
): readonly HighlightRange[] {
  if (pack.noWordBoundaries) {
    const run = longestDifferingRun(answer, target);
    if (run === null) return [];
    return [snapToRubySpans(run, rubySpans)];
  }
  return differingTokenRanges(answer, target);
}

/** Token-level ranges, for packs whose script has word boundaries. */
function differingTokenRanges(answer: string, target: string): readonly HighlightRange[] {
  const answerTokens = answer.length === 0 ? [] : answer.split(' ');
  const targetTokens = target.length === 0 ? [] : target.split(' ');
  const ranges: HighlightRange[] = [];
  let offset = 0;
  for (let i = 0; i < answerTokens.length; i += 1) {
    const token = answerTokens[i]!;
    const width = [...token].length;
    if (targetTokens[i] !== token) ranges.push({ start: offset, end: offset + width });
    offset += width + 1;
  }
  return ranges;
}
