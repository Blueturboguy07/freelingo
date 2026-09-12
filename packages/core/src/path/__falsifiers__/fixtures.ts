/**
 * Test fixtures and fast-check arbitraries for the path engine.
 *
 * Lives under `__falsifiers__/` rather than beside the modules because it is test
 * support, not engine API: `path/index.ts` does not export it.
 *
 * The generators are deliberately tight. A loose generator is how a property runs 10,000
 * cases of nothing: the first four-zone streak property in this repo drew dates from a
 * four-year span and reached the shape it was about in 2.8% of cases. Here that failure
 * mode would be a path whose units are never partially complete, so `completionsFor`
 * builds completions along the *linear* frontier and then perturbs them.
 */
import fc from 'fast-check';
import type {
  NodeType,
  PackManifest,
  PathModel,
  PathNode,
  PathSection,
  PathUnit,
} from '../types.js';
import { CEFR_BANDS } from '../types.js';

export const FULL_MANIFEST: PackManifest = {
  packId: 'es-v1',
  languageName: 'Spanish',
  declaredNodeTypes: [
    'lesson',
    'practice',
    'story',
    'chest',
    'unitReview',
    'radio',
    'speaking',
    'roleplay',
    'letters',
  ],
  legendaryDenominator: ['lesson', 'practice'],
  scoreCeiling: 129,
  cefrChecked: true,
  sectionTitles: ['Section 1', 'Section 2', 'Section 3'],
};

/** A pack with no stories and no radio: INV-PACK-03's subject. */
export const NO_STORIES_MANIFEST: PackManifest = {
  ...FULL_MANIFEST,
  packId: 'ja-beta',
  languageName: 'Japanese',
  declaredNodeTypes: ['lesson', 'practice', 'letters', 'chest', 'unitReview'],
  cefrChecked: false,
  scoreCeiling: 29,
  sectionTitles: ['Section 1', 'Section 2', 'Section 3'],
};

export function node(
  id: string,
  type: NodeType,
  unitIndex: number,
  overrides: Partial<PathNode> = {},
): PathNode {
  return {
    id,
    type,
    unitIndex,
    subLessonsDone: 0,
    subLessonsTotal: 3,
    legendary: false,
    introducesScriptUnits: [],
    requiresScriptUnits: [],
    ...overrides,
  };
}

export function unit(
  index: number,
  nodes: readonly PathNode[],
  title = `Unit ${index + 1}`,
): PathUnit {
  return { index, title, colourIndex: index % 4, nodes };
}

export function section(index: number, units: readonly PathUnit[]): PathSection {
  return {
    index,
    title: `Section ${index + 1}`,
    band: CEFR_BANDS[Math.min(index, CEFR_BANDS.length - 1)] ?? 'very early A1',
    units,
  };
}

export function model(
  sections: readonly PathSection[],
  overrides: Partial<PathModel> = {},
): PathModel {
  return {
    manifest: FULL_MANIFEST,
    sections,
    jumpUnlockedUnits: [],
    scoreEarned: 0,
    scoreFloor: 0,
    viewingSection: 0,
    dailyRefreshUnlocked: false,
    completedUnits: [],
    introducedScriptUnits: [],
    ...overrides,
  };
}

/** Unit 1 of EN->ES as captured: star, star, star, chest, star, trophy. */
export const CAPTURED_UNIT_SHAPE: readonly NodeType[] = [
  'lesson',
  'lesson',
  'lesson',
  'chest',
  'lesson',
  'unitReview',
];

/* --------------------------------------------------------------- arbitraries */

const PLACEABLE: readonly NodeType[] = [
  'lesson',
  'practice',
  'story',
  'chest',
  'unitReview',
  'letters',
];

/**
 * A unit shape: a head node that can actually be played, 1-3 more, then a Unit Review -
 * the captured Unit 1 shape (star, star, star, chest, star, trophy) generalised. A unit
 * that opens with a chest is a content error `placementViolations` reports, so the
 * generator does not produce one: a property whose cases are invalid content tests the
 * content validator, not the engine.
 */
const HEAD_TYPES: readonly NodeType[] = ['lesson', 'practice', 'letters', 'story'];

const unitShapeArb = fc
  .tuple(
    fc.constantFrom(...HEAD_TYPES),
    fc.array(fc.constantFrom(...PLACEABLE.filter((t) => t !== 'unitReview')), {
      minLength: 1,
      maxLength: 3,
    }),
  )
  .map(([head, rest]) => [head, ...rest, 'unitReview' as NodeType]);

/** A course: 1-3 sections of 1-3 units each. Small enough that 10,000 cases stay fast. */
export const courseShapeArb: fc.Arbitrary<readonly (readonly (readonly NodeType[])[])[]> = fc.array(
  fc.array(unitShapeArb, { minLength: 1, maxLength: 3 }),
  {
    minLength: 1,
    maxLength: 2,
  },
);

export function buildModel(
  shape: readonly (readonly (readonly NodeType[])[])[],
  completedNodeCount: number,
  manifest: PackManifest = FULL_MANIFEST,
): PathModel {
  let absoluteUnit = 0;
  let remaining = completedNodeCount;
  const sections: PathSection[] = [];
  for (let s = 0; s < shape.length; s += 1) {
    const units: PathUnit[] = [];
    for (const types of shape[s] ?? []) {
      const nodes = types.map((type, i) => {
        const done = remaining > 0;
        if (done) remaining -= 1;
        return node(`u${absoluteUnit}n${i}`, type, absoluteUnit, {
          subLessonsDone: done ? 3 : 0,
          subLessonsTotal: 3,
        });
      });
      units.push(unit(absoluteUnit, nodes));
      absoluteUnit += 1;
    }
    sections.push(section(s, units));
  }
  return model(sections, { manifest });
}

/**
 * A model whose completions follow the linear frontier, plus the count so a test can say
 * where the frontier is. This is the shape every unlock property is about.
 */
export const linearModelArb: fc.Arbitrary<{
  readonly model: PathModel;
  readonly completed: number;
  readonly totalNodes: number;
}> = courseShapeArb.chain((shape) => {
  const total = shape.flat().reduce((n, types) => n + types.length, 0);
  return fc.nat({ max: total }).map((completed) => ({
    model: buildModel(shape, completed),
    completed,
    totalNodes: total,
  }));
});
