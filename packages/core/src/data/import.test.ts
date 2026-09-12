import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { addCivilDays, toLocalDay, type LocalDay } from '../day/civil.js';
import { sha256Hex } from '../packs/hashing.js';
import {
  ECONOMY_CONFIG_FIELDS,
  IMPORT_ENTRY_POINTS,
  IMPORT_BACKUP_STEPS,
  IMPORT_STEPS,
  applyImport,
  classifyImportedDay,
  clampImportedMaxLocalDaySeen,
  dayKeyedRewardGranted,
  decideImport,
  economyFieldsWritten,
  importIsReachableFromOnboarding,
  type ArchiveAccountState,
  type ImportDevice,
  type PayloadObservation,
} from './import.js';
import {
  IMPORT_UNDO_WINDOW_HOURS,
  buildArchiveManifest,
  parseArchiveManifest,
  serialiseArchiveManifest,
  type ArchiveManifest,
} from './manifest.js';
import { IMPORT_RANGES, recomputeAchievements, type ImportCounters } from './ranges.js';
import { CHECKPOINT_STEP } from './integrity.js';

/** INV-DAT-02, INV-DAT-04, INV-DAT-05, INV-DAT-09, INV-DAT-10. */

const PAYLOAD = Uint8Array.from({ length: 8_000 }, (_, i) => (i * 7) & 0xff);
const TODAY = toLocalDay('2026-09-11');

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

const OBSERVED: PayloadObservation = {
  sha256: sha256Hex(PAYLOAD),
  bytes: PAYLOAD.length,
  attemptRowCount: 900,
};

