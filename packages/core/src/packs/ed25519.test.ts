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

  /**
   * Small-order (torsion) points.
   *
   * Ed25519's group has cofactor 8, so eight points have order dividing 8. They are the
   * classic verifier trap: a *cofactorless* check — which is what OpenSSL, and therefore
   * `node:crypto`, computes, and what this implementation deliberately matches — **accepts**
   * a forged signature under some of them, and a verifier that quietly disagreed with
   * OpenSSL here would accept packs the signing CI would never produce, or reject ones it
   * would. The requirement is therefore agreement, not blanket rejection, and the pinned
   * public key is what actually keeps a torsion key out of the install path.
   */
  const SMALL_ORDER_ENCODINGS: readonly string[] = [
    '0100000000000000000000000000000000000000000000000000000000000000', // identity, order 1
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // order 2
    '0000000000000000000000000000000000000000000000000000000000000000', // order 4
    '0000000000000000000000000000000000000000000000000000000000000080', // order 4
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', // order 8
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', // order 8
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85', // order 8
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa', // order 8
  ];

  /** y >= p: not a point encoding at all, whatever its order would be. */
  const NON_CANONICAL_ENCODINGS: readonly string[] = [
    'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // y = p
    'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // y = p + 1
  ];

  const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  const hex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'hex'));

  function nodeVerdict(rawPublic: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
    const spki = Buffer.concat([SPKI_PREFIX, Buffer.from(rawPublic)]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message), key, Buffer.from(signature));
  }

  /**
   * The one cell where OpenSSL versions disagree with each other, named rather than
   * papered over.
   *
   * Measured at P1 integration, same commit, same code, two platforms:
   *
   * | cell                            | ours | node:crypto, OpenSSL 3.6.4 (macOS, node v24.18.0) | node:crypto on ubuntu-latest (node v24.20.0), CI run 34672723507 |
   * | ------------------------------- | ---- | -------------------------------------------------- | ---------------------------------------------------------------- |
   * | identity key, `R = id, S = 0`   | true | **true**                                           | **false**                                                        |
   * | every other torsion cell (23)   | false| false                                              | false                                                            |
   *
   * The original assertion here was `expect(ours).toBe(theirs)` for all 24 cells. It
   * passed on this Mac and failed on the runner with
   * `disagreed with node:crypto on torsion key 01000000: expected true to be false`, and
   * it would have kept failing on any OpenSSL that rejects small-order public keys before
   * it ever evaluates the equation. That assertion was therefore not a statement about
   * this verifier at all — it pinned the runner's OpenSSL version.
   *
   * So the claim is split into the two things actually being claimed:
   *
   * 1. **What this verifier does** is asserted against a committed table, below. It is
   *    deterministic, it is the cofactorless rule RFC 8032 §5.1.7 describes, and it does
   *    not move when a runner image does.
   * 2. **Agreement with node:crypto** is still asserted on all 24 cells, with exactly one
   *    documented exemption: an OpenSSL that rejects the identity key outright disagrees
   *    on that one forgery. The test records which behaviour it saw, and a divergence in
   *    any OTHER cell is still a failure — so this is an exemption of one named cell, not
   *    a relaxation of the check.
   *
   * None of it can reach the install path: `verifyPackSignature` compares against a
   * PINNED public key, and no torsion encoding is that key. That is what the original
   * comment above already said, and it is why the right resolution is to state the
   * platform difference rather than to make the verifier match whichever OpenSSL ran last.
   */
  const TORSION_DIVERGENT_CELL = { key: SMALL_ORDER_ENCODINGS[0]!, signature: 'R=identity,S=0' };

  it('agrees with node:crypto on every small-order (torsion) public key, except the one cell OpenSSL versions disagree on', () => {
    const message = utf8('freelingo-pack-manifest');
    const identity = hex(SMALL_ORDER_ENCODINGS[0]!);
    const signatures: readonly (readonly [string, Uint8Array])[] = [
      // R = identity, S = 0: the classic cofactorless forgery.
      ['R=identity,S=0', Uint8Array.from([...identity, ...new Uint8Array(32)])],
      // A real signature under a real key, offered under the torsion key instead.
      ['real signature, wrong key', nodeSign(pairs[0]!, message)],
      // S = 1, R = identity: no longer a forgery for any of them.
      ['R=identity,S=1', Uint8Array.from([...identity, 1, ...new Uint8Array(31)])],
    ];

    /** Our verdict for every cell: exactly one acceptance, and it is the known forgery. */
    const ourVerdicts: Record<string, boolean> = {};
    const divergences: string[] = [];
    let accepted = 0;

    for (const encoding of SMALL_ORDER_ENCODINGS) {
      const rawPublic = hex(encoding);
      for (const [label, signature] of signatures) {
        const cell = `${encoding.slice(0, 8)} ${label}`;
        const ours = verifyEd25519(signature, message, rawPublic);
        ourVerdicts[cell] = ours;
        if (ours) accepted += 1;

        // node:crypto may reject a small-order key before it evaluates anything, and on
        // some builds that is a throw rather than a false. Both are "it said no".
        let theirs: boolean;
        try {
          theirs = nodeVerdict(rawPublic, signature, message);
        } catch {
          theirs = false;
        }
        if (ours !== theirs) divergences.push(`${cell}: ours=${ours} node=${theirs}`);
      }
    }

    // 1. What THIS verifier does. Cofactorless: the identity key accepts the zero
    //    forgery and nothing else in the set accepts anything.
    expect(
      verifyEd25519(signatures[0]![1], message, hex(SMALL_ORDER_ENCODINGS[0]!)),
      'the cofactorless identity forgery no longer verifies — the verifier changed rule',
    ).toBe(true);
    expect(accepted, 'exactly one of the 24 torsion cells is a cofactorless acceptance').toBe(1);

    // 2. Agreement with node:crypto, everywhere but the one documented cell.
    const unexpected = divergences.filter(
      (d) =>
        !d.startsWith(
          `${TORSION_DIVERGENT_CELL.key.slice(0, 8)} ${TORSION_DIVERGENT_CELL.signature}`,
        ),
    );
    expect(
      unexpected,
      'this verifier and node:crypto disagree somewhere other than the identity/zero-forgery ' +
        'cell, which is the only divergence OpenSSL versions are known to produce. Any other ' +
        'disagreement means the two no longer share a definition of a valid pack signature.',
    ).toEqual([]);

    // Recorded, not asserted: which side of the OpenSSL change this runner is on.
    if (divergences.length > 0) {
      console.log(
        `ed25519: this OpenSSL (${process.versions.openssl}) rejects the small-order ` +
          `identity key outright — ${divergences.join('; ')}`,
      );
    }
  });

  it('rejects a non-canonical point encoding (y >= p) outright', () => {
    const message = utf8('freelingo-pack-manifest');
    const signature = nodeSign(pairs[1]!, message);
    for (const encoding of NON_CANONICAL_ENCODINGS) {
      expect(verifyEd25519(signature, message, hex(encoding))).toBe(false);
      // The same value used as R inside the signature, rather than as the key.
      const forged = Uint8Array.from([...hex(encoding), ...signature.subarray(32)]);
      expect(verifyEd25519(forged, message, pairs[1]!.rawPublic)).toBe(false);
    }
  });
});
