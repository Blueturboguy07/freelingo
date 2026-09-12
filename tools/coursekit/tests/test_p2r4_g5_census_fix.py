import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_INV_PACK_10_first_full_census_exhaustions_are_resampled() -> None:
    path = ROOT / "content/es/candidates/p2r4-census-fix.jsonl"
    rows = list(map(json.loads, path.read_text(encoding="utf-8").splitlines()))
    counts = Counter(
        (row["slot"]["unit_index"], row["slot"]["lesson_index"], row["slot"]["slot_index"])
        for row in rows
    )
    assert counts == {(1, 5, 7): 20, (23, 133, 8): 20}
