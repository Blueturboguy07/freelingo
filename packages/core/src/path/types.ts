/**
 * Path model types.
 *
 * Section -> Unit -> Node (a "level") -> sub-lesson. `deep/03` §S1, product map Surface 2
 * (S010-S028). Everything here is data: no clock, no I/O, no React.
 *
 * Two vocabulary notes that cost real time to settle:
 *
 * - **`Unit Rewind` is not a path node.** `deep/03`'s node table listed it; its own
 *   adversarial pass (M4) showed the surrounding strings are the practice-session picker
 *   (`Perfect Pronunciation`, `Listen-Up`, `Switch session`). EC-PTH-41 rules it out of the
 *   path entirely — it is one session object with two entry points, keyed
 *   `(unit_id, local_day)`. `placeNodes` refuses to place it (INV-PATH-23).
 * - **The first-level unit-unlock rule is struck.** `deep/03`'s rules table carried both
 *   "complete only the first level of a unit to advance" and "next node unlocks on
 *   finishing the last sub-lesson"; they cannot both hold, and the capture backs the node
 *   rule (EC-PTH-21, ADV 03/M7).
 */

/* ------------------------------------------------------------------ node types */

/**
 * Every node type a pack may declare. `videoCall` is v2 (product map S057-S066 scope
 * note) and deliberately absent; `unitRewind` is absent by EC-PTH-41.
 */
export const NODE_TYPES = [
  'lesson',
  'practice',
  'letters',
  'speaking',
  'radio',
  'roleplay',
  'story',
  'chest',
  'unitReview',
  'jumpHere',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/**
 * Node types that may never be *placed* on the path by the generator, whatever a pack
 * declares. `jumpHere` is an overlay computed from lock state (INV-PATH-13), never a
 * stored node.
 */
export const NEVER_PLACED: readonly NodeType[] = ['jumpHere'];

/* -------------------------------------------------------------- launch flavours */

/**
 * Everything a path affordance can launch.
 *
 * The first ten are the session-runtime configurations S057-S066 ("one runtime, ten
 * configurations"); the rest are content players that a node launches directly. Both
 * kinds are in one enum because INV-PATH-17 asks the same question of both: is every
 * value reachable from a shipped entry point?
 */
export const LAUNCH_FLAVOURS = [
  // S057-S066, the ten session-runtime configurations.
  'lesson',
  'practice',
  'legendary',
  'placement',
  'jumpHere',
  'sectionTest',
  'unitReview',
  'dailyRefresh',
  'recovery',
  'endgame',
  // Content players reached from a node.
  'story',
  'radio',
  'speaking',
  'roleplay',
  'letters',
] as const;
export type LaunchFlavour = (typeof LAUNCH_FLAVOURS)[number];

/** The ten S057-S066 flavours of the single session runtime. */
export const SESSION_FLAVOURS: readonly LaunchFlavour[] = LAUNCH_FLAVOURS.slice(0, 10);

/* ------------------------------------------------------------------- the model */

/** A node as stored. `subLessonsTotal >= 1`; `subLessonsDone` is clamped into range. */
export interface PathNode {
  readonly id: string;
  readonly type: NodeType;
  /** Index of the unit this node belongs to. A node never references another unit. */
  readonly unitIndex: number;
  readonly subLessonsDone: number;
  readonly subLessonsTotal: number;
  readonly legendary: boolean;
  /** Script units (kana/kanji groups) this node *introduces*; letters nodes only. */
  readonly introducesScriptUnits: readonly string[];
  /** Script units a served item in this node requires the learner to already know. */
  readonly requiresScriptUnits: readonly string[];
}

export interface PathUnit {
  readonly index: number;
  readonly title: string;
  /** Brand palette index; per unit, never derived from the section (`deep/03` §S1.2). */
  readonly colourIndex: number;
  readonly nodes: readonly PathNode[];
}

/** CEFR bands, in Score order. `deep/03` ADV M1: seven prose values ship, no A2 prose. */
export const CEFR_BANDS = [
  'very early A1',
  'early A1',
  'high A1',
  'A2',
  'early B1',
  'high B1',
  'early B2',
  'high B2',
] as const;
export type CefrBand = (typeof CEFR_BANDS)[number];

/** Score ranges per band, `deep/03` rules table (Score->CEFR), duoplanet 2025. */
export const CEFR_BAND_RANGES: readonly {
  readonly band: CefrBand;
  readonly min: number;
  readonly max: number;
}[] = [
  { band: 'very early A1', min: 0, max: 9 },
  { band: 'early A1', min: 10, max: 19 },
  { band: 'high A1', min: 20, max: 29 },
  { band: 'A2', min: 30, max: 59 },
  { band: 'early B1', min: 60, max: 79 },
  { band: 'high B1', min: 80, max: 99 },
  { band: 'early B2', min: 100, max: 114 },
  { band: 'high B2', min: 115, max: 129 },
];

export interface PathSection {
  readonly index: number;
  readonly title: string;
  readonly band: CefrBand;
  readonly units: readonly PathUnit[];
}

/**
 * What the pack declares about itself. INV-PACK-03 (the node-type registry is
 * pack-driven) and INV-PACK-56 (completion copy, the section list and the Score ceiling
 * are all functions of the manifest) both read only this.
 */
export interface PackManifest {
  readonly packId: string;
  readonly languageName: string;
  /** Node types this pack supplies content for. A pack with no stories declares none. */
  readonly declaredNodeTypes: readonly NodeType[];
  /** Node types that count toward a unit's legendary trophy denominator (INV-PATH-16). */
  readonly legendaryDenominator: readonly NodeType[];
  /** Highest Score this pack's content can reach. A three-section beta declares its own. */
  readonly scoreCeiling: number;
  /** True where a CEFR lexicon backed the grading (es/fr); false for de/ja. */
  readonly cefrChecked: boolean;
  /** Sections the pack actually ships. The section list renders these, never eight. */
  readonly sectionTitles: readonly string[];
}

/** Progress recorded against a course, distinct from account-scoped state. */
export interface PathModel {
  readonly manifest: PackManifest;
  readonly sections: readonly PathSection[];
  /** Units unlocked by a passed jump-here or placement, by absolute unit index. */
  readonly jumpUnlockedUnits: readonly number[];
  /** Score the learner earned through mastery. */
  readonly scoreEarned: number;
  /** Never decreases. Raised by a passed jump-here or placement (INV-PATH-06). */
  readonly scoreFloor: number;
  /** Section the path viewport is showing; distinct from the frontier (EC-PTH-39). */
  readonly viewingSection: number;
  readonly dailyRefreshUnlocked: boolean;
  /** Units whose every node has been completed; drives the section fraction. */
  readonly completedUnits: readonly number[];
  /** Script units the learner has been introduced to. */
  readonly introducedScriptUnits: readonly string[];
}

/** Absolute unit index across the course, in path order. */
export function allUnits(model: PathModel): readonly PathUnit[] {
  return model.sections.flatMap((s) => s.units);
}

export function nodesOf(unit: PathUnit): readonly PathNode[] {
  return unit.nodes;
}
