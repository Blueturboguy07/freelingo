/**
 * Pack signing: key custody.
 *
 * A content pack ships with a signed manifest. The ed25519 **private** key exists only as
 * the `PACK_SIGNING_KEY` GitHub Actions secret on `Blueturboguy07/freelingo`; the
 * **public** key is committed here and shipped inside the app, so a device can verify a
 * pack it downloaded without trusting the host it came from.
 *
 * This module is custody only — the filename, the location, and a parser that refuses
 * anything that is not an ed25519 SPKI. The verify-before-install rule and the
 * `unverified` pack state (INV-PACK-18) land with the pack installer at P2; there is
 * deliberately no verify function here yet, because a half-written one would be the kind
 * of thing a later phase trusts.
 *
 * Named config — the path is written nowhere else.
 */

/** Relative to the repository root. */
export const PACK_SIGNING_PUBLIC_KEY_PATH = 'packages/schema/keys/pack-signing.pub';

/** The CI secret that holds the matching private key. Never read outside a workflow. */
export const PACK_SIGNING_SECRET_NAME = 'PACK_SIGNING_KEY';

/** ed25519, per the plan's Signing section. No other algorithm is accepted. */
export const PACK_SIGNING_ALGORITHM = 'ed25519';

/**
 * The 12-byte DER prefix of an ed25519 SubjectPublicKeyInfo: SEQUENCE, AlgorithmIdentifier
 * (OID 1.3.101.112, no parameters), then a 32-byte BIT STRING. An ed25519 SPKI is exactly
 * 44 bytes and every one of them starts with these.
 */
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);
export const ED25519_SPKI_LENGTH = 44;
export const ED25519_PUBLIC_KEY_LENGTH = 32;

export interface Ed25519PublicKey {
  /** The raw 32-byte public key. */
  readonly raw: Uint8Array;
  /** The full 44-byte DER SubjectPublicKeyInfo it was carried in. */
  readonly spki: Uint8Array;
}

/**
 * Parse a PEM `PUBLIC KEY` block into its raw ed25519 bytes.
 *
 * Deliberately hand-rolled rather than `node:crypto`: this same check has to run inside
 * the app, where there is no `node:crypto`, and a parser that only works on the test
 * runner would prove nothing about what ships. Throws on anything that is not an
 * ed25519 SPKI, including an RSA or P-256 key, which is the substitution that would
 * otherwise pass silently.
 */
export function parseEd25519PublicKeyPem(pem: string): Ed25519PublicKey {
  const match = /-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/.exec(pem);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error('not a PEM PUBLIC KEY block');
  }
  const base64 = body.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error('PEM body is not base64');
  }

  const binary = atob(base64);
  const spki = Uint8Array.from(binary, (c) => c.charCodeAt(0));

  if (spki.length !== ED25519_SPKI_LENGTH) {
    throw new Error(
      `expected a ${ED25519_SPKI_LENGTH}-byte ed25519 SPKI, got ${spki.length} bytes`,
    );
  }
  for (let i = 0; i < ED25519_SPKI_PREFIX.length; i += 1) {
    if (spki[i] !== ED25519_SPKI_PREFIX[i]) {
      throw new Error(`not an ed25519 SubjectPublicKeyInfo: byte ${i} is not the ed25519 OID`);
    }
  }

  return { spki, raw: spki.slice(ED25519_SPKI_PREFIX.length) };
}
