import type { Db, DbRow } from '@freelingo/schema';
import type { PathModel, PathNode } from '@freelingo/core/path';
import { unitCompleted } from '@freelingo/core/path';
import type { VerifiedInstalledPack } from '../packs/installedPackPorts';

export class PathDataError extends Error {}
/** Legacy databases have no trustworthy negative history for jumps/script exposure. */
export class PathHistoryUnavailable extends PathDataError {}
function requirePath(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new PathDataError(`Invalid path ${detail}.`);
}
function integer(value: unknown, detail: string): number {
  requirePath(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, detail);
  return value;
}
function timestamp(value: unknown, detail: string): boolean {
  if (value === null) return false;
  requirePath(typeof value === 'string' && Number.isFinite(Date.parse(value)), detail);
  return true;
}

/** S010–S028, 2026-09-13. A synchronous, read-only projection shared by the factory
 * and learning runtime. Node IDs and populations come from the verified signed path.
 * Persistence encoding: section_id = String(source sectionIndex); node_index is the
 * zero-based absolute ordinal across sections/units/nodes. A known header, never an
 * absent legacy header, permits an absent node row to mean zero completed sessions.
 * No cache, migration, progress inference from FSRS, or display-triggered writes. */
export function readPathModel(
  db: Db,
  verified: Pick<VerifiedInstalledPack, 'courseId' | 'contentHash' | 'pack'>,
): PathModel {
  const { courseId, pack, contentHash } = verified;
  const progress = db.get('SELECT * FROM course_progress WHERE course_id=?', [courseId]);
  requirePath(progress && progress.pack_content_hash === contentHash, 'pack identity');
  requirePath(pack.meta.courseId === courseId, 'course identity');
  const declaration = pack.path();
  const header = db.get('SELECT * FROM course_path_state WHERE course_id=?', [courseId]);
  if (!header)
    throw new PathHistoryUnavailable('Path history is unavailable for this legacy course.');
  requirePath(Number.isSafeInteger(header.initialized_at_utc_ms), 'initialization');
  const viewingSection = integer(header.viewing_section, 'viewport');
  requirePath(viewingSection < declaration.sections.length, 'viewport section');
  requirePath(
    header.daily_refresh_unlocked === 0 || header.daily_refresh_unlocked === 1,
    'completion latch',
  );
  const rows = db.all('SELECT * FROM course_node WHERE course_id=?', [courseId]);
  const saved = new Map<unknown, DbRow>(rows.map((row) => [row.node_id, row]));
  const knownNodes = new Set<string>();
  let nodeOrdinal = 0;
  let unitOrdinal = 0;
  const sections = declaration.sections.map((section, sectionIndex) => ({
    index: sectionIndex,
    title: section.title,
    band: section.band,
    units: section.units.map((unit) => {
      const unitIndex = unitOrdinal++;
      return {
        index: unitIndex,
        title: unit.title,
        colourIndex: unit.colourIndex,
        nodes: unit.nodes.map((node): PathNode => {
          const absoluteNodeIndex = nodeOrdinal++;
          knownNodes.add(node.nodeId);
          const total = node.type === 'chest' ? 1 : node.sessions.length;
          const row = saved.get(node.nodeId);
          let done = 0;
          let legendary = false;
          if (row) {
            requirePath(
              row.unit_id === unit.unitId &&
                row.section_id === String(section.sectionIndex) &&
                row.node_type === node.type &&
                row.node_index === absoluteNodeIndex &&
                row.levels_total === total,
              'node source binding',
            );
            done = integer(row.levels_completed, 'completed sessions');
            requirePath(done <= total, 'completion overflow');
            requirePath(
              timestamp(row.completed_at, 'completion time') === (done === total),
              'completion evidence',
            );
            legendary = timestamp(row.legendary_awarded_at, 'legendary time');
            requirePath(
              !legendary ||
                (done === total && declaration.manifest.legendaryDenominator.includes(node.type)),
              'legendary evidence',
            );
          }
          return {
            id: node.nodeId,
            type: node.type,
            unitIndex,
            subLessonsDone: done,
            subLessonsTotal: total,
            legendary,
            introducesScriptUnits: node.introducesScriptUnits,
            requiresScriptUnits: node.requiresScriptUnits,
          };
        }),
      };
    }),
  }));
  requirePath(
    rows.every((row) => typeof row.node_id === 'string' && knownNodes.has(row.node_id)),
    'unknown saved node',
  );
  const jumps = db.all(
    `SELECT jump.unit_id,link.node_id,link.economy_flavour,receipt.outcome
    FROM course_path_jump jump
    LEFT JOIN course_session_commit_link link ON link.session_id=jump.source_session_id AND link.course_id=jump.course_id
    LEFT JOIN committed_session receipt ON receipt.session_id=link.session_id WHERE jump.course_id=?`,
    [courseId],
  );
  const jumpUnlockedUnits = jumps
    .map((row) => {
      requirePath(
        typeof row.node_id === 'string' &&
          knownNodes.has(row.node_id) &&
          row.outcome === 'completed' &&
          ['placement', 'jumpHere', 'sectionTest'].includes(String(row.economy_flavour)),
        'jump receipt',
      );
      const binding = declaration.forNode(row.node_id);
      requirePath(binding.unitId === row.unit_id, 'jump target binding');
      return binding.unitIndex;
    })
    .sort((a, b) => a - b);
  // Revision 1's signed decoder explicitly rejects script nodes. Do not manufacture
  // script teaching from unrelated observations or silently discard saved script facts.
  const scripts = db.all(
    'SELECT script_unit_id FROM course_script_introduction WHERE course_id=?',
    [courseId],
  );
  requirePath(scripts.length === 0, 'unsupported script source declaration');
  return {
    manifest: declaration.manifest,
    sections,
    jumpUnlockedUnits,
    scoreEarned: integer(progress.mastery_high_water_points, 'mastery high water'),
    scoreFloor: integer(progress.score_floor, 'score floor'),
    viewingSection,
    dailyRefreshUnlocked: header.daily_refresh_unlocked === 1,
    completedUnits: sections.flatMap((section) =>
      section.units.filter(unitCompleted).map((unit) => unit.index),
    ),
    introducedScriptUnits: [],
  };
}
