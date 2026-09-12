/**
 * Normalisation — every fold the checker can apply, each one on its own.
 *
 * Tier 1 is "exact after normalisation". Tier 2 is a LADDER of further folds, and the
 * class a difference lands in is the first fold in the ladder that makes the two strings
 * equal (`tier2.ts`). So each fold here is a separate exported function: the ladder
 * composes them, and a test can drive any one of them alone.
 *
 * Every function here is pure and idempotent: `f(f(x)) === f(x)` for every input.
 * `normalise.test.ts` asserts that as a property over generated strings, one case per
 * exported fold per fixture pack, because a fold that is not idempotent makes "exact after
 * normalisation" depend on how many times the answer happened to be normalised on its way
 * through the engine.
 */
import type { GradingPack, GradingUnit } from './types.js';
import { normaliseJa } from './ja.js';

/** Characters JS's `\s` misses that a spaceless script still must not see (U+3000). */
const IDEOGRAPHIC_SPACE = '　';

/** Curly quotes an iOS keyboard produces with smart punctuation on (EC-GRD-17). */
const CURLY_QUOTE_FOLDS: readonly (readonly [RegExp, string])[] = Object.freeze([
  [/[‘’‚‛]/gu, "'"],
  [/[“”„‟]/gu, '"'],
] as const);

/**
 * Trivial normalisation (EC-GRD-24): strip every format/zero-width character, fold curly
 * quotes to straight, collapse whitespace runs, trim, and NFC **last**.
 *
 * `\p{Cf}` covers U+200B…U+200F, U+202A…U+202E and U+FEFF — the pasted bidi controls and
 * zero-width spaces that otherwise make an identical-looking answer fail hard.
 *
 * NFC runs last, and the order is load-bearing rather than a preference. Composing first
 * breaks idempotence, because stripping a format character can JOIN a base and a combining
 * mark that the format character was keeping apart: `a` + U+200D + U+0301 composes to
 * itself, then loses the ZWJ, and comes out as the two-code-point `a` + U+0301 — while a
 * second pass over that output yields the one-code-point `á`. Two strings that render
 * identically then compare unequal depending on how many times the answer was normalised on
 * its way through the engine, which is exactly the failure the idempotence property in
 * `normalise.test.ts` exists to catch. It caught this one.
 */
export function trivialNormalise(text: string): string {
  let out = text.replace(/\p{Cf}/gu, '');
  for (const [pattern, replacement] of CURLY_QUOTE_FOLDS) out = out.replace(pattern, replacement);
  return out
    .replace(new RegExp(`[\\s${IDEOGRAPHIC_SPACE}]+`, 'gu'), ' ')
    .trim()
    .normalize('NFC');
}

/**
 * Apply the ACTIVE pack's orthographic equivalences (INV-GRD-13).
 *
 * German ships `ß→ss`, `ä→ae`, `ö→oe`, `ü→ue`; Spanish ships none, because `ñ` is
 * contrastive there. The table is an argument, never a module-level map — the falsifier
 * for INV-GRD-13 is exactly "a shared or hard-coded equivalence map".
 *
 * Longest source first, so a table containing both `ß→ss` and `ßs→sss` is deterministic.
 */
export function applyOrthographicEquivalences(
  text: string,
  equivalences: readonly (readonly [string, string])[],
): string {
  const ordered = [...equivalences].sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [from, to] of ordered) {
    if (from.length === 0) continue;
    out = out.split(from).join(to);
  }
  return out;
}

/** Remove every whitespace character, including U+3000. Used by spaceless packs. */
export function foldAllWhitespace(text: string): string {
  return text.replace(new RegExp(`[\\s${IDEOGRAPHIC_SPACE}]+`, 'gu'), '');
}

/** How many whitespace characters a string carries. Decides insertion vs omission. */
export function whitespaceCount(text: string): number {
  return (text.match(new RegExp(`[\\s${IDEOGRAPHIC_SPACE}]`, 'gu')) ?? []).length;
}

/** Case fold. Locale-independent on purpose: a pack is not a locale. */
export function foldCase(text: string): string {
  return text.toLowerCase();
}

/**
 * Remove the punctuation the UNIT declares equivalent (INV-GRD-29).
 *
 * > "The punctuation-equivalence class is read from the unit declaration, never a global
 * > regex. Falsifier: `はいと言いました` accepted in a quotation-teaching unit."
 *
 * Two unit fields, and the falsifier turns on the difference between them. A unit that
 * does not teach quotation puts `「` and `」` in its equivalence class and they fold away;
 * the unit that DOES teach quotation lists them in `gradedPunctuation`, they survive the
 * fold, and an answer without them is tier 3. Same pack, same characters, one unit apart —
 * which is only expressible because the class is a unit declaration.
 *
 * Removal is positional-agnostic: EC-GRD-42 folds terminal `。` and mid-sentence `、`
 * alike, and a bracket is never terminal.
 */
export function foldEquivalentPunctuation(text: string, unit: GradingUnit): string {
  const foldable = new Set(
    unit.punctuationEquivalenceClass.filter((c) => !unit.gradedPunctuation.includes(c)),
  );
  if (foldable.size === 0) return text;
  return [...text].filter((ch) => !foldable.has(ch)).join('');
}