function deviceOf(overrides: Partial<ImportDevice> = {}): ImportDevice {
  return {
    schemaVersion: 3,
    manifestVersion: 1,
    appVersion: '0.1.0',
    today: TODAY,
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

const COUNTERS: ImportCounters = {
  sessionsCompleted: 120,
  lessonsCompleted: 260,
  perfectLessons: 31,
  daysGoalMet: 55,
  wordsLearned: 480,
};

function archiveOf(overrides: Partial<ArchiveAccountState> = {}): ArchiveAccountState {
  return {
    streak: 212,
    gems: 1_400,
    lifetimeXp: 41_000,
    freezes: 2,
    counters: COUNTERS,
    achievements: { wildfire: 99, sage: 99, scholar: 99, sharpshooter: 99, regular: 99 },
    historicalDays: ['2026-09-01', '2026-09-02'],
    ...overrides,
  };
}

describe('INV-DAT-02 import is replace-only, refuses a downgrade, backs up first', () => {
  it('[INV-DAT-02] the steps run in order: manifest, payload, free space, backup, swap', () => {
    const decision = decideImport(manifestOf(), OBSERVED, deviceOf());
    expect(decision.accepted).toBe(true);
    expect(decision.steps).toEqual([...IMPORT_STEPS]);
    // EC-PER-21: a short disk must fail BEFORE the backup, never halfway through it.
    expect(decision.steps.indexOf('check-free-space')).toBeLessThan(
      decision.steps.indexOf('pre-import-backup'),
    );
    expect(decision.steps.indexOf('pre-import-backup')).toBeLessThan(
      decision.steps.indexOf('swap'),
    );
  });

  it('[INV-DAT-02] the confirm shows both last_day values plus sessions-since-install', () => {
    const decision = decideImport(manifestOf(), OBSERVED, deviceOf());
    expect(decision.confirm).not.toBeNull();
    expect(decision.confirm!.archiveLastDay).toBe('2026-09-05');
    expect(decision.confirm!.deviceLastDay).toBe('2026-09-10');
    expect(decision.confirm!.archiveSessionsSinceInstall).toBe(41);
    expect(decision.confirm!.deviceSessionsSinceInstall).toBe(3);
    expect(decision.confirm!.replaceOnly).toBe(true);
  });

  it('[INV-DAT-02] the pre-import backup is persistent and kept 24 h behind one-tap undo', () => {
    const decision = decideImport(manifestOf(), OBSERVED, deviceOf());
    expect(decision.backup).toEqual({
      region: 'document',
      retainedHours: IMPORT_UNDO_WINDOW_HOURS,
      undo: 'one-tap',
      keep: 2,
      steps: [...IMPORT_BACKUP_STEPS],
    });
    expect(IMPORT_UNDO_WINDOW_HOURS).toBe(24);
    // EC-PER-19: the pre-import backup is the file EC-PER-20's one-tap undo restores, so
    // it may not be written with uncheckpointed pages still in the `-wal`.
    expect(decision.backup!.steps[0]).toBe(CHECKPOINT_STEP);
    expect(decision.steps.indexOf(CHECKPOINT_STEP)).toBe(
      decision.steps.indexOf('pre-import-backup') - 1,
    );
  });

  it('[INV-DAT-02] a newer schema is refused by name, and nothing is backed up or swapped', () => {
    const decision = decideImport(
      manifestOf({ schemaVersion: 9, producerId: 'forklingo', producerAppVersion: '2.0.0' }),
      OBSERVED,
      deviceOf(),
    );
    expect(decision.accepted).toBe(false);
    expect(decision.refusal).toBe('newer-schema');
    expect(decision.refusalDetail).toContain('v9');
    expect(decision.refusalDetail).toContain('forklingo');
    expect(decision.steps).toEqual(['parse-manifest']);
    expect(decision.backup).toBeNull();
  });

  it('[INV-DAT-02] an older archive is accepted, because replace-only is the whole model', () => {
    // EC-PER-10: merging two divergent streak histories has no correct answer.
    const decision = decideImport(manifestOf({ schemaVersion: 1 }), OBSERVED, deviceOf());
    expect(decision.accepted).toBe(true);
    expect(decision.confirm!.replaceOnly).toBe(true);
  });

  it('[INV-DAT-02] a short disk fails before the pre-import backup', () => {
    const decision = decideImport(manifestOf(), OBSERVED, deviceOf({ freeBytes: 1000 }));
    expect(decision.refusal).toBe('short-disk');
    expect(decision.steps).not.toContain('pre-import-backup');
    expect(decision.backup).toBeNull();
  });

  it('[INV-DAT-02] a truncated archive is refused before anything is touched', () => {
    const bad = decideImport(
      manifestOf(),
      { ...OBSERVED, sha256: sha256Hex('truncated') },
      deviceOf(),
    );
    expect(bad.refusal).toBe('payload-mismatch');
    expect(bad.steps).not.toContain('pre-import-backup');
  });

  it('[INV-DAT-02] import is reachable from onboarding S003, before the first lesson', () => {
    // EC-PER-06: otherwise a reinstalling learner does two lessons, then finds Import in
    // Settings, and destroys the new progress to recover the old.
    expect(importIsReachableFromOnboarding()).toBe(true);
    expect(IMPORT_ENTRY_POINTS).toContain('S003-onboarding-restore-prompt');
    expect(IMPORT_ENTRY_POINTS).toContain('S135-settings-data');
  });
});

describe('INV-DAT-04 historical rows are never re-stamped; gap days are missed', () => {
  it('[INV-DAT-04] imported gap days count as missed, never unlived, and the confirm states the freeze cost first', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 5 }),
        (gap, freezesOwned) => {
          const archiveLastDay = addCivilDays(TODAY, -(gap + 1));
          const manifest = manifestOf({ lastDay: archiveLastDay });
          const device = deviceOf({ freezesOwned, freezeCap: 5 });
          const decision = decideImport(manifest, OBSERVED, device);
          expect(decision.accepted).toBe(true);

          const confirm = decision.confirm!;
          expect(confirm.gapDays).toBe(gap);
          // The plan ruling on EC-PER-08: the learner existed, this device did not.
          expect(confirm.gapDayClassification).toBe('missed');
          // Stated BEFORE it is paid — freeze consumption is irreversible.
          expect(confirm.freezeCost).toBe(Math.min(freezesOwned, gap));
          expect(confirm.streakWillBreak).toBe(gap > freezesOwned);

          const applied = applyImport(archiveOf(), confirm, device);
          // Every gap day is accounted for, and none of them is `unlived`.
          expect(applied.missedDays.length + applied.historicalDaysInGap.length).toBe(gap);
          expect(applied.unlivedDays).toEqual([]);
          expect(applied.restampedDays).toEqual([]);
          expect(applied.freezes).toBe(
            Math.max(0, Math.min(archiveOf().freezes, device.freezeCap) - confirm.freezeCost),
          );
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-DAT-04] an export taken in Tokyo and imported 6 days later in LA keeps its historical days', () => {
    const manifest = manifestOf({ lastDay: '2026-09-05' });
    const device = deviceOf({ freezesOwned: 2, freezeCap: 5 });
    const decision = decideImport(manifest, OBSERVED, device);
    const applied = applyImport(archiveOf(), decision.confirm!, device);
    expect(decision.confirm!.gapDays).toBe(5);
    expect(decision.confirm!.freezeCost).toBe(2);
    expect(applied.missedDays).toEqual([
      '2026-09-06',
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
    ]);
    expect(applied.restampedDays).toEqual([]);
    // Three uncovered days: the streak breaks, and the confirm said so first.
    expect(decision.confirm!.streakWillBreak).toBe(true);
    expect(applied.streak).toBe(0);
  });

  /**
   * The falsifiable half. `restampedDays: []` on an archive whose history does not touch
   * the gap is true of any implementation, including one with no rule at all. So: give the
   * archive historical days that sit **inside** the gap window — a clock that ran ahead on
   * the producing device, or an archive taken mid-gap — and assert those rows keep their
   * own stamps. An implementation that classified the gap first would re-stamp them as
   * missed, and both assertions below would fail.
   */
  it('[INV-DAT-04] historical rows that fall inside the gap window keep their own stamps', () => {
    const archiveLastDay = '2026-09-04';
    const inGap = ['2026-09-06', '2026-09-08'];
    const archive = archiveOf({
      historicalDays: ['2026-09-01', '2026-09-02', ...inGap],
    });
    const device = deviceOf({ freezesOwned: 0, freezeCap: 5 });
    const decision = decideImport(manifestOf({ lastDay: archiveLastDay }), OBSERVED, device);
    const confirm = decision.confirm!;
    expect(confirm.gapDays).toBe(6); // 09-05 … 09-10

    const applied = applyImport(archive, confirm, device);

    // Nothing was re-stamped, and the stored history is identical to the archive's, in
    // the archive's own order.
    expect(applied.restampedDays).toEqual([]);
    expect(applied.historicalDaysStored).toEqual([...archive.historicalDays]);
    // The overlapping days are NOT in the missed list: they were lived, on that device.
    for (const day of inGap) expect(applied.missedDays).not.toContain(day);
    expect(applied.missedDays).toEqual(['2026-09-05', '2026-09-07', '2026-09-09', '2026-09-10']);
    expect(applied.historicalDaysInGap).toEqual(inGap);
    // And still nothing is `unlived`, which is the plan's EC-PER-08 ruling.
    expect(applied.unlivedDays).toEqual([]);
  });

  it('[INV-DAT-04] the classifier puts history before the gap, for any generated overlap', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: -20, max: 20 }), { maxLength: 12 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 20 }), { maxLength: 12 }),
        (historyOffsets, gapOffsets) => {
          const historical = new Set(historyOffsets.map((o) => addCivilDays(TODAY, o) as string));
          const gap = new Set(gapOffsets.map((o) => addCivilDays(TODAY, -o) as string));
          for (const day of historical) {
            // History wins, even where the two sets overlap. This is the re-stamp rule.
            expect(classifyImportedDay(day, historical, gap)).toBe('historical');
          }
          for (const day of gap) {
            const expected = historical.has(day) ? 'historical' : 'missed';
            expect(classifyImportedDay(day, historical, gap)).toBe(expected);
          }
          // A day in neither set is nothing at all — never silently `missed`.
          expect(classifyImportedDay('1999-01-01', historical, gap)).toBe('outside');
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('INV-DAT-05 a future max_local_day_seen never suppresses a day-keyed reward', () => {
  it('[INV-DAT-05] whatever the archive claims, the imported value is at most today', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -400, max: 400 }),
        fc.integer({ min: -30, max: 30 }),
        (archiveOffset, deviceOffset) => {
          const archiveDay = addCivilDays(TODAY, archiveOffset);
          const device = deviceOf({ maxLocalDaySeen: addCivilDays(TODAY, deviceOffset) });
          const manifest = manifestOf({ maxLocalDaySeenDiagnostic: archiveDay });
          const decision = decideImport(manifest, OBSERVED, device);
          const applied = applyImport(archiveOf(), decision.confirm!, device);

          // <= today, always. A value ahead of today freezes every day-keyed award until
          // the calendar catches up — a self-inflicted denial of service (EC-PER-15).
          expect(applied.maxLocalDaySeen <= TODAY).toBe(true);
          expect(applied.maxLocalDaySeen).toBe(clampImportedMaxLocalDaySeen(device));
          // The archive value survives only as a diagnostic in the confirm.
          expect(decision.confirm!.archiveMaxLocalDaySeen).toBe(archiveDay);
          expect(decision.confirm!.clampedMaxLocalDaySeen).toBe(applied.maxLocalDaySeen);
          // ...and the next honest-clock session still opens its chest.
          expect(applied.nextSessionGrantsGoalChest).toBe(true);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-DAT-05] a device that exported from a 2027 clock does not poison a correct one', () => {
    const device = deviceOf();
    const manifest = manifestOf({ maxLocalDaySeenDiagnostic: '2027-06-01' });
    const decision = decideImport(manifest, OBSERVED, device);
    const applied = applyImport(archiveOf(), decision.confirm!, device);
    expect(applied.maxLocalDaySeen).toBe(TODAY);
  });

  /**
   * The goal-chest clause, driven rather than asserted. `nextSessionGrantsGoalChest` used
   * to be the literal type `true`, so the assertion could not fail. It is now computed
   * through `dayKeyedRewardGranted`, and this runs the guard the way the next session
   * would: on today, and on each of the following seven honest-clock days.
   */
  it('[INV-DAT-05] the next honest-clock session, and the seven after it, still open their chests', () => {
    const device = deviceOf({ maxLocalDaySeen: addCivilDays(TODAY, 400) });
    const manifest = manifestOf({ maxLocalDaySeenDiagnostic: '2027-06-01' });
    const applied = applyImport(
      archiveOf(),
      decideImport(manifest, OBSERVED, device).confirm!,
      device,
    );

    expect(applied.nextSessionGrantsGoalChest).toBe(true);
    for (let ahead = 0; ahead <= 7; ahead += 1) {
      const sessionDay = addCivilDays(TODAY, ahead);
      expect(
        dayKeyedRewardGranted(sessionDay, applied.maxLocalDaySeen),
        `day ${sessionDay} was suppressed by an imported max_local_day_seen`,
      ).toBe(true);
    }
    // The guard itself is not a permanent yes: a clock that goes backwards still suppresses.
    expect(dayKeyedRewardGranted(addCivilDays(TODAY, -1), applied.maxLocalDaySeen)).toBe(false);
  });

  it('[INV-DAT-05] the guard would fire if the archive value were adopted, which is why it is not', () => {
    // The counterfactual, so the property above is known to have teeth: had the clamp kept
    // the archive's 2027 value, every session for the next nine months would be suppressed.
    const poisoned = toLocalDay('2027-06-01');
    expect(dayKeyedRewardGranted(TODAY, poisoned)).toBe(false);
  });
});

