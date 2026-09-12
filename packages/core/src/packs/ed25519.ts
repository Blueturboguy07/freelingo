/**
 * Ed25519 signature **verification** (RFC 8032 §5.1.7), pure TypeScript, no dependencies.
 *
 * Verification only. Signing happens in CI with the `PACK_SIGNING_KEY` secret and a real
 * crypto library; the device only ever needs to check, and a signing routine nobody calls
 * is a signing routine nobody tests. See `packages/schema/src/signing.ts` for key custody
 * and the SPKI parser this pairs with.
 *
 * **This is escalated, not settled** — `docs/owned/packs.json` ESC-01, for the founder.
 * Hand-writing RFC 8032 on the boundary that decides what gets installed on a learner's
 * device is above a task's pay grade when an audited implementation is already in the
 * lockfile. `packages/schema` declares `@noble/ed25519@^3.2.0` and `@noble/hashes@^2.4.0`
 * (deps commit ebbe84b), and `packages/core` cannot import `@freelingo/schema` because
 * schema already depends on core and the reverse is a cycle (`db/Db.ts` documents the same
 * constraint) — but the **npm packages** are not the workspace package: adding them to
 * `packages/core/package.json` is a one-line change, and only the deps lane may make it.
 * Verified 2026-09-11: `require.resolve('@noble/ed25519')` from `packages/core/src` fails
 * with MODULE_NOT_FOUND, so using it here today would be a phantom dependency.
 *
 * If the founder moves them, `verifyEd25519` is the one function to swap and
 * `ed25519.test.ts` is the harness that proves the swap changed nothing.
 *
 * The safety net is `ed25519.test.ts`, which holds this against `node:crypto` on
 * generated key pairs and messages, in both directions, and shows it rejecting a wrong
 * key, a truncated signature, a tampered message, a non-canonical S, and — the one that
 * catches a naive reimplementation — **agreeing** with `node:crypto` on all eight
 * small-order (torsion) point encodings, including the cofactorless forgeries OpenSSL
 * accepts, plus rejecting the two non-canonical `y >= p` encodings outright.
 *
 * Constant-time is **not** a goal and cannot be one in JavaScript: everything this
 * function touches — the public key, the signature, the manifest — is public. There is no
 * secret to leak.
 */
import { concatBytes, sha512 } from './hashing.js';

/** The field prime, 2^255 − 19. */
const P = (1n << 255n) - 19n;
/** The group order, 2^252 + 27742317777372353535851937790883648493. */
export const ED25519_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

const invert = (a: bigint): bigint => power(a, P - 2n);

/** The curve constant d = −121665/121666. */
const D = mod(-121665n * invert(121666n));
/** sqrt(−1) mod p, used when the first square-root candidate is off by a factor of i. */
const SQRT_M1 = power(2n, (P - 1n) / 4n);

/**
 * A point in extended homogeneous coordinates (X : Y : Z : T), x = X/Z, y = Y/Z, T = XY/Z.
 * Affine coordinates would need an inversion per addition; extended needs one per verify.
 */
interface Point {
  readonly x: bigint;
  readonly y: bigint;
  readonly z: bigint;
  readonly t: bigint;
}

const ZERO: Point = { x: 0n, y: 1n, z: 1n, t: 0n };

/**
 * add-2008-hwcd-3 for a = −1. Strongly unified: the same formula is correct when the two
 * points are equal, so doubling needs no second code path (and a second code path is
 * where an implementation like this normally goes wrong).
 */
function add(p1: Point, p2: Point): Point {
  const a = mod((p1.y - p1.x) * (p2.y - p2.x));
  const b = mod((p1.y + p1.x) * (p2.y + p2.x));
  const c = mod(p1.t * 2n * D * p2.t);
  const d = mod(p1.z * 2n * p2.z);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return { x: mod(e * f), y: mod(g * h), t: mod(e * h), z: mod(f * g) };
}

function multiply(point: Point, scalar: bigint): Point {
  let result = ZERO;
  let addend = point;
  let k = scalar;
  while (k > 0n) {
    if ((k & 1n) === 1n) result = add(result, addend);
    addend = add(addend, addend);
    k >>= 1n;
  }
  return result;
}

function equals(p1: Point, p2: Point): boolean {
  // Cross-multiplied, so the comparison needs no inversion.
  return mod(p1.x * p2.z) === mod(p2.x * p1.z) && mod(p1.y * p2.z) === mod(p2.y * p1.z);
}

function bytesToNumberLe(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]!);
  return value;
}

/** The base point B: y = 4/5, x recovered with the even sign. */
function basePoint(): Point {
  const y = mod(4n * invert(5n));
  const x = recoverX(y, 0n);
  if (x === null) throw new Error('ed25519: the base point does not decode');
  return { x, y, z: 1n, t: mod(x * y) };
}

/** RFC 8032 §5.1.3: recover x from y and the sign bit, or `null` if there is no such x. */
function recoverX(y: bigint, sign: bigint): bigint | null {
  if (y >= P) return null; // non-canonical encoding
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  let x = mod(u * power(v, 3n) * power(mod(u * power(v, 7n)), (P - 5n) / 8n));
  const check = mod(v * x * x);
  if (check === u) {
    // already correct
  } else if (check === mod(-u)) {
    x = mod(x * SQRT_M1);
  } else {
    return null;
  }
  if (x === 0n && sign === 1n) return null; // x = 0 has no negative encoding
  if ((x & 1n) !== sign) x = mod(-x);
  return x;
}

function decodePoint(bytes: Uint8Array): Point | null {
  if (bytes.length !== ED25519_PUBLIC_KEY_BYTES) return null;
  const copy = Uint8Array.from(bytes);
  const sign = BigInt((copy[31]! >> 7) & 1);
  copy[31] = copy[31]! & 0x7f;
  const y = bytesToNumberLe(copy);
  const x = recoverX(y, sign);
  if (x === null) return null;
  return { x, y, z: 1n, t: mod(x * y) };
}

const BASE = basePoint();

/**
 * Verify `signature` over `message` under `publicKey` (32 raw bytes, i.e. the `raw` field
 * of `parseEd25519PublicKeyPem`).
 *
 * Total: every malformed input is `false`, never a throw. A verifier that throws on a
 * short signature is a verifier whose caller has two failure paths to remember, and the
 * one nobody wrote is the one an attacker sends.
 *
 * The check is the cofactorless `[S]B = R + [k]A`, which is what OpenSSL (and therefore
 * `node:crypto`) computes.
 */
export function verifyEd25519(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    if (signature.length !== ED25519_SIGNATURE_BYTES) return false;
    if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES) return false;

    const rBytes = signature.subarray(0, 32);
    const sBytes = signature.subarray(32, 64);
    const s = bytesToNumberLe(sBytes);
    // A non-canonical S is a malleable signature; RFC 8032 requires the rejection.
    if (s >= ED25519_ORDER) return false;

    const a = decodePoint(publicKey);
    if (a === null) return false;
    const r = decodePoint(rBytes);
    if (r === null) return false;

    const k = bytesToNumberLe(sha512(concatBytes(rBytes, publicKey, message))) % ED25519_ORDER;
    return equals(multiply(BASE, s), add(r, multiply(a, k)));
  } catch {
    return false;
  }
}

/**
 * The port every install path takes, so a caller can be handed a different implementation
 * (a `node:crypto` one in a test, a native one if a future SDK grows one) without any of
 * the pack lifecycle knowing.
 */
export interface Ed25519Verifier {
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
}

/** The shipping verifier. */
export const pureEd25519Verifier: Ed25519Verifier = { verify: verifyEd25519 };
