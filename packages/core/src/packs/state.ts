/**
 * The pack lifecycle: a **six**-value enum and a total function from observable facts to
 * it (INV-PACK-01, INV-PACK-04, INV-PACK-18, INV-PACK-27; screens S028, S133, S151).
 *
 * `{ not-downloaded, partial, installed, corrupt, unverified, withdrawn }`
 *
 * The two values that exist because collapsing them cost a learner something:
 *
 * - **`partial` is not `corrupt`** (EC-PACK-01). A pack whose audio bank stopped at 60%
 *   still has its whole path: structure lives in the pack's SQLite file, which is small
 *   and arrives first. Rendering `currently unavailable` there strands somebody who could
 *   have studied all evening with per-item audio fallback.
 * - **`unverified` is not `corrupt`** (EC-PACK-57, founder ruling 2026-09-11). A bad
 *   signature means *these bytes are not ours*, which is recoverable by fetching them
 *   again. `corrupt` sends the same case down the destructive ladder — rename the file,
 *   offer a repair, tell the learner their data is damaged — for a pack that was never
 *   installed in the first place.
 *
 * This module is the whole decision. It takes facts, not events-so-far, because a state
 * machine that accumulates is a state machine that can disagree with the disk: the OS can
 * evict a pack while the app is not running (EC-PACK-23), and no transition was observed.
 * `applyPackEvent` is therefore a fact mutation, and `resolvePackState` is read fresh.
 */

export const PACK_STATES = [
  'not-downloaded',
  'partial',
  'installed',
  'corrupt',
  'unverified',
  'withdrawn',
] as const;

export type PackState = (typeof PACK_STATES)[number];

/** Everything the resolver may look at. Nothing else decides a pack's state. */
export interface PackFacts {
  /** What the catalogue says about this pack version, independent of this device. */
  readonly catalogue: 'available' | 'withdrawn';
  /** Is the pack's read-only SQLite file installed (structure, not audio)? */
  readonly dbPresent: boolean;
  /** The ed25519 verdict over the manifest. `unchecked` before a verify has ever run. */
  readonly signature: 'valid' | 'invalid' | 'unchecked';
  /** `PRAGMA integrity_check` / asset digest over what is installed. */
  readonly integrity: 'ok' | 'failed';
  readonly audioBytesPresent: number;
  readonly audioBytesExpected: number;
}

export const NOT_DOWNLOADED_FACTS: PackFacts = {
  catalogue: 'available',
  dbPresent: false,
  signature: 'unchecked',
  integrity: 'ok',
  audioBytesPresent: 0,
  audioBytesExpected: 0,
};

/**
 * Facts → state. Total: every combination resolves, including the nonsensical ones (a
 * withdrawn pack that is also corrupt, a valid signature over nothing).
 *
 * **The order of these rules is the design.** In particular `invalid signature` is tested
 * before `integrity failed`, so no arrangement of facts can route a bad signature to
 * `corrupt` — that is INV-PACK-18's whole content, and it is a rule about precedence, not
 * about a transition.
 *
 * `withdrawn` is first because a withdrawn pack cannot be re-fetched: offering the
 * re-download that `unverified` and `corrupt` both carry would be an action that is
 * guaranteed to fail, and the course still has to render (EC-PER-09) with its totals.
 */
export function resolvePackState(facts: PackFacts): PackState {
  if (facts.catalogue === 'withdrawn') return 'withdrawn';
  if (facts.signature === 'invalid') return 'unverified';
  if (!facts.dbPresent) return 'not-downloaded';
  if (facts.integrity === 'failed') return 'corrupt';
  if (facts.signature === 'unchecked') return 'unverified';
  if (facts.audioBytesPresent < facts.audioBytesExpected) return 'partial';
  return 'installed';
}

export const PACK_EVENTS = [
  'catalogue-withdrawn',
  'catalogue-reinstated',
  'verify-passed',
  'verify-failed',
  'audio-fetch-progressed',
  'audio-fetch-interrupted',
  'audio-complete',
  'audio-removed',
  'integrity-check-failed',
  'repaired',
  'evicted',
  'deleted',
] as const;

export type PackEvent = (typeof PACK_EVENTS)[number];

/**
 * Apply one lifecycle event to the facts. Total over `PackFacts × PackEvent`.
 *
 * `verify-failed` deliberately leaves `dbPresent` alone: **verification runs before
 * install**, so a failed verify has nothing to un-install. It records the verdict, and
 * `resolvePackState` renders `unverified` whether or not an older copy is on disk.
 */
