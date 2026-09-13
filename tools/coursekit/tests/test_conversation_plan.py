"""[INV-PACK-06] a missing chat review cannot silently define an empty plan."""

import json
from dataclasses import replace

import pytest
from test_conversation_evidence import fixture

from coursekit.conversation_evidence import (
    ConversationEvidenceError,
    conversation_plan_digest,
    load_conversation_plan,
)

pytestmark = pytest.mark.parametrize("invariant", ["INV-PACK-06", "INV-PACK-08"])


def plan_fixture(tmp_path):
    sources = fixture(tmp_path)[0]
    row = dict(
        schema_version=1,
        lang="es",
        authored_on="2026-09-13",
        author="plan author",
        rationale="Explicit scheduled conversation population after source selection.",
        expected_slots=[list(sources[0].slot)],
    )
    path = tmp_path / "conversation-plan.json"
    path.write_text(json.dumps(row))
    return sources, row, path


def test_explicit_plan_keeps_actual_zero_based_slot_and_digest(invariant, tmp_path):
    sources, _, path = plan_fixture(tmp_path)
    plan = load_conversation_plan("es", sources, path=path)
    assert plan == ((1, 1, 0),)
    assert conversation_plan_digest(plan, sources) != conversation_plan_digest((), sources)


@pytest.mark.parametrize(
    "defect",
    [
        "missing",
        "malformed",
        "extra",
        "missing_field",
        "version",
        "boolean_version",
        "language",
        "source_language",
        "author",
        "rationale",
        "date",
        "date_noncanonical",
        "missing_slots",
        "boolean_slot",
        "negative_slot",
        "zero_unit",
        "zero_lesson",
        "unknown_slot",
        "duplicate",
        "nonarray",
    ],
)
def test_plan_loader_refuses_missing_stale_and_ambiguous_declarations(invariant, tmp_path, defect):
    sources, row, path = plan_fixture(tmp_path)
    if defect == "missing":
        path.unlink()
    elif defect == "malformed":
        path.write_text("{")
    else:
        if defect == "extra":
            row["derive_from_review_rows"] = True
        elif defect == "missing_field":
            del row["rationale"]
        elif defect == "version":
            row["schema_version"] = 2
        elif defect == "boolean_version":
            row["schema_version"] = True
        elif defect == "language":
            row["lang"] = "fr"
        elif defect == "source_language":
            sources = (replace(sources[0], lang="fr"),)
        elif defect == "author":
            row["author"] = "  "
        elif defect == "rationale":
            row["rationale"] = ""
        elif defect == "date":
            row["authored_on"] = "2026-02-30"
        elif defect == "date_noncanonical":
            row["authored_on"] = "20260913"
        elif defect == "missing_slots":
            del row["expected_slots"]
        elif defect == "boolean_slot":
            row["expected_slots"] = [[1, True, 0]]
        elif defect == "negative_slot":
            row["expected_slots"] = [[1, 1, -1]]
        elif defect == "zero_unit":
            row["expected_slots"] = [[0, 1, 0]]
        elif defect == "zero_lesson":
            row["expected_slots"] = [[1, 0, 0]]
        elif defect == "unknown_slot":
            row["expected_slots"] = [[1, 1, 9]]
        elif defect == "duplicate":
            row["expected_slots"] *= 2
        elif defect == "nonarray":
            row["expected_slots"] = "1,1,0"
        path.write_text(json.dumps(row))
    with pytest.raises(ConversationEvidenceError):
        load_conversation_plan("es", sources, path=path)


def test_explicit_empty_plan_needs_real_file_and_never_reads_surviving_reviews(
    invariant, tmp_path, monkeypatch
):
    sources, row, path = plan_fixture(tmp_path)
    row["expected_slots"] = []
    target = tmp_path / "content/es/authoring/conversation-plan.json"
    target.parent.mkdir(parents=True)
    target.write_text(json.dumps(row))
    (target.parent / "conversations.jsonl").write_text("Invalid unrelated review rows")
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path / "content"))
    assert load_conversation_plan("es", sources) == ()
    target.unlink()
    with pytest.raises(ConversationEvidenceError, match="missing conversation plan"):
        load_conversation_plan("es", sources)


def test_plan_digest_also_refuses_invalid_direct_coordinates(invariant, tmp_path):
    sources, _, _ = plan_fixture(tmp_path)
    invalid = replace(sources[0], unit_index=0)
    with pytest.raises(ConversationEvidenceError, match="invalid conversation slot"):
        conversation_plan_digest([invalid.slot], [invalid])
