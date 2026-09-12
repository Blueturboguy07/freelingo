/**
 * Bind the journey's ports to whatever the engine actually exports.
 *
 * The rule this file obeys: **never substitute**. If a capability cannot be found, the
 * port is `null` and the journey says which lane owes it. There is no fallback
 * implementation anywhere in this directory, because a driver that quietly computes a
 * streak itself when the day lane is missing would report a green 30-day journey about
 * nothing — which is the exact failure docs/P0-REPORT.md was written to avoid.
 *
 * Resolution is by *name over a set of candidate modules*: a lane may publish
 * `rolloverTo` from `day/rollover.ts`, from `day/index.ts` or from the package barrel,
 * and which of those it chose is that lane's business. The candidates below are ordered
 * cheapest-first (the barrel, then the module) and every failure to import is swallowed —
 * a module that does not exist yet is not an error here, it is a `null` port and a line
 * in the report.
 */
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  DataPort,
  DayPort,
  EconomyPort,
  Engine,
  FreezePort,
  GradingPort,
  PacksPort,
  RecoveryPort,
  SchedulerPort,
  SessionPort,
} from './ports.js';

type Namespace = Record<string, unknown>;

/** This directory, so candidates can be resolved to absolute paths at runtime. */
const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * Import every candidate that exists and merge what they export.
 *
 * By absolute `file:` URL, not by bare specifier: a dynamic `import(variable)` with a
 * relative path has no base a bundler can resolve it against, and a literal
 * `import('../day/recovery.js')` for a file that does not exist yet is a transform-time
 * error that takes the whole gate down with it. Measured under vitest 3.2.7: an absolute
 * file URL resolves through the module graph, and a missing one rejects the promise
 * instead of failing the file — which is what makes "not landed yet" a null port rather
 * than a crash.
 */
async function load(...specifiers: readonly string[]): Promise<Namespace> {
  const merged: Namespace = {};
  for (const specifier of specifiers) {
    try {
      const namespace = (await import(pathToFileURL(resolve(HERE, specifier)).href)) as Namespace;
      for (const [key, value] of Object.entries(namespace)) {
        if (!(key in merged)) merged[key] = value;
      }
    } catch {
      // Not there yet, or not there any more. Either way: not an error, a missing port.
    }
  }
  return merged;
}

/** The first of `names` that is exported as a function, or null. */
function fn(
  namespace: Namespace,
  ...names: readonly string[]
): ((...a: never[]) => unknown) | null {
  for (const name of names) {
    const value = namespace[name];
    if (typeof value === 'function') return value as (...a: never[]) => unknown;
  }
  return null;
}

/** The first of `names` exported as a number, or null. */
function num(namespace: Namespace, ...paths: readonly string[]): number | null {
  for (const path of paths) {
    const [head, key] = path.split('.');
    const root = namespace[head!];
    if (key === undefined) {
      if (typeof root === 'number') return root;
      continue;
    }
    if (typeof root === 'object' && root !== null) {
      const value = (root as Namespace)[key];
      if (typeof value === 'number') return value;
    }
  }
  return null;
}

/** Names a port needed and did not get, e.g. `day.rolloverTo`. */
export interface BindReport {
  readonly engine: Engine;
  /** `port.capability` strings, sorted. Empty when everything resolved. */
  readonly missing: readonly string[];
}

function required<T>(
  port: string,
  parts: Readonly<Record<string, unknown>>,
  missing: string[],
): T | null {
  const absent = Object.entries(parts).filter(([, value]) => value === null || value === undefined);
  for (const [name] of absent) missing.push(`${port}.${name}`);
  return absent.length === 0 ? (parts as T) : null;
}

/**
 * Resolve every port. Never throws: a tree with no engine at all binds to nine nulls and
 * a full `missing` list, which is what the journey reports.
 */