export function applyPackEvent(
  facts: PackFacts,
  event: PackEvent,
  bytesPresent = facts.audioBytesPresent,
): PackFacts {
  switch (event) {
    case 'catalogue-withdrawn':
      return { ...facts, catalogue: 'withdrawn' };
    case 'catalogue-reinstated':
      return { ...facts, catalogue: 'available' };
    case 'verify-passed':
      return { ...facts, dbPresent: true, signature: 'valid', integrity: 'ok' };
    case 'verify-failed':
      return { ...facts, signature: 'invalid' };
    case 'audio-fetch-progressed':
      return { ...facts, audioBytesPresent: Math.min(bytesPresent, facts.audioBytesExpected) };
    case 'audio-fetch-interrupted':
      return {
        ...facts,
        audioBytesPresent: Math.min(bytesPresent, Math.max(0, facts.audioBytesExpected - 1)),
      };
    case 'audio-complete':
      return { ...facts, audioBytesPresent: facts.audioBytesExpected };
    case 'audio-removed':
      return { ...facts, audioBytesPresent: 0 };
    case 'integrity-check-failed':
      return { ...facts, integrity: 'failed' };
    case 'repaired':
      return {
        ...facts,
        dbPresent: true,
        signature: 'valid',
        integrity: 'ok',
        audioBytesPresent: facts.audioBytesExpected,
      };
    case 'evicted':
    case 'deleted':
      // The OS reclaimed the cache directory, or the learner removed the audio. Both
      // leave progress rows untouched; only the bytes go (EC-PACK-20, EC-PACK-23).
      return {
        ...facts,
        dbPresent: false,
        signature: 'unchecked',
        integrity: 'ok',
        audioBytesPresent: 0,
      };
  }
}

/** The action a surface offers for a state. One action per state, never two. */
export type PackAction = 'download' | 'resume' | 'redownload' | 'repair' | 'none';

/**
 * What every surface renders for a state (S151 pack manager, S028 node unavailable,
 * S133 manage courses, the Practice Hub row). One table, so two surfaces cannot disagree
 * about what `partial` means.
 *
 * `copyKey` is distinct per state on purpose: EC-PACK-01's complaint is literally that
 * the corrupt string was reused for a partial pack.
 */
export interface PackSurface {
  readonly state: PackState;
  /** Does the path render at all? Only `corrupt` and `not-downloaded` hide it. */
  readonly pathRendered: boolean;
  /** Can a lesson be started? */
  readonly lessonsPlayable: boolean;
  /** Are items without a baked clip played through the TTS fallback? */
  readonly perItemAudioFallback: boolean;
  /** The `... is currently unavailable` state of S028. Only `corrupt`. */
  readonly showsUnavailable: boolean;
  readonly action: PackAction;
  readonly copyKey: string;
  /** The course renders but nothing can be earned in it. */
  readonly readOnly: boolean;
  /** Streak, XP, achievements, calendar: always counted, in every state. */
  readonly accountTotalsCounted: boolean;
  /** Progress, mistakes and FSRS rows survive every state. Never deleted. */
  readonly progressRowsRetained: boolean;
}

const SURFACES: Readonly<Record<PackState, PackSurface>> = {
  'not-downloaded': {
    state: 'not-downloaded',
    pathRendered: false,
    lessonsPlayable: false,
    perItemAudioFallback: false,
    showsUnavailable: false,
    action: 'download',
    copyKey: 'pack.notDownloaded',
    readOnly: false,
    accountTotalsCounted: true,
    progressRowsRetained: true,
  },
  partial: {
    state: 'partial',
    // EC-PACK-01: the path renders in full and lessons run. This row is the invariant.
    pathRendered: true,
    lessonsPlayable: true,
    perItemAudioFallback: true,
    showsUnavailable: false,
    action: 'resume',
    copyKey: 'pack.partial.resume',
    readOnly: false,
    accountTotalsCounted: true,
    progressRowsRetained: true,
  },
  installed: {
    state: 'installed',
    pathRendered: true,
    lessonsPlayable: true,
    perItemAudioFallback: false,
    showsUnavailable: false,
    action: 'none',
    copyKey: 'pack.installed',
    readOnly: false,
    accountTotalsCounted: true,
    progressRowsRetained: true,
  },
  corrupt: {
    state: 'corrupt',
    pathRendered: false,
    lessonsPlayable: false,
    perItemAudioFallback: false,
    showsUnavailable: true,
    action: 'repair',
    copyKey: 'pack.corrupt.unavailable',
    readOnly: false,
    accountTotalsCounted: true,
    progressRowsRetained: true,
  },
  unverified: {
    state: 'unverified',
    pathRendered: false,
    lessonsPlayable: false,
    perItemAudioFallback: false,
    // Its own copy and its own action: this is the whole point of the sixth value.
    showsUnavailable: false,
    action: 'redownload',
    copyKey: 'pack.unverified.redownload',
    readOnly: false,
    accountTotalsCounted: true,
    progressRowsRetained: true,
  },
  withdrawn: {
    state: 'withdrawn',
    // EC-PER-09: the course is retained READ-ONLY, never dropped — dropping it makes
    // Total XP disagree with the visible courses.
    pathRendered: true,
    lessonsPlayable: false,
    perItemAudioFallback: false,
    showsUnavailable: false,
    action: 'none',
    copyKey: 'pack.withdrawn.readOnly',
    readOnly: true,
    accountTotalsCounted: true,
    progressRowsRetained: true,
  },
};

export function packSurface(state: PackState): PackSurface {
  return SURFACES[state];
}

/** Every state a surface must render. Used by the e2e walk and by the render-all test. */
export function allPackSurfaces(): readonly PackSurface[] {
  return PACK_STATES.map(packSurface);
}
