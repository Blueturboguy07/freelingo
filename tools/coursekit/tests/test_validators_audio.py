"""V7 and F2, driven by the two committed falsifiers.

Every test here plants a manifest that a careless gate would pass. That is the point:
both invariants fail in the direction of looking fine. `lessonsOnly` is 50 MB against a
120 MB budget — comfortable, and missing two of three denominators. A clip at -19.6
LUFS is a perfectly valid file with a perfectly valid duration and licence. A bank
re-baked on a new engine has every digest matching its own bytes.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from coursekit.config import AUDIO_PIPELINES, OPUS_BITRATE_KBPS
from coursekit.config.g8 import (
    AUDIO_MANIFEST_FILENAME,
    AUDIO_MANIFEST_VERSION,
    BYTES_PER_MB,
    CONTENT_ROOT_ENV_VAR,
    LOUDNESS_TOLERANCE_LU,
    MAX_CLIP_MS,
    MIN_CLIP_MS,
    PIPELINE_RESERVED_BYTES,
    TARGET_LUFS,
)
from coursekit.runlog import RunLog
from coursekit.validators import ValidatorContext
from coursekit.validators.audio import audio_budget, string_audio_join

FALSIFIERS = Path(__file__).parent / "falsifiers"
PACK15 = json.loads((FALSIFIERS / "INV-PACK-15.json").read_text(encoding="utf-8"))["input"]
AUD08 = json.loads((FALSIFIERS / "INV-AUD-08.json").read_text(encoding="utf-8"))["input"]


def _clip(**overrides: Any) -> dict[str, Any]:
    clip = {
        "clip_id": "0" * 16,
        "role": "narrator",
        "voice": "ef_dora:1.000@1.000",
        "engine": "kokoro",
        "engine_pin": "model-files-v1.0",
        "pipeline": "lesson",
        "role_sample": False,
        "text": "El gato duerme en la silla.",
        "path": "bank/0000000000000000.opus",
        "sha256": "0" * 64,
        "bytes": 6_000,
        "duration_ms": 2_100,
        "loudness_lufs": TARGET_LUFS,
        "loudness_gated": True,
        "peak_dbfs": -1.0,
        "limiter_reduction_db": 0.0,
        "encode_passes": 2,
    }
    clip.update(overrides)
    return clip


def _manifest(clips: list[dict[str, Any]] | None = None, **overrides: Any) -> dict[str, Any]:
    clips = [_clip()] if clips is None else clips
    pipelines = {
        pipeline: {
            "status": "baked" if pipeline == "lesson" else "reserved",
            "clips": sum(1 for clip in clips if clip["pipeline"] == pipeline),
            "baked_bytes": sum(clip["bytes"] for clip in clips if clip["pipeline"] == pipeline),
            "baked_seconds": 0.0,
            "reserved_bytes": PIPELINE_RESERVED_BYTES[pipeline],
            "reserved_seconds": 1.0,
            "charged_bytes": max(
                sum(clip["bytes"] for clip in clips if clip["pipeline"] == pipeline),
                PIPELINE_RESERVED_BYTES[pipeline],
            ),
            "assumption": "measured",
        }
        for pipeline in AUDIO_PIPELINES
    }
    manifest = {
        "schema_version": AUDIO_MANIFEST_VERSION,
        "language": "es",
        "locale": "es-ES",
        "engine": "kokoro",
        "engine_pin": "model-files-v1.0",
        "engine_licence": "Apache-2.0",
        "codec": "opus",
        "bitrate_kbps": OPUS_BITRATE_KBPS,
        "loudness": {
            "target_lufs": TARGET_LUFS,
            "tolerance_lu": LOUDNESS_TOLERANCE_LU,
            "algorithm": "ITU-R BS.1770-4 K-weighted, gated",
            "measured_on": "the decoded Opus file",
        },
        "cast": [],
        "totals": {"clips": len(clips), "bytes": sum(c["bytes"] for c in clips), "seconds": 0.0},
        "budget": {
            "budget_mb": 120,
            "budget_bytes": 120 * BYTES_PER_MB,
            "declared_bytes": sum(row["charged_bytes"] for row in pipelines.values()),
            "declared_mb": 0.0,
            "headroom_bytes": 0,
            "rule": "max(baked, reserved)",
            "pipelines": pipelines,
        },
        "clips": clips,
    }
    manifest.update(overrides)
    return manifest


@pytest.fixture
def plant(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Write a manifest where the validators look for it."""

    def _plant(manifest: dict[str, Any]) -> None:
        target = tmp_path / "es"
        target.mkdir(parents=True, exist_ok=True)
        (target / AUDIO_MANIFEST_FILENAME).write_text(
            json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
        )
        monkeypatch.setenv(CONTENT_ROOT_ENV_VAR, str(tmp_path))

    return _plant


