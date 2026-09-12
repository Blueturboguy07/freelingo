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
import { CHECKPOINT_STEP } from './integrity.js';
import { IMPORT_UNDO_WINDOW_HOURS, type ArchiveManifest } from './manifest.js';

/**
 * The steps of an import, in the only order they may run.
 *
 * `wal_checkpoint(TRUNCATE)` sits immediately before the backup because EC-PER-19 requires
 * it before **every** export, backup window and suspension — and the pre-import backup is
 * precisely the file EC-PER-20's one-tap undo restores. A backup taken without a
 * checkpoint is a backup missing whatever is still in the `-wal`: it opens cleanly, passes
 * `integrity_check`, and silently loses the last sessions the learner did before the
 * import they are now undoing. That is the exact failure EC-PER-19 describes, arriving
 * through the one path that is supposed to be the safety net.
 */
export const IMPORT_STEPS = [
  'parse-manifest',
  'verify-payload',
  'check-free-space',
  CHECKPOINT_STEP,
  'pre-import-backup',
  'swap',
] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

/** The pre-import backup itself, as a backup window: checkpoint, write, verify. */
export const IMPORT_BACKUP_STEPS = [CHECKPOINT_STEP, 'write-backup', 'verify-backup'] as const;
export type ImportBackupStep = (typeof IMPORT_BACKUP_STEPS)[number];

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
  /** Checkpoint first, always (EC-PER-19). Enumerated so the gate can walk it. */
  readonly steps: readonly ImportBackupStep[];
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

  steps.push(CHECKPOINT_STEP, 'pre-import-backup', 'swap');
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
      steps: [...IMPORT_BACKUP_STEPS],
    },
  };
}

/**
 * `max_local_day_seen` after an import (INV-DAT-05, EC-PER-15 + INV-DAT-10).
 *
 * **This is a spec-vs-invariant contradiction, resolved here and escalated.** EC-PER-15
 * says clamp to `max(device value, device today)`. INV-DAT-10 says the post-import value
 * is `<= today`. When the *device's own* value has run ahead — the phone whose clock read
 * 2027 is the importing phone, not just the exporting one — the two disagree, and only
 * one of them can hold. This returns **today**, satisfying INV-DAT-10, because the whole
 * point of EC-PER-15 is that the guard must not suppress day-keyed rewards, and keeping a
 * future device value is the same denial of service seen from the other side.
 *
 * That is an override of a catalogue row, so it is filed for the plan's rulings table
 * rather than settled in a comment; the report carries it as a blocker. EC-PER-15's
 * companion clause — *"apply the same rule to `broken_on` and the recovery window"* — is
 * **not addressed here and is not addressed in `day/` either**, and is filed with it.
 *
 * The archive value is nowhere in this expression. It survives only as
 * `maxLocalDaySeenDiagnostic` on the manifest and in the confirm.
 */
export function clampImportedMaxLocalDaySeen(device: ImportDevice): LocalDay {
  const kept = device.maxLocalDaySeen > device.today ? device.maxLocalDaySeen : device.today;
  return kept > device.today ? device.today : kept;
}

/**
 * The anti-tamper guard every day-keyed reward runs through (EC-PER-15).
 *
 * A reward keyed to `sessionDay` is suppressed when the device has already seen a *later*
 * civil day: the clock went backwards, and granting a second Monday chest is how a
 * hand-set clock farms them. Post-import `max_local_day_seen` is `today`, so the next
 * honest-clock session is never suppressed — which is the entire content of INV-DAT-05,
 * and the reason `clampImportedMaxLocalDaySeen` may not return the archive's value.
 */
export function dayKeyedRewardGranted(sessionDay: LocalDay, maxLocalDaySeen: LocalDay): boolean {
  return sessionDay >= maxLocalDaySeen;
}

// ---------------------------------------------------------------------------
// INV-DAT-04 — what happens to each civil date the import touches
// ---------------------------------------------------------------------------

/**
 * How one civil date arrives on the importing device.
 *
 * `unlived` is in this union **so that the property can fail**. The plan's EC-PER-08
 * ruling says imported gap days count as missed and never `unlived` — the learner existed,
 * this device did not — and an invariant asserted against a value the type cannot hold is
 * an invariant asserted against the compiler.
 */
export type ImportedDayClass = 'historical' | 'missed' | 'unlived' | 'outside';