describe('INV-DAT-09 import writes no economy config and resolves no unknown pack', () => {
  it('[INV-DAT-09] the manifest is parsed without ever opening the dump', () => {
    // The decision takes a manifest and a digest observation. There is no code path from
    // here into the SQLite payload, so a hostile archive gets no chance to be interesting.
    const text = serialiseArchiveManifest(manifestOf({ schemaVersion: 99 }));
    const parsed = parseArchiveManifest(text);
    // Reading anything off the payload throws. A version refusal that touched it — to
    // size it, to hash it, to peek at a table — would fail here rather than pass quietly.
    const explodingPayload = new Proxy({} as PayloadObservation, {
      get(_target, property) {
        throw new Error(`the dump was read: ${String(property)}`);
      },
    });
    const decision = decideImport(parsed, explodingPayload, deviceOf());
    expect(decision.refusal).toBe('newer-schema');
    expect(decision.refusalDetail).toContain('v99');
    expect(decision.steps).toEqual(['parse-manifest']);
  });

  it('[INV-DAT-09] an archive whose config raises the freeze cap never raises this build s cap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5 }),
        (archiveFreezes, buildCap) => {
          const device = deviceOf({ freezeCap: buildCap, freezesOwned: 0 });
          const decision = decideImport(manifestOf({ lastDay: '2026-09-10' }), OBSERVED, device);
          const applied = applyImport(
            archiveOf({
              freezes: archiveFreezes,
              economy: { freezeCap: 99, freezePrice: 1, streakRepairsPerMonth: 50 },
            }),
            decision.confirm!,
            device,
          );
          expect(applied.freezes).toBeLessThanOrEqual(buildCap);
          expect(economyFieldsWritten(applied)).toEqual([]);
          for (const field of ECONOMY_CONFIG_FIELDS) {
            expect(applied.writtenFields).not.toContain(field);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-DAT-09] a pack id absent from this build is never resolved, and its course is kept', () => {
    const manifest = manifestOf({ packIds: ['es-ES@1.0.0', 'xx-XX@9.9.9'] });
    const device = deviceOf({ installedPackIds: ['es-ES@1.0.0'] });
    const decision = decideImport(manifest, OBSERVED, device);
    expect(decision.confirm!.unresolvablePackIds).toEqual(['xx-XX@9.9.9']);
    const applied = applyImport(archiveOf(), decision.confirm!, device);
    // EC-PER-09: never delete progress rows for an unresolvable pack.
    expect(applied.unresolvedPackIds).toEqual(['xx-XX@9.9.9']);
  });

  it('[INV-DAT-09] the parser refuses a manifest that is not one, without throwing', () => {
    for (const text of ['', '[]', 'null', '{"format":"other"}', '{"format":"freelingo-archive"}']) {
      expect(parseArchiveManifest(text)).toBeNull();
    }
    expect(decideImport(null, OBSERVED, deviceOf()).refusal).toBe('not-an-archive');
  });
});

