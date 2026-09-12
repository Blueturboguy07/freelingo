"""`coursekit sign` against the ed25519 contract in `packages/schema/src/signing.ts`.

The contract is checked from both ends. `tests/test_artifacts.py` already proves pynacl
can build the 44-byte SPKI the app's hand-rolled parser accepts; this file proves the
signing path uses it, that the constants on the Python side and the TypeScript side are
the same strings, and that the three ways a signature check can be theatre all fail.
"""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path

import pytest
from nacl.signing import SigningKey

from coursekit.config.sample import (
    ED25519_SIGNATURE_LENGTH,
    ED25519_SPKI_LENGTH,
    MANIFEST_SIGNATURE_KEY,
    PACK_SIGNING_ALGORITHM,
    PACK_SIGNING_KEY_ENV,
    PACK_SIGNING_PUBLIC_KEY_PATH,
)
from coursekit.signing import (
    MissingSigningKey,
    SignatureInvalid,
    canonical_manifest_bytes,
    load_signing_key,
    parse_public_key_pem,
    public_key_pem,
    public_key_spki,
    sign_manifest,
    trusted_public_key_spki,
    verify_manifest,
)

REPO = Path(__file__).resolve().parents[3]
SIGNING_TS = REPO / "packages" / "schema" / "src" / "signing.ts"


def a_key(seed: int = 1) -> SigningKey:
    return SigningKey(bytes([seed]) * 32)


def a_manifest() -> dict:
    return {
        "pack_version": "0.1.0",
        "lang": "es",
        "items": 1234,
        "audio_bytes": 98_000_000,
        "licences": ["CC-BY-4.0", "CC0-1.0"],
    }


# ---------------------------------------------------------------------------
# The key lives in CI and nowhere else
# ---------------------------------------------------------------------------


def test_an_unset_secret_is_a_loud_failure_with_the_reason(monkeypatch) -> None:
    monkeypatch.delenv(PACK_SIGNING_KEY_ENV, raising=False)
    with pytest.raises(MissingSigningKey, match="GitHub Actions secret"):
        load_signing_key()


def a_pem_private_key_header() -> str:
    """The header a real leaked key starts with, assembled at run time rather than typed.

    Deliberate: `.gitleaks.toml`'s `private-key` rule matches exactly this literal, and
    the pre-commit hook is right to. A test fixture that trips the secret scanner on
    every commit is a fixture that teaches people to reach for `--no-verify`.
    """
    return "-----BEGIN " + "PRIVATE KEY" + "-----"


def test_a_pem_block_in_the_secret_is_refused(monkeypatch) -> None:
    monkeypatch.setenv(PACK_SIGNING_KEY_ENV, f"{a_pem_private_key_header()}\nabc\n-----END")
    with pytest.raises(MissingSigningKey, match="not a PEM block"):
        load_signing_key()


def test_a_path_in_the_secret_is_refused(monkeypatch) -> None:
    """"It also reads a file" is how a release key reaches a developer's laptop."""
    monkeypatch.setenv(PACK_SIGNING_KEY_ENV, "/Users/someone/.freelingo/pack-signing.key")
    with pytest.raises(MissingSigningKey, match="will not read one"):
        load_signing_key()


#: A real ed25519 seed whose base64 contains the character `/`. Hard-coded rather than
#: generated so the regression is pinned even if the generator below is ever deleted.
A_SEED_WHOSE_BASE64_CONTAINS_A_SLASH = "w0aktCZaMLObTDGzvS64mDYeDnLXngT2QWlcaJX/Fpg="


def test_a_key_whose_base64_contains_a_slash_loads(monkeypatch) -> None:
    """THE regression. `/` is in the base64 alphabet; a path heuristic that looked for
    `os.sep` refused ~53% of all valid ed25519 keys — measured 107/200 over freshly
    generated seeds — and `pack-ci.yml` signs under `set -euo pipefail`, so the real
    `PACK_SIGNING_KEY` secret would have failed the whole es build on a coin flip.

    `a_key()` is `SigningKey(bytes([1]) * 32)`, whose base64 is `AQEBAQ…`: no `/`, no
    `+`, so every other test in this file passes whatever that branch does.
    """
    assert "/" in A_SEED_WHOSE_BASE64_CONTAINS_A_SLASH
    monkeypatch.setenv(PACK_SIGNING_KEY_ENV, A_SEED_WHOSE_BASE64_CONTAINS_A_SLASH)
    key = load_signing_key()
    expected = base64.b64decode(A_SEED_WHOSE_BASE64_CONTAINS_A_SLASH)
    assert bytes(key) == expected
    assert len(expected) == 32


