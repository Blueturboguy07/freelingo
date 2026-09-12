/**
 * Import (INV-DAT-02, INV-DAT-04, INV-DAT-05, INV-DAT-09, INV-DAT-10; screens S003, S135).
 *
 * Import is **replace-only**. Merging two divergent streak histories has no correct answer
 * (EC-PER-10), so the app does not try — which makes every guard below load-bearing,
 * because a bad import is not recoverable except through the undo window.
 *
 * The order of operations is the design, and it comes from three separate edge cases:
 *
 *   parse manifest (plaintext, no dump)   EC-PER-22 — refuse instantly, name the version
 *   verify payload digest + row count     EC-PER-05 — a truncated archive must not land
 *   check free space                      EC-PER-21 — a short disk fails BEFORE the backup
 *   pre-import backup, persistent dir     EC-PER-20 — kept 24 h behind one-tap undo
 *   swap                                  replace-only
 *
 * And three rules about the *values* that come in:
 *
 * - **Imported gap days count as missed, never `unlived`** (plan ruling EC-PER-08). The
 *   learner existed; this device did not. The confirm states the freeze cost **before** it
 *   is paid, because freeze consumption is irreversible.
 * - **`max_local_day_seen` is device state, not archive state** (EC-PER-15). An archive
 *   written on a phone whose clock read 2027 must not suppress every day-keyed reward
 *   until the calendar catches up.
 * - **The archive's economy config is never adopted** (EC-PER-22). A fork's archive must
 *   not raise this build's freeze cap.
 */
import { addCivilDays, civilDaysBetween, toLocalDay, type LocalDay } from '../day/civil.js';
import {
  IMPORTED_ACHIEVEMENT_LADDER,
  IMPORT_RANGES,
  clampToRange,
  recomputeAchievements,
  type AchievementTiers,
  type ImportCounters,
} from './ranges.js';
import { IMPORT_UNDO_WINDOW_HOURS, type ArchiveManifest } from './manifest.js';

/** The steps of an import, in the only order they may run. */
export const IMPORT_STEPS = [
  'parse-manifest',
  'verify-payload',
  'check-free-space',
  'pre-import-backup',
  'swap',
] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

export type ImportRefusal =
  | 'not-an-archive'
  | 'newer-schema'
  | 'newer-manifest-format'
  | 'payload-mismatch'
  | 'incomplete-archive'
  | 'short-disk';

/** What this build is and what it already holds. */
export interface ImportDevice {
  readonly schemaVersion: number;
  readonly manifestVersion: number;
  readonly appVersion: string;
  readonly today: LocalDay;
  readonly lastDay: LocalDay | null;
  readonly maxLocalDaySeen: LocalDay;
  readonly sessionsSinceInstall: number;
  readonly freezesOwned: number;
  /** Pack ids this build can resolve. */
  readonly installedPackIds: readonly string[];
  /** This build's economy config. The archive's is never read. */
  readonly freezeCap: number;
  readonly freeBytes: number;
}

/** What the confirm dialog must show before the learner taps through (INV-DAT-02). */
export interface ImportConfirm {
  readonly archiveLastDay: string;
  readonly deviceLastDay: string | null;
  readonly archiveSessionsSinceInstall: number;
  readonly deviceSessionsSinceInstall: number;
  readonly producerId: string;
  readonly producerAppVersion: string;
  readonly replaceOnly: true;
  readonly undoWindowHours: number;
  /** Days between the archive's last day and today. */
  readonly gapDays: number;
  /** Always `missed`. The plan ruling on EC-PER-08 — never `unlived`. */
  readonly gapDayClassification: 'missed';
  /** Freezes this import will spend. Stated BEFORE it is paid. */
  readonly freezeCost: number;
  /** Whether the streak survives the gap after freezes are applied. */
  readonly streakWillBreak: boolean;
  /** The archive's `max_local_day_seen` and what it will actually be set to. */
  readonly archiveMaxLocalDaySeen: string;
  readonly clampedMaxLocalDaySeen: string;
  /** Pack ids this build cannot resolve; their courses arrive read-only, not dropped. */
  readonly unresolvablePackIds: readonly string[];
}

