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
 */
export function normaliseJa(text: string): string {
  const confusables = new Set(JA_CHOONPU_CONFUSABLES);
  const iteration = new Set(JA_ITERATION_MARKS);

  // 1. NFKC. Halfwidth katakana, fullwidth latin and the halfwidth chōonpu all fold here.
  const compatible = [...text.normalize('NFKC')];

  const out: string[] = [];
  for (let i = 0; i < compatible.length; i += 1) {
    const ch = compatible[i]!;

    // 2. The dash-fold set. Unconditional: a hyphen, a minus or any Unicode dash in a
    //    Japanese answer is a chōonpu the keyboard got wrong (EC-GRD-30).
    if (confusables.has(ch)) {
      out.push(JA_CHOONPU);
      continue;
    }

    // 3. `一` ONLY between katakana. Folding it anywhere else would destroy the numeral.
    //    The left neighbour is read from `out`, so a dash already folded in step 3 counts.
    if (ch === JA_KANJI_ONE) {
      const left = out[out.length - 1];
      const right = compatible[i + 1];
      if (isKatakana(left) && isKatakana(right)) {
        out.push(JA_CHOONPU);
        continue;
      }
    }

    // 4. Iteration marks expand against what precedes them.
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
