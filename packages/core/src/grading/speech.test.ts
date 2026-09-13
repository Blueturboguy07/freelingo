import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { ES_PACK } from './packs/es.js';
import { JA_PACK } from './packs/ja.js';
import type { SpeechEvidence, SpeechSegment } from './speech-types.js';
import { gradeSpeech, SpeechEvidenceError } from './speech.js';

// Original fixtures. Segments model SDK observations; expected units are supplied
// independently and never derived by the grader from either displayed or ASR text.
const id = (lang: string, text: string) =>
  'sf_' +
  createHash('sha256')
    .update(JSON.stringify([lang, text]))
    .digest('hex')
    .slice(0, 32);
function fixture(words = ['Quiero', 'agua'], units = ['querer', 'agua']): SpeechEvidence {
  const text = words.join(' ') + '.';
  let offset = 0;
  return {
    schemaVersion: 1,
    language: 'es',
    ledgerUnit: 'lemma',
    policy: {
      algorithm: 'stored-unit-f1-v1',
      threshold: 0.7,
      fallback: 'normalized-levenshtein-v1',
      fallbackThreshold: 0.7,
      ignoredPunctuation: ['.', '!', '?'],
      fillers: ['eh'],
    },
    references: [
      {
        surfaceId: id('es', text),
        text,
        tokens: words.map((surface, i) => {
          const token = {
            unit: units[i]!,
            surface,
            start: offset,
            end: offset + [...surface].length,
          };
          offset = token.end + 1;
          return token;
        }),
        sourceId: 'original-spoken-source',
        sourceSha256: '1'.repeat(64),
        analysisSha256: '2'.repeat(64),
        adapterFingerprint: 'original-independent-test-analysis',
      },
    ],
  };
}
const segments = (words: readonly string[]): SpeechSegment[] =>
  words.map((segment, i) => ({
    segment,
    startTimeMillis: i * 100,
    endTimeMillis: (i + 1) * 100,
    confidence: -1,
  }));
const request = (
  transcript = 'Quiero agua.',
  parts: readonly SpeechSegment[] | null = segments(['Quiero', 'agua.']),
) => ({
  item: fixture(),
  pack: ES_PACK,
  transcript,
  ...(parts === null ? {} : { segments: parts }),
});

describe('stored-token speech grading', () => {
  it('[INV-MOD-13] maps actual analyzed surface spellings to stored ledger units', () => {
    expect(gradeSpeech(request())).toMatchObject({
      outcome: 'graded',
      accepted: true,
      score: 1,
      method: 'token-f1',
      matchedSurfaceId: id('es', 'Quiero agua.'),
      heartCost: 0,
    });
  });
  it.each([7, 6])(
    '[INV-MOD-13] the declared token-F1 threshold is inclusive with %s matches',
    (matches) => {
      const words = Array.from({ length: 10 }, (_, i) => `word${i}`),
        observed = words.map((word, i) => (i < matches ? word : `other${i}`));
      const result = gradeSpeech({
        item: fixture(words, words),
        pack: ES_PACK,
        transcript: observed.join(' '),
        segments: segments(observed),
      });
      expect(result.score).toBe(matches / 10);
      expect(result.accepted).toBe(matches === 7);
      expect(result.method).toBe('token-f1');
    },
  );
  it('[INV-MOD-13] repeated recognized words cannot inflate overlap credit', () => {
    const result = gradeSpeech({
      item: fixture(['agua', 'agua'], ['agua', 'agua']),
      pack: ES_PACK,
      transcript: 'agua agua agua agua agua',
      segments: segments(['agua', 'agua', 'agua', 'agua', 'agua']),
    });
    expect(result.score).toBe(4 / 7);
    expect(result.accepted).toBe(false);
  });
  it('[INV-MOD-13] ignores only declared fillers and punctuation with case folding', () => {
    expect(
      gradeSpeech(request('EH QUIERO AGUA!', segments(['EH', 'QUIERO', 'AGUA!']))),
    ).toMatchObject({ accepted: true, score: 1, method: 'token-f1' });
    expect(gradeSpeech(request('um quiero agua', segments(['um', 'quiero', 'agua']))).score).toBe(
      0.8,
    );
  });
  it.each([
    null,
    segments(['fabricated']),
    [{ segment: 'Quiero agua.', startTimeMillis: 10, endTimeMillis: 1, confidence: -1 }],
  ])('[INV-MOD-13] falls back when actual segments cannot establish alignment', (parts) => {
    expect(gradeSpeech(request('Quiero agua.', parts))).toMatchObject({
      accepted: true,
      score: 1,
      method: 'character-fallback',
    });
  });
  it('[INV-MOD-13] a single unsegmented recognized phrase uses character fallback', () => {
    expect(gradeSpeech(request('Quiero agua.', segments(['Quiero agua.'])))).toMatchObject({
      accepted: true,
      method: 'character-fallback',
    });
  });
  it('[INV-MOD-13] character fallback measures edits, not just a matching character bag', () => {
    const result = gradeSpeech(request('auga oreiuQ', null));
    expect(result.accepted).toBe(false);
    expect(result.matchedSurfaceId).toBeNull();
  });
  it('[INV-MOD-09] an empty transcript is no_audio rather than failed pronunciation', () => {
    expect(gradeSpeech(request('  ', []))).toEqual({
      outcome: 'no-audio',
      accepted: false,
      score: 0,
      method: 'no-audio',
      matchedSurfaceId: null,
      referenceSurfaceId: null,
      heartCost: 0,
    });
    expect(gradeSpeech(request('Otra cosa.', segments(['Otra', 'cosa.'])))).toMatchObject({
      outcome: 'graded',
      accepted: false,
      matchedSurfaceId: null,
      heartCost: 0,
    });
  });
  it('[INV-MOD-13] exact baked contextual kana accepts an unsegmented kanji reference reading', () => {
    const item = fixture();
    const text = '学校へ行く。';
    const reference = {
      surfaceId: id('ja', text),
      text,
      reading: 'がっこうへいく',
      tokens: [
        { unit: '学校', surface: '学校', start: 0, end: 2, reading: 'がっこう' },
        { unit: 'へ', surface: 'へ', start: 2, end: 3, reading: 'へ' },
        { unit: '行く', surface: '行く', start: 3, end: 5, reading: 'いく' },
      ],
      sourceId: 'original-ja-source',
      sourceSha256: '1'.repeat(64),
      analysisSha256: '2'.repeat(64),
      adapterFingerprint: 'original-Mode-A-analysis',
      japaneseScriptSha256: '3'.repeat(64),
    };
    const result = gradeSpeech({
      item: {
        ...item,
        language: 'ja',
        ledgerUnit: 'morpheme_mode_a',
        policy: { ...item.policy, ignoredPunctuation: ['。'], fillers: [] },
        references: [reference],
      },
      pack: JA_PACK,
      transcript: 'がっこうへいく',
    });
    expect(result).toMatchObject({
      accepted: true,
      score: 1,
      method: 'character-fallback',
      matchedSurfaceId: reference.surfaceId,
    });
  });
  it.each([
    'missing-tokens',
    'bad-span',
    'wrong-token-surface',
    'wrong-id',
    'bad-unit',
    'unsupported-algorithm',
    'lowered-threshold',
    'missing-proof',
  ])('[INV-MOD-13] rejects malformed expected evidence %s', (fault) => {
    const item = structuredClone(fixture());
    if (fault === 'missing-tokens') Reflect.deleteProperty(item.references[0]!, 'tokens');
    if (fault === 'bad-span') Object.assign(item.references[0]!.tokens[0]!, { end: 2 });
    if (fault === 'wrong-token-surface')
      Object.assign(item.references[0]!.tokens[0]!, { surface: 'Otro' });
    if (fault === 'wrong-id') Object.assign(item.references[0]!, { surfaceId: 'guessed' });
    if (fault === 'bad-unit') Object.assign(item, { ledgerUnit: 'word' });
    if (fault === 'unsupported-algorithm')
      Object.assign(item.policy, { algorithm: 'exact-string' });
    if (fault === 'lowered-threshold') Object.assign(item.policy, { threshold: 0.1 });
    if (fault === 'missing-proof') Reflect.deleteProperty(item.references[0]!, 'analysisSha256');
    expect(() => gradeSpeech({ ...request(), item })).toThrow(SpeechEvidenceError);
  });
});

