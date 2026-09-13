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
import { PackFormatError, type PackMeta, type PackReader } from './loader.js';

export const GRADING_METADATA_KEY = 'grading:v1';
export const GRADING_METADATA_VERSION = 1;
/** Root loader/schema integration must account for these real queries. */
export const GRADING_METADATA_READS = {
  meta: ['key', 'value'],
  unit: ['unit_id'],
  lexeme: ['lexeme_id'],
  exercise: ['exercise_id', 'unit_id', 'lesson_index'],
} as const;

export interface ExerciseGradingContext {
  readonly profileId: string;
  readonly responseLanguage: string;
  readonly pack: GradingPack;
  readonly unit: GradingUnit;
}
export interface LoadedGradingMetadata {
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
function profile(value: unknown, meta: GradingPackIdentity): Profile {
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
    targetLanguageWords: new Set(strings(config.targetLanguageWords, where, true)),
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
    const parsed = profile(value, meta);
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
    forExercise(exerciseId: string) {
      const result = contexts.get(exerciseId);
      if (result === undefined) invalid('exercise', `no grading metadata for ${exerciseId}`);
      return result;
    },
  });
}
