"""The signed manifest: what a device is told about a pack before it trusts it.

`packages/core/src/packs/install.ts` parses this file and the ed25519 signature is over
**these exact bytes**. Two consequences that are easy to get wrong once and never notice:

- the app never re-serialises the manifest — a JSON round-trip through a different
  serialiser is a different byte string and a broken signature — so this module writes it
  once, deterministically (sorted keys, two-space indent, UTF-8 as itself), and that file
  is the artefact;
- every field `install.ts` requires must be present with exactly its name and type
  (`MANIFEST_REQUIRED_FIELDS`). Unknown fields are tolerated by its parser, which is what
  lets S001, S002, S137 and S151 read provenance, the validator report and the licence
  table off the same document without a schema bump.

What the manifest carries beyond the install fields is the plan's §Data model list: the
provenance percentages, the validator report, the per-corpus licence rows **resolved from
the OPUS legacy pages** (the OPUS API returns no licence field and the front page grants
nothing), the share-alike declaration for the hermitdave-derived ordering, the audio
codec/bitrate/bytes INV-PACK-15 asserts against the 120 MB budget, and `ledgerUnit`
declared exactly once (INV-PACK-40).
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..config import (
    AUDIO_BUDGET_MB,
    AUDIO_PIPELINES,
    OPUS_BITRATE_KBPS,
    REVIEWER_SAMPLE_ITEMS,
)
from ..config.g9 import (
    ITEM_ID_HEX_LENGTH,
    ITEM_ID_PREFIX,
    MANIFEST_FILENAME,
    MANIFEST_REQUIRED_FIELDS,
    OPUS_LEGACY_LICENCE_URL,
    PACK_SCHEMA_VERSION,
    UNRESOLVED_LICENCE,
)

if TYPE_CHECKING:  # pragma: no cover - import cycle avoidance only
    from .sqlite import PackInputs

__all__ = [
    "audio_bytes_on_disk",
    "build_manifest",
    "ledger_unit_declarations",
    "licence_rows",
    "manifest_bytes",
    "manifest_violations",
    "write_manifest",
]

#: `nllb` -> `https://opus.nlpl.eu/legacy/NLLB-v1.php`. Matching the download URL rather
#: than keeping a second table of corpus names: the URL is already the authority for
#: which corpus and which version this build actually read.
_OPUS_URL = re.compile(r"object\.pouta\.csc\.fi/OPUS-(?P<corpus>[^/]+)/(?P<version>[^/]+)/")


def licence_url_for(source_id: str, lang: str) -> str | None:
    """Where a human checks this source's licence.

    For an OPUS-hosted corpus that is the **legacy page**, never the API and never the
    OPUS front page: the API returns no licence field at all, and the front page grants
    no blanket licence, so a manifest that recorded "OPUS" would be recording nothing
    (deep/10, edge case 4). G9 refuses to package an `UNRESOLVED` row.
    """
    from .attribution import source_url

    resolved = source_url(source_id, lang)
    if resolved is None:
        return None
    match = _OPUS_URL.search(resolved)
    if match is None:
        return resolved
    return OPUS_LEGACY_LICENCE_URL.format(
        corpus=match.group("corpus").upper(), version=match.group("version")
    )


def licence_rows(inputs: PackInputs) -> list[dict[str, Any]]:
    """One row per source this run read, with the verdict that governed it."""
    from .attribution import is_share_alike

    rows: dict[str, dict[str, Any]] = {}
    for row in inputs.licences:
        source_id = str(row.get("source_id", ""))
        licence = str(row.get("licence", UNRESOLVED_LICENCE))
        rows[source_id] = {
            "sourceId": source_id,
            "licence": licence,
            "verdict": str(row.get("verdict", "")),
            "attributionRequired": bool(row.get("attribution_required", False)),
            "attributionOwner": row.get("attribution_owner"),
            "licenceUrl": licence_url_for(source_id, inputs.lang),
            "shareAlike": is_share_alike(licence),
        }
    return [rows[key] for key in sorted(rows)]


def share_alike_declaration(inputs: PackInputs) -> list[dict[str, Any]]:
    """The share-alike clauses this pack inherits, stated rather than implied.

    The frequency data is CC BY-SA-4.0 and the ordering derived from it ships inside the
    pack as the order units are taught in, so the derived list is share-alike and the
    manifest says so. The pack's own licence is CC BY-NC-SA 4.0, which is compatible;
    what is not acceptable is inheriting the obligation silently.
    """
    return [
        {
            "sourceId": row["sourceId"],
            "licence": row["licence"],
            "obligation": (
                "A list or ordering derived from this source ships inside the pack, so "
                "the pack's own CC BY-NC-SA 4.0 terms carry this source's share-alike "
                "clause forward."
            ),
        }
        for row in licence_rows(inputs)
        if row["shareAlike"]
    ]


def audio_bytes_on_disk(audio_dir: Path) -> tuple[int, int]:
    """`(bytes, clip count)` of the shipped bank, measured rather than declared.

    Measured because INV-PACK-15 is about the size a learner downloads. A figure summed
    from the bake's own records would agree with the bake even when the bake is what went
    wrong.
    """
    if not audio_dir.exists():
        return (0, 0)
    files = sorted(path for path in audio_dir.iterdir() if path.is_file())
    return (sum(path.stat().st_size for path in files), len(files))


def _item_ids(database: Path) -> list[str]:
    import sqlite3

    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        return [
            str(row[0])
            for row in connection.execute("SELECT DISTINCT item_id FROM exercise ORDER BY item_id")
        ]
    finally:
        connection.close()


def build_manifest(inputs: PackInputs, database: Path, *, audio_dir: Path) -> dict[str, Any]:
    """Assemble the manifest for a pack that has already been written to disk."""
    from .attribution import credit_rows
    from .sqlite import cefr_claim, ledger_unit, provenance_split, shipped_sentences

    payload = database.read_bytes()
    # The SHIPPED count, not the ingest ledger's: S001 renders "{{n}}% machine-authored"
    # over what is in the pack, and a denominator of 250,000 candidates would make any
    # authored share round to zero.
    shipped = len(shipped_sentences(inputs))
    corpus_pct, machine_pct = provenance_split(inputs)
    bank_bytes, clip_count = audio_bytes_on_disk(audio_dir)
    by_pipeline = {
        pipeline: sum(
            int(clip["bytes"]) for clip in inputs.clips if str(clip["pipeline"]) == pipeline
        )
        for pipeline in AUDIO_PIPELINES
    }

    return {
        # -- what install.ts requires, exactly as it names it -------------------
        "packId": inputs.pack_id,
        "courseId": inputs.course_id,
        "major": inputs.major,
        "version": inputs.version,
        "payloadSha256": hashlib.sha256(payload).hexdigest(),
        "payloadBytes": len(payload),
        "audioBytes": bank_bytes,
        "itemIds": _item_ids(database),
        # -- what the surfaces render -----------------------------------------
        "lang": inputs.lang,
        "schemaVersion": PACK_SCHEMA_VERSION,
        # INV-PACK-40: exactly once, here, and read by every token consumer.
        "ledgerUnit": ledger_unit(inputs.lang),
        "provenance": {
            "corpusPct": corpus_pct,
            "machineAuthoredPct": machine_pct,
            "sentences": shipped,
        },
        "defectRate": inputs.defect_rate,
        "reviewerSampleItems": REVIEWER_SAMPLE_ITEMS,
        "cefrClaim": cefr_claim(inputs.lang),
        "audio": {
            "codec": "opus",
            "bitrateKbps": OPUS_BITRATE_KBPS,
            "bytes": bank_bytes,
            "clips": clip_count,
            "budgetMb": AUDIO_BUDGET_MB,
            "bytesByPipeline": by_pipeline,
        },
        "validatorReport": dict(inputs.validator_report),
        "licences": licence_rows(inputs),
        "attribution": credit_rows(inputs),
        "shareAlike": share_alike_declaration(inputs),
        "builtAt": datetime.now(UTC).isoformat(timespec="seconds"),
    }


def manifest_bytes(manifest: Mapping[str, Any]) -> bytes:
    """The exact bytes that get signed. Written once; never regenerated by a reader."""
    return (
        json.dumps(manifest, sort_keys=True, indent=2, ensure_ascii=False).encode("utf-8") + b"\n"
    )


def write_manifest(pack_dir: Path, manifest: Mapping[str, Any]) -> Path:
    pack_dir.mkdir(parents=True, exist_ok=True)
    target = pack_dir / MANIFEST_FILENAME
    target.write_bytes(manifest_bytes(manifest))
    return target


def ledger_unit_declarations(value: Any) -> int:
    """How many times `ledgerUnit` (or `ledger_unit`) appears anywhere in the manifest.

    INV-PACK-40 says **exactly once**. Two declarations is the failure it guards: one
    consumer reads the top-level value, another reads the per-unit copy somebody added
    for convenience, and the same number quietly means two things.
    """
    if isinstance(value, Mapping):
        return sum(
            (1 if key in {"ledgerUnit", "ledger_unit"} else 0) + ledger_unit_declarations(item)
            for key, item in value.items()
        )
    if isinstance(value, (list, tuple)):
        return sum(ledger_unit_declarations(item) for item in value)
    return 0


def manifest_violations(manifest: Mapping[str, Any]) -> list[str]:
    """Everything wrong with a manifest, in one list. Empty means it may be signed."""
    violations: list[str] = []

    for field in MANIFEST_REQUIRED_FIELDS:
        if field not in manifest:
            violations.append(f"manifest has no {field}; install.ts requires it by that name")
    if violations:
        return sorted(violations)

    if not isinstance(manifest["itemIds"], list) or any(
        not isinstance(item, str) for item in manifest["itemIds"]
    ):
        violations.append("manifest itemIds is not an array of strings")
    else:
        shape = re.compile(f"^{re.escape(ITEM_ID_PREFIX)}[0-9a-f]{{{ITEM_ID_HEX_LENGTH}}}$")
        bad = [item for item in manifest["itemIds"] if not shape.match(item)]
        if bad:
            violations.append(
                f"{len(bad)} item id(s) are not content hashes, starting with {bad[0]}"
            )
        if len(set(manifest["itemIds"])) != len(manifest["itemIds"]):
            violations.append("manifest itemIds carries a duplicate")

    declarations = ledger_unit_declarations(manifest)
    if declarations != 1:
        violations.append(
            f"ledgerUnit is declared {declarations} times; INV-PACK-40 requires exactly once"
        )

    audio = manifest.get("audio", {})
    if isinstance(audio, Mapping):
        budget = int(audio.get("budgetMb", AUDIO_BUDGET_MB)) * 1024 * 1024
        if int(manifest["audioBytes"]) > budget:
            violations.append(
                f"the audio bank is {int(manifest['audioBytes'])} bytes against a "
                f"{audio.get('budgetMb', AUDIO_BUDGET_MB)} MB budget (INV-PACK-15)"
            )
        if audio.get("codec") != "opus":
            violations.append(f"audio codec is {audio.get('codec')}, not opus")
        missing = [p for p in AUDIO_PIPELINES if p not in audio.get("bytesByPipeline", {})]
        if missing:
            violations.append(
                f"audio bytes are not declared for {', '.join(missing)}; INV-PACK-15 "
                f"covers all three pipelines, not lessons alone"
            )

    for row in manifest.get("licences", []):
        if row.get("licence") == UNRESOLVED_LICENCE:
            violations.append(
                f"licence for {row.get('sourceId')} is UNRESOLVED; the per-corpus row "
                f"comes from the OPUS legacy page, and a build may not guess it"
            )

    for row in manifest.get("attribution", []):
        if not str(row.get("owner", "")).strip():
            violations.append(f"attribution row {row.get('source_id')} renders no owner")

    return sorted(violations)
