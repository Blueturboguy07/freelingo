"""The `sign` stage — `coursekit sign <lang>` (INV-PACK-18).

A thin adapter over `coursekit.signing`, which holds the ed25519 contract and every
refusal. The stage reads G9's `manifest.json`, writes it back with a `signature` block,
and then **verifies what it just wrote against the committed public key** — the key that
ships inside the app — before reporting success. Signing and not checking is how a pack
gets signed with the wrong key and nobody finds out until a device refuses to install it.

The private key is only ever `PACK_SIGNING_KEY` in CI. There is no `--key` flag.

Owner: p2-validate-sample-ci
"""

from __future__ import annotations

import json

from ..artifacts import stage_dir
from ..config import PACK_STAGE_ID
from ..config.sample import MANIFEST_FILENAME
from ..runlog import require_successful
from ..signing import (
    MissingSigningKey,
    SignatureInvalid,
    sign_manifest,
    trusted_public_key_spki,
    verify_manifest,
)
from . import StageContext, StageResult, register_stage


@register_stage("sign")
def sign(ctx: StageContext) -> StageResult:
    """Sign G9's manifest, then verify the signature against the shipped public key."""
    require_successful(ctx.lang, (PACK_STAGE_ID,))
    manifest_path = stage_dir(ctx.lang, PACK_STAGE_ID) / MANIFEST_FILENAME
    if not manifest_path.exists():
        return StageResult(
            ok=False,
            message=(
                f"no manifest at {manifest_path}; G9 reports success but wrote none. "
                f"Signing an absent manifest would produce a signature over nothing."
            ),
        )

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    try:
        signed = sign_manifest(manifest)
    except MissingSigningKey as exc:
        return StageResult(ok=False, message=str(exc))

    try:
        verify_manifest(signed, trusted_spki=trusted_public_key_spki())
    except SignatureInvalid as exc:
        return StageResult(
            ok=False,
            message=(
                f"the manifest was signed and then failed verification against the "
                f"committed public key: {exc} A device would report this pack as "
                f"`unverified`, so it must not leave CI."
            ),
        )

    manifest_path.write_text(
        json.dumps(signed, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    ctx.entry.written = 1
    ctx.entry.note(
        manifest=str(manifest_path),
        algorithm=signed["signature"]["algorithm"],
        verified_against="packages/schema/keys/pack-signing.pub",
    )
    return StageResult(ok=True)
