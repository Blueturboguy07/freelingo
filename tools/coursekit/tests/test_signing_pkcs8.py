"""INV-PACK-18: the real CI key encoding, with ephemeral OpenSSL-generated keys."""

from __future__ import annotations

import base64
import importlib
import json
import subprocess

import pytest
from nacl.signing import SigningKey
from typer.testing import CliRunner

from coursekit.artifacts import stage_dir
from coursekit.cli import app
from coursekit.config.sample import PACK_SIGNING_KEY_ENV
from coursekit.runlog import RunLog
from coursekit.signing import (
    MissingSigningKey,
    load_signing_key,
    parse_public_key_pem,
    public_key_spki,
    sign_manifest,
    verify_manifest,
)


def openssl_pair(algorithm: str = "ED25519") -> tuple[str, bytes]:
    # Private bytes travel only between subprocess pipes and this test's memory.
    pem = subprocess.run(
        ["openssl", "genpkey", "-algorithm", algorithm], capture_output=True, check=True
    ).stdout
    public = subprocess.run(
        ["openssl", "pkey", "-pubout"], input=pem, capture_output=True, check=True
    ).stdout
    return pem.decode(), public


def armoured(der: bytes) -> str:
    label = "PRIVATE" + " KEY"
    return f"-----BEGIN {label}-----\n{base64.b64encode(der).decode()}\n-----END {label}-----"


def test_inv_pack_18_openssl_pkcs8_secret_loads_and_matches_its_public_key(monkeypatch):
    pem, public = openssl_pair()
    monkeypatch.setenv(PACK_SIGNING_KEY_ENV, pem)
    key = load_signing_key()
    trusted = parse_public_key_pem(public.decode())
    assert public_key_spki(key) == trusted
    manifest = {"packId": "throwaway-test", "payloadSha256": "a" * 64}
    verify_manifest(sign_manifest(manifest), trusted_spki=trusted)


@pytest.mark.parametrize("algorithm", ["X25519", "ED448"])
def test_inv_pack_18_other_curve_pkcs8_keys_are_rejected(monkeypatch, algorithm):
    pem, _ = openssl_pair(algorithm)
    monkeypatch.setenv(PACK_SIGNING_KEY_ENV, pem)
    with pytest.raises(MissingSigningKey, match="Ed25519 PKCS8"):
        load_signing_key()


@pytest.mark.parametrize("mutation", ["truncate", "append", "oid", "length", "version"])
def test_inv_pack_18_malformed_pkcs8_der_is_rejected(monkeypatch, mutation):
    pem, _ = openssl_pair()
    der = bytearray(base64.b64decode("".join(pem.splitlines()[1:-1])))
    if mutation == "truncate":
        der.pop()
    elif mutation == "append":
        der.append(0)
    elif mutation == "oid":
        der[11] ^= 1
    elif mutation == "length":
        der[1] -= 1
    else:
        der[4] = 1
    monkeypatch.setenv(PACK_SIGNING_KEY_ENV, armoured(bytes(der)))
    with pytest.raises(MissingSigningKey, match="Ed25519 PKCS8"):
        load_signing_key()


@pytest.mark.parametrize("mutation", ["junk", "second-key", "wrong-footer", "bad-base64"])
def test_inv_pack_18_malformed_pem_envelope_is_rejected(monkeypatch, mutation):
    pem, _ = openssl_pair()
    if mutation == "junk":
        pem = "not-a-key\n" + pem
    elif mutation == "second-key":
        pem += pem
    elif mutation == "wrong-footer":
        pem = pem.replace("END PRIVATE", "END PUBLIC")
    else:
        lines = pem.splitlines()
        lines[1] = "!" + lines[1][1:]
        pem = "\n".join(lines)
    monkeypatch.setenv(PACK_SIGNING_KEY_ENV, pem)
    with pytest.raises(MissingSigningKey, match="malformed.*PEM"):
        load_signing_key()


def test_inv_pack_18_raw_secret_cannot_carry_an_unrelated_public_half(monkeypatch):
    key = SigningKey.generate()
    wrong_public = bytes(SigningKey.generate().verify_key)
    monkeypatch.setenv(PACK_SIGNING_KEY_ENV, base64.b64encode(bytes(key) + wrong_public).decode())
    with pytest.raises(MissingSigningKey, match="public key does not match"):
        load_signing_key()


@pytest.mark.parametrize("trusted_matches", [True, False])
def test_inv_pack_18_sign_stage_checks_committed_key_before_publishing(
    monkeypatch, trusted_matches
):
    pem, public = openssl_pair()
    monkeypatch.setenv(PACK_SIGNING_KEY_ENV, pem)
    trusted = (
        parse_public_key_pem(public.decode())
        if trusted_matches
        else public_key_spki(SigningKey.generate())
    )
    # This substitutes only the public trust anchor. No release secret is read.
    module = importlib.import_module("coursekit.stages.sign")
    monkeypatch.setattr(module, "trusted_public_key_spki", lambda: trusted)
    with RunLog("es").stage("g9", tool="coursekit", tool_version="0.1.0"):
        pass
    path = stage_dir("es", "g9") / "manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    original = '{"packId":"throwaway-test"}\n'
    path.write_text(original)
    result = CliRunner().invoke(app, ["sign", "es"])
    assert result.exit_code == (0 if trusted_matches else 4), result.output
    assert pem not in result.output
    if trusted_matches:
        verify_manifest(json.loads(path.read_text()), trusted_spki=trusted)
    else:
        assert path.read_text() == original
        assert "committed public key" in result.output
