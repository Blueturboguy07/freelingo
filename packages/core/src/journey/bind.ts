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

/** The first of `names` exported as a constructible class, or null. */
function ctor(
  namespace: Namespace,
  ...names: readonly string[]
): (new (...a: never[]) => unknown) | null {
  for (const name of names) {
    const value = namespace[name];
    if (
      typeof value === 'function' &&
      typeof (value as { prototype?: unknown }).prototype === 'object'
    ) {
      return value as new (...a: never[]) => unknown;
    }
  }
  return null;
}

/** The first of `names` exported as an array of strings, or null. */
function list(namespace: Namespace, ...names: readonly string[]): readonly string[] | null {
  for (const name of names) {
    const value = namespace[name];
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      return value as readonly string[];
    }
  }
  return null;
}

/** The first of `names` exported as a plain object, or null. */
function obj(namespace: Namespace, ...names: readonly string[]): Record<string, unknown> | null {
  for (const name of names) {
    const value = namespace[name];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
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

  const freezeNs = await load('../index.js', '../day/index.js', '../day/freeze.js');
  const freeze = required<FreezePort>(
    'freeze',
    {
      grant: fn(freezeNs, 'grantFreezes', 'grant'),
      held: fn(freezeNs, 'freezesHeld', 'held'),
    },
    missing,
  );

  const recoveryNs = await load('../index.js', '../day/index.js', '../day/recovery.js');
  const recovery = required<RecoveryPort>(
    'recovery',
    {
      offer: fn(recoveryNs, 'recoveryOffer', 'offer'),
      arm: fn(recoveryNs, 'armChallenge', 'arm'),
      recordLesson: fn(recoveryNs, 'recordChallengeLesson', 'recordLesson'),
      completeChallenge: fn(recoveryNs, 'completeChallenge'),
      repair: fn(recoveryNs, 'repairStreak', 'streakRepair', 'applyStreakRepair'),
    },
    missing,
  );

  const sessionNs = await load(
    '../index.js',
    '../session/index.js',
    '../session/generate.js',
    '../session/resume.js',
    '../session/session-fixture.js',
    '../session/test-doubles.js',
  );
  const doubleParts = {
    audio: ctor(sessionNs, 'FixedAudio'),
    pack: ctor(sessionNs, 'FixedPack'),
    modality: ctor(sessionNs, 'FixedModality'),
    scheduler: ctor(sessionNs, 'RecordingScheduler'),
  };
  for (const [name, value] of Object.entries(doubleParts)) {
    if (value === null) missing.push(`session.doubles.${name}`);
  }
  const session = required<SessionPort>(
    'session',
    {
      generate: fn(sessionNs, 'generateSession', 'generate'),
      items: fn(sessionNs, 'items'),
      checkpoint: fn(sessionNs, 'checkpoint', 'checkpointSession'),
      serialise: fn(sessionNs, 'serialiseSession', 'serialise'),
      deserialise: fn(sessionNs, 'deserialiseSession', 'deserialise'),
      freshSession: fn(sessionNs, 'freshSession'),
      doubles: Object.values(doubleParts).every((value) => value !== null) ? doubleParts : null,
    },
    missing,
  );

  const gradingNs = await load(
    '../index.js',
    '../grading/index.js',
    '../grading/grade.js',
    '../grading/packs/index.js',
  );
  const grading = required<GradingPort>(
    'grading',
    {
      grade: fn(gradingNs, 'gradeTypedAnswer', 'gradeAnswer', 'grade'),
      pack: obj(gradingNs, 'ES_PACK'),
      unit: obj(gradingNs, 'ES_UNIT'),
    },
    missing,
  );

  const schedulerNs = await load(
    '../index.js',
    '../scheduler/index.js',
    '../scheduler/engine.js',
    '../scheduler/fsrs.js',
  );
  const scheduler = required<SchedulerPort>(
    'scheduler',
    {
      emptyState: fn(schedulerNs, 'emptySchedulerState', 'emptyState'),
      registerRows: fn(schedulerNs, 'registerRows'),
      introduce: fn(schedulerNs, 'introduce'),
      applyEncounter: fn(schedulerNs, 'applyEncounter'),
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
    '../packs/items.js',
  );
  const packs = required<PacksPort>(
    'packs',
    {
      resolveState: fn(packsNs, 'resolvePackState', 'packState', 'stateOf'),
      applyPackUpdate: fn(packsNs, 'applyPackUpdate'),
    },
    missing,
  );

  const dataNs = await load(
    '../index.js',
    '../data/index.js',
    '../data/import.js',
    '../data/export.js',
  );
  const data = required<DataPort>(
    'data',
    {
      applyImport: fn(dataNs, 'applyImport'),
      economyConfigFields: list(dataNs, 'ECONOMY_CONFIG_FIELDS'),
    },
    missing,
  );

  return {
    engine: { day, freeze, recovery, session, grading, scheduler, economy, packs, data },
    missing: [...missing].sort(),
  };
}
