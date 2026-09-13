/**
 * Production grading metadata, decoded only from the active signed pack.
 *
 * P3/P7 contract approved 2026-09-13. This decoder proves shape and exact database
 * joins, not linguistic completeness. The producer owns licensed dictionaries,
 * reviewed readings, lesson-scoped taught forms and response-language declarations.
 * No grading fixture, language registry, morphology or default policy is consulted.
 */
import { tier1Normalise } from '../grading/normalise.js';
import type { GradingPack, GradingUnit, RegisterDetector, TypoGuards } from '../grading/types.js';
import { sha256Hex } from './hashing.js';
import { PackFormatError, type PackMeta, type PackReader } from './loader.js';

export const GRADING_METADATA_KEY = 'grading:v1';
export const GRADING_METADATA_VERSION = 1;
/** Root loader/schema integration must account for these real queries. */
export const GRADING_METADATA_READS = {
  meta: ['key', 'value'],
  unit: ['unit_id'],
  lexeme: ['lexeme_id'],
  exercise: ['exercise_id', 'unit_id', 'lesson_index'],
  grading_word: ['profile_id', 'surface'],
} as const;

/** Contract frozen 2026-09-13. Dictionary assets retain their own licence/notices. */
export interface DictionaryProvenance {
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly sourceUrl: string;
  readonly license: string;
  readonly notice: string;
  readonly normalizationId: string;
  readonly normalizationSha256: string;
  readonly policySha256: string;
}
export type GradingDictionaryDeclaration = {
  readonly count: number;
  /** SHA256 over UTF-8, BINARY-sorted unique surfaces, each followed by LF. */
  readonly sha256: string;
  readonly provenance: DictionaryProvenance;
} & (
  | { readonly kind: 'inline'; readonly words: readonly string[] }
  | { readonly kind: 'table'; readonly table: 'grading_word'; readonly profileId: string }
);
/** Bounded keyset page size, an implementation setting, not a grading threshold. */
export const GRADING_DICTIONARY_PAGE_SIZE = 256;

export interface ExerciseGradingContext {
  readonly profileId: string;
  readonly responseLanguage: string;
  readonly pack: GradingPack;
  readonly unit: GradingUnit;
}
export interface LoadedGradingMetadata {
  /** Cache belongs to this immutable reader and exact pack identity/version. */
  isFor(reader: PackReader, meta: GradingPackIdentity): boolean;
  forExercise(exerciseId: string): ExerciseGradingContext;
}
export type GradingPackIdentity = Pick<PackMeta, 'packId' | 'courseId' | 'version' | 'lang'>;

type JsonObject = Record<string, unknown>;
interface Profile {
  readonly profileId: string;
  readonly responseLanguage: string;
  readonly pack: GradingPack;
}
interface ExerciseReference {
  readonly exercise_id: string;
  readonly unit_id: string;
  readonly lesson_index: number;
}

const ROOT_FIELDS = [
  'schemaVersion',
  'packId',
  'courseId',
  'packVersion',
  'profiles',
  'lessons',
  'exercises',
] as const;
const PROFILE_FIELDS = ['profileId', 'responseLanguage', 'configuration'] as const;
const CONFIG_FIELDS = [
  'orthographicEquivalences',
  'spaceless',
  'noWordBoundaries',
  'noWordDelimiter',
  'readingsBySurface',
  'japaneseNormalisation',
  'diacriticsContrastive',
  'contrastiveDiacritics',
  'typoGuards',
  'targetLanguageWords',
  'functionClassTokens',
  'targetScriptRanges',
  'scriptOnlyAnswers',
  'wordBankJoinDelimiter',
  'openResponseLengthUnit',
  'registerSlot',
] as const;
const LESSON_FIELDS = [
  'unitId',
  'lessonIndex',
  'profileId',
  'register',
  'punctuationEquivalenceClass',
  'gradedPunctuation',
  'taughtInflections',
  'openResponseMinimumLength',
] as const;
const BINDING_FIELDS = [
  'exerciseId',
  'unitId',
  'lessonIndex',
  'profileId',
  'responseLanguage',
] as const;

