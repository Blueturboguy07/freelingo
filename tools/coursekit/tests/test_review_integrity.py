"""P2 falsifiers for exact source selection and a complete, current review."""

from __future__ import annotations

import json
from dataclasses import replace

import pytest

from coursekit.artifacts import read_records, write_records
from coursekit.packbuild.sqlite import PackInputs, shipped_sentences
from coursekit.sample import (
    ScoreError,
    derive_review,
    draw_sample,
    gate_passed,
    read_scores,
    review_summary,
    write_sample,
)
from coursekit.validators.pack import shipped_items


def _scores(root, items):
    path = root / "content/es/review/scores.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(
            json.dumps(
                {
                    "exercise_id": row["exercise_id"],
                    "verdict": "ok",
                    "reviewer": "Codex",
                    "content_fingerprint": row.get("content_fingerprint"),
                }
            )
            + "\n"
            for row in items
        )
    )
    return path


def test_INV_PACK_14_reserve_candidates_cannot_replace_the_reviewed_source(make_es_build):
    data = make_es_build(units=1, per_unit=4)
    chosen = data["candidates"][0] | {"candidate_id": "a" * 16}
    reserve = chosen | {"candidate_id": "b" * 16, "text": "A different reserve sentence"}
    rejected = chosen | {"candidate_id": "c" * 16, "accepted": False}
    write_records("candidate", [rejected, chosen, reserve], lang="es")
    exercise = data["exercises"][0] | {"source_sentence_id": chosen["candidate_id"]}
    write_records("exercise", [exercise], lang="es")
    actual = shipped_items("es")[0]
    assert actual.item_id == chosen["candidate_id"]
    assert actual.text == chosen["text"]
    sheet = draw_sample("es", n=1)
    assert sheet.items[0].source_text == chosen["text"]
    assert sheet.items[0].provenance == "llm"
    inputs = PackInputs(
        lang="es",
        pack_id="es",
        course_id="en-es",
        major=0,
        version="0.1.0",
        sentences=tuple(data["ingested"]),
        selected=tuple(data["selected"]),
        candidates=(rejected, chosen, reserve),
    )
    packed = shipped_sentences(inputs)
    authored = [row for row in packed if row["provenance"] == "llm"]
    assert len(authored) == 1
    assert authored[0]["sentence_id"] == chosen["candidate_id"]
    assert authored[0]["text"] == chosen["text"]
    # A reserve at a coordinate G4 never selected must not ship either.
    extra = reserve | {"candidate_id": "d" * 16, "slot_index": 99}
    assert shipped_sentences(replace(inputs, candidates=(*inputs.candidates, extra))) == packed


@pytest.mark.parametrize("source", [None, "f" * 16])
def test_INV_PACK_14_missing_sentence_join_is_named_and_never_unknown(make_es_build, source):
    data = make_es_build(units=1, per_unit=2)
    exercise = data["exercises"][0] | {"type": "translate", "source_sentence_id": source}
    write_records("exercise", [exercise], lang="es")
    with pytest.raises(RuntimeError, match=exercise["exercise_id"]):
        draw_sample("es", n=1)


@pytest.mark.parametrize("kind", ["meaning_select", "match_pairs"])
def test_INV_PACK_14_synthetic_lexeme_rows_have_explicit_derived_provenance(make_es_build, kind):
    data = make_es_build(units=1, per_unit=2)
    from coursekit.exercises.shapes import prompt_for

    exercise = data["exercises"][0] | {
        "type": "match",
        "source_sentence_id": None,
        "prompt": prompt_for(kind, lang="es", body="pan", hint="pan"),
    }
    write_records("exercise", [exercise], lang="es")
    assert draw_sample("es", n=1).items[0].provenance == "derived"


def _review(n=300):
    scores = [{"exercise_id": str(i), "verdict": "ok", "reviewer": "Codex"} for i in range(n)]
    return review_summary(scores=scores, sample_size=n, sheet_item_ids=[str(i) for i in range(n)])


@pytest.mark.parametrize(
    "change",
    [
        {"sample_size": 1, "scored": 1, "joined": 1},
        {"scored": 1, "joined": 1},
        {"scored": 301, "unjoined": 1},
        {"sample_size": 299},
        {"wrong_item_rate": -0.01},
        {"wrong_item_rate": float("nan")},
        {"wrong_item_rate": float("inf")},
        {"wrong_item_rate": True},
        {"joined": True},
    ],
)
def test_INV_PACK_14_partial_or_impossible_review_never_passes(change):
    assert gate_passed(_review())
    assert not gate_passed(_review() | change)


