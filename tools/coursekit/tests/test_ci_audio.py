"""Fresh-checkout CI handoff falsifiers for V7 / INV-AUD-08 / INV-PACK-15."""

from __future__ import annotations

import hashlib
import json
import shutil

import pytest
from test_validators_audio import _blocking, _clip, _context, _manifest

from coursekit.artifacts import stage_dir, write_records
from coursekit.config import BUILD_ROOT_ENV_VAR
from coursekit.config.g8 import AUDIO_MANIFEST_FILENAME, CONTENT_ROOT_ENV_VAR
from coursekit.validators.audio import audio_budget, string_audio_join


def transfer(direction):
    from coursekit.ci_audio import transfer_audio_manifest

    return transfer_audio_manifest("es", direction)


@pytest.fixture
def bank(tmp_path, monkeypatch):
    content = tmp_path / "producer-content"
    monkeypatch.setenv(CONTENT_ROOT_ENV_VAR, str(content))
    payload = b"independent throwaway clip bytes"
    clip = _clip(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
    path = stage_dir("es", "g8") / clip["path"]
    path.parent.mkdir(parents=True)
    path.write_bytes(payload)
    record = {
        "schema_version": 1,
        "lang": "es",
        "clip_id": clip["clip_id"],
        "text": clip["text"],
        "voice_id": clip["voice"],
        "engine": clip["engine"],
        "codec": "opus",
        "bitrate_kbps": 20,
        "duration_ms": clip["duration_ms"],
        "bytes": clip["bytes"],
        "path": clip["path"],
        "licence": "Apache-2.0",
        "pipeline": "lesson",
    }
    write_records("baked_clip", [record], lang="es")
    write_records(
        "exercise",
        [
            {
                "schema_version": 1,
                "lang": "es",
                "exercise_id": "1" * 16,
                "unit_index": 1,
                "lesson_index": 1,
                "type": "speak",
                "prompt": "Speak this sentence\n" + clip["text"],
                "accepted_answers": [clip["text"]],
                "distractors": [],
                "alignment": [],
                "source_sentence_id": None,
                "audio_ref": None,
                "register": "tu",
                "item_tags": {"lemmas": ["gato"], "grammar_concepts": []},
            }
        ],
        lang="es",
    )
    original = content / "es" / AUDIO_MANIFEST_FILENAME
    original.parent.mkdir(parents=True)
    original.write_text(json.dumps(_manifest([clip]), ensure_ascii=False))
    return original, path, payload


def test_inv_pack_15_current_manifest_crosses_clean_ci_job_and_validates(
    bank, tmp_path, monkeypatch
):
    original, _, _ = bank
    expected = original.read_bytes()
    snapshot = transfer("snapshot")
    assert snapshot.read_bytes() == expected
    downloaded = tmp_path / "validator-build"
    shutil.copytree(stage_dir("es", "g8").parents[1], downloaded)
    content = tmp_path / "fresh-checkout"
    stale = content / "es" / AUDIO_MANIFEST_FILENAME
    stale.parent.mkdir(parents=True)
    stale.write_text(json.dumps(_manifest([])))
    monkeypatch.setenv(BUILD_ROOT_ENV_VAR, str(downloaded))
    monkeypatch.setenv(CONTENT_ROOT_ENV_VAR, str(content))
    assert _blocking(string_audio_join(_context()))
    restored = transfer("restore")
    assert restored == stale and restored.read_bytes() == expected
    assert not _blocking(string_audio_join(_context()))
    assert not _blocking(audio_budget(_context()))


@pytest.mark.parametrize(
    "damage",
    [
        "absent",
        "missing_clip",
        "same_size_change",
        "stale_manifest",
        "duplicate_id",
        "wrong_hash",
        "wrong_text",
        "wrong_voice",
        "wrong_duration",
        "wrong_totals",
        "wrong_language",
    ],
)
def test_inv_aud_08_restore_refuses_incomplete_or_mismatched_candidate(bank, damage):
    original, path, payload = bank
    snapshot = transfer("snapshot")
    before = original.read_bytes()
    data = json.loads(snapshot.read_bytes())
    if damage == "absent":
        snapshot.unlink()
    elif damage == "missing_clip":
        path.unlink()
    elif damage == "same_size_change":
        path.write_bytes(b"x" * len(payload))
    elif damage == "stale_manifest":
        data["clips"] = []
    elif damage == "duplicate_id":
        data["clips"].append(data["clips"][0])
    elif damage == "wrong_hash":
        data["clips"][0]["sha256"] = "f" * 64
    elif damage == "wrong_text":
        data["clips"][0]["text"] = "Another string."
    elif damage == "wrong_voice":
        data["clips"][0]["voice"] = "another-voice"
    elif damage == "wrong_duration":
        data["clips"][0]["duration_ms"] += 1
    elif damage == "wrong_totals":
        data["totals"]["bytes"] += 1
    elif damage == "wrong_language":
        data["language"] = "fr"
    if damage not in {"absent", "missing_clip", "same_size_change"}:
        snapshot.write_text(json.dumps(data))
    with pytest.raises((ValueError, FileNotFoundError)):
        transfer("restore")
    assert original.read_bytes() == before


def test_inv_pack_15_snapshot_cannot_archive_stale_committed_manifest(bank):
    original, _, _ = bank
    original.write_text(json.dumps(_manifest([])))
    with pytest.raises(ValueError):
        transfer("snapshot")
    assert not (stage_dir("es", "g8") / AUDIO_MANIFEST_FILENAME).exists()
