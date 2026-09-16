/** Stored-unit speaking comparison. No tokenizer, lemmatizer or reading inference. */
import { foldCase, tier1Normalise, trivialNormalise } from './normalise.js';
import { sha256Hex } from '../packs/hashing.js';
import { SPEECH_GRADING_CONFIG } from './speech-config.js';
import type { GradingPack } from './types.js';
import type {
  SpeechEvidence,
  SpeechGradeRequest,
  SpeechGradeResult,
  SpeechReference,
  SpeechSegment,
} from './speech-types.js';
export type * from './speech-types.js';

export class SpeechEvidenceError extends Error {
  constructor(message: string) {
    super('speech evidence: ' + message);
    this.name = 'SpeechEvidenceError';
  }
}
function fail(message: string): never {
  throw new SpeechEvidenceError(message);
}
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('object missing');
  const row = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail('missing or unknown fields');
  return row;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\uD800-\uDFFF\0]/u.test(value))
    fail('nonblank well-formed text required');
  return value;
}
function list(value: unknown, nonempty = false): unknown[] {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) fail('array missing');
  return value;
}
function hash(value: unknown): void {
  if (!/^[0-9a-f]{64}$/u.test(text(value))) fail('SHA256 missing');
}
function normalized(value: string, item: SpeechEvidence, pack: GradingPack): string {
  const ignored = new Set(item.policy.ignoredPunctuation);
  return trivialNormalise(
    [...foldCase(tier1Normalise(value, pack))].filter((char) => !ignored.has(char)).join(''),
  );
}
function withoutFillers(value: string, item: SpeechEvidence, pack: GradingPack): string {
  let result = ' ' + value + ' ';
  for (const filler of item.policy.fillers) {
    const key = ' ' + normalized(filler, item, pack) + ' ';
    while (result.includes(key)) result = result.replace(key, ' ');
  }
  return result.trim();
}
/** Runtime validates only supplied, already build-bound facts; it creates no units. */
export function validateSpeechEvidence(value: unknown, pack: GradingPack): SpeechEvidence {
  const row = object(value, ['schemaVersion', 'language', 'ledgerUnit', 'policy', 'references']);
  if (row.schemaVersion !== SPEECH_GRADING_CONFIG.schemaVersion) fail('unsupported revision');
  const language = text(row.language);
  if (row.ledgerUnit !== (language === 'ja' ? 'morpheme_mode_a' : 'lemma'))
    fail('ledger unit mismatch');
  const policy = object(row.policy, [
    'algorithm',
    'threshold',
    'fallback',
    'fallbackThreshold',
    'ignoredPunctuation',
    'fillers',
  ]);
  for (const key of ['algorithm', 'threshold', 'fallback', 'fallbackThreshold'] as const)
    if (policy[key] !== SPEECH_GRADING_CONFIG[key]) fail('unsupported algorithm or threshold');
  for (const key of ['ignoredPunctuation', 'fillers']) {
    const values = list(policy[key]).map(text);
    if (new Set(values).size !== values.length) fail('duplicate normalization entry');
    if (
      key === 'ignoredPunctuation' &&
      values.some((value) => [...value].length !== 1 || !/\p{P}/u.test(value))
    )
      fail('punctuation must be explicit characters');
  }
  const item = row as unknown as SpeechEvidence;
  const ids = new Set<string>();
  for (const raw of list(row.references, true)) {
    const ref = object(
      raw,
      [
        'surfaceId',
        'text',
        'tokens',
        'sourceId',
        'sourceSha256',
        'analysisSha256',
        'adapterFingerprint',
      ],
      ['reading', 'japaneseScriptSha256'],
    );
    const written = text(ref.text),
      id = text(ref.surfaceId),
      chars = [...written];
    if (id !== 'sf_' + sha256Hex(JSON.stringify([language, written])).slice(0, 32) || ids.has(id))
      fail('invalid/duplicate reference identity');
    ids.add(id);
    text(ref.sourceId);
    hash(ref.sourceSha256);
    hash(ref.analysisSha256);
    text(ref.adapterFingerprint);
    const ja = language === 'ja';
    if (ja) {
      text(ref.reading);
      hash(ref.japaneseScriptSha256);
    } else if (ref.reading !== undefined || ref.japaneseScriptSha256 !== undefined)
      fail('undeclared reading channel');
    let end = 0;
    const leftovers: string[] = [];
    const readings: string[] = [];
    for (const rawToken of list(ref.tokens, true)) {
      const token = object(rawToken, ['unit', 'surface', 'start', 'end'], ['reading']);
      text(token.unit);
      const surface = text(token.surface),
        start = token.start,
        finish = token.end;
      if (
        typeof start !== 'number' ||
        typeof finish !== 'number' ||
        !Number.isInteger(start) ||
        !Number.isInteger(finish) ||
        start < end ||
        finish <= start ||
        finish > chars.length ||
        chars.slice(start, finish).join('') !== surface
      )
        fail('stale/overlapping token span');
      leftovers.push(chars.slice(end, start).join(''));
      end = finish;
      if (!normalized(surface, item, pack)) fail('empty expected token');
      if (ja) readings.push(text(token.reading));
      else if (token.reading !== undefined) fail('undeclared token reading');
    }
    leftovers.push(chars.slice(end).join(''));
    const fillers = new Set(item.policy.fillers.map((value) => normalized(value, item, pack)));
    if (
      (ref.tokens as unknown as SpeechReference['tokens']).every((token) =>
        fillers.has(normalized(token.surface, item, pack)),
      )
    )
      fail('no expected units after declared filler normalization');
    if (normalized(leftovers.join(''), item, pack)) fail('expected tokens omit source text');
    if (
      ja &&
      normalized(readings.join(''), item, pack) !== normalized(text(ref.reading), item, pack)
    )
      fail('whole reading differs from paired token readings');
  }
  if (item.policy.fillers.some((filler) => !normalized(filler, item, pack)))
    fail('empty normalized filler');
  return item;
}
function alignedSegments(
  segments: readonly SpeechSegment[] | undefined,
  transcript: string,
  item: SpeechEvidence,
  pack: GradingPack,
): readonly string[] | null {
  if (segments === undefined || segments.length === 0) return null;
  let previous = 0;
  for (const part of segments) {
    if (
      typeof part.segment !== 'string' ||
      /[\uD800-\uDFFF\0]/u.test(part.segment) ||
      !part.segment.trim() ||
      !Number.isFinite(part.startTimeMillis) ||
      !Number.isFinite(part.endTimeMillis) ||
      part.startTimeMillis < previous ||
      part.endTimeMillis < part.startTimeMillis ||
      !Number.isFinite(part.confidence) ||
      part.confidence < -1 ||
      part.confidence > 1
    )
      return null;
    previous = part.startTimeMillis;
  }
  if (
    normalized(segments.map((part) => part.segment).join(' '), item, pack) !==
    normalized(transcript, item, pack)
  )
    return null;
  const fillers = new Set(item.policy.fillers.map((value) => normalized(value, item, pack)));
  const parts = segments
    .map((part) => normalized(part.segment, item, pack))
    .filter((part) => part && !fillers.has(part));
  if (parts.some((part) => part.includes(' '))) return null;
  return parts;
}
function tokenScore(
  observed: readonly string[],
  reference: SpeechReference,
  item: SpeechEvidence,
  pack: GradingPack,
): number | null {
  // Surface-to-unit evidence is restricted to this reference's stored token spans.
  const fillers = new Set(item.policy.fillers.map((value) => normalized(value, item, pack)));
  const forms = reference.tokens
    .filter((token) => !fillers.has(normalized(token.surface, item, pack)))
    .map(
      (token) =>
        new Set([
          normalized(token.surface, item, pack),
          ...(token.reading === undefined ? [] : [normalized(token.reading, item, pack)]),
        ]),
    );
  if (
    item.ledgerUnit === 'morpheme_mode_a' &&
    observed.some((part) => !forms.some((forms) => forms.has(part)))
  )
    return null;
  // An SDK word may span multiple stored units (French l'eau, Japanese chunks).
  // Detect that only from exact authored spans; never split/lemmatize ASR text.
  const sourceChars = [...reference.text];
  for (const part of observed) {
    if (forms.some((forms) => forms.has(part))) continue;
    for (let first = 0; first < reference.tokens.length; first++) {
      for (let last = first + 1; last < reference.tokens.length; last++) {
        const span = sourceChars
          .slice(reference.tokens[first]!.start, reference.tokens[last]!.end)
          .join('');
        if (normalized(span, item, pack) === part) return null;
      }
    }
  }
  // Maximum occurrence matching prevents duplicate/alias inflation.
  const assigned = new Array<number>(forms.length).fill(-1);
  const match = (index: number, seen: Set<number>): boolean => {
    for (let token = 0; token < forms.length; token++) {
      if (seen.has(token) || !forms[token]!.has(observed[index]!)) continue;
      seen.add(token);
      if (assigned[token] === -1 || match(assigned[token]!, seen)) {
        assigned[token] = index;
        return true;
      }
    }
    return false;
  };
  let overlap = 0;
  for (let index = 0; index < observed.length; index++) if (match(index, new Set())) overlap++;
  return (2 * overlap) / (observed.length + forms.length);
}
function similarity(left: string, right: string): number {
  const a = [...left],
    b = [...right];
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 1 : 0;
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + (a[i] === b[j] ? 0 : 1)));
    row = next;
  }
  return 1 - row[b.length]! / Math.max(a.length, b.length);
}
export function gradeSpeech(request: SpeechGradeRequest): SpeechGradeResult {
  const { pack, transcript } = request,
    item = validateSpeechEvidence(request.item, pack);
  if (typeof transcript !== 'string' || /[\uD800-\uDFFF\0]/u.test(transcript))
    fail('invalid recognizer transcript');
  const observed = withoutFillers(normalized(transcript, item, pack), item, pack);
  if (!observed)
    return {
      outcome: 'no-audio',
      accepted: false,
      score: 0,
      method: 'no-audio',
      matchedSurfaceId: null,
      referenceSurfaceId: null,
      heartCost: 0,
    };
  const parts = alignedSegments(request.segments, transcript, item, pack);
  let best: SpeechGradeResult | null = null;
  for (const reference of item.references) {
    const f1 = parts === null ? null : tokenScore(parts, reference, item, pack);
    const method = f1 === null ? 'character-fallback' : 'token-f1';
    const score =
      f1 ??
      Math.max(
        ...[reference.text, ...(reference.reading === undefined ? [] : [reference.reading])].map(
          (text) => similarity(observed, withoutFillers(normalized(text, item, pack), item, pack)),
        ),
      );
    const accepted = score >= (f1 === null ? item.policy.fallbackThreshold : item.policy.threshold);
    if (best === null || score > best.score)
      best = {
        outcome: 'graded',
        accepted,
        score,
        method,
        matchedSurfaceId: accepted ? reference.surfaceId : null,
        referenceSurfaceId: reference.surfaceId,
        heartCost: 0,
      };
  }
  return best!;
}
