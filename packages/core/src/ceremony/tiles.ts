/**
 * The S1b tile registry (S067 resolved phase).
 *
 * INV-CER-15 / EC-CER-23: the resolved layout renders exactly **two** tiles at every
 * supported width and font scale, and no `CeremonyTile` variant declares a time or
 * COMMITTED slot - `deep/08`'s third tile and its `macaw` binding are deleted so there is
 * no third variant left to render.
 *
 * The loading phase (S1a) is a different layout with one tile; `Perfect lesson!`
 * terminates on that single COMBO tile and never resolves (EC-CER-08, ADV 02/A3).
 */

export type CeremonyTileId = 'totalXp' | 'accuracy' | 'combo';

export interface CeremonyTileSpec {
  readonly id: CeremonyTileId;
  /** `TOTAL XP` (str:139), `COMBO`, or the tiered accuracy label. */
  readonly headerSlot: 'TOTAL XP' | 'COMBO' | 'accuracy-tier';
  readonly treatment: 'gold' | 'green';
  /** Which phase this tile appears in. */
  readonly phase: 'loading' | 'resolved';
}

/**
 * Every tile variant that exists. Deliberately closed: a fourth entry is a spec change,
 * and the gate below is what stops a `COMMITTED`/time tile reappearing.
 */
export const CEREMONY_TILES: readonly CeremonyTileSpec[] = [
  { id: 'combo', headerSlot: 'COMBO', treatment: 'gold', phase: 'loading' },
  { id: 'totalXp', headerSlot: 'TOTAL XP', treatment: 'gold', phase: 'resolved' },
  { id: 'accuracy', headerSlot: 'accuracy-tier', treatment: 'green', phase: 'resolved' },
];

/** Header slots no tile variant may ever declare. */
export const FORBIDDEN_TILE_SLOTS: readonly string[] = ['COMMITTED', 'TIME', 'time', 'committed'];

export function resolvedTiles(): readonly CeremonyTileSpec[] {
  return CEREMONY_TILES.filter((t) => t.phase === 'resolved');
}

export function loadingTiles(): readonly CeremonyTileSpec[] {
  return CEREMONY_TILES.filter((t) => t.phase === 'loading');
}

/* ------------------------------------------------------------- accuracy tiers */

/**
 * `AMAZING` carries no exclamation mark and `GREAT!`/`GOOD!` do; reproduce the
 * inconsistency exactly (verified in `screens/048`, `deep/078`, `deep/104`). The 60/80
 * cut-points and the two lower labels are Freelingo decisions - the corpus has three
 * observed points and nothing else (ADV 02/B3).
 */
export const ACCURACY_TIERS: readonly { readonly min: number; readonly label: string }[] = [
  { min: 1, label: 'AMAZING' },
  { min: 0.9, label: 'GREAT!' },
  { min: 0.8, label: 'GOOD!' },
  { min: 0.6, label: 'NICE!' },
  { min: 0, label: 'KEEP GOING!' },
];

export function accuracyLabel(accuracy: number): string {
  for (const tier of ACCURACY_TIERS) if (accuracy >= tier.min) return tier.label;
  /* c8 ignore next */
  return 'KEEP GOING!';
}