export interface ImportDecision {
  readonly accepted: boolean;
  readonly refusal: ImportRefusal | null;
  /** Human-facing detail for a version refusal, so the dialog can name the version. */
  readonly refusalDetail: string | null;
  readonly steps: readonly ImportStep[];
  readonly confirm: ImportConfirm | null;
  readonly backup: ImportBackupPlan | null;
}

export interface ImportBackupPlan {
  /** Persistent directory, never cache (EC-PER-20). */
  readonly region: 'document';
  readonly retainedHours: number;
  readonly undo: 'one-tap';
  /** The last two backups are kept; a second import rolls the stack. */
  readonly keep: number;
}

export const IMPORT_BACKUPS_KEPT = 2;
/** Headroom an import needs: the staged copy plus the pre-import backup. */
export const IMPORT_HEADROOM_BYTES = 8 * 1024 * 1024;

/** Where import is reachable from. S003 is the one that matters (EC-PER-06). */
export const IMPORT_ENTRY_POINTS: readonly string[] = [
  'S003-onboarding-restore-prompt',
  'S135-settings-data',
  'S147-corruption-recovery',
] as const;

export function importIsReachableFromOnboarding(): boolean {
  return IMPORT_ENTRY_POINTS.includes('S003-onboarding-restore-prompt');
}

/** What the device observed about the payload, computed without interpreting it. */
export interface PayloadObservation {
  readonly sha256: string;
  readonly bytes: number;
  readonly attemptRowCount: number;
}

/**
 * Decide, from the **manifest alone** plus the device's own state, whether this archive
 * may be imported and what the confirm has to say.
 *
 * `payload` is a digest observation, not the dump: nothing here parses SQL, so a hostile
 * archive gets no chance to be interesting before it has been refused.
 */
export function decideImport(
  manifest: ArchiveManifest | null,
  payload: PayloadObservation | null,
  device: ImportDevice,
): ImportDecision {
  const steps: ImportStep[] = ['parse-manifest'];
  const refuse = (refusal: ImportRefusal, detail: string | null = null): ImportDecision => ({
    accepted: false,
    refusal,
    refusalDetail: detail,
    steps,
    confirm: null,
    backup: null,
  });

  if (manifest === null) return refuse('not-an-archive');

  // EC-PER-22: refuse a version this build cannot read, and name it.
  if (manifest.manifestVersion > device.manifestVersion) {
    return refuse(
      'newer-manifest-format',
      `archive manifest v${manifest.manifestVersion}, this build reads v${device.manifestVersion}`,
    );
  }
  if (manifest.schemaVersion > device.schemaVersion) {
    return refuse(
      'newer-schema',
      `archive schema v${manifest.schemaVersion} from ${manifest.producerId} ${manifest.producerAppVersion}, this build is v${device.schemaVersion}`,
    );
  }

  steps.push('verify-payload');
  if (payload === null) return refuse('payload-mismatch');
  if (payload.sha256 !== manifest.payload.sha256 || payload.bytes !== manifest.payload.bytes) {
    return refuse('payload-mismatch');
  }
  // EC-PER-19: a dump whose rows do not reach the manifest's count lost its `-wal`.
  if (payload.attemptRowCount < manifest.payload.attemptRowCount || !manifest.checkpointed) {
    return refuse('incomplete-archive');
  }

  steps.push('check-free-space');
  const required = manifest.payload.bytes * 2 + IMPORT_HEADROOM_BYTES;
  if (device.freeBytes < required) {
    // Before the backup, never halfway through it (EC-PER-21).
    return refuse('short-disk', `needs ${required - device.freeBytes} more bytes`);
  }

  steps.push('pre-import-backup', 'swap');
  const archiveLastDay = toLocalDay(manifest.lastDay);
  const gapDays = Math.max(0, civilDaysBetween(archiveLastDay, device.today) - 1);
  const freezeCost = Math.min(device.freezesOwned, gapDays);

  return {
    accepted: true,
    refusal: null,
    refusalDetail: null,
    steps,
    confirm: {
      archiveLastDay: manifest.lastDay,
      deviceLastDay: device.lastDay,
      archiveSessionsSinceInstall: manifest.sessionsSinceInstall,
      deviceSessionsSinceInstall: device.sessionsSinceInstall,
      producerId: manifest.producerId,
      producerAppVersion: manifest.producerAppVersion,
      replaceOnly: true,
      undoWindowHours: IMPORT_UNDO_WINDOW_HOURS,
      gapDays,
      gapDayClassification: 'missed',
      freezeCost,
      streakWillBreak: gapDays > freezeCost,
      archiveMaxLocalDaySeen: manifest.maxLocalDaySeenDiagnostic,
      clampedMaxLocalDaySeen: clampImportedMaxLocalDaySeen(device),
      unresolvablePackIds: manifest.packIds.filter((id) => !device.installedPackIds.includes(id)),
    },
    backup: {
      region: 'document',
      retainedHours: IMPORT_UNDO_WINDOW_HOURS,
      undo: 'one-tap',
      keep: IMPORT_BACKUPS_KEPT,
    },
  };
}