def _context() -> ValidatorContext:
    runlog = RunLog("es")
    from coursekit.runlog import StageEntry, tool_fingerprint

    entry = StageEntry(
        lang="es",
        stage="V7",
        run_id=runlog.run_id,
        started_at="now",
        tool="coursekit",
        tool_version="test",
        platform=tool_fingerprint(),
    )
    return ValidatorContext(lang="es", entry=entry)


def _blocking(findings: list) -> list[str]:
    return [f.message for f in findings if f.severity == "blocking"]


# ---------------------------------------------------------------------------
# F2 — INV-PACK-15
# ---------------------------------------------------------------------------


def test_a_clean_manifest_passes_f2(plant) -> None:
    """The gate has to be able to say yes, or every other test here is vacuous."""
    plant(_manifest())
    assert _blocking(audio_budget(_context())) == []


def test_a_lessons_only_manifest_is_blocking(plant) -> None:
    """[INV-PACK-15] the named falsifier: 50 MB against 120 MB, two pipelines missing.

    Review R14. The number is comfortable; the denominator is wrong. A gate that only
    compared a total against a budget would pass this and the overrun would land at P6
    with the bank baked.
    """
    manifest = _manifest()
    manifest["budget"]["pipelines"] = {
        "lesson": manifest["budget"]["pipelines"]["lesson"],
    }
    manifest["budget"]["declared_bytes"] = PACK15["lessonsOnly"]["declared_bytes"]
    plant(manifest)

    findings = _blocking(audio_budget(_context()))
    assert any("'story'" in message for message in findings)
    assert any("'radio'" in message for message in findings)
    assert any("R14" in message for message in findings)


def test_over_budget_is_blocking(plant) -> None:
    """[INV-PACK-15] a lesson bank that outgrew its reservation is charged what it costs."""
    over = PACK15["overBudget"]["pipelines"]["lesson"]["baked_bytes"]
    manifest = _manifest([_clip(bytes=over)])
    plant(manifest)
    findings = _blocking(audio_budget(_context()))
    assert any("against a 120 MB budget" in message for message in findings)


def test_a_manifest_with_no_codec_row_is_blocking(plant) -> None:
    """[INV-PACK-15] R13's finding: a budget with no codec and no bitrate beside it
    cannot be argued with, which is how 35-40 MB for 8,000 utterances survived."""
    plant(_manifest(codec=None, bitrate_kbps=None))
    findings = _blocking(audio_budget(_context()))
    assert any("codec" in message for message in findings)
    assert any("R13" in message for message in findings)


def test_a_declared_total_that_is_not_the_sum_is_blocking(plant) -> None:
    manifest = _manifest()
    manifest["budget"]["declared_bytes"] = 1
    plant(manifest)
    findings = _blocking(audio_budget(_context()))
    assert any("sum to" in message for message in findings)


def test_an_unsized_placeholder_is_blocking(plant) -> None:
    """"Named and sized", not "named". A zero reservation is an implicit zero again."""
    manifest = _manifest()
    manifest["budget"]["pipelines"]["radio"]["reserved_bytes"] = 0
    manifest["budget"]["pipelines"]["radio"]["charged_bytes"] = 0
    manifest["budget"]["declared_bytes"] = sum(
        row["charged_bytes"] for row in manifest["budget"]["pipelines"].values()
    )
    plant(manifest)
    findings = _blocking(audio_budget(_context()))
    assert any("positive reservation" in message for message in findings)


def test_a_missing_manifest_is_blocking_not_a_pass(tmp_path, monkeypatch) -> None:
    """A validator that cannot find the thing it checks must not report a pass — V8's
    lesson, applied to this gate."""
    monkeypatch.setenv(CONTENT_ROOT_ENV_VAR, str(tmp_path))
    assert _blocking(audio_budget(_context()))
    assert _blocking(string_audio_join(_context()))


# ---------------------------------------------------------------------------
# INV-AUD-08 in the manifest
# ---------------------------------------------------------------------------


def test_a_drifted_clip_is_blocking(plant) -> None:
    """[INV-AUD-08] the falsifier's `driftedClip`: -19.6 LUFS against a -16 target.

    EC-PACK-52's measured number, and a perfectly valid file in every other respect.
    """
    drifted = AUD08["driftedClip"]
    plant(_manifest([_clip(loudness_lufs=drifted["measured_lufs"])]))
    findings = _blocking(audio_budget(_context()))
    assert any("LU from the declared" in message for message in findings)


def test_a_clip_with_no_measured_loudness_is_blocking(plant) -> None:
    """"Measures within a declared tolerance" — an unmeasured clip cannot have."""
    clip = _clip()
    del clip["loudness_lufs"]
    plant(_manifest([clip]))
    assert any("no measured loudness" in m for m in _blocking(audio_budget(_context())))


def test_a_clip_baked_by_another_engine_is_blocking(plant) -> None:
    """[INV-AUD-08] a bank baked by two engines under one declaration is EC-PACK-52."""
    case = AUD08["sameVoiceDifferentEngine"]
    plant(_manifest([_clip(engine=case["engineAfter"])]))
    assert any("two engines" in m for m in _blocking(audio_budget(_context())))


