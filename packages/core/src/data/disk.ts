/**
 * The disk-space check at session start, and what it changes (INV-PER-05, EC-PER-04;
 * screen S150).
 *
 * With < 50 MB free, WAL growth and boundary writes fail — and they fail *silently*, which
 * is the actual problem. The resume guarantee ("kill the app mid-lesson and you come back
 * to the same question") is a promise the app makes; below the threshold it cannot keep
 * it, so it must **say so once** and downgrade visibly rather than quietly stop writing
 * boundaries and let the learner discover it by losing a lesson.
 *
 * `availableDiskSpace` arrives through an injected probe: `packages/core` is headless, and
 * a probe is also the only way to test the below-threshold branch without filling a disk.
 */

/**
 * Below this, the resume guarantee is downgraded. 50 MB is EC-PER-04's figure: enough for
 * a WAL to grow through a long session plus the pre-migration copy headroom.
 */
export const LOW_DISK_THRESHOLD_BYTES = 50 * 1024 * 1024;

/** The injected probe. Returns bytes free on the volume holding the progress DB. */
export interface DiskProbe {
  availableDiskSpace(): number;
}

export type ResumeGuarantee = 'persistent' | 'in-memory-only';

export interface SessionStartDiskCheck {
  readonly freeBytes: number;
  readonly belowThreshold: boolean;
  readonly resumeGuarantee: ResumeGuarantee;
  /** S150 `warned-at-session-start`. Shown once per low-disk session, never silently. */
  readonly noticeShown: boolean;
  readonly noticeKey: string | null;
  readonly shortfallBytes: number;
}

/**
 * Checked at session start, not at write time: the learner has to be told *before* they
 * spend twenty minutes on a lesson that may not survive a phone call.
 */
export function checkDiskAtSessionStart(probe: DiskProbe): SessionStartDiskCheck {
  const freeBytes = Math.max(0, probe.availableDiskSpace());
  const belowThreshold = freeBytes < LOW_DISK_THRESHOLD_BYTES;
  return {
    freeBytes,
    belowThreshold,
    resumeGuarantee: belowThreshold ? 'in-memory-only' : 'persistent',
    noticeShown: belowThreshold,
    noticeKey: belowThreshold ? 'session.lowDisk.progressMayNotBeSaved' : null,
    shortfallBytes: belowThreshold ? LOW_DISK_THRESHOLD_BYTES - freeBytes : 0,
  };
}

/** The nine-field resume record's storage state, as the session sees it. */
export interface ResumeState {
  readonly guarantee: ResumeGuarantee;
  /**
   * Set when a boundary write failed. A flag, never a silent regression: the session
   * keeps running, and the surface says the resume point is stale.
   */
  readonly boundaryWriteFailed: boolean;
  /** The last exercise index whose boundary actually landed. */
  readonly lastPersistedBoundary: number | null;
}

export function initialResumeState(check: SessionStartDiskCheck): ResumeState {
  return {
    guarantee: check.resumeGuarantee,
    boundaryWriteFailed: false,
    lastPersistedBoundary: null,
  };
}

/**
 * Record the outcome of one boundary write. A failure sets the flag and leaves the last
 * known-good boundary alone — it never advances the resume point on a write that did not
 * land, which is how a resume silently skips the question the learner was on.
 */
export function recordBoundaryWrite(
  state: ResumeState,
  exerciseIndex: number,
  errorCode: string | null,
): ResumeState {
  if (errorCode !== null) {
    return { ...state, boundaryWriteFailed: true };
  }
  return { ...state, lastPersistedBoundary: exerciseIndex };
}

/** What S150 / the session shell renders. Visible, not inferred. */
export interface ResumeDisclosure {
  readonly guarantee: ResumeGuarantee;
  readonly visible: boolean;
  readonly copyKey: string | null;
}

export function resumeDisclosure(state: ResumeState): ResumeDisclosure {
  if (state.guarantee === 'in-memory-only') {
    return { guarantee: state.guarantee, visible: true, copyKey: 'session.resume.inMemoryOnly' };
  }
  if (state.boundaryWriteFailed) {
    return { guarantee: state.guarantee, visible: true, copyKey: 'session.resume.writeFailed' };
  }
  return { guarantee: state.guarantee, visible: false, copyKey: null };
}
