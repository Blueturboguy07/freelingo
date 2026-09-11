/**
 * Persistence rules that are pure enough to test without a device (INV-PER-06).
 *
 * The app shell (`apps/mobile/src/db/`) owns the I/O; every *decision* it makes — what a
 * pre-migration copy is called, which copies are stale, whether a resolved path is on a
 * persistent region — is made here so it can be property-tested in `packages/core`.
 *
 * Named config only: no path string, marker or retention count is written anywhere else.
 */

/** Platforms whose progress region survives an app restart (INV-PER-06). */
export type PersistencePlatform = 'ios' | 'android';

/**
 * The substring that proves a resolved progress-DB path is on the persistent region of
 * each platform. These are the exact markers `e2e/flows/p0-db-path.yaml` asserts on the
 * device, so the unit gate and the device gate can never check different things.
 *
 * - iOS: `<app sandbox>/Documents/` — `Paths.document`, backed up, never evicted.
 * - Android: `<app data dir>/files/` — `Paths.document`, i.e. `Context.getFilesDir()`.
 */
export const PERSISTENT_PATH_MARKER: Readonly<Record<PersistencePlatform, string>> = {
  ios: '/Documents/',
  android: '/files/',
} as const;

export function dbPathIsPersistent(platform: string, path: string): boolean {
  const marker = PERSISTENT_PATH_MARKER[platform as PersistencePlatform];
  if (marker === undefined) return false;
  return path.includes(marker);
}

/**
 * Pre-migration copies.
 *
 * Before the first migration of a run touches a byte, the progress DB is copied beside
 * itself as `freelingo-pre-v<N>-<ISO8601>.db`, where `N` is the user_version the schema
 * is about to move *to* (so `freelingo-pre-v2-...` is the last good v1 file).
 *
 * The timestamp is ISO 8601 **basic** format (`20260911T174233Z`), not extended: a colon
 * is legal in a POSIX filename but is rendered as `/` by the macOS file APIs and is a
 * reserved character on Android's FAT-formatted external volumes, so it never goes in a
 * name we create.
 */
export const PRE_MIGRATION_COPY_PREFIX = 'freelingo-pre-v';
export const PRE_MIGRATION_COPY_SUFFIX = '.db';

/** How many pre-migration copies survive a prune. Older ones are deleted. */
export const PRE_MIGRATION_COPIES_KEPT = 2;

export interface PreMigrationCopy {
  readonly name: string;
  /** The user_version the migration run was moving to. */
  readonly toUserVersion: number;
  /** ISO 8601 basic, UTC, e.g. `20260911T174233Z`. Sorts lexicographically. */
  readonly instant: string;
}

/** `new Date('2026-09-11T17:42:33.123Z')` -> `20260911T174233Z`. */
export function toFileSafeIso8601(at: Date): string {
  const iso = at.toISOString(); // always UTC, always extended format
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

export function preMigrationCopyName(toUserVersion: number, at: Date): string {
  if (!Number.isInteger(toUserVersion) || toUserVersion < 1) {
    throw new RangeError(
      `pre-migration copy needs a positive integer version, got ${toUserVersion}`,
    );
  }
  return `${PRE_MIGRATION_COPY_PREFIX}${toUserVersion}-${toFileSafeIso8601(at)}${PRE_MIGRATION_COPY_SUFFIX}`;
}

const COPY_NAME = /^freelingo-pre-v(\d+)-(\d{8}T\d{6}Z)\.db$/;

/** `null` for any name this module did not create — those are never candidates to delete. */
export function parsePreMigrationCopyName(name: string): PreMigrationCopy | null {
  const match = COPY_NAME.exec(name);
  if (match === null) return null;
  return { name, toUserVersion: Number(match[1]), instant: match[2] as string };
}

/**
 * The copies to delete: everything but the `keep` most recent. Newest first is by
 * instant, then by version, then by name, so the order is total and deterministic even
 * when two copies share a second.
 *
 * Names that are not pre-migration copies are ignored, never returned: this function's
 * output is fed straight to `delete()`, so it must never name a file it does not own.
 */
export function preMigrationCopiesToDelete(
  names: readonly string[],
  keep: number = PRE_MIGRATION_COPIES_KEPT,
): string[] {
  if (keep < 0) throw new RangeError(`keep must be >= 0, got ${keep}`);
  const copies = names
    .map(parsePreMigrationCopyName)
    .filter((copy): copy is PreMigrationCopy => copy !== null)
    .sort(
      (a, b) =>
        b.instant.localeCompare(a.instant) ||
        b.toUserVersion - a.toUserVersion ||
        b.name.localeCompare(a.name),
    );
  return copies.slice(keep).map((copy) => copy.name);
}
