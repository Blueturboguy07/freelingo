import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_INV_PACK_10_round_four_u24_u30_has_twenty_fresh_rows_per_slot() -> None:
    path = ROOT / "content/es/candidates/u24-u30-r4.jsonl"
    rows = list(map(json.loads, path.read_text(encoding="utf-8").splitlines()))
    counts = Counter(
        (row["slot"]["unit_index"], row["slot"]["lesson_index"], row["slot"]["slot_index"])
        for row in rows
    )
    assert len(rows) == 220
    assert len(counts) == 11
    assert set(counts.values()) == {20}