/**
 * `max_local_day_seen` after an import (INV-DAT-05, EC-PER-15 + INV-DAT-10).
 *
 * EC-PER-15 says clamp to `max(device value, device today)`; INV-DAT-10 says the
 * post-import value is `<= today`. Both hold only if the result is exactly **today** — so
 * that is what this returns, and the archive value is nowhere in the expression. A device
 * whose own value had run ahead comes back to today too, which is the same anti-tamper
 * denial-of-service seen from the other side.
 */
export function clampImportedMaxLocalDaySeen(device: ImportDevice): LocalDay {
  const kept = device.maxLocalDaySeen > device.today ? device.maxLocalDaySeen : device.today;
  return kept > device.today ? device.today : kept;
}

// ---------------------------------------------------------------------------
// Applying the archive
// ---------------------------------------------------------------------------

/**
 * The account-region fields an archive carries. Deliberately narrow: P4 widens it as the
 * surfaces land, and the progress schema itself lives in `packages/schema`.
 */
export interface ArchiveAccountState {
  readonly streak: number;
  readonly gems: number;
  readonly lifetimeXp: number;
  readonly freezes: number;
  readonly counters: ImportCounters;
  /** Claimed achievement tiers. Never trusted; recomputed from the counters. */
  readonly achievements: AchievementTiers;
  /** A fork's economy constants, if it wrote any. Never adopted. */
  readonly economy?: Readonly<Record<string, number>>;
  /** Rows the archive stamps as already lived. Never re-stamped (INV-DAT-04). */
  readonly historicalDays: readonly string[];
}

/** Fields no import may ever write. The gate is the list, not a reviewer's memory. */
export const ECONOMY_CONFIG_FIELDS: readonly string[] = [
  'freezeCap',
  'freezePrice',
  'streakRepairsPerMonth',
  'xpPerLesson',
  'goalTiers',
  'boostMultiplier',
  'boostGraceSeconds',
  'maxRolloverDeferralSeconds',
  'questScaling',
] as const;

