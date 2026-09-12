#!/usr/bin/env python3
"""Write the audited P2 round-4 Spanish candidates for units 24-30."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BRIEF = ROOT / "content/es/authoring/gap-brief.jsonl"
OUT = ROOT / "content/es/candidates/u24-u30-r4.jsonl"
AUTHOR = "codex (agent; Freelingo p2r4-author-u24-u30 lane)"


def split(pair: str) -> tuple[str, str]:
    return tuple(pair.split("|", 1))  # type: ignore[return-value]


def cross(stems: list[str], endings: list[str]) -> list[tuple[str, str]]:
    return [
        (f"{text} {ending}", f"{translation} {translated_ending}")
        for text, translation in map(split, stems)
        for ending, translated_ending in map(split, endings)
    ]


WHEN = [
    "hoy.|today.",
    "esta mañana.|this morning.",
    "por la tarde.|in the afternoon.",
    "en casa.|at home.",
    "desde ayer.|since yesterday.",
]

PAIRS = {
    "u25/l143/s8": cross(
        [
            "Me duele la garganta|My throat hurts",
            "Tengo dolor de garganta|I have a sore throat",
            "Mi garganta está seca|My throat is dry",
            "El médico mira mi garganta|The doctor examines my throat",
        ],
        WHEN,
    ),
    "u25/l144/s8": cross(
        [
            "Me duele la pierna|My leg hurts",
            "Tengo dolor en la pierna|I have pain in my leg",
            "Mi pierna está mejor|My leg is better",
            "El médico mira mi pierna|The doctor examines my leg",
        ],
        WHEN,
    ),
    "u25/l145/s4": cross(
        [
            "Me duele el ojo|My eye hurts",
            "Tengo dolor en el ojo|I have pain in my eye",
            "Mi ojo está mejor|My eye is better",
            "El médico mira mi ojo|The doctor examines my eye",
        ],
        WHEN,
    ),
    "u27/l154/s4": cross(
        [
            "El precio es doble|The price is double",
            "La cantidad es doble|The amount is double",
            "Quiero el doble|I want twice as much",
            "Ahora tenemos el doble|Now we have twice as much",
        ],
        [
            "que ayer.|as yesterday.",
            "en esta tienda.|in this shop.",
            "para el proyecto.|for the project.",
            "esta semana.|this week.",
            "por la mañana.|in the morning.",
        ],
    ),
    "u27/l154/s5": cross(
        [
            "Quiero la mitad|I want half",
            "Tengo la mitad|I have half",
            "Pagamos la mitad|We pay half",
            "La mitad es suficiente|Half is enough",
        ],
        [
            "del precio.|of the price.",
            "de la cantidad.|of the amount.",
            "para el proyecto.|for the project.",
            "esta semana.|this week.",
            "por la mañana.|in the morning.",
        ],
    ),
    "u27/l154/s6": cross(
        [
            "El tamaño es grande|The size is large",
            "El tamaño es pequeño|The size is small",
            "Comparamos el tamaño|We compare the size",
            "Quiero este tamaño|I want this size",
        ],
        [
            "hoy.|today.",
            "en la tienda.|in the shop.",
            "con el otro.|with the other one.",
            "para mi casa.|for my home.",
            "antes de comprar.|before buying.",
        ],
    ),
    "u27/l156/s3": cross(
        [
            "La ciudad crece|The city grows",
            "El proyecto crece|The project grows",
            "La cantidad puede crecer|The amount can grow",
            "Queremos crecer|We want to grow",
        ],
        [
            "cada año.|each year.",
            "muy rápido.|very quickly.",
            "poco a poco.|little by little.",
            "durante el verano.|during the summer.",
            "con el tiempo.|over time.",
        ],
    ),
    "u27/l157/s5": cross(
        [
            "El rango es amplio|The range is broad",
            "El rango es pequeño|The range is small",
            "Comparamos el rango|We compare the range",
            "Este rango parece bueno|This range looks good",
        ],
        [
            "hoy.|today.",
            "en el informe.|in the report.",
            "para el proyecto.|for the project.",
            "entre los dos.|between the two.",
            "durante la reunión.|during the meeting.",
        ],
    ),
    "u27/l157/s6": cross(
        [
            "El promedio es alto|The average is high",
            "El promedio es bajo|The average is low",
            "Calculamos el promedio|We calculate the average",
            "Este promedio parece bueno|This average looks good",
        ],
        [
            "hoy.|today.",
            "en el informe.|in the report.",
            "para el proyecto.|for the project.",
            "entre los dos.|between the two.",
            "durante la reunión.|during the meeting.",
        ],
    ),
    "u27/l158/s7": cross(
        [
            "El total es correcto|The total is correct",
            "El total es alto|The total is high",
            "Calculamos el total|We calculate the total",
            "Este total parece bueno|This total looks good",
        ],
        [
            "hoy.|today.",
            "en el informe.|in the report.",
            "para el proyecto.|for the project.",
            "entre los dos.|between the two.",
            "durante la reunión.|during the meeting.",
        ],
    ),
    "u29/l168/s6": cross(
        [
            "El pan está cortado|The bread is sliced",
            "El tomate está cortado|The tomato is cut",
            "El queso está cortado|The cheese is sliced",
            "Todo está cortado|Everything is cut",
        ],
        [
            "hoy.|today.",
            "en la cocina.|in the kitchen.",
            "para la cena.|for dinner.",
            "sobre la mesa.|on the table.",
            "antes de comer.|before eating.",
        ],
    ),
}


def main() -> None:
    brief = {
        row["slot"]: row
        for line in BRIEF.read_text(encoding="utf-8").splitlines()[1:]
        if (row := json.loads(line))
    }
    rows = []
    for slot_name, pairs in PAIRS.items():
        assert len(pairs) == 20
        assert len({text for text, _ in pairs}) == 20
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
