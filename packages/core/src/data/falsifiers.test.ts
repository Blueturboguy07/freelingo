import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addCivilDays, toLocalDay, type LocalDay } from '../day/civil.js';
import { sha256Hex } from '../packs/hashing.js';
import {
  COMMIT_WRITE_ORDER,
  commitSession,
  type CommitWriteFailure,
  type CommitWriteGroup,
  type StoredCommitInput,
} from './commit.js';
import { checkDiskAtSessionStart } from './disk.js';
import { completeExport, planExport } from './export.js';
import {
  assessRestore,
  classifySqliteError,
  guardRolloverForIntegrity,
  integrityCheckRowsVerdict,
  observeOpenFailure,
  observeOpenSuccess,
  planCorruptionRecovery,
  planMigrationLaunch,
  rolloverAllowed,
  rolloverWasRefused,
  type IntegrityVerdict,
  type RestoreObservation,
  type RestoreVerdict,
  type SqliteFailureClass,
} from './integrity.js';
import {
  applyImport,
  decideImport,
  economyFieldsWritten,
  type ArchiveAccountState,
  type ImportDevice,
  type ImportRefusal,
  type PayloadObservation,
} from './import.js';
import { buildArchiveManifest, type ArchiveManifest } from './manifest.js';
import { recomputeAchievements, type ImportCounters } from './ranges.js';

/**
 * `pnpm test:falsify` — the committed falsifier input for every invariant `data/` owns.
 * Each case is an edge case from `00-EDGE-CASES.md` with the answer the spec gives.
 */
const FALSIFIERS = fileURLToPath(new URL('./__falsifiers__/', import.meta.url));

function load<T>(id: string): T {
  return JSON.parse(readFileSync(`${FALSIFIERS}${id}.json`, 'utf8')) as T;
}

const PAYLOAD = Uint8Array.from({ length: 8_000 }, (_, i) => (i * 7) & 0xff);
const OBSERVED: PayloadObservation = {
  sha256: sha256Hex(PAYLOAD),
  bytes: PAYLOAD.length,
  attemptRowCount: 900,
};

function manifestOf(overrides: Partial<ArchiveManifest> = {}): ArchiveManifest {
  return {
    ...buildArchiveManifest({
      producerId: 'freelingo',
      producerAppVersion: '0.1.0',
      schemaVersion: 3,
      createdAt: '2026-09-05T09:00:00.000Z',
      lastDay: '2026-09-05',
      sessionsSinceInstall: 41,
      packIds: ['es-ES@1.0.0'],
      payloadBytes: PAYLOAD,
      attemptRowCount: 900,
      checkpointed: true,
      maxLocalDaySeen: '2026-09-05',
    }),
    ...overrides,
  };
}

const COUNTERS: ImportCounters = {
  sessionsCompleted: 120,
  lessonsCompleted: 260,
  perfectLessons: 31,
  daysGoalMet: 55,
  wordsLearned: 480,
};

function deviceOf(overrides: Partial<ImportDevice> = {}): ImportDevice {
  return {
    schemaVersion: 3,
    manifestVersion: 1,
    appVersion: '0.1.0',
    today: toLocalDay('2026-09-11'),
    lastDay: toLocalDay('2026-09-10'),
    maxLocalDaySeen: toLocalDay('2026-09-10'),
    sessionsSinceInstall: 3,
    freezesOwned: 2,
    installedPackIds: ['es-ES@1.0.0'],
    freezeCap: 2,
    freeBytes: 500 * 1024 * 1024,
    ...overrides,
  };
}

function archiveOf(overrides: Partial<ArchiveAccountState> = {}): ArchiveAccountState {
  return {
    streak: 212,
    gems: 1_400,
    lifetimeXp: 41_000,
    freezes: 2,
    counters: COUNTERS,
    achievements: {},
    historicalDays: [],
    ...overrides,
  };
}