function invalid(where: string, why: string): never {
  throw new PackFormatError(`${GRADING_METADATA_KEY} ${where}: ${why}`);
}
function object(value: unknown, fields: readonly string[], where: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(where, 'expected object');
  const result = value as JsonObject;
  if (
    Object.keys(result).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(result, key))
  ) {
    invalid(where, 'missing or unknown fields');
  }
  return result;
}
function string(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    invalid(where, 'expected nonblank string');
  return value;
}
function boolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') invalid(where, 'expected boolean');
  return value;
}
function integer(value: unknown, where: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    invalid(where, 'invalid integer');
  return value;
}
function array(value: unknown, where: string, nonempty = false): unknown[] {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) invalid(where, 'expected array');
  return value;
}
function strings(value: unknown, where: string, nonempty = false): readonly string[] {
  const rows = array(value, where, nonempty).map((entry) => string(entry, where));
  if (new Set(rows).size !== rows.length) invalid(where, 'duplicate entry');
  return Object.freeze(rows);
}
function characters(value: unknown, where: string): readonly string[] {
  const result = strings(value, where);
  if (result.some((entry) => [...entry].length !== 1))
    invalid(where, 'expected individual characters');
  return result;
}
function choice<T extends string>(value: unknown, options: readonly T[], where: string): T {
  if (!options.includes(value as T)) invalid(where, 'unsupported value');
  return value as T;
}
function pairs(value: unknown, where: string): readonly (readonly [string, string])[] {
  const seen = new Set<string>();
  return Object.freeze(
    array(value, where).map((entry) => {
      const pair = array(entry, where);
      if (pair.length !== 2) invalid(where, 'expected pair');
      const from = string(pair[0], where);
      const to = string(pair[1], where);
      if (seen.has(from)) invalid(where, 'duplicate source');
      seen.add(from);
      return Object.freeze([from, to] as const);
    }),
  );
}
function registerDetector(value: unknown, where: string): RegisterDetector | null {
  if (value === null) return null;
  const record = object(value, ['suffixesByRegister', 'advisoryNote'], where);
  const raw = record.suffixesByRegister;
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length === 0
  )
    invalid(where, 'missing register suffixes');
  const suffixes: Record<string, readonly string[]> = Object.create(null) as Record<
    string,
    readonly string[]
  >;
  const allSuffixes = new Set<string>();
  for (const [register, entries] of Object.entries(raw)) {
    string(register, where);
    const values = strings(entries, where, true);
    for (const suffix of values) {
      if (allSuffixes.has(suffix)) invalid(where, 'ambiguous register suffix');
      allSuffixes.add(suffix);
    }
    suffixes[register] = values;
  }
  return Object.freeze({
    suffixesByRegister: Object.freeze(suffixes),
    advisoryNote: string(record.advisoryNote, where),
  });
}
function typoGuards(value: unknown, where: string): TypoGuards {
  const record = object(
    value,
    [
      'rejectRealTargetWord',
      'rejectEditOnTargetLexeme',
      'minimumLength',
      'lengthUnit',
      'preserveMoraCount',
    ],
    where,
  );
  return Object.freeze({
    rejectRealTargetWord: boolean(record.rejectRealTargetWord, where),
    rejectEditOnTargetLexeme: boolean(record.rejectEditOnTargetLexeme, where),
    minimumLength: integer(record.minimumLength, where, 1),
    lengthUnit: choice(record.lengthUnit, ['characters', 'mora'], where),
    preserveMoraCount: boolean(record.preserveMoraCount, where),
  });
}
function digest(value: unknown, where: string): string {
  const result = string(value, where);
  if (!/^[a-f0-9]{64}$/u.test(result)) invalid(where, 'expected SHA256');
  return result;
}
function dictionaryWord(value: unknown, where: string): string {
  const result = string(value, where);
  if (result.includes('\0') || /[\r\n\uD800-\uDFFF]/u.test(result))
    invalid(where, 'invalid surface encoding');
  return result;
}
/** UTF-8 SQLite BINARY order, including astral characters; never locale collation. */
function binaryOrder(left: string, right: string): number {
  const a = [...left],
    b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = a[i]!.codePointAt(0)! - b[i]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}
function dictionaryProvenance(value: unknown, where: string): DictionaryProvenance {
  const row = object(
    value,
    [
      'sourceId',
      'sourceSha256',
      'sourceUrl',
      'license',
      'notice',
      'normalizationId',
      'normalizationSha256',
      'policySha256',
    ],
    where,
  );
  return Object.freeze({
    sourceId: string(row.sourceId, where),
    sourceSha256: digest(row.sourceSha256, where),
    sourceUrl: string(row.sourceUrl, where),
    license: string(row.license, where),
    notice: string(row.notice, where),
    normalizationId: string(row.normalizationId, where),
    normalizationSha256: digest(row.normalizationSha256, where),
    policySha256: digest(row.policySha256, where),
  });
}
/**
 * The signed, install-verified SQLite payload binds table contents. G9 verifies the
 * declared content hash at build; this adapter verifies count and reads exact keys.
 * It does not claim to rehash millions of words whenever a lesson is opened.
 */
