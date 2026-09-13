// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeDb } from '../../../../packages/testkit/src/nodeDb';
import { migrate, parseEd25519PublicKeyPem } from '@freelingo/schema';
import { canonicalJson, PackFormatError, type PackReader } from '@freelingo/core/packs';
import {
  createInstalledPackRepository,
  type InstalledPackStorage,
} from './InstalledPackRepository';
const roots: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'freelingo-repository-'));
  roots.push(root);
  const fixture = new URL(
    '../../../../packages/core/src/packs/__fixtures__/es-mini/',
    import.meta.url,
  );
  const file = join(root, 'pack.sqlite');
  copyFileSync(new URL('pack.sqlite', fixture), file);
  const base = JSON.parse(readFileSync(new URL('manifest.json', fixture), 'utf8')) as Record<
    string,
    unknown
  >;
  const audioDb = new DatabaseSync(file, { readOnly: true });
  base.audioFiles = audioDb
    .prepare('SELECT path,bytes FROM audio ORDER BY path')
    .all()
    .map((row) => ({
      path: row.path,
      bytes: row.bytes,
      sha256: sha(readFileSync(new URL(String(row.path), fixture))),
    }));
  audioDb.close();
  const keys = generateKeyPairSync('ed25519');
  const pem = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const trusted = parseEd25519PublicKeyPem(pem);
  let manifest: Uint8Array;
  const resign = (transform: (source: string) => string = (source) => source) => {
    const unsigned = { ...base };
    delete unsigned.signature;
    const payload = Buffer.from(transform(canonicalJson(unsigned)));
    manifest = new TextEncoder().encode(
      JSON.stringify({
        ...unsigned,
        signature: {
          algorithm: 'ed25519',
          payload: payload.toString('base64'),
          public_key: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
          signature: sign(null, payload, keys.privateKey).toString('base64'),
        },
      }),
    );
  };
  base.payloadSha256 = sha(readFileSync(file));
  base.payloadBytes = readFileSync(file).length;
  resign();
  let audioPresent = true;
  const readerOpens = vi.fn();
  const readerCloses = vi.fn();
  const storage: InstalledPackStorage = {
    async manifestBytes() {
      return manifest;
    },
    async payloadDigest() {
      return { sha256: sha(readFileSync(file)), bytes: readFileSync(file).length };
    },
    openReader() {
      readerOpens();
      const handle = new DatabaseSync(file, { readOnly: true });
      return {
        reader: {
          all: <T>(sql: string, p: readonly unknown[] = []) =>
            handle.prepare(sql).all(...(p as never[])) as T[],
          get: <T>(sql: string, p: readonly unknown[] = []) =>
            handle.prepare(sql).get(...(p as never[])) as T | undefined,
        } satisfies PackReader,
        packRoot: root,
        close() {
          readerCloses();
          handle.close();
        },
      };
    },
    async audioDigest(_course, path) {
      if (!audioPresent) return null;
      const relative = path.replace(root + '/', '');
      const bytes = readFileSync(new URL(relative, fixture));
      return { sha256: sha(bytes), bytes: bytes.length };
    },
  };
  const db = createNodeDb();
  migrate(db);
  db.run(
    "INSERT INTO course_progress(course_id,added_at,xp,pack_content_hash) VALUES ('en-es','2026-09-13',77,'previous')",
  );
  const runtimeItem = vi.fn(() => {
    throw new PackFormatError('No approved runtime grading data');
  });
  const repo = createInstalledPackRepository({
    db,
    storage,
    publicKey: trusted,
    runtimeItemReader: runtimeItem,
  });
  closers.push(() => {
    repo.close();
    db.close();
  });
  return {
    repo,
    db,
    storage,
    base,
    resign,
    readerOpens,
    readerCloses,
    runtimeItem,
    file,
    setManifest: (value: Uint8Array) => {
      manifest = value;
    },
    setAudio: (value: boolean) => {
      audioPresent = value;
    },
  };
}
it('[INV-PACK-18][INV-PACK-04] verifies actual signed fixture bytes before a reader opens and preserves earned progress', async () => {
  const s = setup();
  await s.repo.refresh(['en-es']);
  expect(s.repo.state('en-es')).toBe('installed');
  expect(s.repo.get('en-es')?.pack.meta.courseId).toBe('en-es');
  expect(s.db.get('SELECT xp,pack_state,pack_content_hash FROM course_progress')).toEqual({
    xp: 77,
    pack_state: 'installed',
    pack_content_hash: s.base.payloadSha256,
  });
  expect(s.readerOpens).toHaveBeenCalledTimes(1);
});
it('[INV-PACK-18] never opens SQLite or changes known hash for an unsigned or wrongly signed manifest', async () => {
  const s = setup();
  s.setManifest(new TextEncoder().encode(JSON.stringify(s.base)));
  await s.repo.refresh(['en-es']);
  expect(s.repo.get('en-es')).toBeNull();
  expect(s.repo.state('en-es')).toBe('unverified');
  expect(s.readerOpens).not.toHaveBeenCalled();
  expect(s.db.get('SELECT xp,pack_content_hash FROM course_progress')).toEqual({
    xp: 77,
    pack_content_hash: 'previous',
  });
});
it('[INV-PACK-18] rejects a changed payload before opening it', async () => {
  const s = setup();
  writeFileSync(s.file, Buffer.from('tampered SQLite bytes'));
  await s.repo.refresh(['en-es']);
  expect(s.repo.get('en-es')).toBeNull();
  expect(s.readerOpens).not.toHaveBeenCalled();
  expect(s.repo.state('en-es')).toBe('corrupt');
});
it('[INV-PACK-04] missing audio retains verified structure as partial', async () => {
  const s = setup();
  s.setAudio(false);
  await s.repo.refresh(['en-es']);
  expect(s.repo.state('en-es')).toBe('partial');
  expect(s.repo.get('en-es')?.pack.units().length).toBeGreaterThan(0);
});
it('[INV-PACK-35] signed manifest identity still must match actual SQLite metadata', async () => {
  const s = setup();
  s.base.courseId = 'en-fr';
  s.resign();
  await s.repo.refresh(['en-es']);
  expect(s.repo.get('en-es')).toBeNull();
  expect(s.readerOpens).not.toHaveBeenCalled();
});
it('[INV-PACK-35] missing production grading never becomes fixture grading at runtime', async () => {
  const s = setup();
  await s.repo.refresh(['en-es']);
  expect(() => s.repo.get('en-es')!.runtimeItem('x')).toThrow(PackFormatError);
});
it('[INV-PACK-18] stale in-flight verification cannot reopen or persist after close', async () => {
  const s = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = s.storage.payloadDigest;
  s.storage.payloadDigest = async (course) => {
    await gate;
    return read(course);
  };
  const pending = s.repo.refresh(['en-es']);
  await Promise.resolve();
  s.repo.close();
  release();
  await pending;
  expect(s.readerOpens).not.toHaveBeenCalled();
  expect(s.repo.get('en-es')).toBeNull();
  expect(s.db.get('SELECT pack_content_hash FROM course_progress')).toEqual({
    pack_content_hash: 'previous',
  });
});
it('[INV-PER-11] disk inspection never creates a course the learner has not selected', async () => {
  const s = setup();
  s.db.run('DELETE FROM course_progress');
  await s.repo.refresh(['en-es']);
  expect(s.repo.get('en-es')).not.toBeNull();
  expect(s.db.all('SELECT * FROM course_progress')).toEqual([]);
});

