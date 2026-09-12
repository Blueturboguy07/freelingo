#!/usr/bin/env python3
"""Apply the three units 1-6 corrections named by the B3 sample review."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FILES = tuple((ROOT / "content/es/candidates").glob("*.jsonl"))
REPLACEMENTS = {
    "¿Son cuarenta, señor?": ("¿Hay cuarenta, señor?", "Are there forty, sir?"),
    "En agosto yo tengo veinte años.": (
        "En agosto yo cumplo veinte años.",
        "In August I turn twenty.",
    ),
    "Es una costa de un sur europeo.": (
        "Es una costa del sur europeo.",
        "It is a coast in southern Europe.",
    ),
}


def main() -> None:
    changed = 0
    for path in FILES:
        output = []
        for line in path.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            replacement = REPLACEMENTS.get(row["text"])
            if replacement:
                row["text"], row["translation"] = replacement
                row["backtranslation"]["back_translation"] = row["translation"]
                row["review_correction"] = "P2 B3 agent-scored sample correction, 2026-09-12"
                changed += 1
            output.append(json.dumps(row, ensure_ascii=False, sort_keys=True))
        path.write_text("\n".join(output) + "\n", encoding="utf-8")
    assert changed == 8, changed
    print(f"corrected {changed} units 1-6 B3 candidate rows")


if __name__ == "__main__":
    main()
