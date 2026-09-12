import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = ROOT / "tools/coursekit/scripts/fix_p2r4_b3_cleanliness.py"
SCRIPT_SPEC = importlib.util.spec_from_file_location("fix_p2r4_b3_cleanliness", SCRIPT_PATH)
assert SCRIPT_SPEC is not None and SCRIPT_SPEC.loader is not None
SCRIPT_MODULE = importlib.util.module_from_spec(SCRIPT_SPEC)
SCRIPT_SPEC.loader.exec_module(SCRIPT_MODULE)
is_state_of_cleanliness_ser = SCRIPT_MODULE.is_state_of_cleanliness_ser
FILES = (
    ROOT / "content/es/candidates/u07-u14.jsonl",
    ROOT / "content/es/candidates/u15-u23.jsonl",
)
ALL_LIVE_FILES = tuple(sorted((ROOT / "content/es/candidates").glob("*.jsonl")))


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


def test_INV_PACK_10_state_of_cleanliness_never_uses_ser_in_live_candidates() -> None:
    """B3's sampled room defect was one instance of a bank-wide template family."""
    state_translation = re.compile(r"\b(?:is|are)\b[^.?!]*\b(?:clean|clear)\b", re.IGNORECASE)
    ser_limpio = re.compile(r"\b(?:es|son) limpi(?:o|a|os|as)\b", re.IGNORECASE)

    offenders = []
    for path in ALL_LIVE_FILES:
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            row = json.loads(line)
            if state_translation.search(row["translation"]) and ser_limpio.search(row["text"]):
                offenders.append(f"{path.relative_to(ROOT)}:{line_number}: {row['text']}")

    assert offenders == []


def test_INV_PACK_10_clean_identity_senses_are_not_rewritten_as_states() -> None:
    assert (
        is_state_of_cleanliness_ser(
            {"text": "El juego es limpio.", "translation": "The game is fair."}
        )
        is False
    )
    assert (
        is_state_of_cleanliness_ser(
            {"text": "La ventana es limpia.", "translation": "The window is clean."}
        )
        is True
    )
    assert (
        is_state_of_cleanliness_ser(
            {"text": "¿Es limpia esta servilleta?", "translation": "Is this napkin clean?"}
        )
        is True
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
