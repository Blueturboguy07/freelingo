/**
 * The art and sound index: what `art/` contains, and which product-map surface consumes
 * each piece.
 *
 * This is a registry, not a loader. Nothing here reads a file or imports a renderer —
 * P3 wires these ids to Skia and `expo-audio`, and this lane's job is to make sure the
 * assets exist, are original, and survive at the sizes the product needs. The `screens`
 * field is what stops the inventory drifting from the product map: an asset nobody can
 * name a screen for is an asset nobody asked for.
 *
 * Sources: `00-PRODUCT-MAP.md` (S013-S020, S034, S075, S101-S103, S125),
 * `art/README.md` (the v1 inventory), `deep/08-design-system-motion-sound.md` §10 and §12.
 */

import { artPath } from './paths.js';
import type { MascotPose } from '../mascot/poses.js';
import { MASCOT_POSES, mascotSource } from '../mascot/poses.js';

// --- palette -------------------------------------------------------------------------

/**
 * The colours the art is allowed to use.
 *
 * Every one is either a measured Duolingo token (`scope/10`, 2026-09-10) or a shade of one,
 * because deep/08 §10 requires the illustration to sit inside the product palette rather
 * than beside it. `scope/10` is explicit that the three greens are three tokens and not one
 * reused, and that the gold and the streak orange are different swatches — so they are
 * different constants here too.
 */
export const ART_PALETTE = {
  /** `rgb(88, 204, 2)` — canonical green, the unit-header fill. Mascot body. */
  body: '#58CC02',
  /** `rgb(114, 214, 39)` — the third green, seen on smaller accents. Mascot belly. */
  shine: '#72D627',
  /** `rgb(88, 167, 0)` — the 4 px button lip. Wings, and every node's lip. */
  shade: '#58A700',
  /** `rgb(55, 70, 79)` — dark-theme disabled fill. Locked nodes. */
  locked: '#37464F',
  /** A darker step of `locked`, for the locked node's lip. Derived, not measured. */
  lockedShade: '#2A363D',
  /** `rgb(255, 199, 0)` — the gold the progress bar flips to at combo 6. Crest, gilded. */
  gold: '#FFC700',
  /** A darker step of `gold`. Derived. */
  goldShade: '#E0A800',
  /** `rgb(255, 171, 51)` — streak-flame orange. Beak and feet. Never reused as gold. */
  beak: '#FFAB33',
  /** A darker step of `beak`, for the lower mandible. Derived. */
  beakShade: '#E08A00',
  /** `rgb(238, 85, 85)` — hearts red. Phoenix flame tips only. */
  ember: '#EE5555',
  /** `rgb(0, 205, 156)` — teal accent. Tail feather. */
  teal: '#00CD9C',
  /** `rgb(73, 192, 248)` — blue accent. Tail feather. */
  sky: '#49C0F8',
  /** `rgb(206, 130, 255)` — the NEW WORD purple. Tail feather, cast hair. */
  berry: '#CE82FF',
  white: '#FFFFFF',
  /** Ink for pupils and closed-eye lines. Not pure black: deep/08 reports no pure black
   * as a rendered ink colour. */
  ink: '#3C3C3C',
} as const;

// --- kinds -------------------------------------------------------------------------

