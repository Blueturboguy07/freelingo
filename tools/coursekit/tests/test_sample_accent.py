from __future__ import annotations

import json

import pytest

from coursekit.artifacts import read_records, run_dir, write_records
from coursekit.sample import (
    ScoreError,
    accent_summary,
    draw_sample,
    read_scores,
    write_sample,
)
from coursekit.tts.cast import load_cast


def _scores(tmp_path, dimensions) -> None:
    review = tmp_path / "content" / "es" / "review"
    review.mkdir(parents=True)
    (review / "scores.jsonl").write_text(
        json.dumps(
            {
                "exercise_id": "exercise-1",
                "verdict": "ok",
                "reviewer": "opus",
                "dimensions": dimensions,
            }
        )
        + "\n",
        encoding="utf-8",
    )


def test_INV_PACK_14_accent_null_remains_an_explicit_unscored_value(tmp_path) -> None:
    _scores(tmp_path, {"accent_consistency": None})
    assert read_scores("es", repo_root=tmp_path)[0]["dimensions"]["accent_consistency"] is None


def test_INV_PACK_14_unknown_dimension_values_are_refused(tmp_path) -> None:
    _scores(tmp_path, {"accent_consistency": "yes"})
    with pytest.raises(ScoreError, match="not pass or fail"):
        read_scores("es", repo_root=tmp_path)


def test_INV_AUD_08_sheet_joins_a_real_baked_clip_to_its_voice_role(make_es_build) -> None:
    make_es_build(units=1, per_unit=1)
    exercises = list(read_records("exercise", lang="es"))
    clip_id = "0123456789abcdef"
    exercises[0]["audio_ref"] = clip_id
    write_records("exercise", exercises, lang="es")

    role = load_cast("es").role("narrator")
    bank = run_dir("es") / "g8" / "bank"
    bank.mkdir(parents=True)
    (bank / f"{clip_id}.opus").write_bytes(b"real packed bytes")
    write_records(
        "baked_clip",
        [
            {
                "schema_version": 1,
                "lang": "es",
                "clip_id": clip_id,
                "text": "Texto hablado.",
                "voice_id": role.voice_id,
                "engine": "kokoro",
                "codec": "opus",
                "bitrate_kbps": 20,
                "duration_ms": 900,
                "bytes": 17,
                "path": f"bank/{clip_id}.opus",
                "licence": "Apache-2.0",
                "pipeline": "lesson",
            }
        ],
        lang="es",
    )

    item = draw_sample("es", n=1).items[0]
    assert item.clip_id == clip_id
    assert item.clip_path == f"g8/bank/{clip_id}.opus"
    assert item.voice_role == "narrator"
    assert item.voice_name == "Plumas"
    assert item.clip_engine == "kokoro"
    assert item.clip_text == "Texto hablado."

    sheet, _ = write_sample(draw_sample("es", n=1))
    row = json.loads(sheet.read_text(encoding="utf-8"))
    assert row["has_audio"] is True


def test_INV_AUD_08_an_accent_verdict_without_playable_bytes_is_refused() -> None:
    scores = [
        {
            "exercise_id": "exercise-1",
            "verdict": "ok",
            "reviewer": "opus",
            "dimensions": {"accent_consistency": "pass"},
        }
    ]
    with pytest.raises(ScoreError, match="no clip"):
        accent_summary(
            scores=scores,
            sheet_item_ids=["exercise-1"],
            sheet_audio_ids=[],
            engines=[],
        )
