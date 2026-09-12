/**
 * Japanese tier-1 normalisation (INV-GRD-19) — ONE pure, documented, idempotent function.
 *
 * "`ja` tier-1 normalisation is one pure, documented, idempotent function; the dash-fold
 * set is a named constant. Falsifier: `ｺｰﾋｰ`, `コ―ヒ―` and `コーヒー` do not collapse to
 * one string, `珈琲` does, or a length-losing answer reaches tier 2."
 *
 * The three halves of that falsifier are three separate rules here:
 *
 *  - `ｺｰﾋｰ` collapses because NFKC maps halfwidth katakana to fullwidth;
 *  - `コ―ヒ―` collapses because U+2015 is in `JA_CHOONPU_CONFUSABLES`;
 *  - `珈琲` does NOT collapse, because nothing in this function touches kanji. It is a
 *    different orthography and belongs in the pack's authored accepted set (EC-GRD-30),
 *    not in a normalisation rule.
 *
 * The fourth rule — "a length-losing answer must not reach tier 2" — is not here at all:
 * this function never deletes a `ー`, `っ` or small kana, and `typo-guards.ts` refuses a
 * single edit that changes the mora count. A fold that deleted the chōonpu would forgive
 * a contrastive vowel-length difference silently, which is the failure the falsifier names.
 *
 * Nothing in this file tokenizes. `deep/10` §S9 forbids shipping a Japanese tokenizer and
 * INV-GRD-28 greps for one; every rule below is character-local.
 */
import {
  JA_CHOONPU,
  JA_CHOONPU_CONFUSABLES,
  JA_ITERATION_MARKS,
  JA_KANJI_ONE,
  JA_NON_MORAIC_SMALL_KANA,
} from './config.js';

/** Katakana block plus the chōonpu, for the "`一` only between katakana" rule. */
function isKatakana(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const code = ch.codePointAt(0)!;
  return (code >= 0x30a1 && code <= 0x30fa) || ch === JA_CHOONPU;
}

/** Kana that `ゝ`/`ヽ` repeat and `ゞ`/`ヾ` repeat voiced. */
function isKana(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const code = ch.codePointAt(0)!;
  return (code >= 0x3041 && code <= 0x3096) || (code >= 0x30a1 && code <= 0x30fa);
}

/** Kanji, for `々`. */
function isKanji(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const code = ch.codePointAt(0)!;
  return code >= 0x4e00 && code <= 0x9fff;
}

/** What `ゞ` and `ヾ` add: the voiced counterpart of the preceding kana. */
const VOICING: Readonly<Record<string, string>> = Object.freeze({
  か: 'が',
  き: 'ぎ',
  く: 'ぐ',
  け: 'げ',
  こ: 'ご',
  さ: 'ざ',
  し: 'じ',
  す: 'ず',
  せ: 'ぜ',
  そ: 'ぞ',
  た: 'だ',
  ち: 'ぢ',
  つ: 'づ',
  て: 'で',
  と: 'ど',
  は: 'ば',
  ひ: 'び',
  ふ: 'ぶ',
  へ: 'べ',
  ほ: 'ぼ',
  カ: 'ガ',
  キ: 'ギ',
  ク: 'グ',
  ケ: 'ゲ',
  コ: 'ゴ',
  サ: 'ザ',
  シ: 'ジ',
  ス: 'ズ',
  セ: 'ゼ',
  ソ: 'ゾ',
  タ: 'ダ',
  チ: 'ヂ',
  ツ: 'ヅ',
  テ: 'デ',
  ト: 'ド',
  ハ: 'バ',
  ヒ: 'ビ',
  フ: 'ブ',
  ヘ: 'ベ',
  ホ: 'ボ',
});

