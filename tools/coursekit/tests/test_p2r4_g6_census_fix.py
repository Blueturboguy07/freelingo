import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_INV_PACK_10_g6_exhaustion_has_twenty_new_agent_approved_candidates() -> None:
    path = ROOT / "content/es/candidates/p2r4-g6-census-fix.jsonl"
    rows = list(map(json.loads, path.read_text(encoding="utf-8").splitlines()))
    assert len(rows) == 20
    assert {
        (row["slot"]["unit_index"], row["slot"]["lesson_index"], row["slot"]["slot_index"])
        for row in rows
    } == {(4, 23, 8)}
    assert {row["backtranslation"]["score"] for row in rows} == {4}