describe('persistence falsifiers', () => {
  it('[INV-PER-01] falsifier: every committed error shape classifies correctly, renames, and never deletes', () => {
    interface ErrorCase {
      why: string;
      error: Record<string, unknown>;
      classification: SqliteFailureClass | null;
      verdict: IntegrityVerdict;
      action: string;
      deletes: string[];
      screen: string;
    }
    interface RowCase {
      why: string;
      rows: { integrity_check: string }[];
      integrityCheck: 'ok' | 'failed';
      verdict: IntegrityVerdict;
      screen: string;
    }
    const file = load<{ cases: ErrorCase[]; returnedRowCases: RowCase[] }>('INV-PER-01');
    expect(file.cases.length).toBeGreaterThanOrEqual(5);
    for (const testCase of file.cases) {
      // The shape goes in unedited, exactly as the driver threw it.
      expect(classifySqliteError(testCase.error), testCase.why).toBe(testCase.classification);
      const plan = planCorruptionRecovery(
        observeOpenFailure(testCase.error),
        new Date('2026-09-11T17:42:33Z'),
      );
      expect(plan.verdict, testCase.why).toBe(testCase.verdict);
      expect(plan.action, testCase.why).toBe(testCase.action);
      expect(plan.deletes, testCase.why).toEqual(testCase.deletes);
      expect(plan.screen, testCase.why).toBe(testCase.screen);
    }
    // The other channel: the pragma answered rather than threw.
    expect(file.returnedRowCases.length).toBeGreaterThanOrEqual(3);
    for (const testCase of file.returnedRowCases) {
      expect(integrityCheckRowsVerdict(testCase.rows), testCase.why).toBe(testCase.integrityCheck);
      const plan = planCorruptionRecovery(
        observeOpenSuccess(testCase.rows),
        new Date('2026-09-11T17:42:33Z'),
      );
      expect(plan.verdict, testCase.why).toBe(testCase.verdict);
      expect(plan.screen, testCase.why).toBe(testCase.screen);
      expect(plan.deletes, testCase.why).toEqual([]);
    }
  });

  it('[INV-PER-02] falsifier: a failed-integrity rollover never enters the walk at all', () => {
    interface Case {
      why: string;
      integrity: IntegrityVerdict;
      precondition: 'ok' | 'failed-integrity';
      walkCalls: number;
      refused: boolean;
      freezesConsumed: number | null;
      screen: string | null;
    }
    const file = load<{ cases: Case[] }>('INV-PER-02');
    for (const testCase of file.cases) {
      expect(rolloverAllowed(testCase.integrity), testCase.why).toBe(testCase.precondition);

      let calls = 0;
      // A walk that would burn every freeze and break the streak, so a guard that merely
      // zeroed the result rather than refusing would still be caught.
      const walk = (): { freezesConsumed: number; streakAfter: number } => {
        calls += 1;
        return { freezesConsumed: 2, streakAfter: 0 };
      };
      const outcome = guardRolloverForIntegrity(walk)(testCase.integrity);

      expect(calls, testCase.why).toBe(testCase.walkCalls);
      expect(rolloverWasRefused(outcome), testCase.why).toBe(testCase.refused);
      if (testCase.refused) {
        expect((outcome as { freezesConsumed: number }).freezesConsumed, testCase.why).toBe(
          testCase.freezesConsumed,
        );
        expect((outcome as { screen: string }).screen, testCase.why).toBe(testCase.screen);
      }
    }
  });

  it('[INV-PER-04] falsifier: the ceremony shows nothing the commit did not write, and disk-full is retried exactly once', () => {
    interface Case {
      why: string;
      failAt: CommitWriteGroup | null;
      failure: CommitWriteFailure;
      failsTimes: number | null;
      checkpointFreesBytes: number | null;
      written: CommitWriteGroup[];
      checkpoints: number;
      retried: boolean;
      ceremonySuppressed: boolean;
      ceremonyRewards: number;
      shortfallBytes: number;
      noticeKey: string | null;
      offers: string[];
    }
    const file = load<{ order: CommitWriteGroup[]; cases: Case[] }>('INV-PER-04');
    expect([...COMMIT_WRITE_ORDER]).toEqual(file.order);
    const input = {
      sessionId: 's1',
      attempts: [{ exerciseIndex: 0, correct: true }],
      mistakes: [],
      rewards: [
        { kind: 'xp' as const, id: 'lesson', amount: 15 },
        { kind: 'chest' as const, id: 'goal', amount: 1 },
      ],
    };
    for (const testCase of file.cases) {
      let failuresLeft = testCase.failsTimes ?? Number.POSITIVE_INFINITY;
      let checkpoints = 0;
      const result = commitSession(input, {
        write: (group: CommitWriteGroup, _stored: StoredCommitInput) => {
          if (group === testCase.failAt && failuresLeft > 0) {
            failuresLeft -= 1;
            return testCase.failure;
          }
          return null;
        },
        checkpointAndShed: () => {
          checkpoints += 1;
          return testCase.checkpointFreesBytes;
        },
      });
      expect(result.written, testCase.why).toEqual(testCase.written);
      expect(checkpoints, testCase.why).toBe(testCase.checkpoints);
      expect(result.retried, testCase.why).toBe(testCase.retried);
      expect(result.ceremonySuppressed, testCase.why).toBe(testCase.ceremonySuppressed);
      expect(result.ceremonyRewards, testCase.why).toHaveLength(testCase.ceremonyRewards);
      expect(result.shortfallBytes, testCase.why).toBe(testCase.shortfallBytes);
      expect(result.noticeKey, testCase.why).toBe(testCase.noticeKey);
      expect([...result.offers], testCase.why).toEqual(testCase.offers);
    }
  });

  it('[INV-PER-05] falsifier: every committed free-space reading downgrades the guarantee visibly', () => {
    interface Case {
      why: string;
      freeBytes: number;
      belowThreshold: boolean;
      resumeGuarantee: string;
      noticeShown: boolean;
    }
    const file = load<{ cases: Case[] }>('INV-PER-05');
    for (const testCase of file.cases) {
      const check = checkDiskAtSessionStart({ availableDiskSpace: () => testCase.freeBytes });
      expect(check.belowThreshold, testCase.why).toBe(testCase.belowThreshold);
      expect(check.resumeGuarantee, testCase.why).toBe(testCase.resumeGuarantee);
      expect(check.noticeShown, testCase.why).toBe(testCase.noticeShown);
    }
  });

  it('[INV-PER-08] falsifier: no DDL runs without a verified backup, and the blocking screen still exports', () => {
    interface Case {
      why: string;
      pendingMigrations: number;
      dbBytes: number;
      freeBytes: number;
      backupVerified: boolean;
      currentUserVersion: number;
      targetUserVersion: number;
      ddlAllowed: boolean;
      userVersionAfter: number;
      openReadOnly: boolean;
      screen: string;
      screenState: string | null;
      offers: string[];
    }
    const file = load<{ cases: Case[] }>('INV-PER-08');
    for (const testCase of file.cases) {
      const plan = planMigrationLaunch(testCase);
      expect(plan.ddlAllowed, testCase.why).toBe(testCase.ddlAllowed);
      expect(plan.userVersionAfter, testCase.why).toBe(testCase.userVersionAfter);
      expect(plan.openReadOnly, testCase.why).toBe(testCase.openReadOnly);
      // S150, the low-disk notice - not the invented `S149-blocking-free-space`.
      expect(plan.screen, testCase.why).toBe(testCase.screen);
      expect(plan.screenState, testCase.why).toBe(testCase.screenState);
      expect([...plan.offers], testCase.why).toEqual(testCase.offers);
    }
  });

  it('[INV-DAT-07] falsifier: a restore missing its -wal is incomplete, not healthy', () => {
    interface Case {
      why: string;
      observation: Omit<RestoreObservation, 'maxLocalDaySeen' | 'newestSessionDay'> & {
        maxLocalDaySeen: string;
        newestSessionDay: string;
      };
      verdict: RestoreVerdict;
    }
    const file = load<{ cases: Case[] }>('INV-DAT-07');
    for (const testCase of file.cases) {
      const verdict = assessRestore({
        ...testCase.observation,
        maxLocalDaySeen: toLocalDay(testCase.observation.maxLocalDaySeen),
        newestSessionDay: toLocalDay(testCase.observation.newestSessionDay),
      });
      expect(verdict, testCase.why).toBe(testCase.verdict);
    }
  });
});