it('[INV-MOD-13] declared fillers normalize both expected units and recognized evidence', () => {
  const item = fixture(['eh', 'Quiero', 'agua'], ['eh', 'querer', 'agua']);
  expect(
    gradeSpeech({
      item,
      pack: ES_PACK,
      transcript: 'Quiero agua',
      segments: segments(['Quiero', 'agua']),
    }),
  ).toMatchObject({ accepted: true, score: 1, method: 'token-f1' });
});
it('[INV-MOD-13] ignored punctuation cannot quietly become a letter-deletion policy', () => {
  const item = fixture();
  Object.assign(item.policy, { ignoredPunctuation: ['.', 'a'] });
  expect(() => gradeSpeech({ ...request(), item })).toThrow(SpeechEvidenceError);
});

it('[INV-MOD-13] a recognizer contraction spanning two stored units falls back without retokenizing', () => {
  const item = fixture(),
    text = "L'eau.";
  const reference = {
    ...item.references[0]!,
    surfaceId: id('fr', text),
    text,
    tokens: [
      { unit: 'le', surface: "L'", start: 0, end: 2 },
      { unit: 'eau', surface: 'eau', start: 2, end: 5 },
    ],
  };
  expect(
    gradeSpeech({
      item: {
        ...item,
        language: 'fr',
        policy: { ...item.policy, ignoredPunctuation: ['.', "'"] },
        references: [reference],
      },
      pack: ES_PACK,
      transcript: text,
      segments: segments([text]),
    }),
  ).toMatchObject({ accepted: true, score: 1, method: 'character-fallback' });
});

it('[INV-MOD-13] token overlap is bounded, multiplicity-safe and non-punitive for every stored reference', () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 16 }), (mask) => {
      const words = mask.map((_, index) => 'word' + (index % 3)),
        observed = words.map((word, index) => (mask[index] ? word : 'other' + index));
      const item = fixture(words, words);
      const result = gradeSpeech({
        item,
        pack: ES_PACK,
        transcript: observed.join(' '),
        segments: segments(observed),
      });
      const expected = mask.filter(Boolean).length / mask.length;
      expect(result.score).toBeCloseTo(expected, 12);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.accepted).toBe(expected >= 0.7);
      expect(result.heartCost).toBe(0);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});
it('[INV-SCH-11][INV-MOD-13] successful spoken alternatives preserve the actually matched target surface', () => {
  const canonical = fixture(),
    alternate = fixture(['Yo', 'quiero', 'agua'], ['yo', 'querer', 'agua']);
  const item = { ...canonical, references: [...canonical.references, ...alternate.references] };
  expect(
    gradeSpeech({
      item,
      pack: ES_PACK,
      transcript: 'Yo quiero agua.',
      segments: segments(['Yo', 'quiero', 'agua.']),
    }),
  ).toMatchObject({
    accepted: true,
    score: 1,
    matchedSurfaceId: alternate.references[0]!.surfaceId,
  });
});
