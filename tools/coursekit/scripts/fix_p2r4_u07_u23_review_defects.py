#!/usr/bin/env python3
"""Apply the B3 review corrections owned by the units 7-23 authoring lane."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FILES = (
    ROOT / "content/es/candidates/u07-u14.jsonl",
    ROOT / "content/es/candidates/u15-u23.jsonl",
)


def corrected(row: dict) -> dict:
    text = row["text"]
    translation = row["translation"]

    if text.startswith("Continúa "):
        translation = translation.replace(
            "You carry on straight on as far as", "Continue straight to"
        ).replace("You carry on as far as", "Continue to")
    if "hay nubes" in text and "There is clouds" in translation:
        translation = translation.replace("There is clouds", "There are clouds")
    if text in {"Los dormitorios son limpios.", "Los salones son limpios."}:
        text = text.replace(" son ", " están ")
    if text == "No encuentro mi cartera.":
        translation = "I can't find my wallet."
    if text == "Mi hermana avisa la propuesta.":
        text = "Mi hermana avisa sobre la propuesta."
        translation = "My sister tells us about the proposal."

    if text != row["text"] or translation != row["translation"]:
        row["text"] = text
        row["translation"] = translation
        row["backtranslation"]["back_translation"] = translation
        row["review_correction"] = "P2 B3 agent-scored sample correction, 2026-09-12"
    return row


def main() -> None:
    changed = 0
    for path in FILES:
        rows = []
        for line in path.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            before = json.dumps(row, ensure_ascii=False, sort_keys=True)
            row = corrected(row)
            after = json.dumps(row, ensure_ascii=False, sort_keys=True)
            changed += before != after
            rows.append(after)
        path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    assert changed == 57, changed
    print(f"corrected {changed} B3 candidate rows")


if __name__ == "__main__":
    main()