def test_every_generated_key_loads_whatever_its_base64_happens_to_contain(monkeypatch) -> None:
    """The same property over real key generation, including `+` and `=` padding.

    200 keys is enough that a filter rejecting ~half of the alphabet cannot hide: the
    probability of 200 consecutive slash-free 32-byte keys is about 1 in 10^13.
    """
    slashy = 0
    for _ in range(200):
        generated = SigningKey.generate()
        encoded = base64.b64encode(bytes(generated)).decode("ascii")
        slashy += "/" in encoded
        monkeypatch.setenv(PACK_SIGNING_KEY_ENV, encoded)
        assert bytes(load_signing_key().verify_key) == bytes(generated.verify_key)
    assert slashy > 0, "the sample never reached the branch this test exists for"


def test_a_windows_path_is_still_named_as_a_path(monkeypatch) -> None:
    """The classification is advisory and runs only AFTER the decode has already failed,
    so it can be generous about shapes without ever rejecting a key."""
    monkeypatch.setenv(PACK_SIGNING_KEY_ENV, r"C:\keys\pack-signing.key")
    with pytest.raises(MissingSigningKey, match="will not read one"):
        load_signing_key()


def test_a_key_of_the_wrong_length_is_refused(monkeypatch) -> None:
    monkeypatch.setenv(PACK_SIGNING_KEY_ENV, base64.b64encode(b"\x01" * 16).decode())
    with pytest.raises(MissingSigningKey, match="16 bytes"):
        load_signing_key()


def test_both_the_seed_and_the_libsodium_secret_key_shapes_are_accepted(monkeypatch) -> None:
    """32 bytes and 64 bytes are what the two common key-generation snippets emit."""
    key = a_key()
    seed = bytes(key)
    monkeypatch.setenv(PACK_SIGNING_KEY_ENV, base64.b64encode(seed).decode())
    from_seed = load_signing_key()
    monkeypatch.setenv(
        PACK_SIGNING_KEY_ENV, base64.b64encode(seed + bytes(key.verify_key)).decode()
    )
    from_secret = load_signing_key()
    assert bytes(from_seed.verify_key) == bytes(from_secret.verify_key)


def test_there_is_no_key_option_on_the_sign_command() -> None:
    """A `--key` flag is the feature that puts the release key on a laptop.

    Asserted against the CLI's own help rather than the source, so a flag added anywhere
    in the option chain fails here — including one a future `--set key=…` shortcut adds.
    """
    from typer.testing import CliRunner

    from coursekit.cli import app

    output = CliRunner().invoke(app, ["sign", "--help"]).output
    assert "--key" not in output
    assert "--keyfile" not in output


# ---------------------------------------------------------------------------
# The bytes the app parses
# ---------------------------------------------------------------------------


def test_the_public_key_is_the_forty_four_byte_spki_the_app_parses() -> None:
    spki = public_key_spki(a_key())
    assert len(spki) == ED25519_SPKI_LENGTH
    assert parse_public_key_pem(public_key_pem(a_key())) == spki


def test_the_python_and_typescript_constants_agree() -> None:
    """A rename on either side must fail the build, not produce unverifiable packs."""
    source = SIGNING_TS.read_text(encoding="utf-8")
    assert f"'{PACK_SIGNING_PUBLIC_KEY_PATH}'" in source
    assert f"'{PACK_SIGNING_KEY_ENV}'" in source
    assert f"'{PACK_SIGNING_ALGORITHM}'" in source
    assert f"ED25519_SPKI_LENGTH = {ED25519_SPKI_LENGTH}" in source


def test_the_der_prefix_matches_the_one_the_app_carries() -> None:
    source = SIGNING_TS.read_text(encoding="utf-8")
    block = re.search(r"ED25519_SPKI_PREFIX = Uint8Array\.from\(\[(.*?)\]\)", source, re.S)
    assert block is not None
    declared = bytes(int(value, 16) for value in re.findall(r"0x([0-9a-f]{2})", block.group(1)))
    assert public_key_spki(a_key())[: len(declared)] == declared


def test_the_committed_public_key_parses_as_ed25519() -> None:
    assert len(trusted_public_key_spki(REPO)) == ED25519_SPKI_LENGTH


