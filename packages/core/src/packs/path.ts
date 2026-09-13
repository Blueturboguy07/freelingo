/** Signed source-bound path declaration, S010–S028 (2026-09-13, revision 1).
 * No inferred node mix, Score ceiling or content population. The producer requires
 * explicit original authoring input; this decoder independently joins actual SQL rows.
 * Missing path metadata is an unavailable capability, not a legacy pack load failure. */
import type { PackManifest as PathManifest, CefrBand } from '../path/types.js';
import { CEFR_BAND_RANGES } from '../path/types.js';
import { canonicalJson } from './items.js';
import { sha256Hex } from './hashing.js';
import { PackFormatError, type PackMeta, type PackReader } from './loader.js';

export const PATH_METADATA_KEY = 'path:v1';
export const PATH_METADATA_VERSION = 1;
/** Long-form and script nodes require their distinct source contracts before this
 * revision can expose them. Never discard unsupported nodes or replace them silently. */
export const SOURCE_BACKED_PATH_TYPES = ['lesson', 'practice', 'unitReview', 'chest'] as const;
export type PackPathNodeType = (typeof SOURCE_BACKED_PATH_TYPES)[number];
export interface PackPathSession {
  readonly lessonIndex: number;
  readonly exerciseIds: readonly string[];
}
export interface PackPathNode {
  readonly nodeId: string;
  readonly type: PackPathNodeType;
  readonly sessions: readonly PackPathSession[];
  readonly introducesScriptUnits: readonly string[];
  readonly requiresScriptUnits: readonly string[];
}
export interface PackPathUnit {
  readonly unitId: string;
  readonly unitIndex: number;
  readonly title: string;
  readonly colourIndex: number;
  readonly nodes: readonly PackPathNode[];
}
export interface PackPathSection {
  readonly sectionIndex: number;
  readonly title: string;
  readonly band: CefrBand;
  readonly units: readonly PackPathUnit[];
}
export interface PathNodeBinding {
  readonly node: PackPathNode;
  readonly unitId: string;
  /** Zero-based absolute path index; source unitIndex remains explicitly one-based. */
  readonly unitIndex: number;
  readonly sectionIndex: number;
}
export interface LoadedPathMetadata {
  readonly manifest: PathManifest;
  readonly sections: readonly PackPathSection[];
  forNode(nodeId: string): PathNodeBinding;
}
const UNIT_FIELDS = [
  'unit_id',
  'section_index',
  'section_cefr',
  'unit_index',
  'title',
  'level_count',
] as const;
const EXERCISE_FIELDS = [
  'exercise_id',
  'item_id',
  'unit_id',
  'lesson_index',
  'slot_index',
  'type',
  'prompt',
  'preferred_surface',
  'register',
  'accepted_answers_json',
  'distractors_json',
  'source_sentence_id',
] as const;
export const PATH_METADATA_READS = {
  meta: ['key', 'value'],
  unit: UNIT_FIELDS,
  exercise: EXERCISE_FIELDS,
} as const;
const DECLARATION_FIELDS = [
  'schemaVersion',
  'packId',
  'courseId',
  'packVersion',
  'languageName',
  'scoreCeiling',
  'cefrChecked',
  'declaredNodeTypes',
  'legendaryDenominator',
  'sections',
] as const;
type ObjectValue = Record<string, unknown>;
function fail(detail: string): never {
  throw new PackFormatError(`path: ${detail}`);
}
function requireThat(condition: unknown, detail: string): asserts condition {
  if (!condition) fail(detail);
}
function object(value: unknown, fields: readonly string[], detail: string): ObjectValue {
  requireThat(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    detail + ' object',
  );
  const row = value as ObjectValue;
  requireThat(
    Object.keys(row).length === fields.length && fields.every((k) => Object.hasOwn(row, k)),
    detail + ' fields',
  );
  return row;
}
function text(value: unknown, detail: string): string {
  requireThat(typeof value === 'string' && value.trim(), detail);
  return value;
}
function integer(value: unknown, detail: string, min = 0): number {
  requireThat(typeof value === 'number' && Number.isSafeInteger(value) && value >= min, detail);
  return value;
}
function array(value: unknown, detail: string, empty = false): readonly unknown[] {
  requireThat(Array.isArray(value) && (empty || value.length > 0), detail);
  requireThat(
    Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean),
    detail + ' sparse',
  );
  return value;
}
function strings(value: unknown, detail: string, empty = false): readonly string[] {
  const values = array(value, detail, empty).map((v) => text(v, detail));
  requireThat(new Set(values).size === values.length, detail + ' duplicates');
  return Object.freeze(values);
}
function oneOf<T extends string>(value: unknown, values: readonly T[], detail: string): T {
  return values.find((v) => v === value) ?? fail(detail);
}
const hash = (value: unknown) => sha256Hex(canonicalJson(value));
function sourceRows(
  reader: PackReader,
  table: 'unit' | 'exercise',
  fields: readonly string[],
  id: string,
): ObjectValue[] {
  const rows = reader.all<unknown>(`SELECT ${fields.join(',')} FROM ${table}`);
  const result = rows.map((row) => object(row, fields, table + ' source'));
  for (const row of result) text(row[id], table + ' source ID');
  result.sort((a, b) =>
    String(a[id]) < String(b[id]) ? -1 : String(a[id]) > String(b[id]) ? 1 : 0,
  );
  requireThat(
    new Set(result.map((row) => row[id])).size === result.length,
    'duplicate ' + table + ' source',
  );
  return result;
}
/** Called only through a verified installed-pack reader. No caching across readers,
 * no progress writes, no network and no second identity inferred from a position. */
