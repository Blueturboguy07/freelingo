import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { gradeTypedAnswer, NO_SURFACES_INTRODUCED } from '../grading/grade.js';
import { PackFormatError, type PackReader } from './loader.js';
import { readRuntimeItem } from './runtime-item.js';
import { readGradingMetadata } from './grading.js';

// Original independently specified input fixtures; no production content or legacy
// grader fixture is used as a fallback. Hashing uses Node, independent of the decoder.
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const surfaceId = (language: string, value: string) =>
  `sf_${hash(JSON.stringify([language, value])).slice(0, 32)}`;
const identity = { packId: 'original-runtime', courseId: 'en-es', version: '1.0.0', lang: 'es' };
const handles: DatabaseSync[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});

function payload() {
  const accepted = [
    { surfaceId: surfaceId('es', 'Quiero cantar.'), surface: 'Quiero cantar.', rank: 4 },
  ];
  return {
    schemaVersion: 1,
    exerciseId: 'ex1',
    itemId: 'i_actual',
    unitId: 'u1',
    lessonIndex: 1,
    profileId: 'spanish',
    responseLanguage: 'es',
    proof: {
      sourceId: 's1',
      sourceSha256: '1'.repeat(64),
      approvalId: 'approved-source',
      approvalSha256: '2'.repeat(64),
      draftSha256: '3'.repeat(64),
    },
    gradable: {
      itemId: 'i_actual',
      family: 'typed-translate',
      accepted,
      targetLexemeId: 'lx:cantar:VERB',
      targetLexemeSurface: 'cantar',
      schedulerFacet: 'meaning',
    },
    presentation: {
      itemId: 'i_actual',
      type: 'typedTranslate',
      instruction: 'Translate this sentence',
      prompt: 'I want to sing.',
      language: 'es',
      promptLanguage: 'en',
      acceptedAnswers: ['Quiero cantar.'],
    },
    schedulerSurfaces: [
      {
        itemId: 'i_actual',
        kind: 'lexeme',
        itemRef: 'lx:cantar:VERB',
        surfaceId: accepted[0]!.surfaceId,
        surface: accepted[0]!.surface,
        language: 'es',
        canonical: true,
      },
    ],
    introductions: [
      {
        surfaceId: accepted[0]!.surfaceId,
        surface: 'Quiero cantar.',
        language: 'es',
        when: 'wrong-feedback',
      },
    ],
    explanation: 'Quiero means I want; cantar is the infinitive to sing.',
  };
}

function metadata() {
  const words = ['cantar', 'contar', 'quiero'];
  return {
    schemaVersion: 1,
    packId: identity.packId,
    courseId: identity.courseId,
    packVersion: identity.version,
    profiles: [
      {
        profileId: 'spanish',
        responseLanguage: 'es',
        configuration: {
          orthographicEquivalences: [],
          spaceless: false,
          noWordBoundaries: false,
          noWordDelimiter: false,
          readingsBySurface: [],
          japaneseNormalisation: false,
          diacriticsContrastive: false,
          contrastiveDiacritics: ['̃'],
          typoGuards: {
            rejectRealTargetWord: true,
            rejectEditOnTargetLexeme: true,
            minimumLength: 5,
            lengthUnit: 'characters',
            preserveMoraCount: false,
          },
          targetLanguageWords: {
            kind: 'inline',
            words,
            count: words.length,
            sha256: hash(words.join('\n') + '\n'),
            provenance: {
              sourceId: 'original-fixture',
              sourceSha256: '4'.repeat(64),
              sourceUrl: 'https://example.test/original',
              license: 'CC0-1.0',
              notice: 'Original test words, not a production dictionary.',
              normalizationId: 'core-grading-lookup-v1',
              normalizationSha256: '5'.repeat(64),
              policySha256: '6'.repeat(64),
            },
          },
          functionClassTokens: ['el'],
          targetScriptRanges: [
            [65, 90],
            [97, 122],
            [192, 383],
          ],
          scriptOnlyAnswers: false,
          wordBankJoinDelimiter: ' ',
          openResponseLengthUnit: 'tokens',
          registerSlot: null,
        },
      },
    ],
    lessons: [
      {
        unitId: 'u1',
        lessonIndex: 1,
        profileId: 'spanish',
        register: null,
        punctuationEquivalenceClass: ['.', '!', '?'],
        gradedPunctuation: [],
        taughtInflections: [{ lexemeId: 'lx:cantar:VERB', surfaces: ['cantar'] }],
        openResponseMinimumLength: 4,
      },
    ],
    exercises: [
      {
        exerciseId: 'ex1',
        unitId: 'u1',
        lessonIndex: 1,
        profileId: 'spanish',
        responseLanguage: 'es',
      },
    ],
  };
}

