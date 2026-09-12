import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import {
  LOW_DISK_THRESHOLD_BYTES,
  checkDiskAtSessionStart,
  initialResumeState,
  recordBoundaryWrite,
  resumeDisclosure,
  type DiskProbe,
} from './disk.js';

/** INV-PER-05 — the disk check at session start, and the visible downgrade. */

function probeOf(bytes: number): DiskProbe {
  return { availableDiskSpace: () => bytes };
}

describe('INV-PER-05 disk space at session start', () => {
  it('[INV-PER-05] availableDiskSpace is read through an injected probe at session start', () => {
    let calls = 0;
    const probe: DiskProbe = {
      availableDiskSpace() {
        calls += 1;
        return 10 * 1024 * 1024;
      },
    };
    checkDiskAtSessionStart(probe);
    expect(calls).toBe(1);
  });

  it('[INV-PER-05] below the threshold the resume guarantee is downgraded VISIBLY', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 * 1024 * 1024 }), (freeBytes) => {
        const check = checkDiskAtSessionStart(probeOf(freeBytes));
        const low = freeBytes < LOW_DISK_THRESHOLD_BYTES;
        expect(check.belowThreshold).toBe(low);
        expect(check.resumeGuarantee).toBe(low ? 'in-memory-only' : 'persistent');
        // Visibly: a downgrade with no notice is the silent regression EC-PER-04 is about.
        expect(check.noticeShown).toBe(low);
        expect(check.noticeKey === null).toBe(!low);

        const disclosure = resumeDisclosure(initialResumeState(check));
        expect(disclosure.visible).toBe(low);
        if (low) expect(disclosure.copyKey).toBe('session.resume.inMemoryOnly');
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PER-05] a failed boundary write sets a flag rather than failing silently', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            index: fc.nat({ max: 40 }),
            errorCode: fc.option(fc.constantFrom('SQLITE_FULL', 'SQLITE_IOERR_WRITE'), {
              nil: null,
            }),
          }),
          { maxLength: 12 },
        ),
        (writes) => {
          const check = checkDiskAtSessionStart(probeOf(500 * 1024 * 1024));
          let state = initialResumeState(check);
          for (const write of writes)
            state = recordBoundaryWrite(state, write.index, write.errorCode);

          const anyFailed = writes.some((write) => write.errorCode !== null);
          expect(state.boundaryWriteFailed).toBe(anyFailed);
          // The flag is visible; the guarantee itself was never silently withdrawn.
          expect(resumeDisclosure(state).visible).toBe(anyFailed);

          // A failed write never advances the resume point.
          const lastGood = [...writes].reverse().find((write) => write.errorCode === null);
          expect(state.lastPersistedBoundary).toBe(lastGood === undefined ? null : lastGood.index);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PER-05] the threshold is the named 50 MB, and the shortfall is reported', () => {
    expect(LOW_DISK_THRESHOLD_BYTES).toBe(50 * 1024 * 1024);
    const check = checkDiskAtSessionStart(probeOf(12 * 1024 * 1024));
    expect(check.shortfallBytes).toBe(38 * 1024 * 1024);
  });

  it('[INV-PER-05] a negative or absurd probe reading is treated as empty, not as plenty', () => {
    expect(checkDiskAtSessionStart(probeOf(-1)).belowThreshold).toBe(true);
    expect(checkDiskAtSessionStart(probeOf(-1)).freeBytes).toBe(0);
  });
});