class IndexedDictionary implements ReadonlySet<string> {
  readonly [Symbol.toStringTag] = 'Set';
  private readonly reader: PackReader;
  private readonly profileId: string;
  readonly size: number;
  constructor(reader: PackReader, profileId: string, size: number) {
    this.reader = reader;
    this.profileId = profileId;
    this.size = size;
  }
  has(value: string): boolean {
    return (
      this.reader.get<{ present: number }>(
        'SELECT 1 AS present FROM grading_word WHERE profile_id = ? AND surface = ?',
        [this.profileId, value],
      ) !== undefined
    );
  }
  *values(): SetIterator<string> {
    let after: string | null = null;
    while (true) {
      const page = this.reader.all<{ surface: string }>(
        after === null
          ? 'SELECT surface FROM grading_word WHERE profile_id = ? ORDER BY surface COLLATE BINARY LIMIT ?'
          : 'SELECT surface FROM grading_word WHERE profile_id = ? AND surface > ? COLLATE BINARY ORDER BY surface COLLATE BINARY LIMIT ?',
        after === null
          ? [this.profileId, GRADING_DICTIONARY_PAGE_SIZE]
          : [this.profileId, after, GRADING_DICTIONARY_PAGE_SIZE],
      );
      if (page.length === 0) return;
      for (const row of page) {
        const word = dictionaryWord(row.surface, 'dictionary table');
        if (after !== null && binaryOrder(word, after) <= 0)
          invalid('dictionary table', 'unordered or duplicate surface');
        after = word;
        yield word;
      }
    }
  }
  keys(): SetIterator<string> {
    return this.values();
  }
  *entries(): SetIterator<[string, string]> {
    for (const value of this.values()) yield [value, value];
  }
  [Symbol.iterator](): SetIterator<string> {
    return this.values();
  }
  forEach(
    callbackfn: (value: string, value2: string, set: ReadonlySet<string>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.values()) callbackfn.call(thisArg, value, value, this);
  }
}
function dictionary(value: unknown, profileId: string, reader: PackReader): ReadonlySet<string> {
  const where = `dictionary ${profileId}`;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(where, 'expected discriminated declaration');
  const kind = (value as JsonObject).kind;
  const row = object(
    value,
    kind === 'inline'
      ? ['kind', 'words', 'count', 'sha256', 'provenance']
      : ['kind', 'table', 'profileId', 'count', 'sha256', 'provenance'],
    where,
  );
  const count = integer(row.count, where, 1);
  const sha256 = digest(row.sha256, where);
  dictionaryProvenance(row.provenance, where);
  if (kind === 'inline') {
    const words = strings(row.words, where, true).map((word) => dictionaryWord(word, where));
    if (words.length !== count) invalid(where, 'count mismatch');
    if (
      sha256Hex(
        [...words]
          .sort(binaryOrder)
          .map((word) => `${word}\n`)
          .join(''),
      ) !== sha256
    )
      invalid(where, 'content digest mismatch');
    return new Set(words);
  }
  if (kind !== 'table' || row.table !== 'grading_word' || row.profileId !== profileId)
    invalid(where, 'wrong table or profile');
  let actual: unknown;
  try {
    actual = reader.get<{ count: number }>(
      'SELECT count(*) AS count FROM grading_word WHERE profile_id = ?',
      [profileId],
    )?.count;
  } catch {
    invalid(where, 'missing or unreadable grading_word table');
  }
  if (actual !== count) invalid(where, 'table count mismatch');
  return Object.freeze(new IndexedDictionary(reader, profileId, count));
}
function profile(value: unknown, meta: GradingPackIdentity, reader: PackReader): Profile {
  const row = object(value, PROFILE_FIELDS, 'profile');
  const profileId = string(row.profileId, 'profileId');
  const responseLanguage = string(row.responseLanguage, 'responseLanguage');
  const where = `profile ${profileId}`;
  const config = object(row.configuration, CONFIG_FIELDS, where);
  const ranges = array(config.targetScriptRanges, where, true).map((entry) => {
    const pair = array(entry, where);
    if (pair.length !== 2) invalid(where, 'invalid script range');
    const low = integer(pair[0], where, 0);
    const high = integer(pair[1], where, low);
    if (high > 0x10ffff) invalid(where, 'script range exceeds Unicode');
    return Object.freeze([low, high] as const);
  });
  const pack: GradingPack = Object.freeze({
    packId: meta.packId,
    label: meta.packId,
    orthographicEquivalences: pairs(config.orthographicEquivalences, where),
    spaceless: boolean(config.spaceless, where),
    noWordBoundaries: boolean(config.noWordBoundaries, where),
    noWordDelimiter: boolean(config.noWordDelimiter, where),
    readingsBySurface: new Map(pairs(config.readingsBySurface, where)),
    japaneseNormalisation: boolean(config.japaneseNormalisation, where),
    diacriticsContrastive: boolean(config.diacriticsContrastive, where),
    contrastiveDiacritics: characters(config.contrastiveDiacritics, where),
    typoGuards: typoGuards(config.typoGuards, where),
    targetLanguageWords: dictionary(config.targetLanguageWords, profileId, reader),
    functionClassTokens: new Set(strings(config.functionClassTokens, where)),
    targetScriptRanges: Object.freeze(ranges),
    scriptOnlyAnswers: boolean(config.scriptOnlyAnswers, where),
    wordBankJoinDelimiter:
      typeof config.wordBankJoinDelimiter === 'string'
        ? config.wordBankJoinDelimiter
        : invalid(where, 'missing delimiter'),
    openResponseLengthUnit: choice(config.openResponseLengthUnit, ['characters', 'tokens'], where),
    registerSlot: registerDetector(config.registerSlot, where),
  });
  // The grader looks up tier-one-normalized answers. Require the producer to
  // supply those exact keys: silently rewriting aliases could erase a conflicting
  // reviewed reading, while keeping an unreachable raw key would lose its answer.
  // Reading VALUES remain the producer's exact baked strings; no reading is derived.
  for (const surface of pack.readingsBySurface.keys()) {
    if (tier1Normalise(surface, pack) !== surface)
      invalid(where, 'reading surface key must be tier-one normalized');
  }
  if (pack.noWordDelimiter && pack.readingsBySurface.size === 0)
    invalid(where, 'reading-based grading requires baked readings');
  if (pack.spaceless && pack.wordBankJoinDelimiter !== '')
    invalid(where, 'spaceless word bank cannot insert a delimiter');
  return Object.freeze({ profileId, responseLanguage, pack });
}
function lessonKey(unitId: string, lessonIndex: number, profileId: string): string {
  return JSON.stringify([unitId, lessonIndex, profileId]);
}
function declaredIds<T>(rows: T[], value: (row: T) => unknown, where: string): Set<string> {
  const result = new Set<string>();
  for (const row of rows) {
    const id = string(value(row), where);
    if (result.has(id)) invalid(where, 'duplicate database identity');
    result.add(id);
  }
  return result;
}

