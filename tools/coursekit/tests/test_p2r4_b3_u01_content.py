import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BAD = {
    "¿Son cuarenta, señor?",
    "En agosto yo tengo veinte años.",
    "Es una costa de un sur europeo.",
}


def test_INV_PACK_10_b3_u01_u06_defects_are_removed_from_every_live_shard() -> None:
    offenders = []
    for path in (ROOT / "content/es/candidates").glob("*.jsonl"):
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            row = json.loads(line)
            if row["text"] in BAD:
                offenders.append((path.name, line_number, row["text"]))
    assert offenders == []