export async function bindEngine(): Promise<BindReport> {
  const missing: string[] = [];

  const dayNs = await load(
    '../index.js',
    '../day/index.js',
    '../day/civil.js',
    '../day/zone.js',
    '../day/state.js',
    '../day/rollover.js',
    '../day/session.js',
    '../day/dispositions.js',
    '../day/unlived.js',
  );
  const day = required<DayPort>(
    'day',
    {
      localDayOf: fn(dayNs, 'localDayOf'),
      addCivilDays: fn(dayNs, 'addCivilDays'),
      civilDaysBetween: fn(dayNs, 'civilDaysBetween'),
      resolveZone: fn(dayNs, 'resolveZone'),
      newState: fn(dayNs, 'newDayEngineState', 'newState'),
      rolloverTo: fn(dayNs, 'rolloverTo'),
      streakFromDispositions: fn(dayNs, 'streakFromDispositions'),
      commitSession: fn(dayNs, 'commitSession'),
      rolloverDeferral: fn(dayNs, 'rolloverDeferral'),
      unlivedDaysFromTransitions: fn(dayNs, 'unlivedDaysFromTransitions'),
    },
    missing,
  );

  const freezeNs = await load('../index.js', '../day/freeze.js');
  const freeze = required<FreezePort>(
    'freeze',
    {
      grant: fn(freezeNs, 'grantFreezes', 'grant'),
      held: fn(freezeNs, 'freezesHeld', 'held'),
    },
    missing,
  );

  const recoveryNs = await load(
    '../index.js',
    '../day/recovery.js',
    '../day/repair.js',
    '../day/rollover.js',
  );
  const recovery = required<RecoveryPort>(
    'recovery',
    {
      completeLesson: fn(recoveryNs, 'completeRecoveryLesson', 'recordRecoveryLesson'),
      repair: fn(recoveryNs, 'streakRepair', 'repairStreak', 'applyStreakRepair'),
    },
    missing,
  );

  const sessionNs = await load(
    '../index.js',
    '../session/index.js',
    '../session/generate.js',
    '../session/resume.js',
    '../session/machine.js',
  );
  const session = required<SessionPort>(
    'session',
    {
      generate: fn(sessionNs, 'generateSession', 'generateQueue', 'generate'),
      checkpoint: fn(sessionNs, 'checkpointSession', 'toSessionRow', 'checkpoint'),
      restore: fn(sessionNs, 'restoreSession', 'fromSessionRow', 'restore'),
    },
    missing,
  );

  const gradingNs = await load('../index.js', '../grading/index.js', '../grading/grade.js');
  const grading = required<GradingPort>(
    'grading',
    { grade: fn(gradingNs, 'gradeAnswer', 'grade') },
    missing,
  );

  const schedulerNs = await load(
    '../index.js',
    '../scheduler/index.js',
    '../scheduler/fsrs.js',
    '../scheduler/quarantine.js',
  );
  const scheduler = required<SchedulerPort>(
    'scheduler',
    {
      review: fn(schedulerNs, 'reviewItem', 'applyReview', 'review'),
      quarantine: fn(schedulerNs, 'quarantineRows', 'quarantine'),
    },
    missing,
  );

  const economyNs = await load(
    '../index.js',
    '../economy/index.js',
    '../economy/config.js',
    '../economy/xp.js',
    '../economy/boost.js',
  );
  const economy = required<EconomyPort>(
    'economy',
    {
      goalXp: fn(economyNs, 'goalXpFor', 'goalXp', 'dailyGoalXp'),
      awardForSession: fn(economyNs, 'awardForSession', 'sessionAward'),
      boostGraceSeconds: num(
        economyNs,
        'BOOST_GRACE_SECONDS',
        'ECONOMY.boostGraceSeconds',
        'ECONOMY_CONFIG.boostGraceSeconds',
      ),
    },
    missing,
  );

  const packsNs = await load(
    '../index.js',
    '../packs/index.js',
    '../packs/state.js',
    '../packs/install.js',
  );
  const packs = required<PacksPort>(
    'packs',
    {
      stateOf: fn(packsNs, 'packState', 'stateOf', 'resolvePackState'),
      isMajorBump: fn(packsNs, 'isMajorBump', 'isMajorVersionBump'),
    },
    missing,
  );

  const dataNs = await load(
    '../index.js',
    '../data/index.js',
    '../data/export.js',
    '../packs/export.js',
  );
  const data = required<DataPort>(
    'data',
    {
      exportProgress: fn(dataNs, 'exportProgress', 'buildExport'),
      importProgress: fn(dataNs, 'importProgress', 'applyImport'),
    },
    missing,
  );

  return {
    engine: { day, freeze, recovery, session, grading, scheduler, economy, packs, data },
    missing: [...missing].sort(),
  };
}