/** Path node kinds that carry art (S013-S019). */
export const NODE_KINDS = ['lesson', 'chest', 'story', 'trophy', 'speaking', 'alphabet'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * The three states every node kind is authored in.
 *
 * S015 fixes what `complete` looks like — "solid green + white check, no ring" — and S013
 * fixes `locked`. The progress *ring* on an in-progress lesson node is not in this list on
 * purpose: it is drawn by the path component at P3 from the node's own sub-lesson count
 * (S014), so baking a ring into the art would be baking in a number.
 */
export const NODE_STATES = ['locked', 'active', 'complete'] as const;
export type NodeState = (typeof NODE_STATES)[number];

/** Story cover states (S101-S103). `gilded` is the completed-story treatment. */
export const COVER_STATES = ['gilded', 'active', 'locked'] as const;
export type CoverState = (typeof COVER_STATES)[number];

/**
 * The cast (S034 meaning-select avatars, S020 tableau).
 *
 * Four original characters, named so nothing reads as a Duolingo character. Each is built
 * from a different silhouette *and* a different hue, because at avatar size hue is what
 * carries and silhouette is what survives a colourblind reader — one alone is not enough.
 */
export const CAST = ['pia', 'bruno', 'zari', 'oskar'] as const;
export type CastMember = (typeof CAST)[number];

/** Sound cues (deep/08 §12). `bus` is the class INV-SND-01 suppresses per-class. */
export const SOUND_CUES = [
  { id: 'correct', bus: 'sting' },
  { id: 'wrong', bus: 'sting' },
  { id: 'combo-shimmer', bus: 'shimmer' },
  { id: 'fanfare', bus: 'sting' },
  { id: 'chest', bus: 'sting' },
  { id: 'streak', bus: 'sting' },
  { id: 'earcon-start', bus: 'earcon' },
  { id: 'earcon-stop', bus: 'earcon' },
] as const;
export type SoundCueId = (typeof SOUND_CUES)[number]['id'];

/** Shipped encodings of every cue. WAV is the master and is not shipped. */
export const SOUND_ENCODINGS = ['opus', 'm4a'] as const;

export function soundSource(id: SoundCueId, encoding: (typeof SOUND_ENCODINGS)[number]): string {
  return `art/sound/${id}.${encoding}`;
}

export const SOUND_MANIFEST = 'art/sound/manifest.json';

// --- the index -----------------------------------------------------------------------

export interface ArtEntry {
  readonly id: string;
  /** Repo-relative path of the SVG source. */
  readonly source: string;
  /**
   * What sort of thing this is, which also picks the legibility class it is held to.
   * A figure, a plate, a full-bleed card and a chrome frame do not carry the same amount
   * of information, so they cannot share one floor — see `legibility.test.ts`.
   */
  readonly kind: 'mascot' | 'cast' | 'node' | 'cover' | 'frame';
  /** Product-map screen ids that render this asset. */
  readonly screens: readonly string[];
}

function mascotEntry(pose: MascotPose): ArtEntry {
  const screens =
    pose === 'phoenix' ? ['S075'] : pose === 'sleepy' ? ['S020', 'S125'] : ['S020', 'S034', 'S067'];
  return { id: `mascot/${pose}`, source: mascotSource(pose), kind: 'mascot', screens };
}

export function nodeSource(kind: NodeKind, state: NodeState): string {
  return `art/nodes/node-${kind}-${state}.svg`;
}

export function castSource(member: CastMember): string {
  return `art/cast/${member}.svg`;
}

export function coverSource(state: CoverState): string {
  return `art/covers/cover-${state}.svg`;
}

/** The speech-bubble frame an S034 avatar speaks from (deep/08 §7). */
export const SPEECH_BUBBLE_SOURCE = 'art/cast/speech-bubble.svg';

const NODE_SCREENS: Record<NodeKind, readonly string[]> = {
  lesson: ['S013', 'S014', 'S015'],
  chest: ['S016'],
  story: ['S017', 'S101'],
  trophy: ['S018'],
  speaking: ['S017'],
  alphabet: ['S017'],
};

/** Every committed piece of vector art, in a stable order. */
export const ART_INDEX: readonly ArtEntry[] = [
  ...MASCOT_POSES.map(mascotEntry),
  ...CAST.map((member): ArtEntry => ({
    id: `cast/${member}`,
    source: castSource(member),
    kind: 'cast',
    screens: ['S034', 'S020'],
  })),
  {
    id: 'cast/speech-bubble',
    source: SPEECH_BUBBLE_SOURCE,
    kind: 'frame',
    screens: ['S034'],
  },
  ...NODE_KINDS.flatMap((kind) =>
    NODE_STATES.map((state): ArtEntry => ({
      id: `node/${kind}/${state}`,
      source: nodeSource(kind, state),
      kind: 'node',
      screens: NODE_SCREENS[kind],
    })),
  ),
  ...COVER_STATES.map((state): ArtEntry => ({
    id: `cover/${state}`,
    source: coverSource(state),
    kind: 'cover',
    screens: ['S101'],
  })),
];

/** Absolute path of an entry's source. Build and test tooling only. */
export function artEntryPath(entry: ArtEntry): string {
  return artPath(entry.source);
}
