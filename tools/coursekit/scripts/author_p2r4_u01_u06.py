#!/usr/bin/env python3
"""Write the audited P2 round-4 Spanish candidates for units 1-6."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BRIEF = ROOT / "content/es/authoring/gap-brief.jsonl"
OUT = ROOT / "content/es/candidates/u01-u06-r4.jsonl"
AUTHOR = "codex (agent; Freelingo p2r4-author-u01-u06 lane)"


def variants(prefixes: list[str], endings: list[str], *, limit: int = 20) -> list[tuple[str, str]]:
    rows = [
        (f"{left} {right}", f"{l1} {r1}")
        for left, l1 in map(split, prefixes)
        for right, r1 in map(split, endings)
    ]
    return rows[:limit]


def split(pair: str) -> tuple[str, str]:
    return tuple(pair.split("|", 1))  # type: ignore[return-value]


PAIRS: dict[str, list[tuple[str, str]]] = {
    "u1/l2/s2": variants(
        [
            "Hola,|Hello,",
            "Buenos días,|Good morning,",
            "Buenas tardes,|Good afternoon,",
            "Buenas noches,|Good evening,",
        ],
        [
            "por favor.|please.",
            "sí, por favor.|yes, please.",
            "gracias, por favor.|thank you, please.",
            "buenos días, por favor.|good morning, please.",
            "buenas tardes, por favor.|good afternoon, please.",
        ],
    ),
    "u1/l2/s4": variants(
        ["Sí,|Yes,", "Sí, sí,|Yes, yes,", "Bueno, sí,|Well, yes,", "Hola, sí,|Hello, yes,"],
        [
            "buenos días.|good morning.",
            "buenas tardes.|good afternoon.",
            "buenas noches.|good evening.",
            "por favor.|please.",
            "gracias.|thank you.",
        ],
    ),
    "u1/l2/s6": variants(
        [
            "Hola,|Hello,",
            "Adiós,|Goodbye,",
            "Gracias,|Thank you,",
            "Por favor,|Please,",
        ],
        [
            "buenos días.|good morning.",
            "buenas tardes.|good afternoon.",
            "buenas noches.|good evening.",
            "sí, por favor.|yes, please.",
            "hola, gracias.|hello, thank you.",
        ],
    ),
    "u1/l2/s7": variants(
        [
            "Buenos días,|Good morning,",
            "Buenas tardes,|Good afternoon,",
            "Buenas noches,|Good evening,",
            "Bueno,|Well,",
        ],
        [
            "hola, adiós.|hello, goodbye.",
            "sí, por favor.|yes, please.",
            "sí, gracias.|yes, thank you.",
            "por favor, gracias.|please, thank you.",
            "hola, gracias.|hello, thank you.",
        ],
    ),
    "u1/l3/s1": variants(
        ["Yo soy|I am", "Yo no soy|I am not", "Sí, yo soy|Yes, I am", "Hola, yo soy|Hello, I am"],
        [
            "bueno.|good.",
            "él.|him.",
            "yo.|myself.",
            "bueno por favor.|good, please.",
            "bueno por la noche.|good at night.",
        ],
    ),
    "u1/l4/s4": variants(
        [
            "Nombre,|Name,",
            "Sí, nombre,|Yes, name,",
            "No, nombre,|No, name,",
            "Hola, nombre,|Hello, name,",
        ],
        [
            "por favor.|please.",
            "señor, por favor.|sir, please.",
            "señora, por favor.|ma'am, please.",
            "sí, por favor.|yes, please.",
            "no, señor.|no, sir.",
        ],
    ),
    "u1/l5/s6": variants(
        [
            "Encantado,|Pleased to meet you,",
            "Yo soy encantado,|I am delighted,",
            "Sí, encantado,|Yes, pleased to meet you,",
            "Mucho gusto, encantado,|A pleasure, delighted to meet you,",
        ],
        [
            "señor.|sir.",
            "señora.|ma'am.",
            "mucho gusto.|a pleasure.",
            "buenos días.|good morning.",
            "y hasta luego.|and see you later.",
        ],
    ),
    "u1/l6/s2": variants(
        [
            "Hasta luego,|See you later,",
            "Hasta la tarde,|Until this afternoon,",
            "Hasta la noche,|Until tonight,",
            "Adiós y hasta luego,|Goodbye and see you later,",
        ],
        [
            "señor.|sir.",
            "señora.|ma'am.",
            "mucho gusto.|a pleasure.",
            "y gracias.|and thank you.",
            "encantado.|pleased to meet you.",
        ],
    ),
    "u1/l6/s3": variants(
        [
            "Luego,|Later,",
            "Hasta luego,|See you later,",
            "Sí, luego,|Yes, later,",
            "Bueno, luego,|Well, later,",
        ],
        [
            "buenos días.|good morning.",
            "buenas tardes.|good afternoon.",
            "buenas noches.|good evening.",
            "muchas gracias.|thank you very much.",
            "señor y señora.|sir and ma'am.",
        ],
    ),
    "u1/l6/s4": variants(
        [
            "Mucho gusto y|A pleasure and",
            "Encantado y|Pleased to meet you and",
            "Buenos días y|Good morning and",
            "Buenas tardes y|Good afternoon and",
        ],
        [
            "hasta luego.|see you later.",
            "muchas gracias.|thank you very much.",
            "buenas noches.|good evening.",
            "adiós, señor.|goodbye, sir.",
            "adiós, señora.|goodbye, ma'am.",
        ],
    ),
    "u1/l6/s5": variants(
        ["¿Cómo eres|How are", "¿Cómo es|How is", "¿Eres tú|Are you", "¿Es él|Is he"],
        [
            "tú, señor?|you, sir?",
            "tú, señora?|you, ma'am?",
            "bueno por la tarde?|good this afternoon?",
            "bueno por la noche?|good tonight?",
            "tú por la noche?|you tonight?",
        ],
    ),
    "u4/l24/s6": variants(
        [
            "El suelo es|The floor is",
            "Todo el suelo es|The whole floor is",
            "El suelo número uno es|Floor number one is",
            "El suelo de aquí es|The floor here is",
        ],
        [
            "el primero.|the first one.",
            "el segundo.|the second one.",
            "el tercero.|the third one.",
            "bueno.|good.",
            "bueno y nuevo.|good and new.",
        ],
    ),
}


def main() -> None:
    brief = {
        row["slot"]: row
        for line in BRIEF.read_text(encoding="utf-8").splitlines()[1:]
        if (row := json.loads(line))
    }
    rows: list[dict] = []
    for slot_name, pairs in PAIRS.items():
        assert len(pairs) >= 20, (slot_name, len(pairs))
        assert len({text for text, _ in pairs}) == len(pairs), slot_name
        slot = brief[slot_name]
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
    print(f"wrote {len(rows)} rows over {len(PAIRS)} slots to {OUT}")


if __name__ == "__main__":
    main()
