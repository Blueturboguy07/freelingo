/**
 * The node-type registry: what each node type offers, can launch, and renders.
 *
 * The registry is *code* (every declarable type must exist here, or the path cannot be
 * rendered at all) but which types are *used* is **pack-driven**: `nodeTypesFor(manifest)`
 * intersects the registry with what the pack declares, which is what INV-PACK-03 means by
 * "a pack declaring no stories produces a path with no book nodes ... with no empty
 * states anywhere".
 *
 * Copy is quoted from the 2026-09-11 web string bundle where a string exists; slots with
 * no shipped string carry a Freelingo decision and say so.
 */
import type { LaunchFlavour, NodeType, PackManifest } from './types.js';
import { NODE_TYPES } from './types.js';

/** Runtime capabilities a device may or may not have (INV-PATH-19). */
export interface DeviceCapabilities {
  /** An on-device model or a BYOK key is available. */
  readonly llm: boolean;
  readonly microphone: boolean;
  readonly audioOutput: boolean;
}

export interface PopupButton {
  readonly label: string;
  readonly flavour: LaunchFlavour;
  /** Gold striped treatment; Legendary is gold since `Legendary is now Gold!`. */
  readonly gold: boolean;
}

export interface NodeTypeSpec {
  readonly type: NodeType;
  /** May the LEGENDARY offer ever fire on this node? Letters: never (INV-PATH-25). */
  readonly offersLegendary: boolean;
  /** Flavours a node of this type can launch. Popup buttons may name only these. */
  readonly launchable: readonly LaunchFlavour[];
  /** Buttons on the *completed* popup, in render order. Never START, never a counter. */
  readonly completedButtons: readonly PopupButton[];
  /** Subtitle of the completed popup, or null where the type has none (EC-PTH-36). */
  readonly completedSubtitle: string | null;
  /** Copy shown when a locked node of this type is tapped. Never null (INV-PATH-01). */
  readonly lockedCopy: string;
  /** Capability the *generator* must probe before placing this type (INV-PATH-19). */
  readonly requiresCapability: keyof DeviceCapabilities | null;
  /** May the generator place this type on the path at all? */
  readonly placeable: boolean;
  /**
   * May this type be the FIRST node of a unit?
   *
   * A chest or a trophy at the head of a unit gives a learner who has just arrived no
   * session at all - the chest launches nothing and the trophy is the unit's closing
   * challenge - which is how INV-PATH-15's guarantee gets broken by content rather than
   * by code. The captured Unit 1 shape is star, star, star, chest, star, trophy.
   */
  readonly canHeadUnit: boolean;
  /** Copy when the pack cannot serve this node's content (S028). */
  readonly unavailableCopy: string;
}

const LOCKED = 'Complete all levels above to unlock this!';

/**
 * `Prove your proficiency with Legendary` (str:2061) — the lesson/practice completed
 * subtitle. Story nodes deliberately do not carry it (EC-PTH-36).
 */
const PROFICIENCY = 'Prove your proficiency with Legendary';

const PRACTICE_BUTTON: PopupButton = { label: 'PRACTICE', flavour: 'practice', gold: false };
const LEGENDARY_BUTTON: PopupButton = { label: 'LEGENDARY', flavour: 'legendary', gold: true };