/**
 * The one ja tier-1 fold. One argument, one result, no configuration.
 *
 * Punctuation is deliberately absent: every punctuation decision is the UNIT's
 * (INV-GRD-29, `foldEquivalentPunctuation`), so this function never strips a mark and
 * cannot be the place a global regex quietly appears.
 *
 * The rewrites are three local rules over the NFKC form:
 *
 *  - every member of the dash-fold set becomes `ー`, unconditionally (EC-GRD-30): a hyphen,
 *    a minus or any Unicode dash in a Japanese answer is a chōonpu the keyboard got wrong;
 *  - an iteration mark becomes what it repeats — `々` the preceding kanji, `ゝ`/`ヽ` the
 *    preceding kana, `ゞ`/`ヾ` the preceding kana voiced;
 *  - `一` becomes `ー`, and ONLY between two katakana. Folding it unconditionally would
 *    destroy the numeral one, which is why the rule is positional at all.
 *
 * ## Why this is a bounded fixed point and not a single pass
 *
 * INV-GRD-19 asks for ONE pure IDEMPOTENT function, and idempotence is what forces the
 * shape. The three rules read each other's output, in both directions, so no single pass in
 * any order is stable. `normalise.test.ts` drew both halves of that:
 *
 *  - `-一-` — one pass folds the leading dash, then meets `一` whose LEFT is already `ー`
 *    but whose RIGHT is still an unfolded `-`, so `一` survives and the answer is `ー一ー`.
 *    Normalise it again and `一` now sits between two chōonpu: `ーーー`.
 *  - `アゝ一ア` — fold `一` first and it survives (its left is the hiragana `ゝ`); expand the
 *    iteration mark and the left becomes `ア`, so the next pass folds it after all.
 *
 * So the pipeline is applied until it stops changing the string, which makes the result a
 * fixed point of the pipeline — and `normaliseJa` of a fixed point is that fixed point.
 * Idempotence is then a property of the construction rather than of an ordering argument
 * that the next rule would quietly invalidate.
 *
 * The loop terminates, and the bound is not a guess. Every rule maps one code point to one
 * code point, so the length never changes; and each round that changes anything strictly
 * decreases the pair (number of dashes and iteration marks, number of `一`) in lexicographic
 * order — a dash or a mark is consumed, or a `一` is, and no rule ever produces a dash or a
 * mark. `一` can be produced (`一々` expands to `一一`), which is why the pair is ordered the
 * way it is. Both components are bounded by the length, so `2 * length + 2` rounds cannot be
 * reached; the bound exists so a future rule that breaks the argument hangs no caller, and
 * `normalise.test.ts` is what would catch it.
 */
export function normaliseJa(text: string): string {
  let current = text.normalize('NFKC');
  const limit = 2 * [...current].length + 2;
  for (let round = 0; round < limit; round += 1) {
    const next = normaliseJaOnce(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** One application of the three rules, left to right. Not exported: the fold is one function. */
function normaliseJaOnce(text: string): string {
  const confusables = new Set(JA_CHOONPU_CONFUSABLES);
  const iteration = new Set(JA_ITERATION_MARKS);
  const compatible = [...text.normalize('NFKC')];

  const out: string[] = [];
  for (let i = 0; i < compatible.length; i += 1) {
    const ch = compatible[i]!;

    if (confusables.has(ch)) {
      out.push(JA_CHOONPU);
      continue;
    }

    if (ch === JA_KANJI_ONE) {
      const left = out[out.length - 1];
      const right = compatible[i + 1];
      if (isKatakana(left) && isKatakana(right)) {
        out.push(JA_CHOONPU);
        continue;
      }
    }

    if (iteration.has(ch)) {
      const left = out[out.length - 1];
      if (ch === '々' && isKanji(left)) {
        out.push(left!);
        continue;
      }
      if ((ch === 'ゝ' || ch === 'ヽ') && isKana(left)) {
        out.push(left!);
        continue;
      }
      if ((ch === 'ゞ' || ch === 'ヾ') && isKana(left)) {
        out.push(VOICING[left!] ?? left!);
        continue;
      }
    }

    out.push(ch);
  }
  return out.join('');
}

/**
 * Mora of a kana reading (EC-GRD-26's length unit).
 *
 * Every code point is one mora except the small kana that ride the preceding one:
 * `がっこう` is 4 (the sokuon `っ` IS a mora), `きょう` is 2. Not a tokenizer — it counts
 * characters against a named set and knows nothing about words.
 */
export function moraCount(reading: string): number {
  const small = new Set(JA_NON_MORAIC_SMALL_KANA);
  let count = 0;
  for (const ch of reading) if (!small.has(ch)) count += 1;
  return count;
}
