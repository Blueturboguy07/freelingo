import { createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from '@freelingo/testkit';
import {
  ED25519_PUBLIC_KEY_LENGTH,
  ED25519_SPKI_LENGTH,
  PACK_SIGNING_ALGORITHM,
  PACK_SIGNING_PUBLIC_KEY_PATH,
  parseEd25519PublicKeyPem,
} from './signing.js';

/**
 * Key custody, not signature verification.
 *
 * The private half lives only in the `PACK_SIGNING_KEY` CI secret. What these tests can
 * check from a checkout is that the committed public half is a real ed25519 key, that the
 * in-app parser agrees with a real crypto implementation about it, and that the parser
 * rejects the substitutions that would otherwise pass unnoticed.
 *
 * INV-PACK-18 (verify before install, invalid signature maps to `unverified`) is NOT
 * claimed here: no pack installer exists yet. It lands at P2 with the verifier.
 */
describe('pack signing key custody', () => {
  const pem = readRepoFile(PACK_SIGNING_PUBLIC_KEY_PATH);

  it('the committed public key parses as a 32-byte ed25519 key', () => {
    const key = parseEd25519PublicKeyPem(pem);
    expect(key.spki).toHaveLength(ED25519_SPKI_LENGTH);
    expect(key.raw).toHaveLength(ED25519_PUBLIC_KEY_LENGTH);
  });

  it("node:crypto agrees it is ed25519, and agrees with the app's own parser byte for byte", () => {
    // The app has no node:crypto, so the shipping parser is the hand-rolled one. This
    // test is the only place the two are held against each other.
    const node = createPublicKey(pem);
    expect(node.asymmetricKeyType).toBe(PACK_SIGNING_ALGORITHM);
    const nodeSpki = new Uint8Array(node.export({ type: 'spki', format: 'der' }));
    expect(Array.from(parseEd25519PublicKeyPem(pem).spki)).toEqual(Array.from(nodeSpki));
  });

  it('the private key is not in the tree — only the public half is committed', () => {
    expect(pem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(pem).not.toContain('PRIVATE KEY');
  });

  it('the parser rejects a non-ed25519 key rather than accepting it as one', () => {
    // A P-256 SPKI: same PEM armour, same base64 shape, wrong algorithm and wrong length.
    const p256 = [
      '-----BEGIN PUBLIC KEY-----',
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfw7wTxCXfJHTbeYpGCkbkFvCFbnR',
      'hAkDBsbLnBNFtPXmnJnJvvPHLdmJU4z0CkK8g1hQdW8dEQBqk5cB4wJKbg==',
      '-----END PUBLIC KEY-----',
    ].join('\n');
    expect(() => parseEd25519PublicKeyPem(p256)).toThrow(/ed25519/);
  });

  it('the parser rejects prose, an empty block and a truncated key', () => {
    expect(() => parseEd25519PublicKeyPem('no key here')).toThrow(/PEM PUBLIC KEY/);
    expect(() =>
      parseEd25519PublicKeyPem('-----BEGIN PUBLIC KEY-----\n\n-----END PUBLIC KEY-----'),
    ).toThrow(/base64/);
    const truncated = pem.replace(/([A-Za-z0-9+/]{8})=*\n-----END/, '\n-----END');
    expect(() => parseEd25519PublicKeyPem(truncated)).toThrow();
  });
});
