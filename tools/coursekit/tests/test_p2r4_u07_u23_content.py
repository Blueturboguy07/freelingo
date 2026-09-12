import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FILES = (
    ROOT / "content/es/candidates/u07-u14.jsonl",
    ROOT / "content/es/candidates/u15-u23.jsonl",
)


def rows() -> list[dict]:
    return [
        json.loads(line) for path in FILES for line in path.read_text(encoding="utf-8").splitlines()
    ]


def test_INV_PACK_10_b3_source_patterns_are_corrected_before_sample_redraw() -> None:
    candidates = rows()
    assert not any("There is clouds" in row["translation"] for row in candidates)
    assert not any(
        row["text"] in {"Los dormitorios son limpios.", "Los salones son limpios."}
        for row in candidates
    )
    assert not any(row["text"] == "Mi hermana avisa la propuesta." for row in candidates)
    assert not any(
        row["translation"] == "I lost my wallet."
        for row in candidates
        if row["text"] == "No encuentro mi cartera."
    )
    assert not any(
        row["translation"].startswith("You carry on")
        for row in candidates
        if row["text"].startswith("Continúa ")
    )


def test_INV_PACK_10_round_four_u07_u23_has_twenty_fresh_rows_per_slot() -> None:
    path = ROOT / "content/es/candidates/u07-u23-r4.jsonl"
    candidates = list(map(json.loads, path.read_text(encoding="utf-8").splitlines()))
    counts: dict[tuple[int, int, int], int] = {}
    for row in candidates:
        slot = row["slot"]
        key = (slot["unit_index"], slot["lesson_index"], slot["slot_index"])
        counts[key] = counts.get(key, 0) + 1
    assert len(candidates) == 200
    assert len(counts) == 10
    assert set(counts.values()) == {20}
