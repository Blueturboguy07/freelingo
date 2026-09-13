"""Carry the measured G8 manifest with its bank between isolated CI jobs.

G8 also writes the reviewable content/<lang>/audio-manifest.json. A fresh checkout
has an older version of that file. Snapshot the current producer bytes into the
candidate tree, then restore only that checked artifact before V7/F2 and packaging.
No committed-manifest fallback is allowed at the consumer boundary.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Literal

from .artifacts import read_records, stage_dir
from .config.g8 import AUDIO_MANIFEST_FILENAME, BANK_DIRNAME
from .stages.g8_bake import manifest_path


def _checked_bytes(source: Path, lang: str) -> bytes:
    data = source.read_bytes()
    manifest = json.loads(data)
    if not isinstance(manifest, dict) or manifest.get("language") != lang:
        raise ValueError("candidate audio manifest has the wrong language or shape")
    clips = manifest.get("clips")
    records = list(read_records("baked_clip", lang=lang))
    if not records or not isinstance(clips, list) or not clips:
        raise ValueError("candidate audio manifest and G8 records must both be nonempty")
    if any(not isinstance(clip, dict) for clip in clips):
        raise ValueError("candidate audio manifest contains a malformed clip")
    ids = [clip.get("clip_id") for clip in clips]
    record_ids = [record["clip_id"] for record in records]
    if any(not isinstance(clip_id, str) for clip_id in ids):
        raise ValueError("candidate audio manifest contains a malformed clip id")
    if (
        len(set(ids)) != len(ids)
        or len(set(record_ids)) != len(record_ids)
        or set(ids) != set(record_ids)
    ):
        raise ValueError("candidate audio manifest must join every G8 clip exactly once")
    by_id = {clip["clip_id"]: clip for clip in clips}
    total = 0
    for record in records:
        clip = by_id[record["clip_id"]]
        for key in ("text", "path", "bytes", "duration_ms", "engine", "pipeline"):
            if clip.get(key) != record[key] or type(clip.get(key)) is not type(record[key]):
                raise ValueError(f"candidate clip {record['clip_id']} disagrees on {key}")
        if clip.get("voice") != record["voice_id"]:
            raise ValueError(f"candidate clip {record['clip_id']} disagrees on voice")
        for key in ("codec", "bitrate_kbps", "engine"):
            if manifest.get(key) != record[key]:
                raise ValueError(
                    f"candidate clip {record['clip_id']} disagrees with manifest {key}"
                )
        expected_path = f"{BANK_DIRNAME}/{record['clip_id']}.opus"
        if record["path"] != expected_path:
            raise ValueError(f"candidate clip path must be {expected_path}")
        path = stage_dir(lang, "g8") / expected_path
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"candidate audio file is missing or not a regular file: {path}")
        payload = path.read_bytes()
        if not payload or len(payload) != clip["bytes"]:
            raise ValueError(f"candidate audio file has the wrong byte count: {path}")
        if hashlib.sha256(payload).hexdigest() != clip.get("sha256"):
            raise ValueError(f"candidate audio file does not match its SHA256: {path}")
        total += len(payload)
    totals = manifest.get("totals")
    if (
        not isinstance(totals, dict)
        or totals.get("clips") != len(clips)
        or totals.get("bytes") != total
    ):
        raise ValueError("candidate audio manifest totals do not describe the complete bank")
    return data


def transfer_audio_manifest(lang: str, direction: Literal["snapshot", "restore"]) -> Path:
    """Check the exact manifest/record/file join before copying either direction."""
    current = manifest_path(lang)
    candidate = stage_dir(lang, "g8") / AUDIO_MANIFEST_FILENAME
    if direction == "snapshot":
        source, target = current, candidate
    elif direction == "restore":
        source, target = candidate, current
    else:
        raise ValueError(f"unknown audio manifest transfer: {direction}")
    data = _checked_bytes(source, lang)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("direction", choices=("snapshot", "restore"))
    parser.add_argument("lang")
    args = parser.parse_args()
    target = transfer_audio_manifest(args.lang, args.direction)
    print(f"{args.direction}: {target}")


if __name__ == "__main__":
    main()
