import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_RUNS } from '@freelingo/testkit';
import { concatBytes, fromHex, sha256, sha256Hex, sha512, toHex, utf8 } from './hashing.js';

/**
 * The hand-rolled hashes are held against `node:crypto` on generated input. The app has
 * no `node:crypto`, so this test is the only place the shipping implementation and a real
 * one are compared — if they ever disagree on one generated case, the build is red.
 */

const arbBytes = fc.uint8Array({ maxLength: 300 });

function nodeDigest(algorithm: 'sha256' | 'sha512', bytes: Uint8Array): string {
  return createHash(algorithm).update(Buffer.from(bytes)).digest('hex');
}

describe('hashing', () => {
  it('sha256 agrees with node:crypto for any input', () => {
    fc.assert(
      fc.property(arbBytes, (bytes) => {
        expect(toHex(sha256(bytes))).toBe(nodeDigest('sha256', bytes));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('sha512 agrees with node:crypto for any input', () => {
    fc.assert(
      fc.property(arbBytes, (bytes) => {
        expect(toHex(sha512(bytes))).toBe(nodeDigest('sha512', bytes));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('matches the published FIPS 180-4 vectors, so the derived constants are the right ones', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(toHex(sha512(utf8('abc')))).toBe(
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
        '2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    );
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('crosses a block boundary the same way node:crypto does', () => {
    // 55/56/63/64 bytes for sha256 and 111/112/127/128 for sha512 are where a padding
    // bug hides: the length field no longer fits and a second block appears.
    for (const size of [0, 1, 55, 56, 63, 64, 65, 111, 112, 127, 128, 129, 256]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 7 + 13) & 0xff);
      expect(toHex(sha256(bytes)), `sha256 @${size}`).toBe(nodeDigest('sha256', bytes));
      expect(toHex(sha512(bytes)), `sha512 @${size}`).toBe(nodeDigest('sha512', bytes));
    }
  });

  it('utf8 encodes astral and combining characters the way Buffer does', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 40 }), (text) => {
        expect(Array.from(utf8(text))).toEqual(Array.from(Buffer.from(text, 'utf8')));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('hex round-trips and concatBytes preserves order', () => {
    fc.assert(
      fc.property(arbBytes, arbBytes, (a, b) => {
        expect(Array.from(fromHex(toHex(a)))).toEqual(Array.from(a));
        expect(Array.from(concatBytes(a, b))).toEqual([...a, ...b]);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