function database(value: unknown = payload()) {
  const db = new DatabaseSync(':memory:');
  handles.push(db);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE unit(unit_id TEXT PRIMARY KEY,grammar_concept TEXT);
    CREATE TABLE grammar_concept(concept_id TEXT PRIMARY KEY);
    CREATE TABLE exercise_item_tag(exercise_id TEXT,item_kind TEXT,item_ref TEXT,is_new INTEGER);
    INSERT INTO exercise_item_tag VALUES('ex1','lexeme','cantar',1);
    CREATE TABLE lexeme(lexeme_id TEXT PRIMARY KEY,lemma TEXT,pos TEXT);
    CREATE TABLE exercise(exercise_id TEXT PRIMARY KEY,item_id TEXT,unit_id TEXT,lesson_index INTEGER,type TEXT,prompt TEXT,accepted_answers_json TEXT,distractors_json TEXT,audio_id TEXT,illustration_ref TEXT,source_sentence_id TEXT);
    CREATE TABLE audio(audio_id TEXT PRIMARY KEY,clip_hash TEXT,path TEXT,duration_ms INTEGER,bytes INTEGER);
    CREATE TABLE exercise_runtime(exercise_id TEXT PRIMARY KEY NOT NULL REFERENCES exercise(exercise_id) ON DELETE CASCADE,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),payload_sha256 TEXT NOT NULL);
    INSERT INTO unit VALUES ('u1','gc:original');
    INSERT INTO lexeme VALUES ('lx:cantar:VERB','cantar','VERB');`);
  db.prepare('INSERT INTO exercise VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    'ex1',
    'i_actual',
    'u1',
    1,
    'translate',
    'Translate this sentence\nI want to sing.',
    '["Quiero cantar."]',
    '[]',
    null,
    null,
    's1',
  );
  db.prepare('INSERT INTO meta VALUES(?,?)').run('grading:v1', JSON.stringify(metadata()));
  const raw = JSON.stringify(value);
  db.prepare('INSERT INTO exercise_runtime VALUES(?,?,?)').run('ex1', raw, hash(raw));
  const reader: PackReader = {
    get: <T>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).get(...(params as [])) as T | undefined,
    all: <T>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).all(...(params as [])) as T[],
  };
  return { db, reader };
}

function decode(value: unknown = payload()) {
  const { reader } = database(value);
  return readRuntimeItem(reader, identity, 'ex1');
}

describe('actual signed-pack runtime item boundary', () => {
  it('[INV-PACK-25] returns the actual typed item, authored explanation and active grading context', () => {
    const item = decode();
    expect(item.exerciseId).toBe('ex1');
    expect(item.gradable.itemId).toBe('i_actual');
    expect(item.presentation.prompt).toBe('I want to sing.');
    expect(item.explanation).toBe('Quiero means I want; cantar is the infinitive to sing.');
    expect(item.introductions).toEqual(payload().introductions);
    expect(item.grading.pack.targetLanguageWords.has('contar')).toBe(true);
    expect(
      gradeTypedAnswer({
        item: item.gradable,
        pack: item.grading.pack,
        unit: item.grading.unit,
        answer: 'Quiero cantar.',
        learner: NO_SURFACES_INTRODUCED,
      }).tier,
    ).toBe(1);
  });

  it.each(['table', 'runtime-row', 'grading', 'exercise', 'lexeme'] as const)(
    '[INV-PACK-25] missing production data fails visibly: %s',
    (fault) => {
      const { db, reader } = database();
      if (fault === 'table') db.exec('DROP TABLE exercise_runtime');
      if (fault === 'runtime-row') db.exec('DELETE FROM exercise_runtime');
      if (fault === 'grading') db.exec("DELETE FROM meta WHERE key='grading:v1'");
      if (fault === 'exercise') db.exec('DELETE FROM exercise');
      if (fault === 'lexeme') db.exec('DELETE FROM lexeme');
      expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(PackFormatError);
    },
  );

  it.each(['stale', 'uppercase', 'short'] as const)(
    '[INV-PACK-12] stored payload digest is exact: %s',
    (fault) => {
      const { db, reader } = database();
      const sha =
        fault === 'stale' ? 'f'.repeat(64) : fault === 'uppercase' ? 'A'.repeat(64) : 'abc';
      db.prepare('UPDATE exercise_runtime SET payload_sha256=?').run(sha);
      expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(PackFormatError);
    },
  );

  it.each(['root', 'gradable', 'presentation', 'proof', 'form'] as const)(
    '[INV-PACK-12] unknown nested fields reject: %s',
    (fault) => {
      const value = payload();
      if (fault === 'root') Object.assign(value, { unexpected: true });
      if (fault === 'gradable') Object.assign(value.gradable, { unexpected: true });
      if (fault === 'presentation') Object.assign(value.presentation, { unexpected: true });
      if (fault === 'proof') Object.assign(value.proof, { unexpected: true });
      if (fault === 'form') Object.assign(value.gradable.accepted[0]!, { unexpected: true });
      expect(() => decode(value)).toThrow(PackFormatError);
    },
  );

  it.each([
    'exercise',
    'item',
    'gradable-item',
    'presentation-item',
    'unit',
    'lesson',
    'profile',
    'language',
    'presentation-language',
    'family',
    'presentation-type',
    'source',
    'rank',
    'surface-id',
    'intro',
    'explanation',
    'approval',
    'source-hash',
    'draft-hash',
    'target',
  ] as const)(
    '[INV-PACK-41] same-hash malformed payload cannot bypass exact joins: %s',
    (fault) => {
      const value = payload();
      if (fault === 'exercise') value.exerciseId = 'other';
      if (fault === 'item') value.itemId = 'other';
      if (fault === 'gradable-item') value.gradable.itemId = 'other';
      if (fault === 'presentation-item') value.presentation.itemId = 'other';
      if (fault === 'unit') value.unitId = 'other';
      if (fault === 'lesson') value.lessonIndex = 2;
      if (fault === 'profile') value.profileId = 'other';
      if (fault === 'language') value.responseLanguage = 'en';
      if (fault === 'presentation-language') value.presentation.language = 'en';
      if (fault === 'family') value.gradable.family = 'select';
      if (fault === 'presentation-type') value.presentation.type = 'readAndRespond';
      if (fault === 'source') value.proof.sourceId = 'other';
      if (fault === 'rank') Object.assign(value.gradable.accepted[0]!, { rank: null });
      if (fault === 'surface-id') value.gradable.accepted[0]!.surfaceId = 'invented';
      if (fault === 'intro') value.introductions[0]!.surfaceId = 'not-presented';
      if (fault === 'explanation') value.explanation = '';
      if (fault === 'approval') value.proof.approvalId = '';
      if (fault === 'source-hash') value.proof.sourceSha256 = 'bad';
      if (fault === 'draft-hash') value.proof.draftSha256 = 'bad';
      if (fault === 'target') value.gradable.targetLexemeId = 'bare-cantar';
      expect(() => decode(value)).toThrow(PackFormatError);
    },
  );

  it.each(['type', 'accepted', 'prompt', 'source'] as const)(
    '[INV-PACK-12] payload must match current exercise content: %s',
    (fault) => {
      const { db, reader } = database();
      if (fault === 'type') db.exec("UPDATE exercise SET type='match'");
      if (fault === 'accepted')
        db.exec('UPDATE exercise SET accepted_answers_json=\'["Quiero bailar."]\'');
      if (fault === 'prompt') db.exec("UPDATE exercise SET prompt='Changed prompt'");
      if (fault === 'source') db.exec("UPDATE exercise SET source_sentence_id='other'");
      expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(PackFormatError);
    },
  );

  it('[INV-GRD-27] decoding does not introduce a later ranked surface or mutate learner state', () => {
    const value = payload();
    value.introductions = [];
    const item = decode(value);
    expect(item.introductions).toEqual([]);
    expect(item.gradable.accepted[0]!.rank).toBe(4);
    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(item.gradable.accepted)).toBe(true);
    expect(Object.isFrozen(item.presentation)).toBe(true);
  });
});

it.each(['reader', 'version'] as const)(
  '[INV-GRD-15] a cached policy cannot cross active pack ownership: %s',
  (fault) => {
    const actual = database(),
      other = database();
    const cached = readGradingMetadata(fault === 'reader' ? other.reader : actual.reader, identity);
    const requested = fault === 'version' ? { ...identity, version: '2.0.0' } : identity;
    expect(() => readRuntimeItem(actual.reader, requested, 'ex1', cached)).toThrow(PackFormatError);
  },
);

it('[INV-GRD-15] the same active pack can reuse its already validated policy', () => {
  const actual = database();
  const cached = readGradingMetadata(actual.reader, identity);
  expect(readRuntimeItem(actual.reader, identity, 'ex1', cached).grading).toBe(
    cached.forExercise('ex1'),
  );
});

function bankPayload() {
  const base = payload();
  return {
    ...base,
    gradable: {
      ...base.gradable,
      family: 'word-bank',
      tiles: [
        { tileId: 't1', text: 'Quiero' },
        { tileId: 't2', text: 'cantar.' },
        { tileId: 't3', text: 'Quiero' },
      ],
    },
    presentation: {
      ...base.presentation,
      type: 'wordBankTranslate',
      bank: [
        { id: 't1', text: 'Quiero' },
        { id: 't2', text: 'cantar.' },
        { id: 't3', text: 'Quiero' },
      ],
    },
  };
}
function bankDecode(value = bankPayload()) {
  const { db, reader } = database(value);
  db.exec("UPDATE exercise SET type='word_bank'");
  return readRuntimeItem(reader, identity, 'ex1');
}
it('[INV-GRD-04] real word-bank tiles preserve distinct repeated occurrences', () => {
  expect(bankDecode().gradable.tiles?.map((tile) => tile.tileId)).toEqual(['t1', 't2', 't3']);
});
it.each(['visible-text', 'visible-id', 'duplicate-id', 'unconstructible'] as const)(
  '[INV-GRD-04] a bank must actually render and construct its authored answer: %s',
  (fault) => {
    const value = bankPayload();
    if (fault === 'visible-text') value.presentation.bank[1]!.text = 'contar.';
    if (fault === 'visible-id') value.presentation.bank[1]!.id = 'other';
    if (fault === 'duplicate-id') value.gradable.tiles[1]!.tileId = 't1';
    if (fault === 'unconstructible') {
      value.gradable.tiles[1]!.text = 'contar.';
      value.presentation.bank[1]!.text = 'contar.';
    }
    expect(() => bankDecode(value)).toThrow(PackFormatError);
  },
);

function listeningPayload() {
  const base = payload();
  return {
    ...base,
    gradable: { ...base.gradable, family: 'listening' },
    presentation: {
      ...base.presentation,
      type: 'listenTypeWhatYouHear',
      audioRef: 'a1',
      audioText: 'Quiero cantar.',
    },
  };
}
function listeningDatabase(value: unknown = listeningPayload()) {
  const result = database(value);
  result.db.exec("UPDATE exercise SET type='listen',audio_id='a1'");
  result.db
    .prepare('INSERT INTO audio VALUES(?,?,?,?,?)')
    .run('a1', 'a'.repeat(16), 'audio/a1.opus', 1200, 4096);
  return result;
}
it('[INV-PACK-12] listening uses the exact built audio row without claiming to play it', () => {
  const { reader } = listeningDatabase();
  expect(readRuntimeItem(reader, identity, 'ex1').presentation.audioRef).toBe('a1');
});
it.each([
  'missing-reference',
  'wrong-reference',
  'missing-row',
  'hash',
  'duration',
  'bytes',
  'absolute',
  'parent',
  'remote',
] as const)('[INV-PACK-12] audio references must have usable local evidence: %s', (fault) => {
  const value = listeningPayload();
  if (fault === 'missing-reference') Reflect.deleteProperty(value.presentation, 'audioRef');
  if (fault === 'wrong-reference') value.presentation.audioRef = 'a2';
  const { db, reader } = listeningDatabase(value);
  if (fault === 'missing-row') db.exec('DELETE FROM audio');
  if (fault === 'hash') db.exec("UPDATE audio SET clip_hash='bad'");
  if (fault === 'duration') db.exec('UPDATE audio SET duration_ms=0');
  if (fault === 'bytes') db.exec('UPDATE audio SET bytes=0');
  if (fault === 'absolute') db.exec("UPDATE audio SET path='/private/audio.opus'");
  if (fault === 'parent') db.exec("UPDATE audio SET path='../audio.opus'");
  if (fault === 'remote') db.exec("UPDATE audio SET path='https://example.test/audio.opus'");
  expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(PackFormatError);
});

function gapPayload() {
  const base = payload();
  const form = { surfaceId: surfaceId('es', 'cantar'), surface: 'cantar', rank: 4 };
  return {
    ...base,
    gradable: {
      itemId: base.itemId,
      family: 'gap-fill',
      accepted: [form],
      gaps: [{ gapId: 'g1', accepted: [{ ...form }] }],
    },
    presentation: {
      ...base.presentation,
      type: 'gapFillSelect',
      instruction: 'Fill in the blank',
      prompt: 'Quiero ____.',
      acceptedAnswers: ['cantar'],
      options: [
        { id: 'o1', text: 'cantar' },
        { id: 'o2', text: 'contar' },
      ],
    },
    schedulerSurfaces: [
      {
        itemId: 'i_actual',
        kind: 'lexeme',
        itemRef: 'lx:cantar:VERB',
        surfaceId: form.surfaceId,
        surface: form.surface,
        language: 'es',
        canonical: true,
      },
    ],
    introductions: [],
  };
}
function gapDecode(value = gapPayload()) {
  const { db, reader } = database(value);
  db.prepare('UPDATE exercise SET type=?,prompt=?,accepted_answers_json=?,distractors_json=?').run(
    'cloze',
    'Fill in the blank\nQuiero ____.',
    '["cantar"]',
    '["contar"]',
  );
  return readRuntimeItem(reader, identity, 'ex1');
}
it('[INV-GRD-05] the current one-gap carrier retains exactly its ranked authored set', () => {
  expect(gapDecode().gradable.gaps?.[0]?.accepted[0]?.surface).toBe('cantar');
});
it.each(['rank', 'id', 'second-gap', 'distractor', 'duplicate-option', 'missing-correct'] as const)(
  '[INV-GRD-05] gap structures remain bound to actual visible answers: %s',
  (fault) => {
    const value = gapPayload();
    if (fault === 'rank') value.gradable.gaps[0]!.accepted[0]!.rank = 0;
    if (fault === 'id') value.gradable.gaps[0]!.accepted[0]!.surfaceId = 'invented';
    if (fault === 'second-gap')
      value.gradable.gaps.push({ ...value.gradable.gaps[0]!, gapId: 'g2' });
    if (fault === 'distractor') value.presentation.options[1]!.text = 'new';
    if (fault === 'duplicate-option') value.presentation.options[1]!.id = 'o1';
    if (fault === 'missing-correct') value.presentation.options[0]!.text = 'new';
    expect(() => gapDecode(value)).toThrow(PackFormatError);
  },
);

describe('reviewed observable introduction witnesses', () => {
  it('[INV-GRD-22] permits a visible source-language prompt outside response forms', () => {
    const value = payload();
    value.introductions = [
      {
        surfaceId: surfaceId('en', value.presentation.prompt),
        surface: value.presentation.prompt,
        language: 'en',
        when: 'prompt',
      },
    ];
    expect(decode(value).introductions).toEqual(value.introductions);
  });
  it.each([
    'old-id',
    'unknown-field',
    'bad-id',
    'bad-language',
    'unknown-event',
    'hidden-alternate',
    'false-prompt',
    'missing-prompt-language',
    'duplicate',
  ])('[INV-GRD-22] rejects unobservable introduction %s', (fault) => {
    const value = payload();
    if (fault === 'old-id')
      Object.assign(value, { introductions: [value.gradable.accepted[0]!.surfaceId] });
    if (fault === 'unknown-field') Object.assign(value.introductions[0]!, { extra: true });
    if (fault === 'bad-id') value.introductions[0]!.surfaceId = 'sf_' + '0'.repeat(32);
    if (fault === 'bad-language') value.introductions[0]!.language = 'en';
    if (fault === 'unknown-event') value.introductions[0]!.when = 'load';
    if (fault === 'hidden-alternate') {
      const alternate = 'Yo quiero cantar.';
      value.gradable.accepted.push({
        surfaceId: surfaceId('es', alternate),
        surface: alternate,
        rank: 5,
      });
      value.presentation.acceptedAnswers.push(alternate);
      value.introductions = [
        {
          surfaceId: surfaceId('es', alternate),
          surface: alternate,
          language: 'es',
          when: 'wrong-feedback',
        },
      ];
    }
    if (fault === 'false-prompt') value.introductions[0]!.when = 'prompt';
    if (fault === 'missing-prompt-language') {
      value.introductions = [
        {
          surfaceId: surfaceId('es', value.presentation.prompt),
          surface: value.presentation.prompt,
          language: 'es',
          when: 'prompt',
        },
      ];
      Reflect.deleteProperty(value.presentation, 'promptLanguage');
    }
    if (fault === 'duplicate') value.introductions.push({ ...value.introductions[0]! });
    const { reader, db } = database(value);
    if (fault === 'hidden-alternate')
      db.prepare('UPDATE exercise SET accepted_answers_json=?').run(
        JSON.stringify(value.presentation.acceptedAnswers),
      );
    expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(/introductions/);
  });
  it('[INV-GRD-22] refuses the hidden listening transcript as a prompt exposure', () => {
    const value = listeningPayload();
    value.introductions = [
      {
        surfaceId: surfaceId('en', value.presentation.prompt),
        surface: value.presentation.prompt,
        language: 'en',
        when: 'prompt',
      },
    ];
    const { reader } = listeningDatabase(value);
    expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(/introductions/);
  });
});

function matchPayload() {
  const pairs = Array.from({ length: 5 }, (_, index) => ({
    leftLexemeId: `lx:source${index}:NOUN`,
    rightLexemeId: `lx:answer${index}:NOUN`,
    left: `source ${index}`,
    right: `answer ${index}`,
    facet: 'meaning',
  }));
  const answers = pairs.map((pair) => pair.left + ' = ' + pair.right);
  return {
    ...payload(),
    gradable: {
      itemId: 'i_actual',
      family: 'match',
      accepted: answers.map((surface) => ({
        surfaceId: surfaceId('es', surface),
        surface,
        rank: 4,
      })),
      pairs,
    },
    presentation: {
      ...payload().presentation,
      type: 'matchPairs',
      acceptedAnswers: answers,
      pairs: pairs.map((pair, index) => ({
        leftItemId: pair.leftLexemeId,
        leftId: `left${index}`,
        rightId: `right${index}`,
        left: pair.left,
        right: pair.right,
      })),
    },
    schedulerSurfaces: pairs.map((pair) => ({
      itemId: pair.leftLexemeId,
      kind: 'lexeme',
      itemRef: pair.leftLexemeId,
      surfaceId: surfaceId('es', pair.left),
      surface: pair.left,
      language: 'es',
      canonical: true,
    })),
    introductions: [],
  };
}
function matchDatabase(value = matchPayload()) {
  const result = database(value);
  result.db
    .prepare('UPDATE exercise SET type=?,accepted_answers_json=?')
    .run('match', JSON.stringify(value.presentation.acceptedAnswers));
  for (let i = 0; i < 5; i++)
    for (const side of ['source', 'answer'])
      result.db
        .prepare('INSERT INTO lexeme VALUES(?,?,?)')
        .run(`lx:${side}${i}:NOUN`, `${side}${i}`, 'NOUN');
  for (let i = 0; i < 5; i++)
    result.db
      .prepare('INSERT INTO exercise_item_tag VALUES(?,?,?,?)')
      .run('ex1', 'lexeme', `source${i}`, 1);
  return result;
}
it('[INV-GRD-08] preserves semantic lexeme identities independently from visible pair IDs', () => {
  const { reader } = matchDatabase();
  expect(readRuntimeItem(reader, identity, 'ex1').gradable.pairs?.[0]?.leftLexemeId).toBe(
    'lx:source0:NOUN',
  );
});
it.each([
  'sixth-answer',
  'sixth-pair',
  'unknown-lexeme',
  'wrong-visible',
  'duplicate-visible',
  'wrong-semantic',
  'wrong-text',
  'wrong-facet',
])('[INV-GRD-08] rejects mismatched actual pair evidence %s', (fault) => {
  const value = matchPayload();
  if (fault === 'sixth-answer') {
    const surface = 'source 5 = answer 5';
    value.gradable.accepted.push({ surfaceId: surfaceId('es', surface), surface, rank: 4 });
    value.presentation.acceptedAnswers.push(surface);
  }
  if (fault === 'sixth-pair') value.gradable.pairs.push({ ...value.gradable.pairs[0]! });
  if (fault === 'unknown-lexeme') value.gradable.pairs[0]!.rightLexemeId = 'unknown';
  if (fault === 'wrong-visible') value.presentation.pairs[0]!.left = 'wrong';
  if (fault === 'duplicate-visible')
    value.presentation.pairs[1]!.rightId = value.presentation.pairs[0]!.rightId;
  if (fault === 'wrong-semantic') value.presentation.pairs[0]!.leftItemId = 'left0';
  if (fault === 'wrong-text') value.gradable.pairs[0]!.right = 'wrong';
  if (fault === 'wrong-facet') value.gradable.pairs[0]!.facet = 'reading';
  const { reader } = matchDatabase(value);
  expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(PackFormatError);
});
function openDatabase(fault?: string) {
  const value = {
    ...payload(),
    gradable: {
      itemId: 'i_actual',
      family: 'read-and-respond',
      accepted: payload().gradable.accepted,
      prompt: payload().presentation.prompt,
      requiredLexemeIds: ['lx:cantar:VERB'],
    },
    presentation: { ...payload().presentation, type: 'readAndRespond' },
  };
  if (fault === 'prompt') value.gradable.prompt = 'wrong';
  if (fault === 'missing-keyword') value.gradable.requiredLexemeIds = [];
  if (fault === 'unknown-keyword') value.gradable.requiredLexemeIds = ['unknown'];
  const result = database(value);
  result.db.exec("UPDATE exercise SET type='speak'");
  if (fault === 'untaught') {
    const meta = metadata();
    meta.lessons[0]!.taughtInflections = [];
    result.db.prepare('UPDATE meta SET value=?').run(JSON.stringify(meta));
  }
  return result;
}
it('[INV-GRD-13] binds open response keywords to the actual active lesson teaching view', () => {
  const { reader } = openDatabase();
  expect(readRuntimeItem(reader, identity, 'ex1').gradable.requiredLexemeIds).toEqual([
    'lx:cantar:VERB',
  ]);
});
it.each(['prompt', 'missing-keyword', 'unknown-keyword', 'untaught'])(
  '[INV-GRD-13] rejects unproved open response %s',
  (fault) => {
    const { reader } = openDatabase(fault);
    expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(PackFormatError);
  },
);

function speechEvidence() {
  const base = payload();
  return {
    schemaVersion: 1,
    language: 'es',
    ledgerUnit: 'lemma',
    policy: {
      algorithm: 'stored-unit-f1-v1',
      threshold: 0.7,
      fallback: 'normalized-levenshtein-v1',
      fallbackThreshold: 0.7,
      ignoredPunctuation: ['.'],
      fillers: [],
    },
    references: [
      {
        surfaceId: base.gradable.accepted[0]!.surfaceId,
        text: 'Quiero cantar.',
        sourceId: base.proof.sourceId,
        sourceSha256: base.proof.sourceSha256,
        analysisSha256: '4'.repeat(64),
        adapterFingerprint: 'original-independent-analysis',
        tokens: [
          { unit: 'querer', surface: 'Quiero', start: 0, end: 6 },
          { unit: 'cantar', surface: 'cantar', start: 7, end: 13 },
        ],
      },
    ],
  };
}
function speakingPayload() {
  const base = listeningPayload();
  return {
    ...base,
    gradable: { ...base.gradable, family: 'speaking' },
    presentation: { ...base.presentation, type: 'speakSentence' },
    speech: speechEvidence(),
  };
}
function speakingDatabase(value: unknown = speakingPayload()) {
  const result = listeningDatabase(value);
  result.db.exec("UPDATE exercise SET type='speak'");
  result.db.prepare('INSERT INTO meta VALUES(?,?)').run('ledger_unit', 'lemma');
  return result;
}
it('[INV-MOD-13] a speaking item without baked source evidence is unavailable', () => {
  const value = speakingPayload();
  Reflect.deleteProperty(value, 'speech');
  const { reader } = speakingDatabase(value);
  expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(PackFormatError);
});
it('[INV-MOD-13] returns exact accepted source-bound speech units from actual SQL payload', () => {
  const value = speakingPayload(),
    { reader } = speakingDatabase(value);
  expect(readRuntimeItem(reader, identity, 'ex1').speech).toEqual(value.speech);
});
it.each([
  'source-id',
  'source-digest',
  'reference-id',
  'reference-text',
  'missing-reference',
  'extra-reference',
  'bad-span',
  'language',
  'ledger-missing',
  'ledger-wrong',
])('[INV-MOD-13] rejects a speech proof with a stale exact join: %s', (fault) => {
  const value = speakingPayload();
  const ref = value.speech.references[0]!;
  if (fault === 'source-id') ref.sourceId = 'unrelated-source';
  if (fault === 'source-digest') ref.sourceSha256 = '5'.repeat(64);
  if (fault === 'reference-id') ref.surfaceId = surfaceId('es', 'Otro.');
  if (fault === 'reference-text') ref.text = 'Otro.';
  if (fault === 'missing-reference') value.speech.references = [];
  if (fault === 'extra-reference') value.speech.references.push({ ...ref });
  if (fault === 'bad-span') ref.tokens[0]!.surface = 'Other';
  if (fault === 'language') value.speech.language = 'en';
  const { reader, db } = speakingDatabase(value);
  if (fault === 'ledger-missing') db.exec("DELETE FROM meta WHERE key='ledger_unit'");
  if (fault === 'ledger-wrong')
    db.exec("UPDATE meta SET value='morpheme_mode_a' WHERE key='ledger_unit'");
  expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(PackFormatError);
});

it('[INV-GRD-22] a speaking audio button does not hide the explicitly declared prompt', () => {
  const base = listeningPayload();
  const value = {
    ...base,
    gradable: { ...base.gradable, family: 'speaking' },
    presentation: { ...base.presentation, type: 'speakSentence' },
    speech: speechEvidence(),
    introductions: [
      {
        surfaceId: surfaceId('en', base.presentation.prompt),
        surface: base.presentation.prompt,
        language: 'en',
        when: 'prompt',
      },
    ],
  };
  const { reader } = speakingDatabase(value);
  expect(readRuntimeItem(reader, identity, 'ex1').introductions).toEqual(value.introductions);
});

describe('explicit target-language scheduling forms', () => {
  it('[INV-SCH-11] returns actual accepted alternates without canonical substitution', () => {
    const value = payload(),
      surface = 'Yo quiero cantar.';
    value.gradable.accepted.push({ surfaceId: surfaceId('es', surface), surface, rank: 5 });
    value.presentation.acceptedAnswers.push(surface);
    value.schedulerSurfaces.push({
      itemId: value.itemId,
      kind: 'lexeme',
      itemRef: 'lx:cantar:VERB',
      surfaceId: surfaceId('es', surface),
      surface,
      language: 'es',
      canonical: false,
    });
    const { reader, db } = database(value);
    db.prepare('UPDATE exercise SET accepted_answers_json=?').run(
      JSON.stringify(value.presentation.acceptedAnswers),
    );
    const item = readRuntimeItem(reader, identity, 'ex1');
    expect(item.schedulerSurfaces).toEqual(value.schedulerSurfaces);
  });
  it.each([
    'absent',
    'empty',
    'canonical-missing',
    'two-canonicals',
    'wrong-language',
    'wrong-id',
    'wrong-item',
    'missing-alternate',
    'unaccepted-alternate',
  ])('[INV-SCH-11] rejects unverifiable scheduler mapping %s', (fault) => {
    const value = payload();
    if (fault === 'absent') Reflect.deleteProperty(value, 'schedulerSurfaces');
    if (fault === 'empty') value.schedulerSurfaces = [];
    if (fault === 'canonical-missing') value.schedulerSurfaces[0]!.canonical = false;
    if (fault === 'two-canonicals')
      value.schedulerSurfaces.push({ ...value.schedulerSurfaces[0]! });
    if (fault === 'wrong-language') value.schedulerSurfaces[0]!.language = 'en';
    if (fault === 'wrong-id') value.schedulerSurfaces[0]!.surfaceId = 'sf_bad';
    if (fault === 'wrong-item') value.schedulerSurfaces[0]!.itemId = 'unknown';
    const surface = 'Yo quiero cantar.';
    if (fault === 'missing-alternate') {
      value.gradable.accepted.push({ surfaceId: surfaceId('es', surface), surface, rank: 5 });
      value.presentation.acceptedAnswers.push(surface);
    }
    if (fault === 'unaccepted-alternate')
      value.schedulerSurfaces.push({
        itemId: value.itemId,
        kind: 'lexeme',
        itemRef: 'lx:cantar:VERB',
        surfaceId: surfaceId('es', surface),
        surface,
        language: 'es',
        canonical: false,
      });
    const { reader, db } = database(value);
    db.prepare('UPDATE exercise SET accepted_answers_json=?').run(
      JSON.stringify(value.presentation.acceptedAnswers),
    );
    expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(
      fault === 'absent' ? /payload/ : /scheduler/,
    );
  });
  it('[INV-SCH-11] an English reverse response preserves the explicitly declared Spanish target', () => {
    const value = payload(),
      answer = 'I want to sing.';
    value.responseLanguage = 'en';
    value.presentation.language = 'en';
    value.presentation.promptLanguage = 'es';
    value.presentation.prompt = 'Quiero cantar.';
    value.presentation.acceptedAnswers = [answer];
    value.gradable.accepted = [{ surfaceId: surfaceId('en', answer), surface: answer, rank: 4 }];
    value.introductions = [];
    const { reader, db } = database(value),
      meta = metadata();
    meta.profiles[0]!.responseLanguage = 'en';
    meta.exercises[0]!.responseLanguage = 'en';
    db.prepare('UPDATE meta SET value=?').run(JSON.stringify(meta));
    db.prepare('UPDATE exercise SET type=?,prompt=?,accepted_answers_json=?').run(
      'reverse_translate',
      value.presentation.instruction + '\n' + value.presentation.prompt,
      JSON.stringify([answer]),
    );
    const item = readRuntimeItem(reader, identity, 'ex1');
    expect(item.responseLanguage).toBe('en');
    expect(item.schedulerSurfaces[0]).toMatchObject({
      language: 'es',
      surface: 'Quiero cantar.',
      canonical: true,
    });
  });
  it('[INV-SCH-11] a match maps each actual semantic target to its displayed target form', () => {
    const value = matchPayload();
    value.schedulerSurfaces[0]!.surface = 'unshown';
    value.schedulerSurfaces[0]!.surfaceId = surfaceId('es', 'unshown');
    const { reader } = matchDatabase(value);
    expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(/scheduler/);
  });
});

it('[INV-SCH-11] a mixed sentence item cannot become a lexeme through an absent objective', () => {
  const value = payload();
  Reflect.deleteProperty(value.schedulerSurfaces[0]!, 'kind');
  Reflect.deleteProperty(value.schedulerSurfaces[0]!, 'itemRef');
  expect(() => decode(value)).toThrow(PackFormatError);
});

it.each([
  'unknown-kind',
  'unknown-id',
  'missing-tag',
  'different-kind',
  'different-ref',
  'different-exercise',
  'conflicting-alternate',
])('[INV-SCH-11] the scheduler objective joins the exact SQL item declaration: %s', (fault) => {
  const value = payload();
  const objective = value.schedulerSurfaces[0]!;
  if (fault === 'unknown-kind') objective.kind = 'sentence';
  if (fault === 'unknown-id') objective.itemRef = 'unknown';
  if (fault === 'conflicting-alternate')
    value.schedulerSurfaces.push({
      ...objective,
      canonical: false,
      kind: 'grammarConcept',
      itemRef: 'gc:other',
    });
  const { reader, db } = database(value);
  if (fault === 'missing-tag') db.exec('DELETE FROM exercise_item_tag');
  if (fault === 'different-kind')
    db.exec("UPDATE exercise_item_tag SET item_kind='grammar_concept'");
  if (fault === 'different-ref') db.exec("UPDATE exercise_item_tag SET item_ref='other'");
  if (fault === 'different-exercise') db.exec("UPDATE exercise_item_tag SET exercise_id='other'");
  expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(PackFormatError);
});
it('[INV-SCH-11] a reviewed declared grammar objective retains the aggregate item identity', () => {
  const value = payload();
  value.schedulerSurfaces[0]!.kind = 'grammarConcept';
  value.schedulerSurfaces[0]!.itemRef = 'gc:original';
  const { reader, db } = database(value);
  db.exec(
    "INSERT INTO grammar_concept VALUES('gc:original');INSERT INTO exercise_item_tag VALUES('ex1','grammar_concept','gc:original',1)",
  );
  expect(readRuntimeItem(reader, identity, 'ex1').schedulerSurfaces[0]).toMatchObject({
    itemId: 'i_actual',
    kind: 'grammarConcept',
    itemRef: 'gc:original',
  });
  db.exec('DELETE FROM grammar_concept');
  expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(PackFormatError);
});

it('[INV-SCH-11] an existing tagged grammar concept must still be this actual unit objective', () => {
  const value = payload();
  value.schedulerSurfaces[0]!.kind = 'grammarConcept';
  value.schedulerSurfaces[0]!.itemRef = 'gc:original';
  const { reader, db } = database(value);
  db.exec(
    "INSERT INTO grammar_concept VALUES('gc:original'),('gc:other'); INSERT INTO exercise_item_tag VALUES('ex1','grammar_concept','gc:original',1); UPDATE unit SET grammar_concept='gc:other'",
  );
  expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(PackFormatError);
});

function pictureIntroPayload() {
  const base = payload(),
    surface = 'cantar',
    id = surfaceId('es', surface);
  return {
    ...base,
    gradable: {
      itemId: base.itemId,
      family: 'select',
      accepted: [{ surfaceId: id, surface, rank: 4 }],
    },
    presentation: {
      ...base.presentation,
      type: 'pictureSelect',
      prompt: 'to sing',
      acceptedAnswers: [surface],
      introduction: 'word',
      options: [
        ['correct', 'cantar'],
        ['other1', 'contar'],
        ['other2', 'bailar'],
      ].map(([id, text]) => ({
        id: id!,
        text: text!,
        imageUri: 'original/' + id + '.png',
        imageDescription: 'Original fixture ' + text,
      })),
    },
    schedulerSurfaces: [{ ...base.schedulerSurfaces[0]!, surfaceId: id, surface }],
    introductions: [
      {
        surfaceId: id,
        surface,
        language: 'es',
        when: 'prompt',
        location: 'option',
        optionId: 'correct',
      },
    ],
  };
}
function pictureIntroDatabase(value: unknown = pictureIntroPayload()) {
  const result = database(value);
  result.db
    .prepare('UPDATE exercise SET type=?,prompt=?,accepted_answers_json=?,distractors_json=?')
    .run('match', 'Translate this sentence\nto sing', '["cantar"]', '["contar","bailar"]');
  return result;
}
it('[INV-SCH-11] a NEW WORD picture option is a declared prompt-phase exposure', () => {
  const value = pictureIntroPayload(),
    { reader } = pictureIntroDatabase(value);
  const item = readRuntimeItem(reader, identity, 'ex1');
  expect(item.introductions).toEqual(value.introductions);
  expect(item.presentation.promptLanguage).toBe('en');
  expect(item.introductions[0]!.language).toBe('es');
});
it.each([
  'missing-id',
  'wrong-id',
  'distractor-id',
  'missing-marker',
  'grammar-marker',
  'wrong-shape',
  'feedback',
  'unknown-location',
  'grammar-objective',
  'foreign-language',
])('[INV-SCH-11] rejects an unproved picture option exposure: %s', (fault) => {
  const value = pictureIntroPayload(),
    intro = value.introductions[0]!;
  if (fault === 'missing-id') Reflect.deleteProperty(intro, 'optionId');
  if (fault === 'wrong-id') intro.optionId = 'missing';
  if (fault === 'distractor-id') intro.optionId = 'other1';
  if (fault === 'missing-marker') Reflect.deleteProperty(value.presentation, 'introduction');
  if (fault === 'grammar-marker') value.presentation.introduction = 'grammar';
  if (fault === 'wrong-shape') value.presentation.type = 'meaningSelect';
  if (fault === 'feedback') intro.when = 'wrong-feedback';
  if (fault === 'unknown-location') intro.location = 'answer-cache';
  if (fault === 'grammar-objective') {
    value.schedulerSurfaces[0]!.kind = 'grammarConcept';
    value.schedulerSurfaces[0]!.itemRef = 'gc:original';
  }
  if (fault === 'foreign-language') {
    intro.language = 'en';
    intro.surfaceId = surfaceId('en', intro.surface);
  }
  const { reader, db } = pictureIntroDatabase(value);
  if (fault === 'grammar-objective')
    db.exec(
      "INSERT INTO grammar_concept VALUES('gc:original');INSERT INTO exercise_item_tag VALUES('ex1','grammar_concept','gc:original',1)",
    );
  expect(() => readRuntimeItem(reader, identity, 'ex1')).toThrow(PackFormatError);
});
it('[INV-SCH-11] an orphan option ID cannot masquerade as a full prompt witness', () => {
  const value = payload();
  value.introductions = [
    {
      surfaceId: surfaceId('en', value.presentation.prompt),
      surface: value.presentation.prompt,
      language: 'en',
      when: 'prompt',
    },
  ];
  Object.assign(value.introductions[0]!, { optionId: 'unbound' });
  expect(() => decode(value)).toThrow(PackFormatError);
});
