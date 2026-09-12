/**
 * SHA-256 and SHA-512, with **no dependencies at all**.
 *
 * Why hand-rolled rather than a library, in a repo that happily takes `ts-fsrs` as a real
 * dependency: these two run in three places that do not share a crypto surface.
 *
 * - `node:sqlite` tests on CI, where `node:crypto` exists;
 * - React Native/Hermes on the device, where there is **no `node:crypto` and no WebCrypto
 *   `subtle`** — the async `crypto.subtle.digest` path that every "isomorphic" wrapper
 *   falls back to is simply absent, so the shipping path has to be synchronous JS;
 * - `packages/core`, which is a **pure** package: its `package.json` declares one runtime
 *   dependency and the P1 deps task put `@noble/*` in `packages/schema`, which depends on
 *   core and therefore cannot be depended on back (see `db/Db.ts` on the cycle).
 *
 * So the choice was: a hash that only works on the test runner, or a hash that works
 * everywhere. The safety net is that both are held against `node:crypto` over generated
 * inputs in `hashing.test.ts` — a disagreement on any generated case is a red build.
 *
 * The round constants are **derived, not pasted**. SHA-2's tables are the fractional parts
 * of the square and cube roots of the first primes, and eighty hand-copied 64-bit hex
 * literals are eighty chances to transpose a digit into a hash that is subtly wrong and
 * passes every short test. `icbrt(p << 192) mod 2^64` is the definition, and it is
 * checkable by eye against FIPS 180-4's first entry.
 */

const MASK64 = (1n << 64n) - 1n;
const MASK32 = 0xffffffff;

/** The first `count` primes. */
function primes(count: number): number[] {
  const found: number[] = [];
  for (let n = 2; found.length < count; n += 1) {
    if (found.every((p) => p * p > n || n % p !== 0)) found.push(n);
  }
  return found;
}

/** Integer square root, Newton. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Integer cube root, Newton. */
function icbrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (2n * x + n / (x * x)) / 3n;
  while (y < x) {
    x = y;
    y = (2n * x + n / (x * x)) / 3n;
  }
  return x;
}

/** `frac(cbrt(p)) * 2^bits`, i.e. the SHA-2 round constants. */
function cbrtFraction(p: number, bits: bigint): bigint {
  return icbrt(BigInt(p) << (3n * bits)) & ((1n << bits) - 1n);
}

/** `frac(sqrt(p)) * 2^bits`, i.e. the SHA-2 initial hash values. */
function sqrtFraction(p: number, bits: bigint): bigint {
  return isqrt(BigInt(p) << (2n * bits)) & ((1n << bits) - 1n);
}

const K512: readonly bigint[] = primes(80).map((p) => cbrtFraction(p, 64n));
const H512: readonly bigint[] = primes(8).map((p) => sqrtFraction(p, 64n));
const K256: readonly number[] = primes(64).map((p) => Number(cbrtFraction(p, 32n)));
const H256: readonly number[] = primes(8).map((p) => Number(sqrtFraction(p, 32n)));

function rotr64(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** Length-padding shared by both: 0x80, zeros, then the bit length big-endian. */
function pad(message: Uint8Array, blockBytes: number, lengthBytes: number): Uint8Array {
  const bitLength = BigInt(message.length) * 8n;
  const withOne = message.length + 1;
  const blocks = Math.ceil((withOne + lengthBytes) / blockBytes);
  const out = new Uint8Array(blocks * blockBytes);
  out.set(message, 0);
  out[message.length] = 0x80;
  let value = bitLength;
  for (let i = out.length - 1; i >= out.length - lengthBytes; i -= 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

export function sha512(message: Uint8Array): Uint8Array {
  const data = pad(message, 128, 16);
  const h = [...H512];
  const w = new Array<bigint>(80);

  for (let offset = 0; offset < data.length; offset += 128) {
    for (let i = 0; i < 16; i += 1) {
      let word = 0n;
      for (let b = 0; b < 8; b += 1) word = (word << 8n) | BigInt(data[offset + i * 8 + b]!);
      w[i] = word;
    }
    for (let i = 16; i < 80; i += 1) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = rotr64(x, 1n) ^ rotr64(x, 8n) ^ (x >> 7n);
      const s1 = rotr64(y, 19n) ^ rotr64(y, 61n) ^ (y >> 6n);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) & MASK64;
    }

    let [a, b, c, d, e, f, g, hh] = h as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    for (let i = 0; i < 80; i += 1) {
      const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ (~e & MASK64 & g);
      const temp1 = (hh + S1 + ch + K512[i]! + w[i]!) & MASK64;
      const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) & MASK64;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) & MASK64;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & MASK64;
    }
    const round = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i += 1) h[i] = (h[i]! + round[i]!) & MASK64;
  }

  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i += 1) {
    let value = h[i]!;
    for (let b = 7; b >= 0; b -= 1) {
      out[i * 8 + b] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return out;
}

export function sha256(message: Uint8Array): Uint8Array {
  const data = pad(message, 64, 8);
  const h = [...H256];
  const w = new Array<number>(64);

  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] =
        ((data[offset + i * 4]! << 24) |
          (data[offset + i * 4 + 1]! << 16) |
          (data[offset + i * 4 + 2]! << 8) |
          data[offset + i * 4 + 3]!) >>>
        0;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = (rotr32(x, 7) ^ rotr32(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr32(y, 17) ^ rotr32(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + K256[i]! + w[i]!) >>> 0;
      const S0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    const round = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i += 1) h[i] = (h[i]! + round[i]!) >>> 0;
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i += 1) {
    const value = h[i]! & MASK32;
    out[i * 4] = (value >>> 24) & 0xff;
    out[i * 4 + 1] = (value >>> 16) & 0xff;
    out[i * 4 + 2] = (value >>> 8) & 0xff;
    out[i * 4 + 3] = value & 0xff;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`not a hex string: ${hex.slice(0, 16)}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** UTF-8 encode without `TextEncoder`, which Hermes has but old JSC engines do not. */
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return Uint8Array.from(out);
}

export function sha256Hex(input: Uint8Array | string): string {
  return toHex(sha256(typeof input === 'string' ? utf8(input) : input));
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
