/**
 * Revision-1 production runtime items, 2026-09-13.
 *
 * Decode only the active pack's hashed exercise_runtime row and exact SQL joins.
 * The source producer owns language review/engine evidence. Runtime verifies their
 * stored bindings and types; a signature is not a licence to invent missing fields.
 * The supported shapes are the current structured producer's seventeen shapes.
 */
import type { AcceptedForm, ItemFamily } from '../grading/types.js';
import type { ExerciseType } from '../session/types.js';
import { exerciseSpec } from '../session/registry.js';
import { sha256Hex } from './hashing.js';
import {
  readGradingMetadata,
  type ExerciseGradingContext,
  type GradingPackIdentity,
  type LoadedGradingMetadata,
} from './grading.js';
import { PackFormatError, type PackReader } from './loader.js';

export const RUNTIME_ITEM_VERSION = 1;
export const RUNTIME_ITEM_READS = {
  exercise_runtime: ['exercise_id', 'payload_json', 'payload_sha256'],
  exercise: [
    'exercise_id',
    'item_id',
    'unit_id',
    'lesson_index',
    'type',
    'prompt',
    'accepted_answers_json',
    'distractors_json',
    'audio_id',
    'illustration_ref',
    'source_sentence_id',
  ],
  lexeme: ['lexeme_id'],
  audio: ['audio_id', 'clip_hash', 'path', 'duration_ms', 'bytes'],
} as const;

export type {
  RuntimeItemProof,
  RuntimeIntroduction,
  VerifiedRuntimeItem,
  RuntimeItemReader,
} from './runtime-item-types.js';
import type { VerifiedRuntimeItem } from './runtime-item-types.js';

type ObjectValue = Record<string, unknown>;
interface ActualExercise {
  readonly exercise_id: string;
  readonly item_id: string;
  readonly unit_id: string;
  readonly lesson_index: number;
  readonly type: string;
  readonly prompt: string;
  readonly accepted_answers_json: string;
  readonly distractors_json: string;
  readonly audio_id: string | null;
  readonly illustration_ref: string | null;
  readonly source_sentence_id: string | null;
}
interface Shape {
  readonly family: ItemFamily;
  readonly types: readonly string[];
  readonly audio?: boolean;
}
/** Shape identities, not a language-dependent grading policy or fallback pack. */
const SHAPES: Partial<Record<ExerciseType, Shape>> = {
  pictureSelect: { family: 'select', types: ['match'] },
  meaningSelect: { family: 'select', types: ['match'] },
  matchPairs: { family: 'match', types: ['match'] },
  wordBankTranslate: { family: 'word-bank', types: ['word_bank'] },
  typedTranslate: { family: 'typed-translate', types: ['translate', 'reverse_translate'] },
  completeChat: { family: 'select', types: ['cloze'], audio: true },
  listenTapWhatYouHear: { family: 'word-bank', types: ['listen'], audio: true },
  listenTypeWhatYouHear: { family: 'listening', types: ['listen'], audio: true },
  listenMissingWord: { family: 'gap-fill', types: ['listen'], audio: true },
  gapFillSelect: { family: 'gap-fill', types: ['cloze'] },
  gapFillTyped: { family: 'gap-fill', types: ['cloze'] },
  typeWordEnding: { family: 'gap-fill', types: ['cloze'] },
  readAndRespond: { family: 'read-and-respond', types: ['speak'] },
  listenAndRespond: { family: 'listen-and-respond', types: ['listen'], audio: true },
  speakSentence: { family: 'speaking', types: ['speak'], audio: true },
};
const ROOT_FIELDS = [
  'schemaVersion',
  'exerciseId',
  'itemId',
  'unitId',
  'lessonIndex',
  'profileId',
  'responseLanguage',
  'proof',
  'gradable',
  'presentation',
  'introductions',
  'explanation',
] as const;
const PRESENTATION_REQUIRED = [
  'itemId',
  'type',
  'instruction',
  'prompt',
  'language',
  'acceptedAnswers',
] as const;
const PRESENTATION_OPTIONAL = [
  'promptLanguage',
  'options',
  'bank',
  'pairs',
  'audioRef',
  'audioText',
  'hints',
  'slowAudioRef',
  'requiresIme',
  'accentCharacters',
  'introduction',
  'tip',
  'hard',
] as const;
const GRADABLE_OPTIONAL = [
  'gaps',
  'pairs',
  'tiles',
  'targetLexemeId',
  'targetLexemeSurface',
  'prompt',
  'requiredLexemeIds',
  'schedulerFacet',
] as const;

