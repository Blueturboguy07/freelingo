/**
 * Verify-before-install, and the rules for when a byte may be fetched at all
 * (INV-PACK-18, INV-PACK-27; EC-PACK-57, EC-PACK-23, EC-CRS-06).
 *
 * The separation this module exists to keep:
 *
 * - **`unverified` is a pre-install fact.** These bytes are not ours: the signature does
 *   not check out under `packages/schema/keys/pack-signing.pub`, or the payload does not
 *   hash to what the signed manifest declares. Nothing is installed, nothing is renamed,
 *   nothing is damaged — the fix is to fetch it again.
 * - **`corrupt` is a post-install fact.** Bytes that *did* verify have since rotted on
 *   disk. That is the destructive ladder: repair, re-download, and a learner who is told
 *   their data is damaged.
 *
 * Collapsing them (EC-PACK-57) sends the recoverable case down the destructive one, so
 * `installPack` never returns `corrupt` for any input at all.
 */
import { sha256Hex } from './hashing.js';
import type { Ed25519Verifier } from './ed25519.js';
import { packSurface, resolvePackState, type PackFacts, type PackState } from './state.js';

/** The steps of an install, in the order they may run. */
export const INSTALL_STEPS = [
  'parse-manifest',
  'verify-signature',
  'verify-payload-digest',
  'install',
] as const;
export type InstallStep = (typeof INSTALL_STEPS)[number];

export type InstallRefusal =
  'manifest-unparseable' | 'signature-invalid' | 'payload-digest-mismatch';

/** What a signed pack manifest declares. The signature is over these exact bytes. */
export interface PackManifest {
  readonly packId: string;
  readonly courseId: string;
  /** Content-hashed item ids are additive-only *within* a major version (INV-PACK-02). */
  readonly major: number;
  readonly version: string;
  /** SHA-256 of the read-only pack SQLite payload. */
  readonly payloadSha256: string;
  readonly payloadBytes: number;
  readonly audioBytes: number;
  readonly itemIds: readonly string[];
}

export interface InstallInput {
  /** The manifest exactly as it was signed. Re-serialising it would change the bytes. */
  readonly manifestBytes: Uint8Array;
  readonly signature: Uint8Array;
  /** 32 raw bytes, from `parseEd25519PublicKeyPem(...).raw`. */
  readonly publicKey: Uint8Array;
  readonly verifier: Ed25519Verifier;
  /** SHA-256 of the staged payload as it actually arrived. */
  readonly stagedPayloadSha256: string;
  readonly stagedAudioBytes: number;
}

export interface InstallResult {
  readonly state: PackState;
  readonly installed: boolean;
  /** Exactly the steps that ran, in order. `install` last, or not at all. */
  readonly steps: readonly InstallStep[];
  readonly refusal: InstallRefusal | null;
  readonly manifest: PackManifest | null;
}

/** Parse the manifest bytes without trusting them. Never throws. */
export function parsePackManifest(bytes: Uint8Array): PackManifest | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const strings = ['packId', 'courseId', 'version', 'payloadSha256'] as const;
  for (const key of strings) if (typeof value[key] !== 'string') return null;
  const numbers = ['major', 'payloadBytes', 'audioBytes'] as const;
  for (const key of numbers)
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      return null;
    }
  if (!Array.isArray(value.itemIds) || value.itemIds.some((id) => typeof id !== 'string')) {
    return null;
  }
  return {
    packId: value.packId as string,
    courseId: value.courseId as string,
    major: value.major as number,
    version: value.version as string,
    payloadSha256: value.payloadSha256 as string,
    payloadBytes: value.payloadBytes as number,
    audioBytes: value.audioBytes as number,
    itemIds: value.itemIds as string[],
  };
}

/**
 * The install gate. `steps` is part of the contract, not diagnostics: the invariant is
 * about ORDER — the signature is checked before anything is installed — and a result that
 * only reported the final state could not tell a correct implementation from one that
 * installs first and checks afterwards.
 */
export function installPack(input: InstallInput): InstallResult {
  const steps: InstallStep[] = ['parse-manifest'];
  const manifest = parsePackManifest(input.manifestBytes);
  if (manifest === null) {
    return {
      state: 'unverified',
      installed: false,
      steps,
      refusal: 'manifest-unparseable',
      manifest: null,
    };
  }

  steps.push('verify-signature');
  const signatureOk = input.verifier.verify(input.signature, input.manifestBytes, input.publicKey);
  if (!signatureOk) {
    return { state: 'unverified', installed: false, steps, refusal: 'signature-invalid', manifest };
  }

  steps.push('verify-payload-digest');
  if (input.stagedPayloadSha256 !== manifest.payloadSha256) {
    // The signature is genuine but these are not the bytes it covers: a truncated or
    // swapped payload. Still `unverified` — nothing was installed, so nothing is damaged.
    return {
      state: 'unverified',
      installed: false,
      steps,
      refusal: 'payload-digest-mismatch',
      manifest,
    };
  }

  steps.push('install');
  const facts: PackFacts = {
    catalogue: 'available',
    dbPresent: true,
    signature: 'valid',
    integrity: 'ok',
    audioBytesPresent: Math.min(input.stagedAudioBytes, manifest.audioBytes),
    audioBytesExpected: manifest.audioBytes,
  };
  return { state: resolvePackState(facts), installed: true, steps, refusal: null, manifest };
}

/** Digest helper so callers do not re-derive the algorithm the manifest declares. */
export function payloadDigest(payload: Uint8Array): string {
  return sha256Hex(payload);
}

// ---------------------------------------------------------------------------
// INV-PACK-27 — fetching
// ---------------------------------------------------------------------------

