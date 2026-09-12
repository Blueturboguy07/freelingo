import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { sha256Hex } from '../packs/hashing.js';
import { CHECKPOINT_STEP } from './integrity.js';
import {
  EXPORT_HEADROOM_BYTES,
  EXPORT_STEPS,
  EXPORT_TEMP_SUFFIX,
  completeExport,
  exportChecksum,
  planExport,
} from './export.js';
import {
  ARCHIVE_FORMAT,
  EXCLUDED_FROM_ARCHIVE,
  buildArchiveManifest,
  manifestDeclaresExclusions,
  parseArchiveManifest,
  serialiseArchiveManifest,
} from './manifest.js';

/** INV-DAT-01 (export), INV-DAT-03 (session_state excluded), INV-DAT-07 (checkpoint). */

const PAYLOAD = Uint8Array.from({ length: 20_000 }, (_, i) => (i * 13) & 0xff);

function manifestOf(payload: Uint8Array = PAYLOAD) {
  return buildArchiveManifest({
    producerId: 'freelingo',
    producerAppVersion: '0.1.0',
    schemaVersion: 3,
    createdAt: '2026-09-11T17:42:33.000Z',
    lastDay: '2026-09-11',
    sessionsSinceInstall: 214,
    packIds: ['es-ES@1.0.0'],
    payloadBytes: payload,
    attemptRowCount: 4211,
    checkpointed: true,
    maxLocalDaySeen: '2026-09-11',
  });
}

describe('INV-DAT-01 export reaches the share sheet only on a verified-complete write', () => {
  const plan = planExport({
    finalPath: '/docs/freelingo-2026-09-11.freelingo',
    estimatedBytes: PAYLOAD.length,
    freeBytes: 500 * 1024 * 1024,
  });

  it('[INV-DAT-01] the happy path checkpoints, writes a temp file, checksums, renames, then shares', () => {
    expect(plan.steps).toEqual([...EXPORT_STEPS]);
    expect(plan.steps[0]).toBe(CHECKPOINT_STEP);
    expect(plan.tempPath.endsWith(EXPORT_TEMP_SUFFIX)).toBe(true);
    const outcome = completeExport({
      plan,
      checkpointed: true,
      bytesWritten: PAYLOAD.length,
      writtenSha256: sha256Hex(PAYLOAD),
      manifest: manifestOf(),
    });
    expect(outcome.shareSheet).toBe(true);
    expect(outcome.artefacts).toEqual([plan.finalPath]);
    expect(outcome.steps.indexOf('verify-complete')).toBeLessThan(
      outcome.steps.indexOf('share-sheet'),
    );
  });

  it('[INV-DAT-01] a failed export leaves no artefact at all', () => {
    // Hoisted: hashing 20 kB ten thousand times measures sha256, not the invariant.
    const manifest = manifestOf();
    const wrongDigest = sha256Hex('other');
    fc.assert(
      fc.property(
        fc.record({
          checkpointed: fc.boolean(),
          bytesWritten: fc.integer({ min: 0, max: PAYLOAD.length }),
          digestMatches: fc.boolean(),
        }),
        ({ checkpointed, bytesWritten, digestMatches }) => {
          const outcome = completeExport({
            plan,
            checkpointed,
            bytesWritten,
            writtenSha256: digestMatches ? manifest.payload.sha256 : wrongDigest,
            manifest,
          });
          const complete = checkpointed && bytesWritten === PAYLOAD.length && digestMatches;
          expect(outcome.shareSheet).toBe(complete);
          if (!complete) {
            // Import is replace-only: a truncated archive found later destroys a good
            // state and restores nothing, so it must not exist to be found.
            expect(outcome.artefacts).toEqual([]);
            expect(outcome.deleted).toEqual([plan.tempPath]);
            expect(outcome.refusal).not.toBeNull();
          } else {
            expect(outcome.artefacts).toEqual([plan.finalPath]);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-DAT-01] a short disk refuses up front, states the shortfall and offers the smaller export', () => {
    // EC-PER-05: export needs 20 MB, 12 MB free.
    const short = planExport({
      finalPath: '/docs/x.freelingo',
      estimatedBytes: 20 * 1024 * 1024,
      freeBytes: 12 * 1024 * 1024,
    });
    expect(short.refusal).toBe('short-disk');
    expect(short.steps).toEqual([]);
    expect(short.shortfallBytes).toBe(20 * 1024 * 1024 + EXPORT_HEADROOM_BYTES - 12 * 1024 * 1024);
    expect(short.offers).toEqual(['export-without-audio-manifest']);

    const outcome = completeExport({
      plan: short,
      checkpointed: true,
      bytesWritten: 0,
      writtenSha256: '',
      manifest: manifestOf(),
    });
    expect(outcome.shareSheet).toBe(false);
    expect(outcome.artefacts).toEqual([]);
  });

  it('[INV-DAT-01] an unrenamed temp file is never what the share sheet gets', () => {
    const outcome = completeExport({
      plan,
      checkpointed: true,
      bytesWritten: PAYLOAD.length,
      writtenSha256: sha256Hex(PAYLOAD),
      manifest: manifestOf(),
    });
    expect(outcome.artefacts).not.toContain(plan.tempPath);
    expect(outcome.artefacts.every((path) => !path.endsWith(EXPORT_TEMP_SUFFIX))).toBe(true);
  });

  it('[INV-DAT-07] an export that did not checkpoint first is refused', () => {
    const outcome = completeExport({
      plan,
      checkpointed: false,
      bytesWritten: PAYLOAD.length,
      writtenSha256: sha256Hex(PAYLOAD),
      manifest: manifestOf(),
    });
    expect(outcome.refusal).toBe('checkpoint-failed');
    expect(outcome.shareSheet).toBe(false);
    expect(outcome.artefacts).toEqual([]);
  });

  it('[INV-DAT-01] the checksum in the manifest is the checksum of the payload', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 500 }), (payload) => {
        expect(manifestOf(payload).payload.sha256).toBe(exportChecksum(payload));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('INV-DAT-03 session_state is excluded, and the manifest says so', () => {
  it('[INV-DAT-03] the archive excludes session_state and the manifest declares the exclusion', () => {
    const manifest = manifestOf();
    expect(EXCLUDED_FROM_ARCHIVE).toContain('session_state');
    expect(manifest.excluded).toContain('session_state');
    expect(manifest.includesAudio).toBe(false);
    expect(manifestDeclaresExclusions(manifest)).toBe(true);
  });

  it('[INV-DAT-03] the export plan carries the excluded table list so a caller cannot forget it', () => {
    const plan = planExport({ finalPath: '/x', estimatedBytes: 1, freeBytes: 1_000_000_000 });
    expect(plan.excludedTables).toEqual([...EXCLUDED_FROM_ARCHIVE]);
  });

  it('[INV-DAT-03] a manifest that drops the declaration is detectable', () => {
    const manifest = { ...manifestOf(), excluded: [] };
    expect(manifestDeclaresExclusions(manifest)).toBe(false);
  });

  it('[INV-DAT-03] the manifest round-trips through its own parser', () => {
    const manifest = manifestOf();
    expect(parseArchiveManifest(serialiseArchiveManifest(manifest))).toEqual(manifest);
    expect(manifest.format).toBe(ARCHIVE_FORMAT);
  });
});
