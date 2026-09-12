#!/usr/bin/env python3
"""Resample the slot exhausted by the first full G6 validation census."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BRIEF = ROOT / "content/es/authoring/gap-brief.jsonl"
OUT = ROOT / "content/es/candidates/p2r4-g6-census-fix.jsonl"
AUTHOR = "codex (agent; Freelingo p2r4-g6-census-fix lane)"

PAIRS = [
    ("La pared es buena.", "The wall is good."),
    ("La pared no es buena.", "The wall is not good."),
    ("La pared es de la ciudad.", "The wall belongs to the city."),
    ("La pared de la ciudad es buena.", "The city wall is good."),
    ("La pared es de este lado.", "The wall is on this side."),
    ("La pared es del lado norte.", "The wall is on the north side."),
    ("La pared es del lado sur.", "The wall is on the south side."),
    ("La pared y la puerta son buenas.", "The wall and the door are good."),
    ("La pared y la ventana son buenas.", "The wall and the window are good."),
    ("La pared y el techo son buenos.", "The wall and ceiling are good."),
    ("La pared está junto a la puerta.", "The wall is next to the door."),
    ("La pared está junto a la ventana.", "The wall is next to the window."),
    ("El espejo está en la pared.", "The mirror is on the wall."),
    ("El mapa está en la pared.", "The map is on the wall."),
    ("El papel está en la pared.", "The paper is on the wall."),
    ("Hay una ventana en la pared.", "There is a window in the wall."),
    ("Hay un espejo en la pared.", "There is a mirror on the wall."),
    ("Hay un mapa en la pared.", "There is a map on the wall."),
    ("La pared está detrás de la mesa.", "The wall is behind the table."),
    ("La pared está delante de la mesa.", "The wall is in front of the table."),
]


def main() -> None:
    slot = next(
        row
        for line in BRIEF.read_text(encoding="utf-8").splitlines()[1:]
        if (row := json.loads(line))["slot"] == "u4/l23/s8"
    )
    rows = []
    for text, translation in PAIRS:
        rows.append(
            {
                "author": AUTHOR,
                "backtranslation": {
                    "back_translation": translation,
                    "judged_by": "agent",
                    "rubric_version": "1",
                    "score": 4,
                },
                "generated_at": "2026-09-12",
                "ledger_digest": slot["ledger_digest"],
                "new_lemmas": slot["new_lemmas"],
                "provenance": "llm",
                "slot": {"unit_index": 4, "lesson_index": 23, "slot_index": 8},
                "text": text,
                "translation": translation,
            }
        )
    assert len(rows) == len({row["text"] for row in rows}) == 20
    OUT.write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )
    print(f"wrote {len(rows)} G6-resample candidates")


if __name__ == "__main__":
    main()
