/**
 * String distance, and where a single edit happened.
 *
 * Deliberately NOT a general Levenshtein: the only question tier 2 asks is "is this
 * exactly one edit, and where?", and a bounded check answers it in one pass without a
 * matrix. A full matrix would also tempt a future "distance ≤ 2" tier, which is not a
 * ruling anyone has made.
 *
 * Code-point based (`[...s]`), not UTF-16 based: a surrogate pair is one character to a
 * learner, and `s.length` would call one emoji two edits.
 */

/** Where a single edit sits, and what it did. */
export interface SingleEdit {
  /** Index, in code points of `target`, of the character the edit touched. */
  readonly index: number;
  readonly kind: 'substitution' | 'insertion' | 'deletion';
  /** The code point present in `answer` but not `target`, for an insertion. */
  readonly inserted: string | null;
  /** The code point present in `target` but not `answer`, for a deletion. */
  readonly deleted: string | null;
}

/**
 * Return the single edit turning `target` into `answer`, or `null` when they are equal or
 * more than one edit apart.
 *
 * `kind` is named from the LEARNER's side: `insertion` means the learner typed a
 * character that is not in the target (`gatto` for `gato`).
 */
export function singleEdit(answer: string, target: string): SingleEdit | null {
  const a = [...answer];
  const t = [...target];
  if (Math.abs(a.length - t.length) > 1) return null;

  let head = 0;
  while (head < a.length && head < t.length && a[head] === t[head]) head += 1;
  if (head === a.length && head === t.length) return null; // identical

  if (a.length === t.length) {
    // One substitution, if the tails match after skipping one character each.
    for (let i = head + 1; i < a.length; i += 1) if (a[i] !== t[i]) return null;
    return { index: head, kind: 'substitution', inserted: a[head]!, deleted: t[head]! };
  }

  if (a.length === t.length + 1) {
    for (let i = head; i < t.length; i += 1) if (a[i + 1] !== t[i]) return null;
    return { index: head, kind: 'insertion', inserted: a[head]!, deleted: null };
  }

  for (let i = head; i < a.length; i += 1) if (a[i] !== t[i + 1]) return null;
  return { index: head, kind: 'deletion', inserted: null, deleted: t[head]! };
}

/** A token-level difference: which token differs, and by what single edit. */
export interface SingleTokenEdit {
  /** Index into the token arrays. */
  readonly tokenIndex: number;
  readonly answerToken: string;
  readonly targetToken: string;
  readonly edit: SingleEdit;
  /** Code-point offset of the edit within the joined TARGET string. */
  readonly targetOffset: number;
}

/**
 * Exactly one token differs, and it differs by exactly one edit.
 *
 * Returns `null` when the token counts differ, when more than one token differs, or when
 * the differing pair is more than one edit apart. A spaceless pack passes a single-token
 * array, so the whole answer is the token — which is correct: without word boundaries the
 * answer IS the word (INV-GRD-16, INV-GRD-28).
 */
export function singleTokenEdit(
  answerTokens: readonly string[],
  targetTokens: readonly string[],
  joinWidth: number,
): SingleTokenEdit | null {
  if (answerTokens.length !== targetTokens.length) return null;
  let found: number | null = null;
  for (let i = 0; i < targetTokens.length; i += 1) {
    if (answerTokens[i] === targetTokens[i]) continue;
    if (found !== null) return null;
    found = i;
  }
  if (found === null) return null;
  const edit = singleEdit(answerTokens[found]!, targetTokens[found]!);
  if (edit === null) return null;
  let targetOffset = 0;
  for (let i = 0; i < found; i += 1) targetOffset += [...targetTokens[i]!].length + joinWidth;
  return {
    tokenIndex: found,
    answerToken: answerTokens[found]!,
    targetToken: targetTokens[found]!,
    edit,
    targetOffset: targetOffset + edit.index,
  };
}

/** The multiset difference `target \ answer` at token level, when `answer ⊂ target`. */
export function droppedTokens(
  answerTokens: readonly string[],
  targetTokens: readonly string[],
): readonly string[] | null {
  let a = 0;
  const dropped: string[] = [];
  for (const token of targetTokens) {
    if (a < answerTokens.length && answerTokens[a] === token) {
      a += 1;
      continue;
    }
    dropped.push(token);
  }
  return a === answerTokens.length ? dropped : null;
}

/** True when `answerTokens` is a (not necessarily contiguous) subsequence of `promptTokens`. */
export function isTokenSubsequence(
  answerTokens: readonly string[],
  promptTokens: readonly string[],
): boolean {
  let p = 0;
  for (const token of answerTokens) {
    while (p < promptTokens.length && promptTokens[p] !== token) p += 1;
    if (p === promptTokens.length) return false;
    p += 1;
  }
  return true;
}

/**
 * The longest contiguous run of differing code points between two strings.
 *
 * Used by the `noWordBoundaries` highlight (INV-GRD-28), where there is no token to bold
 * and the bundle's wrong-word headline is unreachable. Common prefix and suffix are
 * peeled off; what remains in the ANSWER is the run.
 */
export function longestDifferingRun(
  answer: string,
  target: string,
): { readonly start: number; readonly end: number } | null {
  const a = [...answer];
  const t = [...target];
  let head = 0;
  while (head < a.length && head < t.length && a[head] === t[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < t.length - head &&
    a[a.length - 1 - tail] === t[t.length - 1 - tail]
  )
    tail += 1;
  const start = head;
  const end = a.length - tail;
  if (end <= start) return null;
  return { start, end };
}