describe('INV-DAT-10 any syntactically valid archive lands inside declared ranges', () => {
  const arbCounters: fc.Arbitrary<ImportCounters> = fc.record({
    sessionsCompleted: fc.integer({ min: -1000, max: 10_000_000 }),
    lessonsCompleted: fc.integer({ min: -1000, max: 10_000_000 }),
    perfectLessons: fc.integer({ min: -1000, max: 10_000_000 }),
    daysGoalMet: fc.integer({ min: -1000, max: 100_000 }),
    wordsLearned: fc.integer({ min: -1000, max: 10_000_000 }),
  });

  const arbArchive: fc.Arbitrary<ArchiveAccountState> = fc.record({
    streak: fc.integer({ min: -10, max: 99_999 }),
    gems: fc.integer({ min: -10, max: 1_000_000_000 }),
    lifetimeXp: fc.integer({ min: -10, max: 1_000_000_000 }),
    freezes: fc.integer({ min: -10, max: 9_999 }),
    counters: arbCounters,
    achievements: fc.dictionary(
      fc.constantFrom('wildfire', 'sage', 'scholar', 'sharpshooter', 'regular'),
      fc.integer({ min: 0, max: 99 }),
      { maxKeys: 5 },
    ),
    historicalDays: fc.constant<string[]>([]),
  });

  it('[INV-DAT-10] post-import state is within declared ranges, max_local_day_seen <= today, achievements are recomputed, and the next session still grants its goal chest', () => {
    fc.assert(
      fc.property(arbArchive, fc.integer({ min: -60, max: 60 }), (archive, maxDayOffset) => {
        const device = deviceOf({
          maxLocalDaySeen: addCivilDays(TODAY, maxDayOffset),
          freezesOwned: 1,
          freezeCap: 2,
        });
        const manifest = manifestOf({
          maxLocalDaySeenDiagnostic: addCivilDays(TODAY, 400),
          lastDay: '2026-09-09',
        });
        const decision = decideImport(manifest, OBSERVED, device);
        const applied = applyImport(archive, decision.confirm!, device);

        expect(applied.streak).toBeGreaterThanOrEqual(IMPORT_RANGES.streak.min);
        expect(applied.streak).toBeLessThanOrEqual(IMPORT_RANGES.streak.max);
        expect(applied.gems).toBeGreaterThanOrEqual(IMPORT_RANGES.gems.min);
        expect(applied.gems).toBeLessThanOrEqual(IMPORT_RANGES.gems.max);
        expect(applied.lifetimeXp).toBeLessThanOrEqual(IMPORT_RANGES.lifetimeXp.max);
        expect(applied.freezes).toBeGreaterThanOrEqual(0);
        expect(applied.freezes).toBeLessThanOrEqual(device.freezeCap);
        for (const [key, range] of Object.entries(IMPORT_RANGES)) {
          if (key in applied.counters) {
            const value = applied.counters[key as keyof ImportCounters];
            expect(value).toBeGreaterThanOrEqual(range.min);
            expect(value).toBeLessThanOrEqual(range.max);
          }
        }

        expect(applied.maxLocalDaySeen <= TODAY).toBe(true);

        // Recomputed from counters: the archive's claimed tiers are not an input.
        expect(applied.achievements).toEqual(recomputeAchievements(applied.counters));
        expect(applied.provenance).toBe('imported');
        expect(applied.nextSessionGrantsGoalChest).toBe(true);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-DAT-10] the hand-edited archive of EC-SEC-07 lands with an adjusted notice', () => {
    const device = deviceOf({ freezesOwned: 0, freezeCap: 2 });
    const decision = decideImport(manifestOf({ lastDay: '2026-09-10' }), OBSERVED, device);
    const applied = applyImport(
      archiveOf({
        streak: 99_999,
        gems: 1_000_000_000,
        freezes: 9_999,
        achievements: { wildfire: 7, sage: 6, scholar: 6, sharpshooter: 5, regular: 5 },
      }),
      decision.confirm!,
      device,
    );
    expect(applied.streak).toBe(IMPORT_RANGES.streak.max);
    expect(applied.gems).toBe(IMPORT_RANGES.gems.max);
    expect(applied.freezes).toBe(2);
    expect(applied.adjusted).toContain('streak');
    expect(applied.adjusted).toContain('gems');
    expect(applied.noticeKey).toBe('data.import.adjusted');
    // Tiers come from the counters, not from the file.
    expect(applied.achievements).toEqual(recomputeAchievements(COUNTERS));
  });

  it('[INV-DAT-10] achievements depend on the counters alone', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom('wildfire', 'sage'), fc.integer({ min: 0, max: 99 })),
        (claimed) => {
          const device = deviceOf();
          const decision = decideImport(manifestOf({ lastDay: '2026-09-10' }), OBSERVED, device);
          const applied = applyImport(
            archiveOf({ achievements: claimed }),
            decision.confirm!,
            device,
          );
          expect(applied.achievements).toEqual(recomputeAchievements(COUNTERS));
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-DAT-10] every declared range is a sane interval', () => {
    for (const [key, range] of Object.entries(IMPORT_RANGES)) {
      expect(range.min, key).toBeGreaterThanOrEqual(0);
      expect(range.max, key).toBeGreaterThan(range.min);
    }
  });
});

/** A guard for the helper the day tests share: LocalDay comparison is lexicographic. */
describe('day comparison used by the clamps', () => {
  it('LocalDay strings order the same way the dates do', () => {
    fc.assert(
      fc.property(fc.integer({ min: -500, max: 500 }), (offset) => {
        const day: LocalDay = addCivilDays(TODAY, offset);
        expect(day < TODAY).toBe(offset < 0);
        expect(day > TODAY).toBe(offset > 0);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