def test_an_rsa_key_is_refused_rather_than_accepted_silently() -> None:
    """The substitution a length-only check lets through."""
    fake = base64.b64encode(b"\x30\x2a\x30\x05\x06\x03\x2a\x86\x48" + b"\x00" * 35).decode()
    with pytest.raises(SignatureInvalid, match="OID"):
        parse_public_key_pem(f"-----BEGIN PUBLIC KEY-----\n{fake}\n-----END PUBLIC KEY-----")


# ---------------------------------------------------------------------------
# Signing and verifying
# ---------------------------------------------------------------------------


def test_a_signed_manifest_verifies_against_the_key_that_signed_it() -> None:
    key = a_key()
    signed = sign_manifest(a_manifest(), key=key)
    verify_manifest(signed, trusted_spki=public_key_spki(key))
    assert signed[MANIFEST_SIGNATURE_KEY]["algorithm"] == PACK_SIGNING_ALGORITHM
    raw = base64.b64decode(signed[MANIFEST_SIGNATURE_KEY]["signature"])
    assert len(raw) == ED25519_SIGNATURE_LENGTH


def test_one_changed_byte_of_the_manifest_breaks_the_signature() -> None:
    key = a_key()
    signed = sign_manifest(a_manifest(), key=key)
    signed["items"] = 1235
    with pytest.raises(SignatureInvalid, match="does not verify"):
        verify_manifest(signed, trusted_spki=public_key_spki(key))


def test_a_manifest_signed_by_another_key_is_refused(unused: None = None) -> None:
    """THE falsifier for the whole module.

    A manifest that carries its own public key and verifies against it proves that
    somebody owned *a* key — which is exactly what an attacker who re-signed a modified
    pack also has. The embedded key is compared with the shipped one first.
    """
    attacker = a_key(seed=9)
    signed = sign_manifest(a_manifest(), key=attacker)
    # Self-consistent: it verifies fine against its own key.
    verify_manifest(signed, trusted_spki=public_key_spki(attacker))
    with pytest.raises(SignatureInvalid, match="not the one shipped in the app"):
        verify_manifest(signed, trusted_spki=public_key_spki(a_key()))


def test_an_unsigned_manifest_is_unverified_never_corrupt() -> None:
    with pytest.raises(SignatureInvalid, match="`unverified`, never `corrupt`"):
        verify_manifest(a_manifest(), trusted_spki=public_key_spki(a_key()))


def test_a_wrong_algorithm_is_refused() -> None:
    signed = sign_manifest(a_manifest(), key=a_key())
    signed[MANIFEST_SIGNATURE_KEY]["algorithm"] = "rsa"
    with pytest.raises(SignatureInvalid, match="only 'ed25519'"):
        verify_manifest(signed, trusted_spki=public_key_spki(a_key()))


def test_signing_twice_produces_the_same_signature() -> None:
    """ed25519 is deterministic, and the canonicalisation must not add entropy."""
    first = sign_manifest(a_manifest(), key=a_key())
    second = sign_manifest(first, key=a_key())
    assert first[MANIFEST_SIGNATURE_KEY] == second[MANIFEST_SIGNATURE_KEY]


def test_the_signature_covers_the_manifest_without_its_own_signature_block() -> None:
    """So a verifier rebuilds the signed bytes from the shipped file and nothing else."""
    manifest = a_manifest()
    signed = sign_manifest(manifest, key=a_key())
    assert canonical_manifest_bytes(signed) == canonical_manifest_bytes(manifest)


def test_canonical_bytes_are_key_order_independent_and_reformat_proof() -> None:
    manifest = a_manifest()
    shuffled = dict(reversed(list(manifest.items())))
    assert canonical_manifest_bytes(manifest) == canonical_manifest_bytes(shuffled)
    round_tripped = json.loads(json.dumps(manifest, indent=4))
    assert canonical_manifest_bytes(round_tripped) == canonical_manifest_bytes(manifest)


def test_non_ascii_in_a_manifest_survives_canonicalisation() -> None:
    """Attribution owners and unit titles carry accents; `ensure_ascii` would change bytes."""
    manifest = {"attribution": "Tatoeba contribuidores — español"}
    signed = sign_manifest(manifest, key=a_key())
    verify_manifest(signed, trusted_spki=public_key_spki(a_key()))
    assert "español".encode() in canonical_manifest_bytes(manifest)