export function readPathMetadata(
  reader: PackReader,
  identity: Pick<PackMeta, 'packId' | 'courseId' | 'version' | 'cefrChecked'>,
): LoadedPathMetadata {
  const records = reader.all<{ key: unknown; value: unknown }>(
    'SELECT key,value FROM meta WHERE key=?',
    [PATH_METADATA_KEY],
  );
  requireThat(records.length === 1, 'metadata capability unavailable or ambiguous');
  let raw: unknown;
  try {
    raw = JSON.parse(text(records[0]!.value, 'metadata JSON'));
  } catch {
    return fail('invalid metadata JSON');
  }
  const root = object(raw, [...DECLARATION_FIELDS, 'lessonsPerLevel', 'proof'], 'metadata');
  requireThat(root['schemaVersion'] === PATH_METADATA_VERSION, 'version');
  requireThat(
    root['packId'] === identity.packId &&
      root['courseId'] === identity.courseId &&
      root['packVersion'] === identity.version,
    'pack identity',
  );
  requireThat(
    typeof root['cefrChecked'] === 'boolean' && root['cefrChecked'] === identity.cefrChecked,
    'CEFR claim identity',
  );
  const languageName = text(root['languageName'], 'language name');
  const ceiling = integer(root['scoreCeiling'], 'score ceiling');
  const lessonsPerLevel = integer(root['lessonsPerLevel'], 'lessons per level', 1);
  const declared = strings(root['declaredNodeTypes'], 'declared node types').map((v) =>
    oneOf(v, SOURCE_BACKED_PATH_TYPES, 'unsupported node source declaration'),
  );
  const denominator = strings(root['legendaryDenominator'], 'legendary denominator', true).map(
    (v) => oneOf(v, ['lesson', 'practice'] as const, 'legendary denominator'),
  );
  requireThat(
    denominator.every((v) => declared.includes(v)),
    'undeclared legendary type',
  );
  const proof = object(
    root['proof'],
    ['declarationSha256', 'unitRowsSha256', 'exerciseRowsSha256'],
    'proof',
  );
  const declaration = Object.fromEntries(DECLARATION_FIELDS.map((key) => [key, root[key]]));
  requireThat(proof['declarationSha256'] === hash(declaration), 'declaration proof changed');
  const sourceUnits = sourceRows(reader, 'unit', UNIT_FIELDS, 'unit_id');
  const sourceExercises = sourceRows(reader, 'exercise', EXERCISE_FIELDS, 'exercise_id');
  requireThat(sourceUnits.length > 0 && sourceExercises.length > 0, 'empty source population');
  requireThat(proof['unitRowsSha256'] === hash(sourceUnits), 'unit source proof changed');
  requireThat(
    proof['exerciseRowsSha256'] === hash(sourceExercises),
    'exercise source proof changed',
  );
  const unitsById = new Map(sourceUnits.map((row) => [text(row['unit_id'], 'unit ID'), row]));
  for (const row of sourceUnits) {
    integer(row['unit_index'], 'unit index', 1);
    integer(row['section_index'], 'section index', 1);
    integer(row['level_count'], 'level count', 1);
    text(row['title'], 'unit title');
    text(row['section_cefr'], 'section CEFR');
  }
  const byLesson = new Map<string, ObjectValue[]>();
  const lessonKey = (unit: string, lesson: number) => JSON.stringify([unit, lesson]);
  for (const row of sourceExercises) {
    const unit = text(row['unit_id'], 'exercise unit');
    requireThat(unitsById.has(unit), 'unknown exercise unit');
    const lesson = integer(row['lesson_index'], 'lesson index', 1);
    integer(row['slot_index'], 'slot index', 1);
    for (const field of EXERCISE_FIELDS)
      if (!['lesson_index', 'slot_index', 'source_sentence_id'].includes(field))
        text(row[field], 'exercise ' + field);
    if (row['source_sentence_id'] !== null) text(row['source_sentence_id'], 'source sentence');
    const key = lessonKey(unit, lesson);
    const rows = byLesson.get(key) ?? [];
    rows.push(row);
    byLesson.set(key, rows);
  }
  for (const rows of byLesson.values()) {
    requireThat(
      new Set(rows.map((row) => row['slot_index'])).size === rows.length,
      'duplicate lesson slot',
    );
    rows.sort((a, b) => Number(a['slot_index']) - Number(b['slot_index']));
  }
  const seenUnits = new Set<string>();
  const seenNodes = new Map<string, PathNodeBinding>();
  const usedTypes = new Set<PackPathNodeType>();
  const sectionIds: number[] = [];
  let lastBand = -1;
  let absoluteUnit = 0;
  const sections = array(root['sections'], 'sections').map(
    (value, sectionOrdinal): PackPathSection => {
      const section = object(value, ['sectionIndex', 'title', 'band', 'units'], 'section');
      const sectionIndex = integer(section['sectionIndex'], 'section index', 1);
      sectionIds.push(sectionIndex);
      const title = text(section['title'], 'section title');
      const band = oneOf(
        section['band'],
        CEFR_BAND_RANGES.map((row) => row.band),
        'section band',
      );
      const bandIndex = CEFR_BAND_RANGES.findIndex((row) => row.band === band);
      requireThat(bandIndex >= lastBand, 'section band ordering');
      lastBand = bandIndex;
      const chip = band.includes('A1')
        ? 'A1'
        : band.includes('B1')
          ? 'B1'
          : band.includes('B2')
            ? 'B2'
            : 'A2';
      const units = array(section['units'], 'section units').map((unitValue): PackPathUnit => {
        const unit = object(
          unitValue,
          ['unitId', 'unitIndex', 'title', 'colourIndex', 'nodes'],
          'unit',
        );
        const unitId = text(unit['unitId'], 'unit ID');
        const source = unitsById.get(unitId);
        requireThat(source && !seenUnits.has(unitId), 'unit population');
        seenUnits.add(unitId);
        const pathUnitIndex = absoluteUnit++;
        const unitIndex = integer(unit['unitIndex'], 'unit index', 1);
        requireThat(
          unitIndex === source['unit_index'] && unitIndex === absoluteUnit,
          'unit order/index',
        );
        requireThat(source['section_index'] === sectionIndex, 'unit section binding');
        requireThat(source['section_cefr'] === chip, 'section CEFR binding');
        const unitTitle = text(unit['title'], 'unit title');
        requireThat(unitTitle === source['title'], 'unit title binding');
        const colourIndex = integer(unit['colourIndex'], 'colour index');
        const canonicalLessons: number[] = [];
        let canonicalNodes = 0;
        const nodes = array(unit['nodes'], 'unit nodes').map(
          (nodeValue, nodeOrdinal): PackPathNode => {
            const node = object(
              nodeValue,
              ['nodeId', 'type', 'sessions', 'introducesScriptUnits', 'requiresScriptUnits'],
              'node',
            );
            const nodeId = text(node['nodeId'], 'node ID');
            requireThat(!seenNodes.has(nodeId), 'duplicate node ID');
            const type = oneOf(node['type'], declared, 'undeclared node type');
            usedTypes.add(type);
            requireThat(
              nodeOrdinal !== 0 || type === 'lesson',
              'unit must start with a canonical lesson',
            );
            const introduces = strings(node['introducesScriptUnits'], 'script introductions', true);
            const requires = strings(node['requiresScriptUnits'], 'script requirements', true);
            requireThat(
              introduces.length === 0 && requires.length === 0,
              'script source declaration unavailable',
            );
            const seenLessons = new Set<number>();
            const sessions = array(node['sessions'], 'node sessions', type === 'chest').map(
              (sessionValue): PackPathSession => {
                const session = object(sessionValue, ['lessonIndex', 'exerciseIds'], 'session');
                const lessonIndex = integer(session['lessonIndex'], 'session lesson', 1);
                requireThat(!seenLessons.has(lessonIndex), 'duplicate session lesson');
                seenLessons.add(lessonIndex);
                const ids = strings(session['exerciseIds'], 'exercise population');
                const actual = byLesson.get(lessonKey(unitId, lessonIndex)) ?? [];
                requireThat(
                  canonicalJson(ids) === canonicalJson(actual.map((row) => row['exercise_id'])),
                  'exact ordered lesson population',
                );
                if (type === 'lesson') canonicalLessons.push(lessonIndex);
                return Object.freeze({ lessonIndex, exerciseIds: ids });
              },
            );
            requireThat(
              type !== 'chest' || sessions.length === 0,
              'chest may not claim lesson sources',
            );
            if (type === 'lesson') {
              canonicalNodes++;
              requireThat(sessions.length === lessonsPerLevel, 'canonical lessons per level');
            }
            const result = Object.freeze({
              nodeId,
              type,
              sessions: Object.freeze(sessions),
              introducesScriptUnits: introduces,
              requiresScriptUnits: requires,
            });
            seenNodes.set(
              nodeId,
              Object.freeze({
                node: result,
                unitId,
                unitIndex: pathUnitIndex,
                sectionIndex: sectionOrdinal,
              }),
            );
            return result;
          },
        );
        const actualLessons = [
          ...new Set(
            sourceExercises
              .filter((row) => row['unit_id'] === unitId)
              .map((row) => Number(row['lesson_index'])),
          ),
        ].sort((a, b) => a - b);
        requireThat(canonicalNodes === source['level_count'], 'canonical level count');
        requireThat(
          canonicalJson(canonicalLessons) === canonicalJson(actualLessons),
          'canonical lesson partition/order',
        );
        return Object.freeze({
          unitId,
          unitIndex,
          title: unitTitle,
          colourIndex,
          nodes: Object.freeze(nodes),
        });
      });
      return Object.freeze({ sectionIndex, title, band, units: Object.freeze(units) });
    },
  );
  requireThat(seenUnits.size === sourceUnits.length, 'missing unit population');
  const actualSections = [...new Set(sourceUnits.map((row) => Number(row['section_index'])))].sort(
    (a, b) => a - b,
  );
  requireThat(
    canonicalJson(sectionIds) === canonicalJson(actualSections),
    'section population/order',
  );
  requireThat(
    usedTypes.size === declared.length && declared.every((v) => usedTypes.has(v)),
    'declared node type population',
  );
  const finalBand = CEFR_BAND_RANGES[lastBand]!;
  requireThat(
    ceiling >= finalBand.min && ceiling <= finalBand.max,
    'score ceiling outside final band',
  );
  const manifest: PathManifest = Object.freeze({
    packId: identity.packId,
    languageName,
    scoreCeiling: ceiling,
    cefrChecked: identity.cefrChecked,
    declaredNodeTypes: Object.freeze(declared),
    legendaryDenominator: Object.freeze(denominator),
    sectionTitles: Object.freeze(sections.map((section) => section.title)),
  });
  return Object.freeze({
    manifest,
    sections: Object.freeze(sections),
    forNode: (id: string) => seenNodes.get(id) ?? fail('unknown node ' + id),
  });
}
