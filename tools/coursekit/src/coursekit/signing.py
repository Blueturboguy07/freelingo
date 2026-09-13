"""`coursekit sign <lang>` — ed25519 over the pack manifest (INV-PACK-18).

The contract is `packages/schema/src/signing.ts`, and it is a contract in the strict
sense: the app parses a 44-byte ed25519 `SubjectPublicKeyInfo` with a hand-rolled parser
(there is no `node:crypto` on a phone), so this module has to produce exactly those
bytes rather than whatever a convenience API hands back.

Three rules, each of which is a hole if it is not written down:

* **The private key exists only as the `PACK_SIGNING_KEY` CI secret.** There is no
  `--key` flag and no file path. A signing tool that will read a key off disk is a
  signing tool whose key ends up on disk.
* **The signature covers the manifest with its own signature block removed**, serialised
  as sorted-key, compact JSON. A verifier reconstructs the signed bytes from the shipped
  file; nothing rides alongside it.
* **Verification compares the embedded public key with the trusted one.** A signature
  that verifies against the key packaged next to it proves only that somebody owned *a*
  key. The trusted key is the committed `packages/schema/keys/pack-signing.pub`, which
  ships inside the app.

An invalid signature maps to the `unverified` pack state, never `corrupt` (plan, Data
model).
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Final

from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

from .config.sample import (
    ED25519_PKCS8_LENGTH,
    ED25519_PKCS8_PREFIX_HEX,
    ED25519_SEED_LENGTH,
    ED25519_SIGNATURE_LENGTH,
    ED25519_SPKI_LENGTH,
    ED25519_SPKI_PREFIX_HEX,
    MANIFEST_SIGNATURE_KEY,
    PACK_SIGNING_ALGORITHM,
    PACK_SIGNING_KEY_ENV,
    PACK_SIGNING_PUBLIC_KEY_PATH,
)

__all__ = [
    "MissingSigningKey",
    "SignatureInvalid",
    "canonical_manifest_bytes",
    "load_signing_key",
    "public_key_pem",
    "public_key_spki",
    "sign_manifest",
    "trusted_public_key_spki",
    "verify_manifest",
]


class MissingSigningKey(RuntimeError):
    """`PACK_SIGNING_KEY` is absent or malformed. Never a fallback, never a local key."""


class SignatureInvalid(RuntimeError):
    """A manifest's signature does not verify, or verifies against the wrong key."""


def _spki_prefix() -> bytes:
    return bytes.fromhex(ED25519_SPKI_PREFIX_HEX)


def _repo_root() -> Path:
    """`tools/coursekit/src/coursekit/signing.py` -> five parents is the repo root.

    Same walk, and the same reasoning, as `coursekit.artifacts`: a `.git` probe breaks
    inside a worktree's `.git` FILE and inside a source distribution, while the monorepo
    path shape only changes when somebody moves the package.
    """
    return Path(__file__).resolve().parents[4]


#: Advisory only. `"/"` is a member of the standard base64 alphabet, so roughly half of
#: all valid ed25519 keys contain one and a `os.sep in value` test refuses them: measured
#: over 200 freshly generated seeds, 107 were refused, e.g.
#: `w0aktCZaMLObTDGzvS64mDYeDnLXngT2QWlcaJX/Fpg=`. Nothing here may *reject* a value — a
#: value is only ever classified as a path AFTER base64 decoding has already failed or
#: produced the wrong number of bytes, and then only to make the error message useful.
_PATH_PREFIXES: Final[tuple[str, ...]] = ("/", "~", "./", "../", ".\\", "..\\")


def _looks_like_a_path(value: str) -> bool:
    """Advisory classification of an ALREADY-REJECTED value. Never a rejection itself."""
    if value.startswith(_PATH_PREFIXES):
        return True
    if re.match(r"^[A-Za-z]:[\\/]", value):  # C:\keys\pack.key
        return True
    return value.endswith((".key", ".pem", ".b64", ".txt", ".json"))


