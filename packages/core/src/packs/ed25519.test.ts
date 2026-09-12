import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyEd25519 } from './ed25519.js';
import { utf8 } from './hashing.js';

/**
 * The pure-TS verifier held against `node:crypto`.
 *
 * The app has no `node:crypto`, so this file is the only place the shipping verifier and
 * a real one are compared. It runs as an ordinary loop rather than a fast-check property:
 * one verify is ~5 ms of BigInt arithmetic, so 10,000 cases would be a minute of wall
 * clock for nothing — the cases that can falsify this are structural (wrong key, wrong
 * message, truncation, non-canonical S), not statistical, and they are all enumerated.
 */

/** How many independent key pairs the agreement loop draws. */
const KEY_PAIRS = 24;

interface Pair {
  readonly privatePem: string;
  readonly rawPublic: Uint8Array;
  readonly publicPem: string;
}

function keyPair(): Pair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    // An ed25519 SPKI is a 12-byte prefix then the 32 raw bytes.
    rawPublic: spki.subarray(12),
  };
}

function nodeSign(pair: Pair, message: Uint8Array): Uint8Array {
  return new Uint8Array(sign(null, Buffer.from(message), createPrivateKey(pair.privatePem)));
}

describe('ed25519 verification (INV-PACK-18 primitive)', () => {
  const pairs = Array.from({ length: KEY_PAIRS }, keyPair);
  const messages = [
    utf8(''),
    utf8('{"pack":"es-ES","version":"1.0.0"}'),
    utf8('a'.repeat(1000)),
    Uint8Array.from({ length: 256 }, (_, i) => i),
  ];

  it('accepts every node:crypto signature over every message', () => {
    for (const pair of pairs) {
      for (const message of messages) {
        const signature = nodeSign(pair, message);
        expect(verifyEd25519(signature, message, pair.rawPublic)).toBe(true);
        // ...and node:crypto agrees it is valid, so the loop is not comparing a bug to itself.
        expect(
          verify(
            null,
            Buffer.from(message),
            createPublicKey(pair.publicPem),
            Buffer.from(signature),
          ),
        ).toBe(true);
      }
    }
  });

  it('rejects a signature made under a different key', () => {
    const message = utf8('{"pack":"es-ES"}');
    for (let i = 0; i < pairs.length; i += 1) {
      const signer = pairs[i]!;
      const other = pairs[(i + 1) % pairs.length]!;
      const signature = nodeSign(signer, message);
      expect(verifyEd25519(signature, message, other.rawPublic)).toBe(false);
    }
  });

  it('rejects a message tampered with by one bit', () => {
    const pair = pairs[0]!;
    const message = utf8('{"defect_rate":0.018}');
    const signature = nodeSign(pair, message);
    for (let bit = 0; bit < message.length * 8; bit += 7) {
      const tampered = Uint8Array.from(message);
      tampered[bit >> 3] = tampered[bit >> 3]! ^ (1 << (bit % 8));
      expect(verifyEd25519(signature, tampered, pair.rawPublic)).toBe(false);
    }
  });

  it('rejects a signature tampered with by one bit, in R and in S alike', () => {
    const pair = pairs[1]!;
    const message = utf8('manifest');
    const signature = nodeSign(pair, message);
    for (const index of [0, 7, 31, 32, 40, 62]) {
      const tampered = Uint8Array.from(signature);
      tampered[index] = tampered[index]! ^ 0x01;
      expect(verifyEd25519(tampered, message, pair.rawPublic)).toBe(false);
    }
  });

  it('rejects a truncated or over-long signature rather than throwing', () => {
    const pair = pairs[2]!;
    const message = utf8('manifest');
    const signature = nodeSign(pair, message);
    for (const length of [0, 1, 32, 63, 65, 128]) {
      const wrong =
        length <= signature.length
          ? signature.subarray(0, length)
          : new Uint8Array([...signature, ...new Uint8Array(length - signature.length)]);
      expect(verifyEd25519(wrong, message, pair.rawPublic)).toBe(false);
    }
  });

  it('rejects a malformed public key rather than throwing', () => {
    const pair = pairs[3]!;
    const message = utf8('manifest');
    const signature = nodeSign(pair, message);
    expect(verifyEd25519(signature, message, pair.rawPublic.subarray(0, 31))).toBe(false);
    expect(verifyEd25519(signature, message, new Uint8Array(32))).toBe(false);
    // A y-coordinate that is not on the curve decodes to nothing.
    const offCurve = Uint8Array.from(pair.rawPublic);
    offCurve[0] = offCurve[0]! ^ 0xff;
    const result = verifyEd25519(signature, message, offCurve);
    expect(result).toBe(false);
  });

  it('rejects a non-canonical S (>= the group order), which node:crypto also rejects', () => {
    const pair = pairs[4]!;
    const message = utf8('manifest');
    const signature = nodeSign(pair, message);
    const malleable = Uint8Array.from(signature);
    malleable[63] = malleable[63]! | 0xf0; // pushes S far above L
    expect(verifyEd25519(malleable, message, pair.rawPublic)).toBe(false);
    expect(
      verify(null, Buffer.from(message), createPublicKey(pair.publicPem), Buffer.from(malleable)),
    ).toBe(false);
  });
});