/** No metadata means no production grading capability; callers display that failure. */
export function readGradingMetadata(
  reader: PackReader,
  meta: GradingPackIdentity,
): LoadedGradingMetadata {
  const identity = Object.freeze({
    packId: meta.packId,
    courseId: meta.courseId,
    version: meta.version,
    lang: meta.lang,
  });
  const stored = reader.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
    GRADING_METADATA_KEY,
  ]);
  if (stored === undefined || typeof stored.value !== 'string')
    invalid('metadata', 'missing production grading data');
  let raw: unknown;
  try {
    raw = JSON.parse(stored.value);
  } catch {
    invalid('metadata', 'invalid JSON');
  }
  const root = object(raw, ROOT_FIELDS, 'metadata');
  if (root.schemaVersion !== GRADING_METADATA_VERSION)
    invalid('metadata', 'unsupported schema version');
  if (
    root.packId !== meta.packId ||
    root.courseId !== meta.courseId ||
    root.packVersion !== meta.version
  )
    invalid('metadata', 'stale pack identity');
  const units = declaredIds(
    reader.all<{ unit_id: string }>('SELECT unit_id FROM unit'),
    (row) => row.unit_id,
    'unit',
  );
  const lexemes = declaredIds(
    reader.all<{ lexeme_id: string }>('SELECT lexeme_id FROM lexeme'),
    (row) => row.lexeme_id,
    'lexeme',
  );
  const references = new Map<string, ExerciseReference>();
  for (const row of reader.all<ExerciseReference>(
    'SELECT exercise_id, unit_id, lesson_index FROM exercise',
  )) {
    string(row.exercise_id, 'exercise');
    string(row.unit_id, 'exercise');
    integer(row.lesson_index, 'exercise', 1);
    if (!units.has(row.unit_id) || references.has(row.exercise_id))
      invalid('exercise', 'duplicate or unknown database unit');
    references.set(row.exercise_id, row);
  }
  if (references.size === 0) invalid('exercise', 'no declared exercises');
  const profiles = new Map<string, Profile>();
  for (const value of array(root.profiles, 'profiles', true)) {
    const parsed = profile(value, meta, reader);
    if (profiles.has(parsed.profileId)) invalid('profiles', 'duplicate profile');
    profiles.set(parsed.profileId, parsed);
  }
  const lessons = new Map<string, GradingUnit>();
  for (const value of array(root.lessons, 'lessons', true)) {
    const row = object(value, LESSON_FIELDS, 'lesson');
    const unitId = string(row.unitId, 'lesson');
    const lessonIndex = integer(row.lessonIndex, 'lesson', 1);
    const profileId = string(row.profileId, 'lesson');
    const selected = profiles.get(profileId);
    if (!units.has(unitId) || selected === undefined) invalid('lesson', 'unknown unit or profile');
    if (
      ![...references.values()].some(
        (ref) => ref.unit_id === unitId && ref.lesson_index === lessonIndex,
      )
    )
      invalid('lesson', 'lesson not declared by pack exercises');
    const key = lessonKey(unitId, lessonIndex, profileId);
    if (lessons.has(key)) invalid('lesson', 'duplicate lesson view');
    const inflections: Record<string, readonly string[]> = Object.create(null) as Record<
      string,
      readonly string[]
    >;
    for (const entry of array(row.taughtInflections, 'taughtInflections')) {
      const inflection = object(entry, ['lexemeId', 'surfaces'], 'taughtInflections');
      const lexemeId = string(inflection.lexemeId, 'taughtInflections');
      if (!lexemes.has(lexemeId) || Object.hasOwn(inflections, lexemeId))
        invalid('taughtInflections', 'unknown or duplicate lexeme identity');
      inflections[lexemeId] = strings(inflection.surfaces, 'taughtInflections', true);
    }
    const register = row.register === null ? null : string(row.register, 'register');
    if (
      register !== null &&
      (selected.pack.registerSlot === null ||
        !Object.hasOwn(selected.pack.registerSlot.suffixesByRegister, register))
    )
      invalid('register', 'unit register has no declared detector');
    lessons.set(
      key,
      Object.freeze({
        unitId,
        register,
        punctuationEquivalenceClass: characters(
          row.punctuationEquivalenceClass,
          'punctuationEquivalenceClass',
        ),
        gradedPunctuation: characters(row.gradedPunctuation, 'gradedPunctuation'),
        taughtInflections: Object.freeze(inflections),
        openResponseMinimumLength: integer(
          row.openResponseMinimumLength,
          'openResponseMinimumLength',
          1,
        ),
      }),
    );
  }
  const contexts = new Map<string, ExerciseGradingContext>();
  for (const value of array(root.exercises, 'exercises', true)) {
    const row = object(value, BINDING_FIELDS, 'exercise binding');
    const exerciseId = string(row.exerciseId, 'exercise binding');
    const unitId = string(row.unitId, 'exercise binding');
    const lessonIndex = integer(row.lessonIndex, 'exercise binding', 1);
    const profileId = string(row.profileId, 'exercise binding');
    const responseLanguage = string(row.responseLanguage, 'exercise binding');
    const reference = references.get(exerciseId);
    const selected = profiles.get(profileId);
    if (
      reference === undefined ||
      reference.unit_id !== unitId ||
      reference.lesson_index !== lessonIndex
    )
      invalid('exercise binding', 'stale exercise placement');
    if (selected === undefined || selected.responseLanguage !== responseLanguage)
      invalid('exercise binding', 'response-language profile mismatch');
    const unit = lessons.get(lessonKey(unitId, lessonIndex, profileId));
    if (unit === undefined || contexts.has(exerciseId))
      invalid('exercise binding', 'missing exact lesson view or duplicate binding');
    contexts.set(
      exerciseId,
      Object.freeze({ profileId, responseLanguage, pack: selected.pack, unit }),
    );
  }
  if (contexts.size !== references.size) invalid('exercise binding', 'incomplete pack population');
  return Object.freeze({
    isFor(candidate: PackReader, target: GradingPackIdentity) {
      return (
        candidate === reader &&
        target.packId === identity.packId &&
        target.courseId === identity.courseId &&
        target.version === identity.version &&
        target.lang === identity.lang
      );
    },
    forExercise(exerciseId: string) {
      const result = contexts.get(exerciseId);
      if (result === undefined) invalid('exercise', `no grading metadata for ${exerciseId}`);
      return result;
    },
  });
}
