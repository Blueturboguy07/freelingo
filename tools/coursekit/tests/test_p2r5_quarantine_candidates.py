"""The review quarantine must be replenished by fresh authored candidates."""

import json
from collections import defaultdict
from pathlib import Path

from coursekit.engines.backtranslation import AgentRubricEngine
from coursekit.pair_quality import reviewed_pair
from coursekit.stages.g5_gapfill import _read_one

ROOT = Path(__file__).resolve().parents[3]
PATH = ROOT / "content/es/candidates/p2r5-quarantine-resample.jsonl"


def test_INV_PACK_10_quarantine_gaps_have_twenty_distinct_unmodified_candidates(
    monkeypatch,
) -> None:
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(ROOT / "content"))
    rows = [row for _, row in _read_one(PATH)]
    slots = defaultdict(list)
    for row in rows:
        slot = row["slot"]
        key = (slot["unit_index"], slot["lesson_index"], slot["slot_index"])
        slots[key].append(row)
        assert isinstance(row["accepted_alternates"], list)
        assert row["provenance"] == "llm"
        assert "codex" in row["author"]
        assert reviewed_pair("es", row["text"], row["translation"]) is None
    assert set(slots) == {
        (2, 9, 4),
        (2, 9, 5),
        (2, 9, 6),
        (12, 71, 7),
        (26, 151, 4),
        (26, 151, 5),
        (29, 165, 7),
    }
    for candidates in slots.values():
        assert len(candidates) == len({row["text"] for row in candidates}) == 20
        assert len({row["ledger_digest"] for row in candidates}) == 1
    engine = AgentRubricEngine(paths=(PATH,))
    assert engine.probe("es")["available"] is True
    for row in rows:
        assert engine.score(row["text"], translation=row["translation"]) == 4
        for alternate in row["accepted_alternates"]:
            assert engine.score(alternate["text"], translation=row["translation"]) == 4
    assert slots[(12, 71, 7)][0]["accepted_alternates"] == [
        {
            "text": "Yo tomo fruta de postre.",
            "backtranslation": {
                "back_translation": "I have fruit for dessert.",
                "judged_by": "agent",
                "rubric_version": "1",
                "score": 4,
            },
        }
    ]


def test_INV_PACK_10_quarantine_resamples_do_not_collide_with_older_shards() -> None:
    rows = [row for _, row in _read_one(PATH)]
    new_keys = {(json.dumps(row["slot"], sort_keys=True), row["text"]) for row in rows}
    for path in PATH.parent.glob("*.jsonl"):
        if path == PATH:
            continue
        for _, row in _read_one(path):
            assert (json.dumps(row["slot"], sort_keys=True), row["text"]) not in new_keys


def test_INV_PACK_08_gender_neutral_reserves_record_both_reviewed_answers() -> None:
    rows = {row["text"]: row for _, row in _read_one(PATH)}
    pairs = (
        ("Mi amiga quiere una beca.", "Mi amigo quiere una beca."),
        ("El alumno tiene una beca.", "La alumna tiene una beca."),
        (
            "El alumno quiere estudiar en la biblioteca.",
            "La alumna quiere estudiar en la biblioteca.",
        ),
        (
            "Mi amiga quiere estudiar en la biblioteca.",
            "Mi amigo quiere estudiar en la biblioteca.",
        ),
    )
    for left, right in pairs:
        assert rows[left]["translation"] == rows[right]["translation"]
        assert [a["text"] for a in rows[left]["accepted_alternates"]] == [right]
        assert [a["text"] for a in rows[right]["accepted_alternates"]] == [left]
