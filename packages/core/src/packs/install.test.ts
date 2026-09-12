import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_RUNS, readRepoFile } from '@freelingo/testkit';
import { pureEd25519Verifier } from './ed25519.js';
import { sha256Hex, utf8 } from './hashing.js';
import {
  installPack,
  parsePackManifest,
  payloadDigest,
  planPackFetch,
  resolvePackOnSwitch,
  type Connection,
  type FetchTrigger,
  type InstallInput,
  type PackManifest,
} from './install.js';
import { NOT_DOWNLOADED_FACTS, type PackFacts } from './state.js';

/**
 * INV-PACK-18 (verify before install) and INV-PACK-27 (eviction and metered links).
 *
 * The committed public key is read from `packages/schema/keys/pack-signing.pub` — the key
 * that actually ships. `packages/core` cannot import `@freelingo/schema` (schema already
 * depends on core; see `db/Db.ts`), so this test decodes the PEM with `node:crypto`
 * instead of schema's hand-rolled parser. That is sound because
 * `packages/schema/src/signing.test.ts` already asserts the two parsers agree on this
 * exact file byte for byte — the app wires `parseEd25519PublicKeyPem(pem).raw` into
 * `installPack`, and this test wires the same 32 bytes in by another route.
 */
const PACK_SIGNING_PUBLIC_KEY_PATH = 'packages/schema/keys/pack-signing.pub';

function rawPublicKeyFromPem(pem: string): Uint8Array {
  const spki = new Uint8Array(createPublicKey(pem).export({ type: 'spki', format: 'der' }));
  return spki.subarray(12); // 12-byte ed25519 SPKI prefix, then the 32 raw bytes
}

const COMMITTED_PUBLIC_KEY = rawPublicKeyFromPem(readRepoFile(PACK_SIGNING_PUBLIC_KEY_PATH));

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    raw: rawPublicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
  };
}

const PAYLOAD = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31) & 0xff);

function manifestOf(overrides: Partial<PackManifest> = {}): PackManifest {
  return {
    packId: 'es-ES@1.0.0',
    courseId: 'en-es',
    major: 1,
    version: '1.0.0',
    payloadSha256: sha256Hex(PAYLOAD),
    payloadBytes: PAYLOAD.length,
    audioBytes: 38_000_000,
    itemIds: ['i_0000000000000001'],
    ...overrides,
  };
}

function signedInput(overrides: Partial<InstallInput> = {}, manifest = manifestOf()): InstallInput {
  const pair = keyPair();
  const manifestBytes = utf8(JSON.stringify(manifest));
  const signature = new Uint8Array(
    sign(null, Buffer.from(manifestBytes), createPrivateKey(pair.privatePem)),
  );
  return {
    manifestBytes,
    signature,
    publicKey: pair.raw,
    verifier: pureEd25519Verifier,
    stagedPayloadSha256: manifest.payloadSha256,
    stagedAudioBytes: manifest.audioBytes,
    ...overrides,
  };
}