def load_signing_key(env_var: str = PACK_SIGNING_KEY_ENV) -> SigningKey:
    """The ed25519 private key, from the CI secret and nowhere else.

    Accepts an unencrypted Ed25519 PKCS8 PEM, or base64 of a 32-byte seed or
    libsodium's 64-byte seed-plus-public-key representation. PEM is decoded strictly:
    the RFC 8410 version-zero DER envelope, absent algorithm parameters, Ed25519 OID,
    nested OCTET STRING and exact 32-byte seed must all match. Optional attributes and
    version-one public-key extensions are not accepted by this importer.

    No format reads a path. A path-like raw value is named only after base64 decoding
    fails, because `/` is also part of the base64 alphabet.
    """
    raw = os.environ.get(env_var)
    if raw is None or not raw.strip():
        raise MissingSigningKey(
            f"{env_var} is not set. The pack signing key exists only as the "
            f"{env_var} GitHub Actions secret on Blueturboguy07/freelingo; there is "
            f"deliberately no --key flag and no local key file. Run `coursekit sign` "
            f"from `pack-ci.yml`, or generate a throwaway key for a test."
        )
    value = raw.strip()
    if "-----" in value:
        return _load_pkcs8_pem(value, env_var)
    compact = re.sub(r"\s+", "", value)
    try:
        material = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise MissingSigningKey(
            f"{env_var} is not valid base64: {exc}.{_path_hint(env_var, compact)}"
        ) from exc
    if len(material) not in (ED25519_SEED_LENGTH, ED25519_SEED_LENGTH * 2):
        raise MissingSigningKey(
            f"{env_var} decoded to {len(material)} bytes; an ed25519 key is "
            f"{ED25519_SEED_LENGTH} (seed) or {ED25519_SEED_LENGTH * 2} "
            f"(seed followed by the public key).{_path_hint(env_var, compact)}"
        )
    key = SigningKey(material[:ED25519_SEED_LENGTH])
    if len(material) == ED25519_SEED_LENGTH * 2 and material[ED25519_SEED_LENGTH:] != bytes(
        key.verify_key
    ):
        raise MissingSigningKey(f"{env_var}: the supplied public key does not match its seed")
    return key