describe('export and import falsifiers', () => {
  it('[INV-DAT-01] falsifier: only a verified-complete write reaches the share sheet', () => {
    interface Case {
      why: string;
      estimatedBytes: number;
      freeBytes: number;
      checkpointed: boolean;
      bytesWritten: number;
      digestMatches: boolean;
      shareSheet: boolean;
      artefacts: number;
      refusal: string | null;
    }
    const file = load<{ cases: Case[] }>('INV-DAT-01');
    for (const testCase of file.cases) {
      const payload = Uint8Array.from(
        { length: testCase.estimatedBytes % 30_000 },
        (_, i) => i & 0xff,
      );
      const manifest = buildArchiveManifest({
        producerId: 'freelingo',
        producerAppVersion: '0.1.0',
        schemaVersion: 3,
        createdAt: '2026-09-11T00:00:00.000Z',
        lastDay: '2026-09-11',
        sessionsSinceInstall: 1,
        packIds: [],
        payloadBytes: payload,
        attemptRowCount: 1,
        checkpointed: true,
        maxLocalDaySeen: '2026-09-11',
      });
      const plan = planExport({
        finalPath: '/docs/x.freelingo',
        estimatedBytes: testCase.estimatedBytes,
        freeBytes: testCase.freeBytes,
      });
      const outcome = completeExport({
        plan,
        checkpointed: testCase.checkpointed,
        bytesWritten:
          testCase.bytesWritten === testCase.estimatedBytes
            ? payload.length
            : testCase.bytesWritten,
        writtenSha256: testCase.digestMatches ? manifest.payload.sha256 : sha256Hex('other'),
        manifest,
      });
      expect(outcome.shareSheet, testCase.why).toBe(testCase.shareSheet);
      expect(outcome.artefacts, testCase.why).toHaveLength(testCase.artefacts);
      expect(outcome.refusal, testCase.why).toBe(testCase.refusal);
    }
  });

  it('[INV-DAT-02] falsifier: every committed version pair is accepted or refused by name', () => {
    interface Case {
      why: string;
      manifest: {
        schemaVersion: number;
        manifestVersion: number;
        lastDay: string;
        sessionsSinceInstall: number;
      };
      device: {
        schemaVersion: number;
        manifestVersion: number;
        lastDay: string;
        sessionsSinceInstall: number;
      };
      accepted: boolean;
      refusal: ImportRefusal | null;
      backupRetainedHours: number | null;
    }
    const file = load<{ cases: Case[] }>('INV-DAT-02');
    for (const testCase of file.cases) {
      const decision = decideImport(
        manifestOf(testCase.manifest),
        OBSERVED,
        deviceOf({
          schemaVersion: testCase.device.schemaVersion,
          manifestVersion: testCase.device.manifestVersion,
          lastDay: toLocalDay(testCase.device.lastDay),
          sessionsSinceInstall: testCase.device.sessionsSinceInstall,
        }),
      );
      expect(decision.accepted, testCase.why).toBe(testCase.accepted);
      expect(decision.refusal, testCase.why).toBe(testCase.refusal);
      expect(decision.backup?.retainedHours ?? null, testCase.why).toBe(
        testCase.backupRetainedHours,
      );
      if (decision.accepted) {
        expect(decision.confirm!.archiveLastDay, testCase.why).toBe(testCase.manifest.lastDay);
        expect(decision.confirm!.deviceLastDay, testCase.why).toBe(testCase.device.lastDay);
      }
    }
  });

  it('[INV-DAT-04] falsifier: imported gap days are missed, never unlived, and the cost is stated first', () => {
    interface Case {
      why: string;
      archiveLastDay: string;
      today: string;
      freezesOwned: number;
      gapDays: number;
      freezeCost: number;
      streakWillBreak: boolean;
      missedDays: string[];
      unlivedDays: string[];
      restampedDays: string[];
    }
    const file = load<{ cases: Case[] }>('INV-DAT-04');
    for (const testCase of file.cases) {
      const device = deviceOf({
        today: toLocalDay(testCase.today),
        freezesOwned: testCase.freezesOwned,
        freezeCap: 5,
      });
      const decision = decideImport(
        manifestOf({ lastDay: testCase.archiveLastDay }),
        OBSERVED,
        device,
      );
      const confirm = decision.confirm!;
      expect(confirm.gapDays, testCase.why).toBe(testCase.gapDays);
      expect(confirm.gapDayClassification, testCase.why).toBe('missed');
      expect(confirm.freezeCost, testCase.why).toBe(testCase.freezeCost);
      expect(confirm.streakWillBreak, testCase.why).toBe(testCase.streakWillBreak);

      const applied = applyImport(archiveOf(), confirm, device);
      expect(applied.missedDays, testCase.why).toEqual(testCase.missedDays);
      expect(applied.unlivedDays, testCase.why).toEqual(testCase.unlivedDays);
      expect(applied.restampedDays, testCase.why).toEqual(testCase.restampedDays);
    }
  });

  it('[INV-DAT-05] falsifier: an imported max_local_day_seen never reaches past today', () => {
    interface Case {
      why: string;
      archiveMaxLocalDaySeen: string;
      deviceMaxLocalDaySeen: string;
      today: string;
      clamped: string;
      nextSessionGrantsGoalChest: boolean;
    }
    const file = load<{ cases: Case[] }>('INV-DAT-05');
    for (const testCase of file.cases) {
      const today: LocalDay = toLocalDay(testCase.today);
      const device = deviceOf({
        today,
        lastDay: addCivilDays(today, -1),
        maxLocalDaySeen: toLocalDay(testCase.deviceMaxLocalDaySeen),
      });
      const decision = decideImport(
        manifestOf({
          lastDay: addCivilDays(today, -1),
          maxLocalDaySeenDiagnostic: testCase.archiveMaxLocalDaySeen,
        }),
        OBSERVED,
        device,
      );
      const applied = applyImport(archiveOf(), decision.confirm!, device);
      expect(applied.maxLocalDaySeen, testCase.why).toBe(testCase.clamped);
      expect(applied.nextSessionGrantsGoalChest, testCase.why).toBe(
        testCase.nextSessionGrantsGoalChest,
      );
      expect(decision.confirm!.archiveMaxLocalDaySeen, testCase.why).toBe(
        testCase.archiveMaxLocalDaySeen,
      );
    }
  });

  it('[INV-DAT-09] falsifier: a fork archive never raises this build s freeze cap or resolves its packs', () => {
    interface Case {
      why: string;
      archiveFreezes: number;
      archiveEconomy: Record<string, number>;
      buildFreezeCap: number;
      freezesAfter: number;
      economyFieldsWritten: string[];
    }
    const file = load<{
      cases: Case[];
      unresolvablePackCase: {
        why: string;
        archivePackIds: string[];
        installedPackIds: string[];
        unresolvable: string[];
      };
    }>('INV-DAT-09');

    for (const testCase of file.cases) {
      const device = deviceOf({ freezeCap: testCase.buildFreezeCap, freezesOwned: 0 });
      const decision = decideImport(manifestOf({ lastDay: '2026-09-10' }), OBSERVED, device);
      const applied = applyImport(
        archiveOf({ freezes: testCase.archiveFreezes, economy: testCase.archiveEconomy }),
        decision.confirm!,
        device,
      );
      expect(applied.freezes, testCase.why).toBe(testCase.freezesAfter);
      expect(economyFieldsWritten(applied), testCase.why).toEqual(testCase.economyFieldsWritten);
    }

    const packCase = file.unresolvablePackCase;
    const decision = decideImport(
      manifestOf({ lastDay: '2026-09-10', packIds: packCase.archivePackIds }),
      OBSERVED,
      deviceOf({ installedPackIds: packCase.installedPackIds }),
    );
    expect([...decision.confirm!.unresolvablePackIds], packCase.why).toEqual(packCase.unresolvable);
  });

  it('[INV-DAT-10] falsifier: the hand-edited archive lands inside every declared range', () => {
    interface Case {
      why: string;
      archive: {
        streak: number;
        gems: number;
        lifetimeXp: number;
        freezes: number;
        claimedAchievements: Record<string, number>;
      };
      buildFreezeCap: number;
      streak: number;
      gems: number;
      lifetimeXp: number;
      freezes: number;
      adjustedIncludes: string[];
      achievementsFromCounters: boolean;
      provenance: string;
      nextSessionGrantsGoalChest: boolean;
    }
    const file = load<{ cases: Case[] }>('INV-DAT-10');
    for (const testCase of file.cases) {
      const device = deviceOf({ freezeCap: testCase.buildFreezeCap, freezesOwned: 0 });
      const decision = decideImport(manifestOf({ lastDay: '2026-09-10' }), OBSERVED, device);
      const applied = applyImport(
        archiveOf({
          streak: testCase.archive.streak,
          gems: testCase.archive.gems,
          lifetimeXp: testCase.archive.lifetimeXp,
          freezes: testCase.archive.freezes,
          achievements: testCase.archive.claimedAchievements,
        }),
        decision.confirm!,
        device,
      );
      expect(applied.streak, testCase.why).toBe(testCase.streak);
      expect(applied.gems, testCase.why).toBe(testCase.gems);
      expect(applied.lifetimeXp, testCase.why).toBe(testCase.lifetimeXp);
      expect(applied.freezes, testCase.why).toBe(testCase.freezes);
      for (const field of testCase.adjustedIncludes) {
        expect(applied.adjusted, `${testCase.why} [${field}]`).toContain(field);
      }
      if (testCase.achievementsFromCounters) {
        expect(applied.achievements, testCase.why).toEqual(recomputeAchievements(COUNTERS));
      }
      expect(applied.provenance, testCase.why).toBe(testCase.provenance);
      expect(applied.nextSessionGrantsGoalChest, testCase.why).toBe(
        testCase.nextSessionGrantsGoalChest,
      );
    }
  });
});