it('[INV-PACK-18] a legacy manifest without per-file digests retains structure but does not authenticate its audio', async () => {
  const s = setup();
  delete s.base.audioFiles;
  s.resign();
  await s.repo.refresh(['en-es']);
  expect(s.repo.state('en-es')).toBe('partial');
  expect(s.repo.get('en-es')?.audioUri('33bc78a7d26fb193')).toBeNull();
});
it('[INV-PACK-18] authenticates Python numeric JSON payload without changing signed bytes', async () => {
  const s = setup();
  s.base.numericProof = 1;
  s.resign();
  // The general fixture signer can produce exact alternate payload bytes below.
  const bytes = await s.storage.manifestBytes('en-es');
  const signed = JSON.parse(new TextDecoder().decode(bytes!));
  signed.signature.payload = Buffer.from(
    Buffer.from(signed.signature.payload, 'base64')
      .toString()
      .replace('"numericProof":1', '"numericProof":1.0'),
  ).toString('base64');
  // Old signature is now invalid: signed payload bytes cannot be replaced by equivalent JSON.
  s.setManifest(new TextEncoder().encode(JSON.stringify(signed)));
  await s.repo.refresh(['en-es']);
  expect(s.repo.state('en-es')).toBe('unverified');
});
it('[INV-PACK-18] reports progress write failure instead of disguising it as damaged content', async () => {
  const s = setup();
  s.db.run(
    "CREATE TRIGGER refuse_pack_state BEFORE UPDATE OF pack_state ON course_progress BEGIN SELECT RAISE(ABORT,'write refused'); END",
  );
  await expect(s.repo.refresh(['en-es'])).rejects.toThrow('write refused');
  expect(s.repo.get('en-es')).toBeNull();
  expect(s.readerCloses).toHaveBeenCalledTimes(1);
});

it('[INV-PACK-18] verifies exact Python numeric spellings while binding all decoded manifest fields', async () => {
  const s = setup();
  s.base.numericProof = [1, 1e-7, 1e20];
  s.resign((source) =>
    source.replace(
      '"numericProof":[1,1e-7,100000000000000000000]',
      '"numericProof":[1.0,1e-07,1e+20]',
    ),
  );
  await s.repo.refresh(['en-es']);
  expect(s.repo.state('en-es')).toBe('installed');
  expect(s.repo.get('en-es')?.audioUri('33bc78a7d26fb193')).toContain(
    '/audio/33bc78a7d26fb193.opus',
  );
});
it('[INV-PACK-18] a replaced or closed reader cannot serve cached pack references', async () => {
  const s = setup();
  await s.repo.refresh(['en-es']);
  const old = s.repo.get('en-es')!;
  await s.repo.refresh(['en-es']);
  expect(() => old.pack.units()).toThrow('closed');
  expect(old.audioUri('33bc78a7d26fb193')).toBeNull();
  expect(s.readerCloses).toHaveBeenCalledTimes(1);
  s.repo.close();
  expect(s.readerCloses).toHaveBeenCalledTimes(2);
});
it('[INV-PACK-18] changed audio bytes are corrupt and never playable', async () => {
  const s = setup();
  const digest = s.storage.audioDigest;
  s.storage.audioDigest = async (course, path) => {
    const d = await digest(course, path);
    return d ? { ...d, sha256: 'f'.repeat(64) } : null;
  };
  await s.repo.refresh(['en-es']);
  expect(s.repo.state('en-es')).toBe('corrupt');
  expect(s.repo.get('en-es')).toBeNull();
  expect(s.readerCloses).toHaveBeenCalledTimes(1);
});
