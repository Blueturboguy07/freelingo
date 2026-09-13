import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { openDatabaseSync, type SQLiteBindParams } from 'expo-sqlite';
import type { Db } from '@freelingo/core';
import { PackFormatError } from '@freelingo/core/packs';
import {
  digestPackStream,
  PACK_DB_DIRNAME,
  PACK_SIGNING_PUBLIC_KEY_PEM,
  parseEd25519PublicKeyPem,
} from '@freelingo/schema';
import type { RuntimeItemReader } from '../../../../packages/core/src/packs/runtime-item-types';
import {
  createInstalledPackRepository,
  type InstalledPackStorage,
  type PackFileDigest,
} from './InstalledPackRepository';
/** Implementation limits, 2026-09-13; no full dictionary/payload buffer on the JS heap. */
export const PACK_READ_CONFIG = {
  chunkBytes: 262144,
  yieldEveryChunks: 4,
  maximumManifestBytes: 16 * 1024 * 1024,
} as const;
export const PACK_FILES = { manifest: 'manifest.json', payload: 'pack.sqlite' } as const;
function coursePath(root: string, courseId: string): string {
  if (!/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)+$/.test(courseId))
    throw new PackFormatError('Invalid pack course identity');
  return root.replace(/\/+$/, '') + '/' + courseId;
}
function assetPath(courseRoot: string, path: string): string {
  const prefix = courseRoot + '/';
  const relative = path.slice(prefix.length);
  if (
    !path.startsWith(prefix) ||
    !relative ||
    /[\\%?#:]/.test(relative) ||
    [...relative].some((char) => char.charCodeAt(0) < 32) ||
    relative.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new PackFormatError('Invalid pack asset path');
  return path;
}
/** Expo57 opens SQLite read/write, so query_only is paired with a narrow SQL
 * facade. No connection-setting pragma, CTE writer, comments or statement tail is
 * accepted. All loader/runtime queries are SELECTs with bound content parameters. */
function requireReadQuery(sql: string): void {
  const query = sql.trim();
  const forbidden = /;|--|\/\*|\b(?:load_extension|writefile|eval)\s*\(/i;
  const select = /^SELECT\s/i.test(query);
  const pragma =
    /^PRAGMA\s+(?:(?:integrity_check|foreign_key_check|user_version|query_only)|table_info\((?:[A-Za-z_][A-Za-z0-9_]*|"[A-Za-z_][A-Za-z0-9_]*"|'[A-Za-z_][A-Za-z0-9_]*')\))$/i.test(
      query,
    );
  if (forbidden.test(query) || (!select && !pragma))
    throw new PackFormatError('Pack reader requires a single read query');
}
async function fileDigest(file: File): Promise<PackFileDigest | null> {
  if (!file.exists) return null;
  const handle = file.open(FileMode.ReadOnly);
  try {
    const size = handle.size;
    if (size === null || !Number.isSafeInteger(size) || size < 0)
      throw new PackFormatError('Invalid pack file size');
    const chunks = async function* () {
      let read = 0;
      let count = 0;
      while (read < size) {
        const chunk = handle.readBytes(Math.min(PACK_READ_CONFIG.chunkBytes, size - read));
        if (chunk.length === 0) throw new PackFormatError('Pack file was truncated');
        read += chunk.length;
        yield chunk;
        count++;
        if (count % PACK_READ_CONFIG.yieldEveryChunks === 0)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (handle.size !== size)
        throw new PackFormatError('Pack file size changed during verification');
    };
    return await digestPackStream(chunks());
  } finally {
    handle.close();
  }
}
/** Read existing cache packs only. Download/publish owns creation and must retire live
 * readers before replacing the course directory; this adapter never downloads or repairs. */
export function createExpoPackStorage(
  root = new Directory(Paths.cache, PACK_DB_DIRNAME).uri,
): InstalledPackStorage {
  return {
    async manifestBytes(courseId) {
      const file = new File(coursePath(root, courseId), PACK_FILES.manifest);
      if (!file.exists) return null;
      if (file.size > PACK_READ_CONFIG.maximumManifestBytes)
        throw new PackFormatError('Pack manifest exceeds its read limit');
      return file.bytes();
    },
    payloadDigest(courseId) {
      return fileDigest(new File(coursePath(root, courseId), PACK_FILES.payload));
    },
    audioDigest(courseId, path) {
      return Promise.resolve().then(() =>
        fileDigest(new File(assetPath(coursePath(root, courseId), path))),
      );
    },
    openReader(courseId) {
      const directory = coursePath(root, courseId),
        file = new File(directory, PACK_FILES.payload);
      if (!file.exists) throw new PackFormatError('Pack payload is missing');
      // SQLite may otherwise replay unsigned WAL/journal pages before query_only is set.
      for (const suffix of ['-wal', '-journal']) {
        const sidecar = new File(directory, PACK_FILES.payload + suffix);
        if (sidecar.exists && sidecar.size > 0)
          throw new PackFormatError('Pack carries an unsigned SQLite sidecar');
      }
      const handle = openDatabaseSync(PACK_FILES.payload, { useNewConnection: true }, directory);
      try {
        handle.execSync('PRAGMA query_only=ON');
        if (handle.getFirstSync<{ query_only: number }>('PRAGMA query_only')?.query_only !== 1)
          throw new PackFormatError('Pack reader is not read-only');
        let closed = false;
        return {
          packRoot: directory,
          reader: {
            all<T>(sql: string, params: readonly unknown[] = []) {
              if (closed) throw new PackFormatError('Pack reader is closed');
              requireReadQuery(sql);
              return handle.getAllSync<T>(sql, params as SQLiteBindParams);
            },
            get<T>(sql: string, params: readonly unknown[] = []) {
              if (closed) throw new PackFormatError('Pack reader is closed');
              requireReadQuery(sql);
              return handle.getFirstSync<T>(sql, params as SQLiteBindParams) ?? undefined;
            },
          },
          close() {
            if (closed) return;
            closed = true;
            handle.closeSync();
          },
        };
      } catch (error) {
        handle.closeSync();
        throw error;
      }
    },
  };
}
export function createNativeInstalledPackRepository(
  db: Db,
  runtimeItemReader: RuntimeItemReader,
  catalogueState?: (courseId: string) => 'available' | 'withdrawn',
) {
  return createInstalledPackRepository({
    db,
    storage: createExpoPackStorage(),
    publicKey: parseEd25519PublicKeyPem(PACK_SIGNING_PUBLIC_KEY_PEM),
    runtimeItemReader,
    ...(catalogueState ? { catalogueState } : {}),
  });
}