def _load_pkcs8_pem(value: str, env_var: str) -> SigningKey:
    """Import the standard Ed25519 PrivateKeyInfo; never echo private material.

    The fixed DER prefix is RFC 8410 section 10.3's version-zero encoding:
    https://www.rfc-editor.org/rfc/rfc8410.html#section-10.3
    An X25519 key has the same length but a different OID, so slicing off a seed
    without checking the entire envelope would sign with the wrong algorithm's key.
    """
    label = "PRIVATE" + " KEY"
    match = re.fullmatch(
        rf"-----BEGIN {label}-----\s+([A-Za-z0-9+/=\s]+)-----END {label}-----",
        value,
    )
    if match is None:
        raise MissingSigningKey(f"{env_var}: malformed or unsupported private-key PEM")
    try:
        der = base64.b64decode(re.sub(r"\s+", "", match.group(1)), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise MissingSigningKey(f"{env_var}: malformed private-key PEM base64") from exc
    prefix = bytes.fromhex(ED25519_PKCS8_PREFIX_HEX)
    if len(der) != ED25519_PKCS8_LENGTH or not der.startswith(prefix):
        raise MissingSigningKey(
            f"{env_var}: expected a standard unencrypted Ed25519 PKCS8 key; "
            "the DER version, algorithm OID, lengths and seed envelope must match"
        )
    return SigningKey(der[len(prefix) :])


def _path_hint(env_var: str, value: str) -> str:
    if not _looks_like_a_path(value):
        return ""
    return (
        f" {env_var} looks like a filesystem path, and this tool will not read one: a "
        f"signing tool that reads a key off disk is a signing tool whose key ends up on "
        f"disk. Put the base64 key in the secret itself."
    )


def public_key_spki(key: SigningKey | VerifyKey) -> bytes:
    """The 44-byte DER SubjectPublicKeyInfo `packages/schema/src/signing.ts` parses."""
    verify = key.verify_key if isinstance(key, SigningKey) else key
    spki = _spki_prefix() + bytes(verify)
    if len(spki) != ED25519_SPKI_LENGTH:
        raise SignatureInvalid(
            f"built a {len(spki)}-byte SPKI; the app's parser accepts exactly "
            f"{ED25519_SPKI_LENGTH}."
        )
    return spki


def public_key_pem(key: SigningKey | VerifyKey) -> str:
    """The PEM `PUBLIC KEY` block, in the shape of the committed key file."""
    body = base64.b64encode(public_key_spki(key)).decode("ascii")
    return f"-----BEGIN PUBLIC KEY-----\n{body}\n-----END PUBLIC KEY-----\n"


def parse_public_key_pem(pem: str) -> bytes:
    """PEM -> the 44-byte SPKI, refusing anything that is not ed25519.

    The mirror of `parseEd25519PublicKeyPem` in `packages/schema/src/signing.ts`. An RSA
    or P-256 key is the substitution that otherwise passes silently, so the OID prefix is
    checked rather than assumed.
    """
    match = re.search(r"-----BEGIN PUBLIC KEY-----(.*?)-----END PUBLIC KEY-----", pem, re.S)
    if match is None:
        raise SignatureInvalid("not a PEM PUBLIC KEY block")
    spki = base64.b64decode(re.sub(r"\s+", "", match.group(1)), validate=True)
    if len(spki) != ED25519_SPKI_LENGTH:
        raise SignatureInvalid(
            f"expected a {ED25519_SPKI_LENGTH}-byte ed25519 SPKI, got {len(spki)} bytes"
        )
    prefix = _spki_prefix()
    if spki[: len(prefix)] != prefix:
        raise SignatureInvalid("not an ed25519 SubjectPublicKeyInfo: the OID does not match")
    return spki


def trusted_public_key_spki(repo_root: Path | None = None) -> bytes:
    """The committed public key — the one that ships inside the app."""
    root = repo_root or _repo_root()
    return parse_public_key_pem((root / PACK_SIGNING_PUBLIC_KEY_PATH).read_text(encoding="utf-8"))


def canonical_manifest_bytes(manifest: Mapping[str, Any]) -> bytes:
    """The exact bytes a signature covers: the manifest, minus its signature block.

    Sorted keys, no insignificant whitespace, UTF-8, `ensure_ascii=False`. A verifier
    rebuilds these from the shipped `manifest.json`, so the pack needs no second copy of
    the manifest and a reformatting of the file on the way out breaks the signature
    rather than silently changing what was signed.
    """
    payload = {key: value for key, value in manifest.items() if key != MANIFEST_SIGNATURE_KEY}
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sign_manifest(
    manifest: Mapping[str, Any],
    *,
    key: SigningKey | None = None,
    env_var: str = PACK_SIGNING_KEY_ENV,
) -> dict[str, Any]:
    """Return the manifest with its `signature` block filled in.

    `key` exists for tests. Nothing in the build path passes it; `pack-ci.yml` sets
    `PACK_SIGNING_KEY` from the repository secret and this reads it.
    """
    signing_key = key or load_signing_key(env_var)
    signature = signing_key.sign(canonical_manifest_bytes(manifest)).signature
    signed = {key_: value for key_, value in manifest.items() if key_ != MANIFEST_SIGNATURE_KEY}
    signed[MANIFEST_SIGNATURE_KEY] = {
        "algorithm": PACK_SIGNING_ALGORITHM,
        "public_key": base64.b64encode(public_key_spki(signing_key)).decode("ascii"),
        "signature": base64.b64encode(signature).decode("ascii"),
    }
    return signed


def verify_manifest(manifest: Mapping[str, Any], *, trusted_spki: bytes) -> None:
    """Raise `SignatureInvalid` unless the manifest is signed by the trusted key.

    The second half is the one that is easy to leave out. A manifest that carries its own
    public key and verifies against it proves that somebody owned *a* key, which is what
    an attacker who re-signs a modified pack also has. So the embedded key is compared
    with the committed one first, and only then is the signature checked.
    """
    block = manifest.get(MANIFEST_SIGNATURE_KEY)
    if not isinstance(block, Mapping):
        raise SignatureInvalid(
            f"the manifest carries no {MANIFEST_SIGNATURE_KEY!r} block; an unsigned pack "
            f"is `unverified`, never `corrupt`."
        )
    if block.get("algorithm") != PACK_SIGNING_ALGORITHM:
        raise SignatureInvalid(
            f"algorithm is {block.get('algorithm')!r}; only {PACK_SIGNING_ALGORITHM!r} is accepted."
        )
    try:
        embedded = base64.b64decode(block["public_key"], validate=True)
        signature = base64.b64decode(block["signature"], validate=True)
    except (KeyError, binascii.Error, ValueError) as exc:
        raise SignatureInvalid(f"signature block is malformed: {exc}") from exc

    if embedded != trusted_spki:
        raise SignatureInvalid(
            "the manifest is signed by a key that is not the one shipped in the app. "
            "A pack that carries its own key and verifies against it proves nothing."
        )
    if len(signature) != ED25519_SIGNATURE_LENGTH:
        raise SignatureInvalid(
            f"signature is {len(signature)} bytes; ed25519 signatures are "
            f"{ED25519_SIGNATURE_LENGTH}."
        )
    verify_key = VerifyKey(embedded[len(_spki_prefix()) :])
    try:
        verify_key.verify(canonical_manifest_bytes(manifest), signature)
    except BadSignatureError as exc:
        raise SignatureInvalid(f"signature does not verify: {exc}") from exc
