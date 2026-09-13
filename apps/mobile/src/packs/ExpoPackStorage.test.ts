// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readSync,
  statSync,
  fstatSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExpoPackStorage } from './ExpoPackStorage';
const handles: DatabaseSync[] = [];
const roots: string[] = [];
const modes: string[] = [];
const readSizes: number[] = [];
vi.mock('expo-file-system', () => ({
  FileMode: { ReadOnly: 'r' },
  Paths: { cache: { uri: '/unused-cache' } },
  Directory: class {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = parts
        .map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri))
        .join('/');
    }
  },
  File: class {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = parts
        .map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri))
        .join('/');
    }
    get exists() {
      return existsSync(this.uri);
    }
    get size() {
      return statSync(this.uri).size;
    }
    async bytes() {
      const file = this.open('r');
      try {
        return file.readBytes(file.size!);
      } finally {
        file.close();
      }
    }
    open(mode: string) {
      modes.push(mode);
      const fd = openSync(this.uri, mode);
      let offset = 0;
      return {
        get size() {
          return fstatSync(fd).size;
        },
        get offset() {
          return offset;
        },
        readBytes(size: number) {
          readSizes.push(size);
          const bytes = Buffer.alloc(size);
          const count = readSync(fd, bytes, 0, size, offset);
          offset += count;
          return bytes.subarray(0, count);
        },
        close() {
          closeSync(fd);
        },
      };
    }
  },
}));
vi.mock('expo-sqlite', () => ({
  openDatabaseSync: (name: string, _options: unknown, dir: string) => {
    const h = new DatabaseSync(join(dir, name));
    handles.push(h);
    return {
      execSync: (sql: string) => h.exec(sql),
      getAllSync: (sql: string, p: unknown[] = []) => h.prepare(sql).all(...(p as never[])),
      getFirstSync: (sql: string, p: unknown[] = []) => h.prepare(sql).get(...(p as never[])),
      closeSync: () => {
        handles.splice(handles.indexOf(h), 1);
        h.close();
      },
    };
  },
}));
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  modes.length = 0;
  readSizes.length = 0;
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'freelingo-expo-pack-'));
  roots.push(root);
  const course = join(root, 'en-es');
  mkdirSync(course);
  copyFileSync(
    new URL(
      '../../../../packages/core/src/packs/__fixtures__/es-mini/pack.sqlite',
      import.meta.url,
    ),
    join(course, 'pack.sqlite'),
  );
  return { root, course, storage: createExpoPackStorage(root) };
}
it('[INV-PACK-18] actual file bytes are streamed read-only with bounded chunks', async () => {
  const s = setup();
  const digest = await s.storage.payloadDigest('en-es');
  const bytes = Buffer.alloc(700000, 9);
  writeFileSync(join(s.course, 'audio.bin'), bytes);
  expect(await s.storage.audioDigest('en-es', join(s.course, 'audio.bin'))).toEqual({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  });
  expect(digest?.bytes).toBeGreaterThan(0);
  expect(modes.every((mode) => mode === 'r')).toBe(true);
  expect(Math.max(...readSizes)).toBeLessThanOrEqual(262144);
});
it('[INV-PACK-11] reader is query-only before the first pack query and exposes no writer', () => {
  const s = setup();
  const opened = s.storage.openReader('en-es');
  expect(opened.reader.get("SELECT value FROM meta WHERE key='course_id'")).toEqual({
    value: 'en-es',
  });
  expect('run' in opened.reader).toBe(false);
  expect(() => handles[0]!.exec("UPDATE meta SET value='bad'")).toThrow('readonly');
  opened.close();
  expect(handles).toEqual([]);
});
it('[INV-PACK-18] unsigned WAL or rollback-journal bytes cannot alter a signed main database', () => {
  const s = setup();
  writeFileSync(join(s.course, 'pack.sqlite-wal'), 'untrusted pages');
  expect(() => s.storage.openReader('en-es')).toThrow('sidecar');
  expect(handles).toEqual([]);
});
it('[INV-PACK-11] absent payload does not cause SQLite to create a new file', async () => {
  const s = setup();
  rmSync(join(s.course, 'pack.sqlite'));
  expect(await s.storage.payloadDigest('en-es')).toBeNull();
  expect(() => s.storage.openReader('en-es')).toThrow('missing');
  expect(existsSync(join(s.course, 'pack.sqlite'))).toBe(false);
});
it('[INV-SEC-02] course and audio paths cannot escape the configured pack root', async () => {
  const s = setup();
  await expect(s.storage.manifestBytes('../outside')).rejects.toThrow('course');
  await expect(s.storage.audioDigest('en-es', join(s.root, 'outside'))).rejects.toThrow('path');
  await expect(s.storage.audioDigest('en-es', s.course + '/../outside')).rejects.toThrow('path');
  expect(handles).toEqual([]);
});

it('[INV-PACK-11] the read facade refuses connection mutations and writer statements even through all/get', () => {
  const s = setup();
  const opened = s.storage.openReader('en-es');
  for (const sql of [
    'PRAGMA query_only=OFF',
    "UPDATE meta SET value='changed' RETURNING value",
    'SELECT 1; PRAGMA query_only=OFF',
    'WITH one AS (SELECT 1) DELETE FROM meta RETURNING value',
    "ATTACH DATABASE ':memory:' AS extra",
  ]) {
    expect(() => opened.reader.all(sql)).toThrow('read query');
    expect(() => opened.reader.get(sql)).toThrow('read query');
  }
  expect(opened.reader.get("SELECT value FROM meta WHERE key='course_id'")).toEqual({
    value: 'en-es',
  });
  opened.close();
});