function fail(where: string, reason: string): never {
  throw new PackFormatError(`exercise_runtime ${where}: ${reason}`);
}
function object(
  value: unknown,
  required: readonly string[],
  where: string,
  optional: readonly string[] = [],
): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(where, 'expected object');
  const row = value as ObjectValue;
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail(where, 'missing or unknown fields');
  return row;
}
function text(value: unknown, where: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.includes('\0') ||
    /[\uD800-\uDFFF]/u.test(value)
  )
    fail(where, 'expected nonblank valid text');
  return value;
}
function integer(value: unknown, where: string, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    fail(where, 'invalid integer');
  return value;
}
function digest(value: unknown, where: string): string {
  const sha = text(value, where);
  if (!/^[0-9a-f]{64}$/u.test(sha)) fail(where, 'expected SHA256');
  return sha;
}
function array(value: unknown, where: string, nonempty = false): unknown[] {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) fail(where, 'expected array');
  return value;
}
function strings(value: unknown, where: string, nonempty = false): string[] {
  const result = array(value, where, nonempty).map((v) => text(v, where));
  if (new Set(result).size !== result.length) fail(where, 'duplicate identity/value');
  return result;
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function parse(raw: string, where: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    fail(where, 'invalid JSON');
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function accepted(value: unknown, language: string, where: string): AcceptedForm[] {
  const forms = array(value, where, true).map((entry) => {
    const row = object(entry, ['surfaceId', 'surface', 'rank'], where);
    const surface = text(row.surface, where),
      surfaceId = text(row.surfaceId, where);
    if (surfaceId !== `sf_${sha256Hex(JSON.stringify([language, surface])).slice(0, 32)}`)
      fail(where, 'surface identity does not match exact language/text');
    return { surface, surfaceId, rank: integer(row.rank, where, 0) };
  });
  if (new Set(forms.map((row) => row.surfaceId)).size !== forms.length)
    fail(where, 'duplicate accepted surface');
  return forms;
}
function lexeme(reader: PackReader, value: unknown, where: string): string {
  const id = text(value, where);
  if (
    reader.get<{ lexeme_id: string }>('SELECT lexeme_id FROM lexeme WHERE lexeme_id = ?', [id])
      ?.lexeme_id !== id
  )
    fail(where, 'unknown declared lexeme');
  return id;
}
function audio(reader: PackReader, value: unknown): string {
  const id = text(value, 'audio reference');
  const row = reader.get<{
    audio_id: string;
    clip_hash: string;
    path: string;
    duration_ms: number;
    bytes: number;
  }>('SELECT audio_id, clip_hash, path, duration_ms, bytes FROM audio WHERE audio_id = ?', [id]);
  if (row === undefined || row.audio_id !== id) fail('audio', 'missing built row');
  digest(row.clip_hash, 'audio hash');
  integer(row.duration_ms, 'audio duration');
  integer(row.bytes, 'audio bytes');
  const path = text(row.path, 'audio path');
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('://') ||
    path.split('/').some((part) => part === '..' || part === '')
  )
    fail('audio', 'unsafe pack-relative path');
  return id;
}
function entries(
  value: unknown,
  fields: readonly string[],
  where: string,
  optional: readonly string[] = [],
): ObjectValue[] {
  return array(value, where, true).map((row) => object(row, fields, where, optional));
}
function unique(rows: ObjectValue[], field: string, where: string): void {
  const ids = rows.map((row) => text(row[field], where));
  if (new Set(ids).size !== ids.length) fail(where, 'duplicate identity');
}

/** Exact literal assembly under the authored delimiter; no tokenization or alternatives. */
function bankCanConstruct(texts: readonly string[], answer: string, delimiter: string): boolean {
  const counts = new Map<string, number>();
  for (const value of texts) counts.set(value, (counts.get(value) ?? 0) + 1);
  const words = [...counts.keys()];
  const remaining = words.map((word) => counts.get(word)!);
  const failed = new Set<string>();
  const visit = (position: number, started: boolean): boolean => {
    if (position === answer.length) return started;
    const key = JSON.stringify([position, remaining]);
    if (failed.has(key)) return false;
    for (let index = 0; index < words.length; index++) {
      if (remaining[index] === 0) continue;
      const part = (started ? delimiter : '') + words[index]!;
      if (!answer.startsWith(part, position)) continue;
      remaining[index]!--;
      const found = visit(position + part.length, true);
      remaining[index]!++;
      if (found) return true;
    }
    failed.add(key);
    return false;
  };
  return visit(0, false);
}

function decodePayload(
  value: unknown,
  exercise: ActualExercise,
  grading: ExerciseGradingContext,
  reader: PackReader,
): VerifiedRuntimeItem {
  const row = object(value, ROOT_FIELDS, 'payload');
  if (row.schemaVersion !== RUNTIME_ITEM_VERSION) fail('payload', 'unsupported revision');
  const exerciseId = text(row.exerciseId, 'exercise ID'),
    itemId = text(row.itemId, 'item ID'),
    unitId = text(row.unitId, 'unit ID'),
    lessonIndex = integer(row.lessonIndex, 'lesson index');
  const profileId = text(row.profileId, 'profile ID'),
    responseLanguage = text(row.responseLanguage, 'response language');
  if (
    exerciseId !== exercise.exercise_id ||
    itemId !== exercise.item_id ||
    unitId !== exercise.unit_id ||
    lessonIndex !== exercise.lesson_index
  )
    fail('payload', 'actual exercise/item/unit/lesson mismatch');
  if (
    profileId !== grading.profileId ||
    responseLanguage !== grading.responseLanguage ||
    unitId !== grading.unit.unitId
  )
    fail('payload', 'actual grading context mismatch');
  const proof = object(
    row.proof,
    ['sourceId', 'sourceSha256', 'approvalId', 'approvalSha256', 'draftSha256'],
    'proof',
  );
  const sourceId = text(proof.sourceId, 'proof source');
  text(proof.approvalId, 'proof approval');
  for (const name of ['sourceSha256', 'approvalSha256', 'draftSha256'])
    digest(proof[name], 'proof ' + name);
  if (exercise.source_sentence_id !== null && sourceId !== exercise.source_sentence_id)
    fail('proof', 'actual source identity mismatch');
  text(row.explanation, 'baked explanation');
  const presentation = object(
    row.presentation,
    PRESENTATION_REQUIRED,
    'presentation',
    PRESENTATION_OPTIONAL,
  );
  const type = text(presentation.type, 'presentation type') as ExerciseType,
    shape = SHAPES[type];
  if (shape === undefined || !shape.types.includes(exercise.type))
    fail('presentation', 'unsupported or mismatched actual exercise type');
  const gradable = object(
    row.gradable,
    ['itemId', 'family', 'accepted'],
    'gradable',
    GRADABLE_OPTIONAL,
  );
  if (
    gradable.itemId !== itemId ||
    presentation.itemId !== itemId ||
    gradable.family !== shape.family
  )
    fail('gradable', 'item/family mismatch');
  if (presentation.language !== responseLanguage)
    fail('presentation', 'response language mismatch');
  const forms = accepted(gradable.accepted, responseLanguage, 'accepted forms');
  const actualAnswers = strings(
    parse(exercise.accepted_answers_json, 'actual accepted answers'),
    'actual accepted answers',
    true,
  );
  if (
    !same(
      forms.map((form) => form.surface),
      actualAnswers,
    ) ||
    !same(presentation.acceptedAnswers, actualAnswers)
  )
    fail('accepted forms', 'current authored set mismatch');
  if (
    text(presentation.instruction, 'instruction') + '\n' + text(presentation.prompt, 'prompt') !==
    exercise.prompt
  )
    fail('presentation', 'actual instruction/body mismatch');
  const introductionKeys = new Set<string>();
  for (const value of array(row.introductions, 'introductions')) {
    const intro = object(value, ['surfaceId', 'surface', 'language', 'when'], 'introductions');
    const surface = text(intro.surface, 'introductions surface');
    const language = text(intro.language, 'introductions language');
    const id = text(intro.surfaceId, 'introductions identity');
    if (id !== 'sf_' + sha256Hex(JSON.stringify([language, surface])).slice(0, 32))
      fail('introductions', 'surface identity mismatch');
    if (intro.when === 'prompt') {
      // Same visible prompt predicate as the actual LessonPlayer. An optional audio
      // button does not hide speaking/text prompts. The carrier names the language.
      if (
        (exerciseSpec(type).requiresAudio && type !== 'completeChat') ||
        presentation.promptLanguage === undefined ||
        surface !== presentation.prompt ||
        language !== presentation.promptLanguage
      )
        fail('introductions', 'prompt is hidden, different, or lacks explicit language');
    } else if (intro.when === 'wrong-feedback') {
      if (surface !== actualAnswers[0] || language !== responseLanguage)
        fail('introductions', 'wrong feedback does not display this surface');
    } else fail('introductions', 'unknown display event');
    const key = JSON.stringify([id, intro.when]);
    if (introductionKeys.has(key)) fail('introductions', 'duplicate display witness');
    introductionKeys.add(key);
  }
  if ((gradable.targetLexemeId === undefined) !== (gradable.targetLexemeSurface === undefined))
    fail('target lexeme', 'ID and surface must be paired');
  if (gradable.targetLexemeId !== undefined) {
    lexeme(reader, gradable.targetLexemeId, 'target lexeme');
    text(gradable.targetLexemeSurface, 'target surface');
  }
  if (gradable.schedulerFacet !== undefined && gradable.schedulerFacet !== 'meaning')
    fail('scheduler facet', 'unsupported producer facet');
  const familyFields: Partial<Record<ItemFamily, readonly string[]>> = {
    'gap-fill': ['gaps'],
    match: ['pairs'],
    'word-bank': ['tiles'],
    'read-and-respond': ['prompt', 'requiredLexemeIds'],
    'listen-and-respond': ['prompt', 'requiredLexemeIds'],
  };
  const allowed = new Set([
    'itemId',
    'family',
    'accepted',
    'targetLexemeId',
    'targetLexemeSurface',
    'schedulerFacet',
    ...(familyFields[shape.family] ?? []),
  ]);
  if (Object.keys(gradable).some((key) => !allowed.has(key)))
    fail('gradable', 'fields belong to another family');
  if (shape.family === 'gap-fill') {
    const gaps = entries(gradable.gaps, ['gapId', 'accepted'], 'gaps');
    if (gaps.length !== 1) fail('gaps', 'current source carrier requires one proven gap');
    unique(gaps, 'gapId', 'gap ID');
    if (!same(accepted(gaps[0]!.accepted, responseLanguage, 'gap accepted forms'), forms))
      fail('gaps', 'accepted forms/ranks differ from authored set');
  }
  if (shape.family === 'word-bank') {
    const tiles = entries(gradable.tiles, ['tileId', 'text'], 'tiles'),
      bank = entries(presentation.bank, ['id', 'text'], 'visible bank');
    unique(tiles, 'tileId', 'tile');
    unique(bank, 'id', 'bank');
    for (const tile of tiles) text(tile.text, 'tile text');
    if (
      tiles.length !== bank.length ||
      tiles.some(
        (tile) => !bank.some((shown) => shown.id === tile.tileId && shown.text === tile.text),
      )
    )
      fail('word bank', 'grader and visible tile IDs/text differ');
    if (
      forms.some(
        (form) =>
          !bankCanConstruct(
            tiles.map((tile) => text(tile.text, 'tile text')),
            form.surface,
            grading.pack.wordBankJoinDelimiter,
          ),
      )
    )
      fail('word bank', 'authored answer cannot be constructed from available occurrences');
  }
  if (shape.family === 'match') {
    const pairs = entries(
      gradable.pairs,
      ['leftLexemeId', 'rightLexemeId', 'left', 'right', 'facet'],
      'pairs',
    );
    const shown = entries(
      presentation.pairs,
      ['leftItemId', 'leftId', 'rightId', 'left', 'right'],
      'visible pairs',
    );
    if (pairs.length !== 5 || shown.length !== 5 || forms.length !== 5)
      fail('match', 'exactly five semantic and visible pairs required');
    for (const field of ['leftLexemeId', 'rightLexemeId'])
      unique(pairs, field, 'match semantic ID');
    for (const field of ['leftId', 'rightId']) unique(shown, field, 'match visible ID');
    pairs.forEach((pair, index) => {
      lexeme(reader, pair.leftLexemeId, 'match left');
      lexeme(reader, pair.rightLexemeId, 'match right');
      if (
        pair.facet !== 'meaning' ||
        shown[index]!.leftItemId !== pair.leftLexemeId ||
        shown[index]!.left !== pair.left ||
        shown[index]!.right !== pair.right
      )
        fail('match', 'semantic/display pairing mismatch');
      if (
        text(pair.left, 'match left text') + ' = ' + text(pair.right, 'match right text') !==
        forms[index]!.surface
      )
        fail('match', 'current accepted pair mapping mismatch');
    });
  }
  if (shape.family === 'read-and-respond' || shape.family === 'listen-and-respond') {
    if (gradable.prompt !== presentation.prompt) fail('open response', 'prompt mismatch');
    for (const id of strings(gradable.requiredLexemeIds, 'required lexemes', true)) {
      lexeme(reader, id, 'required lexeme');
      if ((grading.unit.taughtInflections[id]?.length ?? 0) === 0)
        fail('open response', 'required keyword was not taught in this lesson view');
    }
  }
  const hasOptions =
    shape.family === 'select' || type === 'gapFillSelect' || type === 'listenMissingWord';
  if (hasOptions) {
    const options = entries(presentation.options, ['id', 'text'], 'options', [
      'imageUri',
      'imageDescription',
    ]);
    unique(options, 'id', 'option ID');
    unique(options, 'text', 'option text');
    const displayed = options.map((option) => text(option.text, 'option text'));
    const distractors = strings(
      parse(exercise.distractors_json, 'actual distractors'),
      'actual distractors',
    );
    if (
      displayed.length !== distractors.length + 1 ||
      !displayed.includes(forms[0]!.surface) ||
      distractors.some((d) => !displayed.includes(d)) ||
      forms.filter((form) => displayed.includes(form.surface)).length !== 1
    )
      fail('options', 'current distractors/accepted option mismatch');
    for (const option of options) {
      if (option.imageUri !== undefined) text(option.imageUri, 'image reference');
      if (option.imageDescription !== undefined) text(option.imageDescription, 'image description');
      if (
        type === 'pictureSelect' &&
        (option.imageUri === undefined || option.imageDescription === undefined)
      )
        fail('picture select', 'baked image references required');
    }
  }
  const visibleAllowed = new Set(
    hasOptions
      ? ['options']
      : shape.family === 'word-bank'
        ? ['bank']
        : shape.family === 'match'
          ? ['pairs']
          : [],
  );
  if (
    ['options', 'bank', 'pairs'].some(
      (field) => presentation[field] !== undefined && !visibleAllowed.has(field),
    )
  )
    fail('presentation', 'controls belong to another family');
  for (const field of ['requiresIme', 'hard'])
    if (presentation[field] !== undefined && typeof presentation[field] !== 'boolean')
      fail('presentation', 'invalid boolean');
  for (const field of ['audioText', 'promptLanguage', 'tip'])
    if (presentation[field] !== undefined) text(presentation[field], 'presentation ' + field);
  if (
    presentation.accentCharacters !== undefined &&
    strings(presentation.accentCharacters, 'accent characters').some((ch) => [...ch].length !== 1)
  )
    fail('presentation', 'invalid accent character');
  if (
    presentation.introduction !== undefined &&
    !['word', 'phrase', 'grammar', 'character', 'counter', 'particle'].includes(
      text(presentation.introduction, 'introduction kind'),
    )
  )
    fail('presentation', 'unsupported introduction kind');
  if (presentation.hints !== undefined)
    for (const hint of array(presentation.hints, 'hints')) {
      const entry = object(hint, ['token', 'meanings'], 'hint');
      text(entry.token, 'hint token');
      strings(entry.meanings, 'hint meanings', true);
    }
  if (presentation.audioRef !== undefined) {
    if (presentation.audioRef !== exercise.audio_id)
      fail('audio', 'actual exercise audio mismatch');
    audio(reader, presentation.audioRef);
  }
  if (shape.audio === true && presentation.audioRef === undefined)
    fail('audio', 'required built audio reference missing');
  if (presentation.slowAudioRef !== undefined) audio(reader, presentation.slowAudioRef);
  return Object.freeze({ ...freeze(row), grading }) as unknown as VerifiedRuntimeItem;
}

/** A caller may reuse its successfully decoded grading metadata; there is no fallback. */
export function readRuntimeItem(
  reader: PackReader,
  meta: GradingPackIdentity,
  exerciseId: string,
  grading?: LoadedGradingMetadata,
): VerifiedRuntimeItem {
  try {
    text(exerciseId, 'requested exercise');
    const exercise = reader.get<ActualExercise>(
      `SELECT exercise_id,item_id,unit_id,lesson_index,type,prompt,accepted_answers_json,distractors_json,audio_id,illustration_ref,source_sentence_id FROM exercise WHERE exercise_id = ?`,
      [exerciseId],
    );
    if (exercise === undefined || exercise.exercise_id !== exerciseId)
      fail('exercise', 'missing actual exercise');
    const stored = reader.get<{
      exercise_id: string;
      payload_json: string;
      payload_sha256: string;
    }>(
      'SELECT exercise_id, payload_json, payload_sha256 FROM exercise_runtime WHERE exercise_id = ?',
      [exerciseId],
    );
    if (stored === undefined || stored.exercise_id !== exerciseId)
      fail('payload', 'missing authored runtime item');
    const raw = text(stored.payload_json, 'payload JSON');
    if (sha256Hex(raw) !== digest(stored.payload_sha256, 'payload hash'))
      fail('payload', 'stored content hash mismatch');
    if (grading !== undefined && !grading.isFor(reader, meta))
      fail('grading cache', 'belongs to another reader or pack identity/version');
    const context = (grading ?? readGradingMetadata(reader, meta)).forExercise(exerciseId);
    return decodePayload(parse(raw, 'payload'), exercise, context, reader);
  } catch (error) {
    if (error instanceof PackFormatError) throw error;
    throw new PackFormatError(
      `exercise_runtime: missing or malformed production evidence (${error instanceof Error ? error.name : 'unknown error'})`,
    );
  }
}
