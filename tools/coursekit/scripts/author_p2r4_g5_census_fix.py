#!/usr/bin/env python3
"""Resample the two slots exhausted by the first complete round-4 G5 census."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BRIEF = ROOT / "content/es/authoring/gap-brief.jsonl"
OUT = ROOT / "content/es/candidates/p2r4-census-fix.jsonl"
AUTHOR = "codex (agent; Freelingo p2r4-g5-census-fix lane)"

MAL = [
    ("Yo soy mal señor.", "I am a bad gentleman."),
    ("Yo no soy mal señor.", "I am not a bad gentleman."),
    ("Sí, yo soy mal señor.", "Yes, I am a bad gentleman."),
    ("Bueno, yo soy mal señor.", "Well, I am a bad gentleman."),
    ("Hola, yo soy mal señor.", "Hello, I am a bad gentleman."),
    ("Tú eres mal señor.", "You are a bad gentleman."),
    ("Tú no eres mal señor.", "You are not a bad gentleman."),
    ("Sí, tú eres mal señor.", "Yes, you are a bad gentleman."),
    ("Bueno, tú eres mal señor.", "Well, you are a bad gentleman."),
    ("Hola, tú eres mal señor.", "Hello, you are a bad gentleman."),
    ("Él es mal señor.", "He is a bad gentleman."),
    ("Él no es mal señor.", "He is not a bad gentleman."),
    ("Sí, él es mal señor.", "Yes, he is a bad gentleman."),
    ("Bueno, él es mal señor.", "Well, he is a bad gentleman."),
    ("Hola, él es mal señor.", "Hello, he is a bad gentleman."),
    ("No soy mal señor.", "I am not a bad gentleman."),
    ("No eres mal señor.", "You are not a bad gentleman."),
    ("No es mal señor.", "He is not a bad gentleman."),
    ("Yo soy mal señor, sí.", "I am a bad gentleman, yes."),
    ("Tú no eres mal señor, no.", "You are not a bad gentleman, no."),
]

FILA_STEMS = [
    ("Estoy en la fila", "I am in the queue"),
    ("Espero en la fila", "I wait in the queue"),
    ("Tú estás en la fila", "You are in the queue"),
    ("La fila está aquí", "The queue is here"),
]
FILA_ENDINGS = [
    ("hoy.", "today."),
    ("por favor.", "please."),
    ("en la recepción.", "at reception."),
    ("con mi documento.", "with my document."),
    ("para este trámite.", "for this procedure."),
]
FILA = [(f"{a} {b}", f"{x} {y}") for a, x in FILA_STEMS for b, y in FILA_ENDINGS]
PAIRS = {"u1/l5/s7": MAL, "u23/l133/s8": FILA}


def main() -> None:
    brief = {
        row["slot"]: row
        for line in BRIEF.read_text(encoding="utf-8").splitlines()[1:]
        if (row := json.loads(line))
    }
    rows = []
    for slot_name, pairs in PAIRS.items():
        slot = brief[slot_name]
        assert len(pairs) == len({text for text, _ in pairs}) == 20
        for text, translation in pairs:
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
                    "slot": {
                        "unit_index": slot["unit_index"],
                        "lesson_index": slot["lesson_index"],
                        "slot_index": slot["slot_index"],
                    },
                    "text": text,
                    "translation": translation,
                }
            )
    OUT.write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )
    print(f"wrote {len(rows)} census-resample candidates")


if __name__ == "__main__":
    main()
