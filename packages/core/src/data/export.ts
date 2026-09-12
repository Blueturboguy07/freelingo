/**
 * Export (INV-DAT-01, INV-DAT-03, INV-DAT-07; screen S135).
 *
 * Export needs 20 MB and 12 MB are free (EC-PER-05). The failure that matters is not the
 * failed export — it is the **half-written file that reaches the share sheet**, gets
 * mailed to the learner, and is imported six months later onto a reinstalled phone. Import
 * is replace-only, so a truncated archive destroys a good state and restores nothing.
 *
 * Hence: temp path → checksum into the manifest → atomic rename → share sheet, and the
 * share sheet is reached **only** on a verified-complete write. A failed export leaves no
 * artefact at all, so there is nothing to find later and mistake for a backup.
 *
 * Every export checkpoints first (`wal_checkpoint(TRUNCATE)`, INV-DAT-07): otherwise the
 * dump is missing whatever is still in the `-wal`, and it opens cleanly and passes
 * `integrity_check` anyway.
 */
import { sha256Hex } from '../packs/hashing.js';
import { CHECKPOINT_STEP } from './integrity.js';
import { EXCLUDED_FROM_ARCHIVE, type ArchiveManifest } from './manifest.js';

/** The steps of an export, in the only order they may run. */
export const EXPORT_STEPS = [
  CHECKPOINT_STEP,
  'write-temp',
  'compute-checksum',
  'verify-complete',
  'rename-atomic',
  'share-sheet',
] as const;
export type ExportStep = (typeof EXPORT_STEPS)[number];

/** The suffix a partial export carries. It is never handed to the share sheet. */
export const EXPORT_TEMP_SUFFIX = '.partial';

export type ExportRefusal =
  'short-disk' | 'short-write' | 'checksum-mismatch' | 'checkpoint-failed';

export interface ExportRequest {
  readonly finalPath: string;
  readonly estimatedBytes: number;
  readonly freeBytes: number;
}

export interface ExportPlan {
  readonly tempPath: string;
  readonly finalPath: string;
  /** Steps that may run. Empty when the plan refuses up front. */
  readonly steps: readonly ExportStep[];
  readonly refusal: ExportRefusal | null;
  readonly shortfallBytes: number;
  /** EC-PER-05: on a short disk, state the shortfall and offer the smaller export. */
  readonly offers: readonly 'export-without-audio-manifest'[];
  /** Tables the dump omits, so the caller cannot forget (INV-DAT-03). */
  readonly excludedTables: readonly string[];
}

/** Headroom beyond the dump itself: the temp copy and the rename both need room. */
export const EXPORT_HEADROOM_BYTES = 4 * 1024 * 1024;

export function planExport(request: ExportRequest): ExportPlan {
  const required = request.estimatedBytes + EXPORT_HEADROOM_BYTES;
  const tempPath = `${request.finalPath}${EXPORT_TEMP_SUFFIX}`;
  if (request.freeBytes < required) {
    return {
      tempPath,
      finalPath: request.finalPath,
      steps: [],
      refusal: 'short-disk',
      shortfallBytes: required - request.freeBytes,
      offers: ['export-without-audio-manifest'],
      excludedTables: [...EXCLUDED_FROM_ARCHIVE],
    };
  }
  return {
    tempPath,
    finalPath: request.finalPath,
    steps: [...EXPORT_STEPS],
    refusal: null,
    shortfallBytes: 0,
    offers: [],
    excludedTables: [...EXCLUDED_FROM_ARCHIVE],
  };
}

export interface ExportAttempt {
  readonly plan: ExportPlan;
  readonly checkpointed: boolean;
  /** Bytes actually written to the temp path. */
  readonly bytesWritten: number;
  /** SHA-256 of what is on disk at the temp path. */
  readonly writtenSha256: string;
  readonly manifest: ArchiveManifest;
}

export interface ExportOutcome {
  readonly shareSheet: boolean;
  readonly steps: readonly ExportStep[];
  readonly refusal: ExportRefusal | null;
  /** Files left on disk when this returns. Empty on every failure path. */
  readonly artefacts: readonly string[];
  readonly deleted: readonly string[];
  readonly shortfallBytes: number;
}

/**
 * Decide whether the write that happened is complete, and therefore whether the file may
 * exist at all. Three independent checks, because they fail independently: the checkpoint
 * (completeness of the *source*), the byte count (a short write), and the digest (a
 * corrupted one).
 */
export function completeExport(attempt: ExportAttempt): ExportOutcome {
  const fail = (refusal: ExportRefusal, steps: ExportStep[]): ExportOutcome => ({
    shareSheet: false,
    steps,
    refusal,
    // Nothing is left behind: a `.partial` file the learner can find is a file the
    // learner can mail to themselves.
    artefacts: [],
    deleted: [attempt.plan.tempPath],
    shortfallBytes: 0,
  });

  if (attempt.plan.refusal !== null) {
    return {
      shareSheet: false,
      steps: [],
      refusal: attempt.plan.refusal,
      artefacts: [],
      deleted: [],
      shortfallBytes: attempt.plan.shortfallBytes,
    };
  }
  if (!attempt.checkpointed) return fail('checkpoint-failed', [CHECKPOINT_STEP]);
  if (attempt.bytesWritten !== attempt.manifest.payload.bytes) {
    return fail('short-write', [CHECKPOINT_STEP, 'write-temp']);
  }
  if (attempt.writtenSha256 !== attempt.manifest.payload.sha256) {
    return fail('checksum-mismatch', [CHECKPOINT_STEP, 'write-temp', 'compute-checksum']);
  }
  return {
    shareSheet: true,
    steps: [...EXPORT_STEPS],
    refusal: null,
    artefacts: [attempt.plan.finalPath],
    deleted: [],
    shortfallBytes: 0,
  };
}

/** Convenience for the shell: the digest the manifest must carry. */
export function exportChecksum(payload: Uint8Array): string {
  return sha256Hex(payload);
}
