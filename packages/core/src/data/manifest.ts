/**
 * The archive manifest: the plaintext half of a `.freelingo` export.
 *
 * An archive is a SQLite dump plus this manifest, and **never audio** (S135). The
 * manifest is plaintext and is parsed **without opening the dump** (INV-DAT-09,
 * EC-PER-22): an archive produced by an AGPL fork carries extra columns, a different
 * economy config and pack ids this build has never heard of, and the decision to refuse —
 * plus the version it names in the refusal — has to be instant. Opening a foreign SQLite
 * dump to find out whether you want it is the wrong order.
 *
 * Named config: the format string, the excluded tables and the undo window live here and
 * nowhere else.
 */
import { sha256Hex } from '../packs/hashing.js';

export const ARCHIVE_FORMAT = 'freelingo-archive';
/** Bumped when the manifest's own shape changes, independently of the DB schema. */
export const ARCHIVE_MANIFEST_VERSION = 1;

/**
 * Tables that never enter an archive (INV-DAT-03, EC-PER-07).
 *
 * `session_state` is a half-finished session: it references a pack that may not be
 * installed on the importing device, and there is no correct merge with a session already
 * in flight there. The archive excludes it and **the manifest says so** — a reader has to
 * be able to tell an exclusion from an omission.
 */
export const EXCLUDED_FROM_ARCHIVE: readonly string[] = ['session_state'] as const;

/** Audio is re-downloadable and is 120 MB per language. It is never in an archive. */
export const ARCHIVE_INCLUDES_AUDIO = false;

/** How long the pre-import backup is kept behind one-tap undo (INV-DAT-02, EC-PER-20). */
export const IMPORT_UNDO_WINDOW_HOURS = 24;

export interface ArchivePayloadDescriptor {
  readonly bytes: number;
  readonly sha256: string;
  /** Attempt rows, so an import can tell a truncated dump from a small one (EC-PER-19). */
  readonly attemptRowCount: number;
}

export interface ArchiveManifest {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly manifestVersion: number;
  /** Who produced it — this build, or a fork, which the confirm names (EC-PER-22). */
  readonly producerId: string;
  readonly producerAppVersion: string;
  /** `PRAGMA user_version` of the dump. */
  readonly schemaVersion: number;
  readonly createdAt: string;
  /** The producing device's `last_day`, shown in the confirm beside the device's own. */
  readonly lastDay: string;
  readonly sessionsSinceInstall: number;
  readonly packIds: readonly string[];
  /** Exactly `EXCLUDED_FROM_ARCHIVE`. Stated, not implied. */
  readonly excluded: readonly string[];
  readonly includesAudio: boolean;
  /** Every export and backup checkpoints first; the manifest records that it did. */
  readonly checkpointed: boolean;
  readonly payload: ArchivePayloadDescriptor;
  /**
   * The producer's `max_local_day_seen`, kept as a **diagnostic only** (EC-PER-15). It is
   * device state, never imported.
   */
  readonly maxLocalDaySeenDiagnostic: string;
}

export interface BuildArchiveManifestInput {
  readonly producerId: string;
  readonly producerAppVersion: string;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly lastDay: string;
  readonly sessionsSinceInstall: number;
  readonly packIds: readonly string[];
  readonly payloadBytes: Uint8Array;
  readonly attemptRowCount: number;
  readonly checkpointed: boolean;
  readonly maxLocalDaySeen: string;
}

export function buildArchiveManifest(input: BuildArchiveManifestInput): ArchiveManifest {
  return {
    format: ARCHIVE_FORMAT,
    manifestVersion: ARCHIVE_MANIFEST_VERSION,
    producerId: input.producerId,
    producerAppVersion: input.producerAppVersion,
    schemaVersion: input.schemaVersion,
    createdAt: input.createdAt,
    lastDay: input.lastDay,
    sessionsSinceInstall: input.sessionsSinceInstall,
    packIds: [...input.packIds],
    excluded: [...EXCLUDED_FROM_ARCHIVE],
    includesAudio: ARCHIVE_INCLUDES_AUDIO,
    checkpointed: input.checkpointed,
    payload: {
      bytes: input.payloadBytes.length,
      sha256: sha256Hex(input.payloadBytes),
      attemptRowCount: input.attemptRowCount,
    },
    maxLocalDaySeenDiagnostic: input.maxLocalDaySeen,
  };
}

export function serialiseArchiveManifest(manifest: ArchiveManifest): string {
  return JSON.stringify(manifest, null, 2);
}

/**
 * Parse the manifest text. Never throws, never opens the dump, and refuses anything whose
 * shape it does not recognise — including a manifest whose `format` is somebody else's.
 */
export function parseArchiveManifest(text: string): ArchiveManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.format !== ARCHIVE_FORMAT) return null;

  const strings = [
    'producerId',
    'producerAppVersion',
    'createdAt',
    'lastDay',
    'maxLocalDaySeenDiagnostic',
  ] as const;
  for (const key of strings) if (typeof value[key] !== 'string') return null;
  const numbers = ['manifestVersion', 'schemaVersion', 'sessionsSinceInstall'] as const;
  for (const key of numbers) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) return null;
  }
  if (!Array.isArray(value.packIds) || value.packIds.some((id) => typeof id !== 'string')) {
    return null;
  }
  if (!Array.isArray(value.excluded) || value.excluded.some((t) => typeof t !== 'string')) {
    return null;
  }
  const payload = value.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.bytes !== 'number' || typeof p.sha256 !== 'string') return null;
  if (typeof p.attemptRowCount !== 'number') return null;

  return {
    format: ARCHIVE_FORMAT,
    manifestVersion: value.manifestVersion as number,
    producerId: value.producerId as string,
    producerAppVersion: value.producerAppVersion as string,
    schemaVersion: value.schemaVersion as number,
    createdAt: value.createdAt as string,
    lastDay: value.lastDay as string,
    sessionsSinceInstall: value.sessionsSinceInstall as number,
    packIds: value.packIds as string[],
    excluded: value.excluded as string[],
    includesAudio: value.includesAudio === true,
    checkpointed: value.checkpointed === true,
    payload: {
      bytes: p.bytes as number,
      sha256: p.sha256 as string,
      attemptRowCount: p.attemptRowCount as number,
    },
    maxLocalDaySeenDiagnostic: value.maxLocalDaySeenDiagnostic as string,
  };
}

/** Does the manifest say what INV-DAT-03 requires it to say? */
export function manifestDeclaresExclusions(manifest: ArchiveManifest): boolean {
  return (
    EXCLUDED_FROM_ARCHIVE.every((table) => manifest.excluded.includes(table)) &&
    manifest.includesAudio === false
  );
}
