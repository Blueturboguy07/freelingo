import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BRIEF = ROOT / "content/es/authoring/gap-brief.jsonl"
CANDIDATES = ROOT / "content/es/candidates/u01-u06-r4.jsonl"


def test_INV_PACK_10_round_four_u01_u06_is_twenty_fresh_candidates_per_slot() -> None:
    """The authored lane must be deep enough to reject, never repair, bad rows."""
    gaps = {
        row["slot"]: row
        for row in map(json.loads, BRIEF.read_text(encoding="utf-8").splitlines()[1:])
    }
    rows = list(map(json.loads, CANDIDATES.read_text(encoding="utf-8").splitlines()))
    counts: Counter[str] = Counter()
    texts: set[tuple[str, str]] = set()

    for row in rows:
        slot = row["slot"]
        slot_name = f"u{slot['unit_index']}/l{slot['lesson_index']}/s{slot['slot_index']}"
        assert slot_name in gaps
        assert row["ledger_digest"] == gaps[slot_name]["ledger_digest"]
        assert row["new_lemmas"] == gaps[slot_name]["new_lemmas"]
        assert (slot_name, row["text"]) not in texts
        texts.add((slot_name, row["text"]))
        counts[slot_name] += 1

    assert len(rows) == 240
    assert len(counts) == 12
    assert set(counts.values()) == {20}