/**
 * Classify one civil date against the archive's own history and the gap the import opens.
 *
 * **History wins.** A historical row is a fact stamped with the zone it was lived in; a
 * date that is both in the archive's history and inside the gap window keeps its stamp
 * rather than being re-stamped as a missed day (INV-DAT-04). Getting this order the other
 * way round is exactly the re-stamp bug, and it is what `restampedDays` detects.
 */
export function classifyImportedDay(
  day: string,
  historical: ReadonlySet<string>,
  gap: ReadonlySet<string>,
): ImportedDayClass {
  if (historical.has(day)) return 'historical';
  if (gap.has(day)) return 'missed';
  return 'outside';
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
  /**
   * Historical rows, in the archive's own order, exactly as they are stored. The identity
   * of this list with `archive.historicalDays` is what INV-DAT-04 asserts.
   */
  readonly historicalDaysStored: readonly string[];
  /** Historical rows whose class came back as something other than `historical`. */
  readonly restampedDays: readonly string[];
  /** Gap days classified `missed`. */
  readonly missedDays: readonly string[];
  /**
   * Gap days classified `unlived`. The plan's EC-PER-08 ruling says there are none — the
   * learner existed, this device did not — and `ImportedDayClass` carries the value so
   * that claim is asserted against a classifier rather than against the compiler.
   */
  readonly unlivedDays: readonly string[];
  /**
   * Gap days the archive had already stamped as lived. They keep their stamps, so they
   * are neither missed nor unlived; `missedDays.length + this.length === gapDays`.
   */
  readonly historicalDaysInGap: readonly string[];
  /** Field names that were clamped, for the one-line `adjusted` notice. */
  readonly adjusted: readonly string[];
  readonly noticeKey: string | null;
  /** Courses whose pack this build cannot resolve: retained, never dropped. */
  readonly unresolvedPackIds: readonly string[];
  /** The keys this import writes. Never intersects ECONOMY_CONFIG_FIELDS. */
  readonly writtenFields: readonly string[];
  /**
   * INV-DAT-05: does the next honest-clock session still open its goal chest? Computed
   * from the clamped value through `dayKeyedRewardGranted`, not asserted as a type.
   */
  readonly nextSessionGrantsGoalChest: boolean;
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

  // The gap the import opens, and the history the archive already stamped.
  const gapWindow: string[] = [];
  for (let i = 1; i <= confirm.gapDays; i += 1) {
    gapWindow.push(addCivilDays(toLocalDay(confirm.archiveLastDay), i));
  }
  const historicalSet = new Set(archive.historicalDays);
  const gapSet = new Set(gapWindow);
  const classOf = (day: string): ImportedDayClass =>
    classifyImportedDay(day, historicalSet, gapSet);

  const historicalDaysStored = archive.historicalDays.filter(
    (day) => classOf(day) === 'historical',
  );
  const restampedDays = archive.historicalDays.filter((day) => classOf(day) !== 'historical');
  const missedDays = gapWindow.filter((day) => classOf(day) === 'missed');
  const unlivedDays = gapWindow.filter((day) => classOf(day) === 'unlived');
  const historicalDaysInGap = gapWindow.filter((day) => classOf(day) === 'historical');

  const maxLocalDaySeen = clampImportedMaxLocalDaySeen(device);

  return {
    streak: streakAfterGap,
    gems: clamp('gems', archive.gems),
    lifetimeXp: clamp('lifetimeXp', archive.lifetimeXp),
    freezes: Math.max(0, cappedFreezes - confirm.freezeCost),
    counters,
    // Recomputed from counters, never read from the archive's flags (EC-SEC-07).
    achievements: recomputeAchievements(counters, IMPORTED_ACHIEVEMENT_LADDER),
    maxLocalDaySeen,
    provenance: 'imported',
    // Historical rows are facts stamped with the zone they were lived in (EC-PER-08).
    historicalDaysStored,
    restampedDays,
    missedDays,
    unlivedDays,
    historicalDaysInGap,
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
    // The next honest-clock session is `today` or later, and the clamp put
    // `max_local_day_seen` at `today`, so the guard does not fire.
    nextSessionGrantsGoalChest: dayKeyedRewardGranted(device.today, maxLocalDaySeen),
  };
}

/** The gate INV-DAT-09 names: an import must never touch an economy-config field. */
export function economyFieldsWritten(applied: AppliedImport): string[] {
  return applied.writtenFields.filter((field) => ECONOMY_CONFIG_FIELDS.includes(field));
}
