#!/usr/bin/env python3
"""Repair B3's state-of-cleanliness ser template across live Spanish shards."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CANDIDATES = ROOT / "content/es/candidates"
STATE_TRANSLATION = re.compile(r"\b(?:is|are)\b[^.?!]*\b(?:clean|clear)\b", re.IGNORECASE)
SER_LIMPIO = re.compile(r"\b(?P<ser>es|son) (?P<form>limpi(?:o|a|os|as))\b", re.IGNORECASE)
CORRECTION = "P2 B3 state-of-cleanliness correction, 2026-09-12"


def is_state_of_cleanliness_ser(row: dict) -> bool:
    """Select states, while leaving identity/classification senses such as 'fair' alone."""
    return bool(STATE_TRANSLATION.search(row["translation"]) and SER_LIMPIO.search(row["text"]))


def corrected(row: dict) -> dict:
    if not is_state_of_cleanliness_ser(row):
        return row

    def replace(match: re.Match[str]) -> str:
        copula = "está" if match.group("ser").lower() == "es" else "están"
        return f"{copula} {match.group('form')}"

    row["text"] = SER_LIMPIO.sub(replace, row["text"])
    row["review_correction"] = CORRECTION
    return row


def main() -> None:
    changed = 0
    for path in sorted(CANDIDATES.glob("*.jsonl")):
        rows = []
        for line in path.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            before = json.dumps(row, ensure_ascii=False, sort_keys=True)
            row = corrected(row)
            after = json.dumps(row, ensure_ascii=False, sort_keys=True)
            changed += before != after
            rows.append(after)
        path.write_text("\n".join(rows) + "\n", encoding="utf-8")

    assert changed == 34, changed
    print(f"corrected {changed} B3 state-of-cleanliness rows")


if __name__ == "__main__":
    main()
