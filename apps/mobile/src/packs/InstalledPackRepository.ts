import type { Db } from '@freelingo/core';
import {
  canonicalJson,
  openPack,
  PACK_LOADER_READS,
  PackFormatError,
  parsePackManifest,
  readGradingMetadata,
  resolvePackState,
  verifyEd25519,
  type LoadedGradingMetadata,
  type PackManifest,
  type PackReader,
  type PackState,
} from '@freelingo/core/packs';
import { PACK_SCHEMA_VERSION, type Ed25519PublicKey } from '@freelingo/schema';
import type { RuntimeItemReader } from '../../../../packages/core/src/packs/runtime-item-types';
import type { InstalledPackRepository, VerifiedInstalledPack } from './installedPackPorts';

export interface PackFileDigest {
  readonly sha256: string;
  readonly bytes: number;
}
/** The storage owner publishes immutable pack directories. It must not replace their
 * payload while a reader is live; OS cache eviction may still make any read fail. */
export interface InstalledPackStorage {
  manifestBytes(courseId: string): Promise<Uint8Array | null>;
  payloadDigest(courseId: string): Promise<PackFileDigest | null>;
  openReader(courseId: string): {
    readonly reader: PackReader;
    readonly packRoot: string;
    close(): void;
  };
  audioDigest(courseId: string, absolutePath: string): Promise<PackFileDigest | null>;
}
export interface InstalledPackRepositoryOptions {
  readonly db: Db;
  readonly storage: InstalledPackStorage;
  readonly publicKey: Ed25519PublicKey;
  readonly runtimeItemReader: RuntimeItemReader;
  readonly catalogueState?: (courseId: string) => 'available' | 'withdrawn';
}
interface Entry {
  readonly value: VerifiedInstalledPack;
  close(): void;
}
const hexDigest = /^[0-9a-f]{64}$/;
const integer = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function base64(value: unknown, length?: number): Uint8Array | null {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return null;
  try {
    const result = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return length === undefined || result.length === length ? result : null;
  } catch {
    return null;
  }
}
/** G9 signs canonical JSON with only the top-level signature block removed. */
interface AudioFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface VerifiedManifest {
  readonly manifest: PackManifest;
  readonly audioFiles: readonly AudioFile[] | null;
}
function verifiedManifest(
  bytes: Uint8Array,
  courseId: string,
  key: Ed25519PublicKey,
): VerifiedManifest | null {
  try {
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(raw) || !object(raw.signature) || raw.signature.algorithm !== 'ed25519')
      return null;
    const embedded = base64(raw.signature.public_key, 44);
    const signature = base64(raw.signature.signature, 64);
    if (
      embedded === null ||
      signature === null ||
      embedded.length !== key.spki.length ||
      embedded.some((b, i) => b !== key.spki[i])
    )
      return null;
    const unsigned = { ...raw };
    delete unsigned.signature;
    let payload: Uint8Array = new TextEncoder().encode(canonicalJson(unsigned));
    if ('payload' in raw.signature) {
      const exact = base64(raw.signature.payload);
      if (exact === null) return null;
      const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(exact));
      if (canonicalJson(decoded) !== canonicalJson(unsigned)) return null;
      payload = exact;
    }
    if (!verifyEd25519(signature, payload, key.raw)) return null;
    const parsed = parsePackManifest(bytes);
    if (
      parsed === null ||
      parsed.courseId !== courseId ||
      !parsed.packId.trim() ||
      !parsed.version.trim() ||
      !hexDigest.test(parsed.payloadSha256) ||
      !integer(parsed.major) ||
      !integer(parsed.payloadBytes) ||
      parsed.payloadBytes === 0 ||
      !integer(parsed.audioBytes) ||
      parsed.itemIds.some((id) => !id.trim()) ||
      new Set(parsed.itemIds).size !== parsed.itemIds.length
    )
      return null;
    let audioFiles: readonly AudioFile[] | null = null;
    if ('audioFiles' in raw) {
      if (!Array.isArray(raw.audioFiles)) return null;
      const files: AudioFile[] = [];
      const paths = new Set<string>();
      for (const entry of raw.audioFiles) {
        if (
          !object(entry) ||
          Object.keys(entry).sort().join(',') !== 'bytes,path,sha256' ||
          typeof entry.path !== 'string' ||
          !safeAssetPath(entry.path) ||
          !integer(entry.bytes) ||
          entry.bytes === 0 ||
          typeof entry.sha256 !== 'string' ||
          !hexDigest.test(entry.sha256) ||
          paths.has(entry.path)
        )
          return null;
        paths.add(entry.path);
        files.push(Object.freeze({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }));
      }
      if (files.reduce((sum, entry) => sum + entry.bytes, 0) !== parsed.audioBytes) return null;
      audioFiles = Object.freeze(files);
    }
    return {
      manifest: Object.freeze({ ...parsed, itemIds: Object.freeze([...parsed.itemIds]) }),
      audioFiles,
    };
  } catch {
    return null;
  }
}
function checkReader(reader: PackReader): void {
  const integrity = reader.all<{ integrity_check: string }>('PRAGMA integrity_check');
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
    throw new PackFormatError('Pack SQLite integrity failed');
  if (
    reader.get<{ user_version: number }>('PRAGMA user_version')?.user_version !==
    PACK_SCHEMA_VERSION
  )
    throw new PackFormatError('Unsupported pack schema');
  if (reader.all('PRAGMA foreign_key_check').length !== 0)
    throw new PackFormatError('Pack contains broken references');
  for (const [table, required] of Object.entries(PACK_LOADER_READS)) {
    // Names come only from the committed loader declaration, never content input.
    const columns = new Set(
      reader.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((row) => row.name),
    );
    if (required.some((name) => !columns.has(name)))
      throw new PackFormatError(`Pack is missing ${table} columns`);
  }
}
function safeAssetPath(path: string): boolean {
  return (
    path.length > 0 &&
    !/[:\\%?#]/.test(path) &&
    ![...path].some((char) => char.charCodeAt(0) < 32) &&
    !path.startsWith('/') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
export function createInstalledPackRepository(
  options: InstalledPackRepositoryOptions,
): InstalledPackRepository {
  const { db, storage, runtimeItemReader } = options;
  const entries = new Map<string, Entry>();
  const states = new Map<string, PackState>();
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  const forget = (courseId: string) => {
    const old = entries.get(courseId);
    entries.delete(courseId);
    old?.close();
  };
  const publish = (courseId: string, state: PackState, hash?: string) => {
    if (closed) return;
    // Disk verification does not select a course or touch earned progress. A last known
    // verified identity remains available to recovery when disk bytes disappear.
    if (hash !== undefined)
      db.run(
        'UPDATE course_progress SET pack_state = ?, pack_content_hash = ? WHERE course_id = ?',
        [state, hash, courseId],
      );
    else db.run('UPDATE course_progress SET pack_state = ? WHERE course_id = ?', [state, courseId]);
    states.set(courseId, state);
  };
  const verifyOne = async (courseId: string) => {
    if (closed) return;
    forget(courseId);
    const catalogue = options.catalogueState?.(courseId) ?? 'available';
    let candidate: ReturnType<InstalledPackStorage['openReader']> | undefined;
    let adopted = false;
    let writingProgress = false;
    const finish = (state: PackState, hash?: string) => {
      writingProgress = true;
      publish(courseId, state, hash);
      writingProgress = false;
    };
    try {
      const bytes = await storage.manifestBytes(courseId);
      if (closed) return;
      if (bytes === null) {
        finish(catalogue === 'withdrawn' ? 'withdrawn' : 'not-downloaded');
        return;
      }
      const verified = verifiedManifest(bytes, courseId, options.publicKey);
      if (verified === null) {
        finish(catalogue === 'withdrawn' ? 'withdrawn' : 'unverified');
        return;
      }
      const { manifest, audioFiles } = verified;
      const digest = await storage.payloadDigest(courseId);
      if (closed) return;
      if (digest === null) {
        finish(catalogue === 'withdrawn' ? 'withdrawn' : 'not-downloaded');
        return;
      }
      if (digest.sha256 !== manifest.payloadSha256 || digest.bytes !== manifest.payloadBytes)
        throw new PackFormatError('Installed payload differs from signed manifest');
      candidate = storage.openReader(courseId);
      let readerClosed = false;
      const native = candidate;
      const reader: PackReader = {
        all<T>(sql: string, params?: readonly unknown[]) {
          if (readerClosed || closed) throw new PackFormatError('Pack reader is closed');
          return native.reader.all<T>(sql, params);
        },
        get<T>(sql: string, params?: readonly unknown[]) {
          if (readerClosed || closed) throw new PackFormatError('Pack reader is closed');
          return native.reader.get<T>(sql, params);
        },
      };
      checkReader(reader);
      const pack = openPack(reader, { packRoot: candidate.packRoot });
      if (
        pack.meta.packId !== manifest.packId ||
        pack.meta.courseId !== courseId ||
        pack.meta.major !== manifest.major ||
        pack.meta.version !== manifest.version ||
        pack.meta.schemaVersion !== PACK_SCHEMA_VERSION
      )
        throw new PackFormatError('Signed manifest and SQLite identity differ');
      const actualIds = pack.itemIds();
      const declared = new Set(manifest.itemIds);
      if (actualIds.length !== declared.size || actualIds.some((id) => !declared.has(id)))
        throw new PackFormatError('Signed item population differs from SQLite');
      let expected = 0;
      let present = 0;
      const paths = new Set<string>();
      const assets = new Map(audioFiles?.map((file) => [file.path, file]) ?? []);
      const playable = new Map<string, string>();
      for (const audio of pack.unresolvedAudio(() => false)) {
        if (
          !safeAssetPath(audio.path) ||
          paths.has(audio.path) ||
          !integer(audio.bytes) ||
          audio.bytes === 0
        )
          throw new PackFormatError('Invalid pack audio identity');
        paths.add(audio.path);
        expected += audio.bytes;
        if (!integer(expected)) throw new PackFormatError('Invalid total audio size');
        const asset = assets.get(audio.path);
        if (audioFiles !== null && (asset === undefined || asset.bytes !== audio.bytes))
          throw new PackFormatError('Signed audio file differs from SQLite');
        if (asset === undefined) continue;
        const observed = await storage.audioDigest(courseId, audio.uri);
        if (closed) return;
        if (observed !== null) {
          if (observed.bytes !== audio.bytes || observed.sha256 !== asset.sha256)
            throw new PackFormatError('Installed audio differs from signed payload');
          present += observed.bytes;
          playable.set(audio.audioId, audio.uri);
        }
      }
      if (expected !== manifest.audioBytes || (audioFiles !== null && assets.size !== paths.size))
        throw new PackFormatError('Signed audio population differs from SQLite');
      const state = resolvePackState({
        catalogue,
        dbPresent: true,
        signature: 'valid',
        integrity: 'ok',
        audioBytesPresent: present,
        audioBytesExpected: expected,
      });
      let grading: LoadedGradingMetadata | undefined;
      const value: VerifiedInstalledPack = Object.freeze({
        courseId,
        contentHash: manifest.payloadSha256,
        manifest,
        pack,
        audioUri(audioId: string) {
          if (readerClosed || closed) return null;
          return playable.get(audioId) ?? null;
        },
        runtimeItem(exerciseId: string) {
          if (readerClosed || closed) throw new PackFormatError('Pack reader is closed');
          grading ??= readGradingMetadata(reader, pack.meta);
          return runtimeItemReader(reader, pack.meta, exerciseId, grading);
        },
      });
      finish(
        state,
        state === 'installed' || state === 'partial' ? manifest.payloadSha256 : undefined,
      );
      entries.set(courseId, {
        value,
        close() {
          if (readerClosed) return;
          readerClosed = true;
          native.close();
        },
      });
      adopted = true;
    } catch (error) {
      if (writingProgress) throw error;
      if (!closed) finish(catalogue === 'withdrawn' ? 'withdrawn' : 'corrupt');
    } finally {
      if (!adopted) candidate?.close();
    }
  };
  return {
    refresh(courseIds) {
      const ids = [...new Set(courseIds)];
      const task = queue.then(async () => {
        for (const id of ids) await verifyOne(id);
      });
      queue = task.catch(() => undefined);
      return task;
    },
    get(courseId) {
      return closed ? null : (entries.get(courseId)?.value ?? null);
    },
    state(courseId) {
      return states.get(courseId) ?? 'not-downloaded';
    },
    close() {
      if (closed) return;
      closed = true;
      for (const courseId of entries.keys()) forget(courseId);
    },
  };
}