/**
 * Fold non-contrastive diacritics (INV-GRD-01's fourth class).
 *
 * Decomposes, drops combining marks, recomposes. Marks the pack declares contrastive
 * survive: Spanish keeps the combining tilde, so `esta`/`está` is a soft correct and
 * `ano`/`año` is not (INV-GRD-13's falsifier).
 *
 * For a pack with `diacriticsContrastive` this is the IDENTITY (INV-GRD-18): the class is
 * empty and unreachable through any normalisation path, which is the point — NFD would
 * decompose `が` into `か` plus a combining mark and quietly forgive a contrastive
 * Japanese difference (EC-GRD-29).
 */
export function foldDiacritics(text: string, pack: GradingPack): string {
  if (pack.diacriticsContrastive) return text;
  const keep = new Set(pack.contrastiveDiacritics);
  const decomposed = text.normalize('NFD');
  let out = '';
  for (const ch of decomposed) {
    if (/\p{Mn}/u.test(ch) && !keep.has(ch)) continue;
    out += ch;
  }
  return out.normalize('NFC');
}

/**
 * Tier-1 normalisation: everything that is applied before "exact match" is decided.
 *
 * Order matters and is documented rather than incidental:
 *  1. trivial normalisation, so nothing downstream sees a zero-width character;
 *  2. the ja fold (INV-GRD-19) when the pack declares it, because NFKC has to run before
 *     the equivalence table is matched against anything;
 *  3. the pack's orthographic equivalences (INV-GRD-13);
 *  4. whitespace removal for a spaceless pack (INV-GRD-16), which is what makes the two
 *     whitespace channels unreachable there rather than merely unused.
 *
 * Case, terminal punctuation and diacritics are NOT folded here. They are tier-2 classes
 * with their own notes; folding them in tier 1 would make them silent everywhere and
 * delete three of the six notes.
 *
 * The UNIT is deliberately not a parameter. Every unit-scoped fold is a tier-2 class
 * (INV-GRD-29's punctuation equivalence is the only one), so a unit cannot change whether
 * an answer matches exactly — and a parameter that is accepted and ignored is an invitation
 * to start reading it.
 *
 * ## Why the pipeline runs to a fixed point
 *
 * The four stages feed each other backwards as well as forwards, so one pass is not stable
 * and `normalise.test.ts` drew the case: `が` + IDEOGRAPHIC SPACE + `ヾ` in the ja pack.
 * Stage 1 collapses U+3000 to a space; stage 2 leaves `ヾ` alone, because the thing to its
 * left is a space and not a kana; stage 4 then deletes the space, and the answer that comes
 * out is `がヾ`. Normalise THAT and `ヾ` finally repeats the `が` it is now adjacent to:
 * `がが`. Two answers that differ only in how many times the engine normalised them stop
 * matching, which is the failure the idempotence property exists to catch.
 *
 * Reordering does not fix it — stage 4 cannot simply run first, because stage 2's NFKC
 * *creates* whitespace: 52 code points expand to a string containing a space, U+309B and
 * U+309C (the standalone voiced sound marks a Japanese IME emits) among them. Whichever of
 * the two runs first, the other can hand it new work.
 *
 * So the pipeline is applied until it stops changing the string, exactly as `normaliseJa`
 * is, and for the same reason: the result is then a fixed point, and normalising a fixed
 * point returns it unchanged. Convergence is fast and bounded — a round that changes
 * anything consumes at least one pending rewrite (a format character, a curly quote, a run
 * of whitespace, a dash, an iteration mark, a `一`, an equivalence source), and after the
 * first round no stage creates one, because NFKC and NFC are themselves idempotent. The
 * explicit bound is there so a future stage that breaks that argument hangs no caller; it
 * returns a non-fixed point instead, and the idempotence property fails loudly.
 */
export function tier1Normalise(text: string, pack: GradingPack): string {
  const limit = 2 * [...text].length + 4;
  let current = text;
  for (let round = 0; round < limit; round += 1) {
    const next = tier1NormaliseOnce(current, pack);
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** One application of the four tier-1 stages, in order. */
function tier1NormaliseOnce(text: string, pack: GradingPack): string {
  let out = trivialNormalise(text);
  if (pack.japaneseNormalisation) out = normaliseJa(out);
  out = applyOrthographicEquivalences(out, pack.orthographicEquivalences);
  if (pack.spaceless) out = foldAllWhitespace(out);
  return out;
}

/** Split on whitespace. A spaceless pack has exactly one token: the whole string. */
export function tokenise(text: string, pack: GradingPack): readonly string[] {
  if (pack.spaceless) return text.length === 0 ? [] : [text];
  return text.length === 0 ? [] : text.split(' ');
}

/** True when `text` contains at least one character in the pack's target script. */
export function hasTargetScript(text: string, pack: GradingPack): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    for (const [lo, hi] of pack.targetScriptRanges) {
      if (code >= lo && code <= hi) return true;
    }
  }
  return false;
}