const SPECS: Readonly<Record<NodeType, NodeTypeSpec>> = {
  lesson: {
    type: 'lesson',
    offersLegendary: true,
    launchable: ['lesson', 'practice', 'legendary'],
    completedButtons: [PRACTICE_BUTTON, LEGENDARY_BUTTON],
    completedSubtitle: PROFICIENCY,
    lockedCopy: LOCKED,
    requiresCapability: null,
    placeable: true,
    canHeadUnit: true,
    unavailableCopy: 'This unit is currently unavailable',
  },
  practice: {
    type: 'practice',
    offersLegendary: true,
    launchable: ['practice', 'legendary'],
    completedButtons: [PRACTICE_BUTTON, LEGENDARY_BUTTON],
    completedSubtitle: PROFICIENCY,
    lockedCopy: LOCKED,
    requiresCapability: null,
    placeable: true,
    canHeadUnit: true,
    unavailableCopy: 'This unit is currently unavailable',
  },
  letters: {
    // EC-PTH-43: script nodes are legendary-exempt. Legendary strips hints a script node
    // never had, and tracing is non-punitive so the mistake budget cannot be spent.
    type: 'letters',
    offersLegendary: false,
    launchable: ['letters'],
    completedButtons: [{ label: 'PRACTICE', flavour: 'letters', gold: false }],
    completedSubtitle: null,
    lockedCopy: LOCKED,
    requiresCapability: null,
    placeable: true,
    canHeadUnit: true,
    unavailableCopy: 'Alphabet Lessons are currently unavailable',
  },
  speaking: {
    type: 'speaking',
    offersLegendary: false,
    launchable: ['speaking'],
    completedButtons: [{ label: 'SPEAK', flavour: 'speaking', gold: false }],
    completedSubtitle: null,
    lockedCopy: LOCKED,
    requiresCapability: 'microphone',
    placeable: true,
    canHeadUnit: true,
    unavailableCopy: 'This unit is currently unavailable',
  },
  radio: {
    type: 'radio',
    offersLegendary: false,
    launchable: ['radio'],
    completedButtons: [{ label: 'LISTEN', flavour: 'radio', gold: false }],
    completedSubtitle: null,
    lockedCopy: LOCKED,
    requiresCapability: 'audioOutput',
    placeable: true,
    canHeadUnit: true,
    unavailableCopy: 'This unit is currently unavailable',
  },
  roleplay: {
    type: 'roleplay',
    offersLegendary: false,
    launchable: ['roleplay'],
    completedButtons: [{ label: 'CONVERSATION', flavour: 'roleplay', gold: false }],
    completedSubtitle: null,
    lockedCopy: LOCKED,
    requiresCapability: 'llm',
    placeable: true,
    canHeadUnit: true,
    unavailableCopy: 'This unit is currently unavailable',
  },
  story: {
    // EC-PTH-36: a completed story gets its own popup shape - `READ`, plus LEGENDARY
    // where the pack marks it legendary-capable. Never PRACTICE, never the proficiency
    // subtitle.
    type: 'story',
    offersLegendary: true,
    launchable: ['story', 'legendary'],
    completedButtons: [{ label: 'READ', flavour: 'story', gold: false }, LEGENDARY_BUTTON],
    completedSubtitle: null,
    lockedCopy: LOCKED,
    requiresCapability: null,
    placeable: true,
    canHeadUnit: true,
    unavailableCopy: 'This story is currently unavailable',
  },
  chest: {
    type: 'chest',
    offersLegendary: false,
    launchable: [],
    completedButtons: [],
    completedSubtitle: null,
    lockedCopy: LOCKED,
    requiresCapability: null,
    placeable: true,
    canHeadUnit: false,
    unavailableCopy: 'This unit is currently unavailable',
  },
  unitReview: {
    type: 'unitReview',
    offersLegendary: false,
    launchable: ['unitReview'],
    completedButtons: [{ label: 'REVIEW', flavour: 'unitReview', gold: false }],
    completedSubtitle: null,
    lockedCopy: LOCKED,
    requiresCapability: null,
    placeable: true,
    canHeadUnit: false,
    unavailableCopy: 'This unit is currently unavailable',
  },
  jumpHere: {
    // INV-PATH-17: the section test is the section-boundary *variant* of this node
    // (ruling EC-PTH-35), not a node type of its own. Never placed: the overlay is
    // computed from lock state (INV-PATH-13).
    type: 'jumpHere',
    offersLegendary: false,
    launchable: ['jumpHere', 'sectionTest'],
    completedButtons: [],
    completedSubtitle: null,
    lockedCopy: LOCKED,
    requiresCapability: null,
    placeable: false,
    canHeadUnit: false,
    unavailableCopy: 'This unit is currently unavailable',
  },
};

export function specFor(type: NodeType): NodeTypeSpec {
  const spec = SPECS[type];
  /* c8 ignore next */
  if (!spec) throw new Error(`no registry entry for node type ${type}`);
  return spec;
}

/** Every type the registry knows. Enumerated for the completeness gates. */
export const REGISTERED_TYPES: readonly NodeType[] = NODE_TYPES;

/**
 * The node types this pack can actually produce. INV-PACK-03: a pack declaring no
 * stories yields a path with no book nodes anywhere.
 */
export function nodeTypesFor(manifest: PackManifest): readonly NodeType[] {
  return NODE_TYPES.filter((t) => manifest.declaredNodeTypes.includes(t));
}

/**
 * Can this device finish a node of this type? INV-PATH-19: a linear chain must never
 * contain a node the generating device cannot finish.
 */
export function canComplete(type: NodeType, caps: DeviceCapabilities): boolean {
  const need = specFor(type).requiresCapability;
  return need === null || caps[need];
}