def test_a_tolerance_the_tool_does_not_enforce_is_blocking(plant) -> None:
    manifest = _manifest()
    manifest["loudness"]["tolerance_lu"] = 6.0
    plant(manifest)
    assert any("the tool enforces" in m for m in _blocking(audio_budget(_context())))


# ---------------------------------------------------------------------------
# V7
# ---------------------------------------------------------------------------


def test_v7_passes_on_a_bank_with_no_exercises_but_records_that_it_checked_nothing(
    plant,
) -> None:
    """The other half of V8's lesson: a validator that could not check says so.

    Without the exercise artefact the "every renderable string has audio" half has
    nothing to join against, and a silent green there is indistinguishable from a clean
    pack.
    """
    plant(_manifest())
    context = _context()
    findings = string_audio_join(context)
    assert _blocking(findings) == []
    assert any(f.severity == "warning" for f in findings)
    assert context.entry.notes.get("exercises_artefact") == "absent"


def test_a_clip_with_no_text_is_blocking(plant) -> None:
    """[V7] every audio file has a string."""
    plant(_manifest([_clip(text="")]))
    assert any("no text" in m for m in _blocking(string_audio_join(_context())))


def test_an_absurd_duration_is_blocking(plant) -> None:
    """[V7] durations are sane.

    The bound is not a quality metric. It catches a phonemiser handed the wrong
    language or an empty phoneme string — a failure whose text, licence and loudness
    are all perfectly valid.
    """
    plant(_manifest([_clip(duration_ms=MIN_CLIP_MS - 1)]))
    assert any("outside" in m for m in _blocking(string_audio_join(_context())))

    plant(_manifest([_clip(duration_ms=MAX_CLIP_MS + 1)]))
    assert any("outside" in m for m in _blocking(string_audio_join(_context())))


def test_a_renderable_string_with_no_clip_is_blocking(plant, tmp_path, monkeypatch) -> None:
    """[V7] every renderable string has audio."""
    from coursekit.artifacts import write_records
    from coursekit.config import ARTIFACT_SCHEMA_VERSION

    write_records(
        "exercise",
        [
            {
                "schema_version": ARTIFACT_SCHEMA_VERSION,
                "lang": "es",
                "exercise_id": "1" * 16,
                "unit_index": 1,
                "lesson_index": 1,
                "type": "listen",
                "prompt": "Where is the station?",
                "accepted_answers": ["¿Dónde está la estación?"],
                "distractors": [],
                "alignment": [],
                "item_tags": {"lemmas": ["dónde"], "grammar_concepts": []},
                "audio_ref": None,
                "register": "neutral",
                "source_sentence_id": None,
            }
        ],
        lang="es",
    )
    plant(_manifest([_clip(role_sample=True)]))
    findings = _blocking(string_audio_join(_context()))
    assert any("no clip for a renderable" in message for message in findings)


def test_a_clip_no_exercise_plays_is_blocking(plant) -> None:
    """[V7] a clip nothing plays is bytes inside the budget doing nothing."""
    from coursekit.artifacts import write_records
    from coursekit.config import ARTIFACT_SCHEMA_VERSION

    text = "Hoy hace mucho calor."
    write_records(
        "exercise",
        [
            {
                "schema_version": ARTIFACT_SCHEMA_VERSION,
                "lang": "es",
                "exercise_id": "2" * 16,
                "unit_index": 1,
                "lesson_index": 1,
                "type": "listen",
                "prompt": "It is hot today.",
                "accepted_answers": [text],
                "distractors": [],
                "alignment": [],
                "item_tags": {"lemmas": ["hoy"], "grammar_concepts": []},
                "audio_ref": None,
                "register": "neutral",
                "source_sentence_id": None,
            }
        ],
        lang="es",
    )
    plant(_manifest([_clip(text=text), _clip(clip_id="9" * 16, text="Una frase huérfana.")]))
    findings = _blocking(string_audio_join(_context()))
    assert any("no exercise plays it" in message for message in findings)


def test_a_cast_sample_is_exempt_by_name_not_by_accident(plant) -> None:
    """S002's sample lines belong to no exercise, and the exemption is a manifest flag
    rather than a rule that quietly swallows every orphan."""
    from coursekit.artifacts import write_records
    from coursekit.config import ARTIFACT_SCHEMA_VERSION

    write_records(
        "exercise",
        [
            {
                "schema_version": ARTIFACT_SCHEMA_VERSION,
                "lang": "es",
                "exercise_id": "3" * 16,
                "unit_index": 1,
                "lesson_index": 1,
                "type": "match",
                "prompt": "rojo",
                "accepted_answers": ["red"],
                "distractors": [],
                "alignment": [],
                "item_tags": {"lemmas": ["rojo"], "grammar_concepts": []},
                "audio_ref": None,
                "register": "neutral",
                "source_sentence_id": None,
            }
        ],
        lang="es",
    )
    plant(_manifest([_clip(role_sample=True, text="Hola, soy el loro.")]))
    assert _blocking(string_audio_join(_context())) == []
