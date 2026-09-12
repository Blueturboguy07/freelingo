"""`coursekit sign <lang>` — ed25519 over the manifest (INV-PACK-18)."""

from __future__ import annotations

from ..config import SIGN_STAGE_ID
from ._run import run_stages


def sign(language: str, options: dict[str, str] | None = None) -> None:
    """Sign the manifest with the ed25519 release key.

    The private key exists only as the `PACK_SIGNING_KEY` CI secret; the public key is
    committed at `packages/schema/keys/pack-signing.pub` and ships inside the app, so a
    device verifies a pack without trusting the host it came from. The key format is
    the 44-byte ed25519 SPKI `packages/schema/src/signing.ts` parses — `pynacl` is in
    the default dependency group for exactly this, and
    `tests/test_artifacts.py::test_pynacl_produces_the_spki_the_app_parses` pins the
    two sides together.

    An invalid signature maps to the `unverified` pack state, never `corrupt`.
    """
    run_stages(language, (SIGN_STAGE_ID,), options=options)