export type Connection = 'unmetered' | 'metered' | 'offline';

/** What caused a fetch to be considered. Only one of these may run on a metered link. */
export type FetchTrigger = 'explicit-tap' | 'auto-resume' | 'course-switch' | 'session-start';

export interface FetchRequest {
  readonly connection: Connection;
  /** A confirm the learner gave for THIS download, with the size shown. */
  readonly userConfirmedMetered: boolean;
  readonly trigger: FetchTrigger;
  readonly bytesRemaining: number;
}

export type FetchRefusal =
  'offline' | 'metered-needs-confirm' | 'needs-explicit-start' | 'nothing-to-fetch';

export interface FetchPlan {
  readonly start: boolean;
  /** A confirm, **with the size**, must be shown and tapped before a byte moves. */
  readonly confirmRequired: boolean;
  readonly refusal: FetchRefusal | null;
  readonly bytes: number;
  /** EC-CRS-06: queued so it auto-resumes — but only on an unmetered link. */
  readonly queued: boolean;
}

/**
 * Triggers that may begin a fetch on their own once the link allows it.
 *
 * `explicit-tap` is the learner asking for this download now. `auto-resume` is EC-CRS-06:
 * *"the download is queued and auto-resumes"* — a download the learner already started
 * and which was interrupted, so resuming it is finishing what they asked for.
 *
 * `course-switch` and `session-start` are **not** on this list. EC-PACK-23 is explicit
 * that for an evicted pack *"re-download is explicitly initiated with the size shown"* —
 * switching to a course is not a request for 38 MB, on any link. Starting one there means
 * a learner who taps a course to look at their path has begun a download they never saw
 * the size of, which on an unmetered link is merely rude and on a hotspot the OS has not
 * flagged as metered is expensive.
 */
export const SELF_STARTING_TRIGGERS: readonly FetchTrigger[] = ['explicit-tap', 'auto-resume'];

/**
 * "No pack byte is fetched on a metered link without a deliberate tap" (EC-PACK-23),
 * which restricts EC-CRS-06's auto-resume to unmetered connections.
 *
 * An `auto-resume` on a metered link therefore does not start **even when a confirm is on
 * record**: a confirm belongs to the download the learner was looking at, and a resume
 * days later in another country is not that download.
 */
export function planPackFetch(request: FetchRequest): FetchPlan {
  const bytes = Math.max(0, request.bytesRemaining);
  if (bytes === 0) {
    return {
      start: false,
      confirmRequired: false,
      refusal: 'nothing-to-fetch',
      bytes,
      queued: false,
    };
  }
  // "Explicitly initiated with the size shown" is checked BEFORE the link, so it cannot be
  // got around by being offline or on wifi when the course is tapped. Nothing is queued
  // either: a queued download fires the moment a link appears, which is the same silent
  // 38 MB fetch by a slower route.
  if (!SELF_STARTING_TRIGGERS.includes(request.trigger)) {
    return {
      start: false,
      confirmRequired: true,
      refusal: 'needs-explicit-start',
      bytes,
      queued: false,
    };
  }
  if (request.connection === 'offline') {
    // EC-CRS-06: a download the learner already started is queued and auto-resumes.
    return { start: false, confirmRequired: false, refusal: 'offline', bytes, queued: true };
  }
  if (request.connection === 'metered') {
    const allowed = request.userConfirmedMetered && request.trigger === 'explicit-tap';
    return {
      start: allowed,
      confirmRequired: !allowed,
      refusal: allowed ? null : 'metered-needs-confirm',
      bytes,
      queued: !allowed,
    };
  }
  return { start: true, confirmRequired: false, refusal: null, bytes, queued: false };
}

export interface SwitchResult {
  readonly state: PackState;
  /** A session never launches into a course whose audio is gone (EC-PACK-23). */
  readonly sessionLaunchable: boolean;
  /** Never `start: true`. The learner initiates the re-download, with the size shown. */
  readonly fetch: FetchPlan;
  /** The size to put on that offer, in bytes. 0 when there is nothing to fetch. */
  readonly offerBytes: number;
  /**
   * Progress, mistakes and FSRS rows are untouched by a switch, in every state. Read from
   * the surface table rather than asserted here, so one table decides it for all six
   * states and this cannot drift from what S151 renders.
   */
  readonly progressRowsRetained: boolean;
}

/**
 * Switching to a course re-reads the facts rather than trusting the recorded state: iOS
 * can reclaim an inactive pack from the cache directory while the app is not running, and
 * no transition was ever observed (EC-PACK-23).
 *
 * The switch itself never starts a fetch — on **any** link. It resolves the state, refuses
 * to launch a session into a course whose audio is gone, and hands back an offer carrying
 * the size for the learner to initiate (EC-PACK-23). EC-CRS-06's auto-resume applies to a
 * download that is already under way, which `planPackFetch` serves through the
 * `auto-resume` trigger; it is not what a course tap is.
 */
export function resolvePackOnSwitch(
  facts: PackFacts,
  connection: Connection,
  bytesRemaining: number,
): SwitchResult {
  const state = resolvePackState(facts);
  const launchable = state === 'installed' || state === 'partial';
  const bytes = launchable ? 0 : Math.max(0, bytesRemaining);
  const fetch = planPackFetch({
    connection,
    userConfirmedMetered: false,
    trigger: 'course-switch',
    bytesRemaining: bytes,
  });
  return {
    state,
    sessionLaunchable: launchable,
    fetch,
    offerBytes: fetch.bytes,
    progressRowsRetained: packSurface(state).progressRowsRetained,
  };
}