describe('INV-PACK-18 verify before install', () => {
  it('[INV-PACK-18] a good pack verifies first, then installs — in that order', () => {
    const result = installPack(signedInput());
    expect(result.steps).toEqual([
      'parse-manifest',
      'verify-signature',
      'verify-payload-digest',
      'install',
    ]);
    expect(result.steps.indexOf('verify-signature')).toBeLessThan(result.steps.indexOf('install'));
    expect(result.installed).toBe(true);
    expect(result.state).toBe('installed');
  });

  it('[INV-PACK-18] a wrong key is rejected: unverified, never installed, never corrupt', () => {
    const other = keyPair();
    const result = installPack(signedInput({ publicKey: other.raw }));
    expect(result.state).toBe('unverified');
    expect(result.state).not.toBe('corrupt');
    expect(result.installed).toBe(false);
    expect(result.refusal).toBe('signature-invalid');
    expect(result.steps).not.toContain('install');
  });

  it('[INV-PACK-18] the committed pack-signing key rejects a pack signed by anyone else', () => {
    // The private half lives only in the PACK_SIGNING_KEY CI secret, so the accept path
    // cannot be exercised from a checkout — but this is the check that ships.
    const result = installPack(signedInput({ publicKey: COMMITTED_PUBLIC_KEY }));
    expect(COMMITTED_PUBLIC_KEY).toHaveLength(32);
    expect(result.state).toBe('unverified');
    expect(result.installed).toBe(false);
  });

  it('[INV-PACK-18] a truncated signature is rejected rather than throwing', () => {
    for (const length of [0, 1, 32, 63]) {
      const base = signedInput();
      const result = installPack({ ...base, signature: base.signature.subarray(0, length) });
      expect(result.state, `length ${length}`).toBe('unverified');
      expect(result.installed).toBe(false);
      expect(result.steps).not.toContain('install');
    }
  });

  it('[INV-PACK-18] a tampered manifest is rejected: the signature no longer covers it', () => {
    const base = signedInput();
    fc.assert(
      fc.property(fc.nat({ max: base.manifestBytes.length - 1 }), (index) => {
        const tampered = Uint8Array.from(base.manifestBytes);
        tampered[index] = tampered[index]! ^ 0x20;
        if (tampered[index] === base.manifestBytes[index]) return;
        const result = installPack({ ...base, manifestBytes: tampered });
        expect(result.installed).toBe(false);
        expect(result.state).not.toBe('corrupt');
        expect(['unverified']).toContain(result.state);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-18] a genuinely signed manifest over the wrong payload is unverified, not corrupt', () => {
    const result = installPack(signedInput({ stagedPayloadSha256: sha256Hex('other bytes') }));
    expect(result.refusal).toBe('payload-digest-mismatch');
    expect(result.state).toBe('unverified');
    expect(result.installed).toBe(false);
    expect(result.steps).not.toContain('install');
  });

  it('[INV-PACK-18] installPack can never return corrupt, for any input', () => {
    // `corrupt` is a post-install fact. Nothing an installer sees can produce it.
    const mutations: (() => InstallInput)[] = [
      () => signedInput(),
      () => signedInput({ signature: new Uint8Array(64) }),
      () => signedInput({ manifestBytes: utf8('not json') }),
      () => signedInput({ manifestBytes: utf8('{"packId":1}') }),
      () => signedInput({ manifestBytes: new Uint8Array([0xff, 0xfe, 0xfd]) }),
      () => signedInput({ stagedPayloadSha256: '' }),
      () => signedInput({ stagedAudioBytes: 0 }),
    ];
    for (const make of mutations) {
      expect(installPack(make()).state).not.toBe('corrupt');
    }
  });

  it('[INV-PACK-18] an unparseable manifest refuses before the signature is even checked', () => {
    const result = installPack(signedInput({ manifestBytes: utf8('{') }));
    expect(result.steps).toEqual(['parse-manifest']);
    expect(result.refusal).toBe('manifest-unparseable');
  });

  it('[INV-PACK-18] a verified pack whose audio is incomplete installs as partial', () => {
    const manifest = manifestOf();
    const result = installPack(
      signedInput({ stagedAudioBytes: Math.floor(manifest.audioBytes * 0.6) }, manifest),
    );
    expect(result.installed).toBe(true);
    expect(result.state).toBe('partial');
  });

  it('parsePackManifest refuses anything that is not a manifest, and never throws', () => {
    for (const text of ['', '[]', 'null', '{"packId":"a"}', '{"major":"1"}', '{}']) {
      expect(parsePackManifest(utf8(text))).toBeNull();
    }
    expect(parsePackManifest(utf8(JSON.stringify(manifestOf())))).not.toBeNull();
    expect(payloadDigest(PAYLOAD)).toBe(sha256Hex(PAYLOAD));
  });
});

describe('INV-PACK-27 eviction and metered links', () => {
  const arbTrigger = fc.constantFrom<FetchTrigger>(
    'explicit-tap',
    'auto-resume',
    'course-switch',
    'session-start',
  );
  const arbConnection = fc.constantFrom<Connection>('unmetered', 'metered', 'offline');

  it('[INV-PACK-27] no fetch starts on a metered connection without an explicit confirm', () => {
    fc.assert(
      fc.property(
        arbTrigger,
        fc.boolean(),
        fc.integer({ min: 1, max: 120_000_000 }),
        (trigger, confirmed, bytes) => {
          const plan = planPackFetch({
            connection: 'metered',
            userConfirmedMetered: confirmed,
            trigger,
            bytesRemaining: bytes,
          });
          if (!confirmed) {
            expect(plan.start).toBe(false);
            expect(plan.confirmRequired).toBe(true);
          }
          // A confirm belongs to the download the learner was looking at: an auto-resume
          // days later in another country is not that download.
          if (trigger !== 'explicit-tap') expect(plan.start).toBe(false);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-27] a 38 MB cellular fixture never auto-resumes', () => {
    const plan = planPackFetch({
      connection: 'metered',
      userConfirmedMetered: true,
      trigger: 'auto-resume',
      bytesRemaining: 38_000_000,
    });
    expect(plan.start).toBe(false);
    expect(plan.refusal).toBe('metered-needs-confirm');
    expect(plan.queued).toBe(true);
  });

  it('[INV-PACK-27] EC-CRS-06 auto-resume survives, but only on an unmetered link', () => {
    fc.assert(
      fc.property(arbTrigger, fc.integer({ min: 1, max: 120_000_000 }), (trigger, bytes) => {
        const plan = planPackFetch({
          connection: 'unmetered',
          userConfirmedMetered: false,
          trigger,
          bytesRemaining: bytes,
        });
        expect(plan.start).toBe(true);
        expect(plan.confirmRequired).toBe(false);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-27] offline queues rather than failing, and starts nothing', () => {
    fc.assert(
      fc.property(arbTrigger, fc.boolean(), (trigger, confirmed) => {
        const plan = planPackFetch({
          connection: 'offline',
          userConfirmedMetered: confirmed,
          trigger,
          bytesRemaining: 38_000_000,
        });
        expect(plan.start).toBe(false);
        expect(plan.queued).toBe(true);
        expect(plan.refusal).toBe('offline');
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-27] an evicted installed pack resolves to not-downloaded on switch, and opens no lesson', () => {
    fc.assert(
      fc.property(arbConnection, fc.integer({ min: 1, max: 120_000_000 }), (connection, bytes) => {
        const installed: PackFacts = {
          ...NOT_DOWNLOADED_FACTS,
          dbPresent: true,
          signature: 'valid',
          audioBytesExpected: bytes,
          audioBytesPresent: bytes,
        };
        // iOS reclaimed the cache directory while the app was not running.
        const evicted: PackFacts = {
          ...installed,
          dbPresent: false,
          signature: 'unchecked',
          audioBytesPresent: 0,
        };
        const result = resolvePackOnSwitch(evicted, connection, bytes);
        expect(result.state).toBe('not-downloaded');
        expect(result.sessionLaunchable).toBe(false);
        expect(result.fetch.start).toBe(connection === 'unmetered' ? true : false);
        expect(result.progressRowsRetained).toBe(true);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('[INV-PACK-27] a switch to an intact pack starts no fetch at all', () => {
    const installed: PackFacts = {
      ...NOT_DOWNLOADED_FACTS,
      dbPresent: true,
      signature: 'valid',
      audioBytesExpected: 38_000_000,
      audioBytesPresent: 38_000_000,
    };
    const result = resolvePackOnSwitch(installed, 'metered', 38_000_000);
    expect(result.state).toBe('installed');
    expect(result.sessionLaunchable).toBe(true);
    expect(result.fetch.start).toBe(false);
    expect(result.fetch.refusal).toBe('nothing-to-fetch');
  });
});
