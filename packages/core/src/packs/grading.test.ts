import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { gradeTypedAnswer, NO_SURFACES_INTRODUCED } from '../grading/grade.js';
import { registerAdvisories, isRegisterMismatch } from '../grading/register.js';
import { applyTypoGuards } from '../grading/typo-guards.js';
import { tier1Normalise } from '../grading/normalise.js';
import { hasRequiredLexeme } from '../grading/open-response.js';
import { PackFormatError, type PackReader } from './loader.js';
import { readGradingMetadata } from './grading.js';

// Independently authored decoder fixtures. These tiny declared vocabularies falsify
// joins and behavior; they are not a production dictionary or language-quality proof.
const handles: DatabaseSync[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});
const provenance = {
  sourceId: 'original-independent-fixture',
  sourceSha256: '1'.repeat(64),
  sourceUrl: 'https://example.test/original-fixture',
  license: 'CC0-1.0',
  notice: 'Original decoder fixture, not production linguistic evidence.',
  normalizationId: 'core-grading-lookup-v1',
  normalizationSha256: '2'.repeat(64),
  policySha256: '3'.repeat(64),
};
function inlineDictionary(words: string[]) {
  return {
    kind: 'inline',
    words,
    count: words.length,
    sha256: createHash('sha256')
      .update(
        [...words]
          .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
          .map((w) => `${w}\n`)
          .join(''),
      )
      .digest('hex'),
    provenance: { ...provenance },
  };
}
const identity = { packId: 'test-original', courseId: 'en-es', version: '0.1.0', lang: 'es' };
function configuration() {
  return {
    orthographicEquivalences: [] as string[][],
    spaceless: false,
    noWordBoundaries: false,
    noWordDelimiter: false,
    readingsBySurface: [] as string[][],
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
    targetLanguageWords: inlineDictionary(['cantar', 'contar', 'escribo', 'escribes']),
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
  };
}
function lesson(lessonIndex: number, profileId = 'spanish') {
  return {
    unitId: 'u001',
    lessonIndex,
    profileId,
    register: null as string | null,
    punctuationEquivalenceClass: ['.', '!', '?'],
    gradedPunctuation: [] as string[],
    taughtInflections: [
      {
        lexemeId: 'lx:escribir:VERB',
        surfaces: lessonIndex === 1 ? ['escribo'] : ['escribo', 'escribes'],
      },
    ],
    openResponseMinimumLength: 4,
  };
}
function metadata() {
  return {
    schemaVersion: 1,
    packId: identity.packId,
    courseId: identity.courseId,
    packVersion: identity.version,
    profiles: [
      { profileId: 'spanish', responseLanguage: 'es', configuration: configuration() },
      {
        profileId: 'english',
        responseLanguage: 'en',
        configuration: {
          ...configuration(),
          targetLanguageWords: inlineDictionary(['write', 'writes']),
          contrastiveDiacritics: [],
        },
      },
    ],
    lessons: [lesson(1), lesson(2), { ...lesson(1, 'english'), taughtInflections: [] }],
    exercises: [
      {
        exerciseId: 'ex-a',
        unitId: 'u001',
        lessonIndex: 1,
        profileId: 'spanish',
        responseLanguage: 'es',
      },
      {
        exerciseId: 'ex-b',
        unitId: 'u001',
        lessonIndex: 2,
        profileId: 'spanish',
        responseLanguage: 'es',
      },
      {
        exerciseId: 'ex-reverse',
        unitId: 'u001',
        lessonIndex: 1,
        profileId: 'english',
        responseLanguage: 'en',
      },
    ],
  };
}
function database(value: unknown = metadata()) {
  const db = new DatabaseSync(':memory:');
  handles.push(db);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE unit(unit_id TEXT PRIMARY KEY);
    CREATE TABLE lexeme(lexeme_id TEXT PRIMARY KEY);
    CREATE TABLE exercise(exercise_id TEXT PRIMARY KEY, unit_id TEXT, lesson_index INTEGER);
    INSERT INTO unit VALUES ('u001');
    INSERT INTO lexeme VALUES ('lx:escribir:VERB');
    INSERT INTO exercise VALUES ('ex-a','u001',1),('ex-b','u001',2),('ex-reverse','u001',1);`);
  if (value !== null)
    db.prepare('INSERT INTO meta VALUES (?,?)').run(
      'grading:v1',
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  const reader: PackReader = {
    all: <T>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
    get: <T>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).get(...(params as never[])) as T | undefined,
  };
  return { db, reader };
}
function load(value: unknown = metadata()) {
  return readGradingMetadata(database(value).reader, identity);
}

describe('production grading metadata', () => {
  it('[INV-GRD-13] reads only the active pack metadata without fixture fallback', () => {
    const runtime = load();
    const context = runtime.forExercise('ex-a');
    expect(context.pack.packId).toBe(identity.packId);
    expect(context.responseLanguage).toBe('es');
    expect(context.unit.unitId).toBe('u001');
    expect(context.pack.targetLanguageWords.has('contar')).toBe(true);
    expect(() => load(null)).toThrow(PackFormatError);
    expect(() => runtime.forExercise('unknown')).toThrow(PackFormatError);
  });
  it('[INV-GRD-02] the shipped surface dictionary drives the real-word guard', () => {
    const pack = load().forExercise('ex-a').pack;
    const verdict = applyTypoGuards(
      {
        mistypedWord: 'contar',
        targetWord: 'cantar',
        targetReading: null,
        answerReading: null,
        targetLexemeSurface: null,
        targetString: 'cantar',
        editOffsetInTarget: 1,
        targetLanguageWords: pack.targetLanguageWords,
      },
      pack.typoGuards,
    );
    expect(verdict.forgiven).toBe(false);
    expect(verdict.rejectedBy).toContain('real-target-word');
  });
  it('[INV-GRD-13] reverse answers use their explicit English profile', () => {
    const runtime = load();
    expect(runtime.forExercise('ex-reverse').responseLanguage).toBe('en');
    expect(runtime.forExercise('ex-reverse').pack.targetLanguageWords.has('write')).toBe(true);
    expect(runtime.forExercise('ex-reverse').pack.targetLanguageWords.has('contar')).toBe(false);
  });
  it('[INV-GRD-22] later lesson inflections never leak into the earlier lesson view', () => {
    const runtime = load();
    const early = runtime.forExercise('ex-a');
    const late = runtime.forExercise('ex-b');
    const item = {
      itemId: 'response',
      family: 'read-and-respond' as const,
      accepted: [],
      requiredLexemeIds: ['lx:escribir:VERB'],
    };
    expect(hasRequiredLexeme('escribes', early.unit, item, early.pack)).toBe(false);
    expect(hasRequiredLexeme('escribes', late.unit, item, late.pack)).toBe(true);
  });
  it('[INV-GRD-13] decoding another pack cannot change the first equivalence policy', () => {
    const first = load();
    const different = metadata();
    different.profiles[0]!.configuration.orthographicEquivalences = [['ß', 'ss']];
    const second = load(different);
    expect(tier1Normalise('heißt', first.forExercise('ex-a').pack)).toBe('heißt');
    expect(tier1Normalise('heißt', second.forExercise('ex-a').pack)).toBe('heisst');
    expect(tier1Normalise('heißt', first.forExercise('ex-a').pack)).toBe('heißt');
  });
  it.each(['packId', 'courseId', 'packVersion'] as const)(
    '[INV-GRD-13] refuses stale identity %s',
    (key) => {
      const value = metadata();
      value[key] = 'stale';
      expect(() => load(value)).toThrow(PackFormatError);
    },
  );
  it.each([
    'missing-profile',
    'wrong-language',
    'wrong-unit',
    'wrong-lesson',
    'missing-binding',
    'duplicate-binding',
    'extra-binding',
    'missing-view',
    'duplicate-view',
    'unknown-lexeme',
  ])('[INV-GRD-22] rejects broken exact joins: %s', (fault) => {
    const value = metadata();
    if (fault === 'missing-profile') value.exercises[0]!.profileId = 'absent';
    if (fault === 'wrong-language') value.exercises[0]!.responseLanguage = 'en';
    if (fault === 'wrong-unit') value.exercises[0]!.unitId = 'elsewhere';
    if (fault === 'wrong-lesson') value.exercises[0]!.lessonIndex = 2;
    if (fault === 'missing-binding') value.exercises.pop();
    if (fault === 'duplicate-binding') value.exercises.push({ ...value.exercises[0]! });
    if (fault === 'extra-binding')
      value.exercises.push({ ...value.exercises[0]!, exerciseId: 'not-in-db' });
    if (fault === 'missing-view') value.lessons.shift();
    if (fault === 'duplicate-view') value.lessons.push({ ...value.lessons[0]! });
    if (fault === 'unknown-lexeme') value.lessons[0]!.taughtInflections[0]!.lexemeId = 'escribir';
    expect(() => load(value)).toThrow(PackFormatError);
  });
  it('[INV-GRD-22] actual database lesson values refute otherwise coherent metadata', () => {
    const { db, reader } = database();
    db.exec("UPDATE exercise SET lesson_index=3 WHERE exercise_id='ex-a'");
    expect(() => readGradingMetadata(reader, identity)).toThrow(PackFormatError);
  });
  it.each([
    'empty-dictionary',
    'duplicate-word',
    'duplicate-profile',
    'unknown-field',
    'bad-boolean',
    'bad-threshold',
    'bad-range',
    'empty-equivalence',
    'duplicate-reading',
    'bad-punctuation',
  ])('[INV-GRD-15] refuses malformed declared policy: %s', (fault) => {
    const value = metadata();
    const config = value.profiles[0]!.configuration;
    if (fault === 'empty-dictionary') config.targetLanguageWords = inlineDictionary([]);
    if (fault === 'duplicate-word') config.targetLanguageWords.words.push('contar');
    if (fault === 'duplicate-profile') value.profiles.push({ ...value.profiles[0]! });
    if (fault === 'unknown-field') Object.assign(config, { fallback: true });
    if (fault === 'bad-boolean') Object.assign(config, { spaceless: 'false' });
    if (fault === 'bad-threshold') config.typoGuards.minimumLength = -1;
    if (fault === 'bad-range') config.targetScriptRanges = [[120, 65]];
    if (fault === 'empty-equivalence') config.orthographicEquivalences = [['', 'x']];
    if (fault === 'duplicate-reading')
      config.readingsBySurface = [
        ['学校', 'がっこう'],
        ['学校', 'まなびや'],
      ];
    if (fault === 'bad-punctuation') value.lessons[0]!.punctuationEquivalenceClass = ['two'];
    expect(() => load(value)).toThrow(PackFormatError);
  });
  it('[INV-GRD-29] exact per-lesson punctuation declarations survive decoding', () => {
    const value = metadata();
    value.lessons[0]!.gradedPunctuation = ['?'];
    const runtime = load(value);
    expect(runtime.forExercise('ex-a').unit.gradedPunctuation).toEqual(['?']);
    expect(runtime.forExercise('ex-b').unit.gradedPunctuation).toEqual([]);
  });
  it.each(['ｺｰﾋｰ', 'コ―ヒ―', 'コー ヒー', 'か\u3099っこう'])(
    '[INV-GRD-17] refuses reading keys unavailable after tier-one normalization: %s',
    (surface) => {
      const value = metadata();
      const config = value.profiles[0]!.configuration;
      config.japaneseNormalisation = true;
      config.spaceless = true;
      config.wordBankJoinDelimiter = '';
      config.readingsBySurface = [[surface, 'こーひー']];
      expect(() => load(value)).toThrow(/reading.*normalized/u);
    },
  );
  it('[INV-GRD-17] refuses incompatible readings hidden behind normalized aliases', () => {
    const value = metadata();
    const config = value.profiles[0]!.configuration;
    config.japaneseNormalisation = true;
    config.readingsBySurface = [
      ['コーヒー', 'こーひー'],
      ['ｺｰﾋｰ', 'おちゃ'],
    ];
    expect(() => load(value)).toThrow(PackFormatError);
  });
  it('[INV-GRD-17] baked canonical keys drive the actual reading channel', () => {
    const value = metadata();
    const config = value.profiles[0]!.configuration;
    config.japaneseNormalisation = true;
    config.readingsBySurface = [
      ['橋', 'はし'],
      ['箸', 'はし'],
    ];
    const context = load(value).forExercise('ex-a');
    const item = {
      itemId: 'original-reading-witness',
      family: 'typed-translate' as const,
      accepted: [{ surface: '橋', surfaceId: 'bridge-original', rank: 1 }],
      readingSurfaceNote: 'Use 橋 for the bridge.',
    };
    const verdict = gradeTypedAnswer({
      ...context,
      item,
      answer: '箸',
      learner: NO_SURFACES_INTRODUCED,
    });
    expect(verdict.tier).toBe(2);
    expect(verdict.channel).toBe('reading-surface');
    expect(verdict.mistakeLexemeIds).toEqual([]);
  });
  it('[INV-GRD-20] authored register metadata drives the same core detector and advisory', () => {
    const value = metadata();
    Object.assign(value.profiles[0]!.configuration, {
      registerSlot: {
        suffixesByRegister: { polite: ['ます'], plain: ['る'] },
        advisoryNote: 'Use the polite ending here.',
      },
    });
    value.lessons[0]!.register = 'polite';
    const context = load(value).forExercise('ex-a');
    expect(isRegisterMismatch('食べる', '食べます', context.pack, context.unit)).toBe(true);
    expect(registerAdvisories('食べる', context.pack, context.unit)).toEqual([
      'Use the polite ending here.',
    ]);
    expect(registerAdvisories('食べます', context.pack, context.unit)).toEqual([]);
  });
  it.each(['missing-detector', 'missing-register', 'ambiguous-suffix', 'unknown-field'])(
    '[INV-GRD-20] refuses malformed register declarations: %s',
    (fault) => {
      const value = metadata();
      const detector = {
        suffixesByRegister: { polite: ['ます'], plain: ['る'] },
        advisoryNote: 'Use polite.',
      };
      Object.assign(value.profiles[0]!.configuration, { registerSlot: detector });
      value.lessons[0]!.register = 'polite';
      if (fault === 'missing-detector') value.profiles[0]!.configuration.registerSlot = null;
      if (fault === 'missing-register') value.lessons[0]!.register = 'absent';
      if (fault === 'ambiguous-suffix') detector.suffixesByRegister.plain.push('ます');
      if (fault === 'unknown-field') Object.assign(detector, { defaultRegister: 'polite' });
      expect(() => load(value)).toThrow(PackFormatError);
    },
  );
  it.each([
    'missing-config',
    'missing-nested-field',
    'empty-reading-table',
    'invalid-spaceless-delimiter',
  ])('[INV-GRD-26] refuses absent or inconsistent required declaration: %s', (fault) => {
    const value = metadata();
    const config = value.profiles[0]!.configuration;
    if (fault === 'missing-config') Reflect.deleteProperty(value.profiles[0]!, 'configuration');
    if (fault === 'missing-nested-field')
      Reflect.deleteProperty(config.typoGuards, 'minimumLength');
    if (fault === 'empty-reading-table') config.noWordDelimiter = true;
    if (fault === 'invalid-spaceless-delimiter') config.spaceless = true;
    expect(() => load(value)).toThrow(PackFormatError);
  });
  it('[INV-GRD-02] indexed dictionaries have lazy exact membership and truthful bounded iteration', () => {
    const value = metadata();
    const original = value.profiles[0]!.configuration.targetLanguageWords;
    const words = [
      'cantar',
      'contar',
      'escribo',
      'escribes',
      ...Array.from({ length: 600 }, (_, i) => `word${String(i).padStart(4, '0')}`),
      '😀',
      '\ue000',
    ];
    const declaration = {
      ...inlineDictionary(words),
      kind: 'table',
      table: 'grading_word',
      profileId: 'spanish',
    };
    Reflect.deleteProperty(declaration, 'words');
    Object.assign(value.profiles[0]!.configuration, { targetLanguageWords: declaration });
    const { db, reader } = database(value);
    db.exec(
      'CREATE TABLE grading_word(profile_id TEXT NOT NULL,surface TEXT NOT NULL,PRIMARY KEY(profile_id,surface)) WITHOUT ROWID;',
    );
    for (const word of words)
      db.prepare('INSERT INTO grading_word VALUES (?,?)').run('spanish', word);
    db.prepare('INSERT INTO grading_word VALUES (?,?)').run('english', 'elsewhere');
    const calls: string[] = [];
    const observed: PackReader = {
      get: <T>(sql: string, params: readonly unknown[] = []) => {
        calls.push(sql);
        return reader.get<T>(sql, params);
      },
      all: <T>(sql: string, params: readonly unknown[] = []) => {
        calls.push(sql);
        return reader.all<T>(sql, params);
      },
    };
    const runtime = readGradingMetadata(observed, identity);
    const set = runtime.forExercise('ex-a').pack.targetLanguageWords;
    expect(calls.filter((sql) => sql.includes('grading_word'))).toHaveLength(1);
    expect(calls.find((sql) => sql.includes('grading_word'))).toContain('count(*)');
    expect(set.size).toBe(606);
    expect(set.has('contar')).toBe(true);
    expect(set.has('elsewhere')).toBe(false);
    expect(set.has("contar' OR 1=1 --")).toBe(false);
    const sorted = [...words].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    // Taking one word fetches only one bounded page; no Set algebra or eager copy.
    const beforeFirst = calls.length;
    const firstOnly = set[Symbol.iterator]();
    expect(firstOnly.next()).toEqual({ value: sorted[0], done: false });
    expect(calls.slice(beforeFirst)).toHaveLength(1);
    firstOnly.return?.();
    expect([...set]).toEqual(sorted);
    expect(original.words).toEqual(['cantar', 'contar', 'escribo', 'escribes']);
    expect(
      calls.filter((sql) => sql.includes('SELECT surface')).every((sql) => sql.includes('LIMIT')),
    ).toBe(true);
  });
  it.each([
    'table-missing',
    'count-stale',
    'profile-stale',
    'digest-malformed',
    'provenance-missing',
  ])('[INV-PACK-12] indexed dictionary declaration fails by name: %s', (fault) => {
    const value = metadata();
    const declaration = {
      ...inlineDictionary(['cantar']),
      kind: 'table',
      table: 'grading_word',
      profileId: 'spanish',
    };
    Reflect.deleteProperty(declaration, 'words');
    if (fault === 'count-stale') declaration.count = 2;
    if (fault === 'profile-stale') declaration.profileId = 'english';
    if (fault === 'digest-malformed') declaration.sha256 = 'not-a-sha';
    if (fault === 'provenance-missing') Reflect.deleteProperty(declaration, 'provenance');
    Object.assign(value.profiles[0]!.configuration, { targetLanguageWords: declaration });
    const { db, reader } = database(value);
    if (fault !== 'table-missing')
      db.exec(
        "CREATE TABLE grading_word(profile_id TEXT,surface TEXT); INSERT INTO grading_word VALUES('spanish','cantar');",
      );
    expect(() => readGradingMetadata(reader, identity)).toThrow(/grading:v1.*dictionary/u);
  });
  it.each(['hash', 'count', 'raw-array', 'source-hash', 'normalization-hash', 'newline'])(
    '[INV-GRD-02] inline dictionary integrity is explicit: %s',
    (fault) => {
      const value = metadata();
      const config = value.profiles[0]!.configuration;
      if (fault === 'hash') config.targetLanguageWords.sha256 = 'f'.repeat(64);
      if (fault === 'count') config.targetLanguageWords.count += 1;
      if (fault === 'raw-array') Object.assign(config, { targetLanguageWords: ['cantar'] });
      if (fault === 'source-hash') config.targetLanguageWords.provenance.sourceSha256 = 'bad';
      if (fault === 'normalization-hash')
        config.targetLanguageWords.provenance.normalizationSha256 = 'bad';
      if (fault === 'newline') config.targetLanguageWords = inlineDictionary(['can\ntar']);
      expect(() => load(value)).toThrow(PackFormatError);
    },
  );
  it('[INV-GRD-13] malformed JSON fails visibly', () => {
    expect(() => load('{')).toThrow(PackFormatError);
  });
});
