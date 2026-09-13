"""Falsifiers for reviewed bytes and the chronological validation boundary."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

import pytest

from coursekit.artifacts import run_dir, write_records
from coursekit.config import VALIDATOR_IDS, VALIDATOR_TITLES
from coursekit.sample import derive_review, draw_sample, gate_passed, write_sample
from coursekit.tts.cast import load_cast


def _review_with_clip(make_es_build, tmp_path, *, sampled=True):
    data = make_es_build(units=10, per_unit=40)
    selected = {item.exercise_id for item in draw_sample("es", n=300).items}
    target = next(
        row for row in data["exercises"] if (row["exercise_id"] in selected) == sampled
    )
    clip_id = "0123456789abcdef"
    target["audio_ref"] = clip_id
    write_records("exercise", data["exercises"], lang="es")
    clip = run_dir("es") / "g8" / "bank" / f"{clip_id}.opus"
    clip.parent.mkdir(parents=True)
    # These are synthetic bytes for integrity checks, not a claim of playable audio.
    clip.write_bytes(b"first audio bytes")
    write_records(
        "baked_clip",
        [
            {
                "schema_version": 1,
                "lang": "es",
                "clip_id": clip_id,
                "text": "Texto hablado.",
                "voice_id": load_cast("es").role("narrator").voice_id,
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
    sheet = draw_sample("es", n=300)
    write_sample(sheet)
    assert (target["exercise_id"] in {item.exercise_id for item in sheet.items}) == sampled
    scores = tmp_path / "content" / "es" / "review" / "scores.jsonl"
    scores.parent.mkdir(parents=True)
    scores.write_text(
        "".join(
            json.dumps(
                {
                    "exercise_id": item.exercise_id,
                    "reviewer": "Codex",
                    "verdict": "ok",
                    "content_fingerprint": item.to_json()["content_fingerprint"],
                }
            )
            + "\n"
            for item in sheet.items
        )
    )
    assert gate_passed(derive_review("es", repo_root=tmp_path))
    return clip, target["exercise_id"], sheet


@pytest.mark.parametrize("sampled", [True, False])
def test_INV_PACK_14_replaced_audio_bytes_invalidate_the_review_population(
    make_es_build, tmp_path, sampled
):
    clip, _, _ = _review_with_clip(make_es_build, tmp_path, sampled=sampled)
    original_size = clip.stat().st_size
    clip.write_bytes(b"other audio bytes")
    assert clip.stat().st_size == original_size
    review = derive_review("es", repo_root=tmp_path)
    assert review["joined"] == 0
    assert not gate_passed(review)


def test_INV_AUD_08_sheet_binds_exact_bytes_and_keeps_a_portable_path(make_es_build, tmp_path):
    clip, exercise_id, sheet = _review_with_clip(make_es_build, tmp_path)
    row = next(item.to_json() for item in sheet.items if item.exercise_id == exercise_id)
    assert row["clip_sha256"] == hashlib.sha256(clip.read_bytes()).hexdigest()
    assert row["clip_path"] == f"g8/bank/{clip.name}"
    assert row["has_audio"] is True


@pytest.mark.parametrize("replacement", ["missing", "empty", "directory"])
def test_INV_AUD_08_a_missing_empty_or_nonfile_clip_cannot_retain_a_review(
    make_es_build, tmp_path, replacement
):
    clip, exercise_id, _ = _review_with_clip(make_es_build, tmp_path)
    clip.unlink()
    if replacement == "empty":
        clip.touch()
    elif replacement == "directory":
        clip.mkdir()
    row = next(item for item in draw_sample("es", n=300).items if item.exercise_id == exercise_id)
    assert row.has_audio is False
    assert row.to_json()["clip_sha256"] is None
    assert not gate_passed(derive_review("es", repo_root=tmp_path))


def _green_report(stamp):
    from coursekit.validators.report import build_report

    return build_report(
        lang="es",
        run_id="prior-validation",
        tool="coursekit",
        tool_version="test",
        generated_at=stamp,
        runs=[
            {
                "id": identifier,
                "title": VALIDATOR_TITLES[identifier],
                "outcome": "ok",
                "findings": {"blocking": 0, "warning": 0, "info": 0},
                "messages": [],
                "notes": {},
            }
            for identifier in VALIDATOR_IDS
        ],
    )


def _embed_after_stage(monkeypatch, stage_stamp, report_stamp):
    from coursekit.stages import g9_package
    from coursekit.validators.report import report_path, write_report

    report = _green_report(report_stamp)
    write_report(report, report_path("es"))
    monkeypatch.setattr(
        g9_package,
        "read_entries",
        lambda lang: iter([{"stage": "g7", "finished_at": stage_stamp, "run_id": "build"}]),
    )
    return g9_package._validator_report("es"), report


def test_INV_PACK_14_same_legacy_second_cannot_prove_a_validator_report_is_fresh(monkeypatch):
    stamp = "2026-09-13T00:10:00+00:00"
    embedded, report = _embed_after_stage(monkeypatch, stamp, stamp)
    assert embedded != report
    assert embedded["hard_gate"]["passed"] is False


@pytest.mark.parametrize("stage_before", [True, False])
def test_INV_PACK_14_both_timestamp_producers_preserve_same_second_stage_order(
    monkeypatch, stage_before
):
    import coursekit.runlog as runlog
    from coursekit.validators import runner

    # Run both real timestamp helpers under a controlled same-second clock. If either
    # truncates its timestamp, the later-stage or earlier-stage branch fails.
    class Clock(datetime):
        current = datetime(2026, 9, 13, 0, 10, 0, 200000, tzinfo=UTC)

        @classmethod
        def now(cls, tz=None):
            return cls.current

    monkeypatch.setattr(runlog, "datetime", Clock)
    monkeypatch.setattr(runner, "datetime", Clock)
    Clock.current = Clock.current.replace(microsecond=100000 if stage_before else 300000)
    stage_stamp = runlog._now()
    Clock.current = Clock.current.replace(microsecond=200000)
    report_stamp = runner._now()
    embedded, report = _embed_after_stage(monkeypatch, stage_stamp, report_stamp)
    if stage_before:
        assert embedded == report
        assert embedded["hard_gate"]["passed"] is True
    else:
        assert embedded != report
        assert embedded["hard_gate"]["passed"] is False
