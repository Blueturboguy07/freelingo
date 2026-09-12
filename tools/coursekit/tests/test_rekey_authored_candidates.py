from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "rekey_authored_candidates.py"
SPEC = importlib.util.spec_from_file_location("rekey_authored_candidates", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
merge_orphans = MODULE.merge_orphans


def _row(slot: int, text: str) -> dict:
    return {
        "slot": {"unit_index": 1, "lesson_index": 2, "slot_index": slot},
        "text": text,
        "translation": text,
        "author": "test",
        "orphaned_because": "the slot is not in G4's gap list",
    }


def test_INV_PACK_10_a_later_rekey_preserves_previous_orphans() -> None:
    old = [_row(1, "anterior"), _row(2, "duplicado")]
    new = [_row(2, "duplicado"), _row(3, "nuevo")]

    merged = merge_orphans(old, new)

    assert [(row["slot"]["slot_index"], row["text"]) for row in merged] == [
        (1, "anterior"),
        (2, "duplicado"),
        (3, "nuevo"),
    ]