export interface AppliedImport {
  readonly streak: number;
  readonly gems: number;
  readonly lifetimeXp: number;
  readonly freezes: number;
  readonly counters: ImportCounters;
  readonly achievements: AchievementTiers;
  readonly maxLocalDaySeen: LocalDay;
  /** EC-SEC-07: the account region is stamped so a surface can say where this came from. */
  readonly provenance: 'imported';
  /** Days that were re-stamped. Always empty (INV-DAT-04). */
  readonly restampedDays: readonly string[];
  /** Gap days, all classified `missed`. */
  readonly missedDays: readonly string[];
  /** Never `unlived`. Always empty. */
  readonly unlivedDays: readonly string[];
  /** Field names that were clamped, for the one-line `adjusted` notice. */
  readonly adjusted: readonly string[];
  readonly noticeKey: string | null;
  /** Courses whose pack this build cannot resolve: retained, never dropped. */
  readonly unresolvedPackIds: readonly string[];
  /** The keys this import writes. Never intersects ECONOMY_CONFIG_FIELDS. */
  readonly writtenFields: readonly string[];
  /** INV-DAT-05: the next honest-clock session still opens its goal chest. */
  readonly nextSessionGrantsGoalChest: true;
}

/**
 * Apply a decided import. Every value is clamped into a declared range, achievements are
 * recomputed from counters, and the economy config is taken from the *device*.
 */
export function applyImport(
  archive: ArchiveAccountState,
  confirm: ImportConfirm,
  device: ImportDevice,
): AppliedImport {
  const adjusted: string[] = [];
  const clamp = (field: keyof typeof IMPORT_RANGES, value: number): number => {
    const clamped = clampToRange(IMPORT_RANGES[field], value);
    if (clamped !== value) adjusted.push(field);
    return clamped;
  };

  const counters: ImportCounters = {
    sessionsCompleted: clamp('sessionsCompleted', archive.counters.sessionsCompleted),
    lessonsCompleted: clamp('lessonsCompleted', archive.counters.lessonsCompleted),
    perfectLessons: clamp('perfectLessons', archive.counters.perfectLessons),
    daysGoalMet: clamp('daysGoalMet', archive.counters.daysGoalMet),
    wordsLearned: clamp('wordsLearned', archive.counters.wordsLearned),
  };

  // The freeze count is clamped to THIS BUILD's cap. An archive that declares a bigger
  // one is describing a fork's rules, which this build does not run (EC-PER-22).
  const cappedFreezes = Math.min(clamp('freezes', archive.freezes), Math.max(0, device.freezeCap));
  if (cappedFreezes !== archive.freezes && !adjusted.includes('freezes')) adjusted.push('freezes');

  const streakAfterGap = confirm.streakWillBreak ? 0 : clamp('streak', archive.streak);

  const missedDays: string[] = [];
  for (let i = 1; i <= confirm.gapDays; i += 1) {
    missedDays.push(addCivilDays(toLocalDay(confirm.archiveLastDay), i));
  }

  return {
    streak: streakAfterGap,
    gems: clamp('gems', archive.gems),
    lifetimeXp: clamp('lifetimeXp', archive.lifetimeXp),
    freezes: Math.max(0, cappedFreezes - confirm.freezeCost),
    counters,
    // Recomputed from counters, never read from the archive's flags (EC-SEC-07).
    achievements: recomputeAchievements(counters, IMPORTED_ACHIEVEMENT_LADDER),
    maxLocalDaySeen: clampImportedMaxLocalDaySeen(device),
    provenance: 'imported',
    // Historical rows are facts stamped with the zone they were lived in (EC-PER-08).
    restampedDays: [],
    missedDays,
    unlivedDays: [],
    adjusted,
    noticeKey: adjusted.length > 0 ? 'data.import.adjusted' : null,
    unresolvedPackIds: [...confirm.unresolvablePackIds],
    writtenFields: [
      'streak',
      'gems',
      'lifetimeXp',
      'freezes',
      'counters',
      'achievements',
      'maxLocalDaySeen',
      'provenance',
    ],
    nextSessionGrantsGoalChest: true,
  };
}

/** The gate INV-DAT-09 names: an import must never touch an economy-config field. */
export function economyFieldsWritten(applied: AppliedImport): string[] {
  return applied.writtenFields.filter((field) => ECONOMY_CONFIG_FIELDS.includes(field));
}