def test_INV_PACK_14_duplicate_scores_cannot_manufacture_three_hundred_reviews(tmp_path):
    path = _scores(tmp_path, [{"exercise_id": "e1"}, {"exercise_id": "e1"}])
    with pytest.raises(ScoreError, match="duplicate"):
        read_scores("es", repo_root=tmp_path)
    assert path.exists()
    rows = [{"exercise_id": "e1", "verdict": "ok", "reviewer": "Codex"}] * 300
    with pytest.raises(ScoreError, match="duplicate"):
        review_summary(scores=rows, sample_size=300, sheet_item_ids=["e1"])


def test_INV_PACK_14_scores_bind_to_content_even_when_semantic_id_stays_fixed(
    make_es_build, tmp_path
):
    make_es_build(units=4, per_unit=80)
    sheet = draw_sample("es")
    path, summary = write_sample(sheet)
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert all(len(row["content_fingerprint"]) == 64 for row in rows)
    assert len(json.loads(summary.read_text())["population_fingerprint"]) == 64
    _scores(tmp_path, rows)
    assert gate_passed(derive_review("es", repo_root=tmp_path))
    exercises = list(read_records("exercise", lang="es"))
    changed_id = rows[0]["exercise_id"]
    for row in exercises:
        if row["exercise_id"] == changed_id:
            row["accepted_answers"].append("A new accepted surface")
    write_records("exercise", exercises, lang="es")
    # Old draw itself no longer describes the population.
    assert not gate_passed(derive_review("es", repo_root=tmp_path))
    # Redrawing same seed/id cannot make old scores review new accepted answers.
    write_sample(draw_sample("es"))
    review = derive_review("es", repo_root=tmp_path)
    assert review["joined"] == 299
    assert review["unjoined"] == 1
    assert not gate_passed(review)


@pytest.mark.parametrize("field", ["distractors", "alignment"])
def test_INV_PACK_14_population_change_outside_the_draw_invalidates_old_review(
    make_es_build, tmp_path, field
):
    make_es_build(units=4, per_unit=80)
    path, _ = write_sample(draw_sample("es"))
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    _scores(tmp_path, rows)
    assert gate_passed(derive_review("es", repo_root=tmp_path))
    drawn = {row["exercise_id"] for row in rows}
    exercises = list(read_records("exercise", lang="es"))
    next(row for row in exercises if row["exercise_id"] not in drawn)[field].append(
        "changed" if field == "distractors" else [0, 1]
    )
    write_records("exercise", exercises, lang="es")
    assert not gate_passed(derive_review("es", repo_root=tmp_path))


def test_INV_PACK_14_scores_without_content_fingerprints_do_not_review_new_sheet(
    make_es_build, tmp_path
):
    make_es_build(units=4, per_unit=80)
    path, _ = write_sample(draw_sample("es"))
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    for row in rows:
        row.pop("content_fingerprint", None)
    _scores(tmp_path, rows)
    review = derive_review("es", repo_root=tmp_path)
    assert review["joined"] == 0
    assert not gate_passed(review)


def test_INV_PACK_14_g9_embeds_only_the_current_full_validator_report(monkeypatch):
    from coursekit.stages import g9_package
    from coursekit.validators.report import build_report, report_path, write_report

    report = build_report(
        lang="es",
        run_id="validation",
        tool="coursekit",
        tool_version="test",
        generated_at="2026-09-13T00:10:00+00:00",
        runs=[],
    )
    path = report_path("es")
    write_report(report, path)
    monkeypatch.setattr(
        g9_package,
        "read_entries",
        lambda lang: iter(
            [
                {"stage": "g7", "finished_at": "2026-09-13T00:00:00+00:00", "run_id": "build"},
            ]
        ),
    )
    assert g9_package._validator_report("es") == report
    monkeypatch.setattr(
        g9_package,
        "read_entries",
        lambda lang: iter(
            [
                {"stage": "g7", "finished_at": "2026-09-13T00:20:00+00:00", "run_id": "new-build"},
            ]
        ),
    )
    stale = g9_package._validator_report("es")
    assert stale != report
    assert stale["hard_gate"]["passed"] is False
    assert stale["counts"]["ran"] == 0
    assert all(row["outcome"] == "unregistered" for row in stale["validators"])


def test_INV_PACK_14_source_from_another_lesson_cannot_join(make_es_build):
    data = make_es_build(units=2, per_unit=4)
    row = data["exercises"][0] | {"source_sentence_id": data["exercises"][-1]["source_sentence_id"]}
    write_records("exercise", [row], lang="es")
    with pytest.raises(RuntimeError, match=row["exercise_id"]):
        draw_sample("es", n=1)
