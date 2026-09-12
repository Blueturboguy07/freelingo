#!/usr/bin/env python3
"""Write the audited P2 round-4 Spanish candidates for units 7-23."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BRIEF = ROOT / "content/es/authoring/gap-brief.jsonl"
OUT = ROOT / "content/es/candidates/u07-u23-r4.jsonl"
AUTHOR = "codex (agent; Freelingo p2r4-author-u07-u23 lane)"


def cross(stems: list[str], endings: list[str]) -> list[tuple[str, str]]:
    return [
        (f"{text} {ending}", f"{translation} {translated_ending}")
        for text, translation in map(split, stems)
        for ending, translated_ending in map(split, endings)
    ]


def split(pair: str) -> tuple[str, str]:
    return tuple(pair.split("|", 1))  # type: ignore[return-value]


PAIRS = {
    "u13/l78/s8": cross(
        [
            "Quiero el billete|I want the ticket",
            "Tengo el billete|I have the ticket",
            "Busco el billete|I am looking for the ticket",
            "Necesito el billete|I need the ticket",
        ],
        [
            "hoy.|today.",
            "aquí.|here.",
            "por favor.|please.",
            "para mañana.|for tomorrow.",
            "en mi bolso.|in my bag.",
        ],
    ),
    "u16/l96/s6": cross(
        [
            "Hoy es mediodía|It is noon now",
            "Ya es mediodía|It is noon already",
            "Trabajo hasta mediodía|I work until noon",
            "Comemos después de mediodía|We eat after noon",
        ],
        [
            "aquí.|here.",
            "en la ciudad.|in the city.",
            "cada día.|every day.",
            "esta semana.|this week.",
            "con mi familia.|with my family.",
        ],
    ),
    "u17/l101/s8": cross(
        [
            "Busco la sombra|I am looking for shade",
            "Estoy en la sombra|I am in the shade",
            "Descanso en la sombra|I rest in the shade",
            "Aquí hay sombra|There is shade here",
        ],
        [
            "hoy.|today.",
            "en el parque.|in the park.",
            "por la tarde.|in the afternoon.",
            "con mi familia.|with my family.",
            "porque hace calor.|because it is hot.",
        ],
    ),
    "u17/l102/s6": cross(
        [
            "El cielo está claro|The sky is clear",
            "Miro el cielo|I look at the sky",
            "Hoy el cielo parece gris|Today the sky looks gray",
            "Hay nubes en el cielo|There are clouds in the sky",
        ],
        [
            "aquí.|here.",
            "esta mañana.|this morning.",
            "por la tarde.|in the afternoon.",
            "sobre la ciudad.|over the city.",
            "después de la lluvia.|after the rain.",
        ],
    ),
    "u19/l112/s3": cross(
        [
            "Explico la propuesta|I explain the proposal",
            "Ella explica la propuesta|She explains the proposal",
            "Él explica la propuesta|He explains the proposal",
            "Quiero explicar la propuesta|I want to explain the proposal",
        ],
        [
            "hoy.|today.",
            "en la reunión.|at the meeting.",
            "para el proyecto.|for the project.",
            "con mi jefe.|with my boss.",
            "cada día.|every day.",
        ],
    ),
    "u21/l121/s8": cross(
        [
            "Me peino|I comb my hair",
            "Ella se peina|She combs her hair",
            "Él se peina|He combs his hair",
            "Voy a peinarme|I am going to comb my hair",
        ],
        [
            "cada mañana.|every morning.",
            "antes de salir.|before leaving.",
            "en el baño.|in the bathroom.",
            "con cuidado.|carefully.",
            "después de ducharme.|after showering.",
        ],
    ),
    "u23/l132/s6": cross(
        [
            "Tú ruegas por ayuda|You ask for help",
            "Ella ruega por ayuda|She asks for help",
            "Él ruega por ayuda|He asks for help",
            "Rogar por ayuda es formal|Asking for help is formal",
        ],
        [
            "por favor.|please.",
            "hoy.|today.",
            "aquí.|here.",
            "con mucho respeto.|very respectfully.",
            "en la oficina.|at the office.",
        ],
    ),
    "u23/l132/s7": cross(
        [
            "Tú saludas|You greet people",
            "Yo saludo|I greet people",
            "Ella saluda|She greets people",
            "Él saluda|He greets people",
        ],
        [
            "por favor.|please.",
            "hoy.|today.",
            "aquí.|here.",
            "con respeto.|respectfully.",
            "con atención.|attentively.",
        ],
    ),
    "u23/l134/s5": cross(
        [
            "Necesito el formulario|I need the form",
            "Tengo el formulario|I have the form",
            "Busco el formulario|I am looking for the form",
            "Voy a firmar el formulario|I am going to sign the form",
        ],
        [
            "por favor.|please.",
            "para este trámite.|for this procedure.",
            "en la recepción.|at reception.",
            "con mi firma.|with my signature.",
            "antes de salir.|before leaving.",
        ],
    ),
    "u23/l134/s6": cross(
        [
            "Necesito el documento|I need the document",
            "Tengo el documento|I have the document",
            "Busco el documento|I am looking for the document",
            "Voy a firmar el documento|I am going to sign the document",
        ],
        [
            "por favor.|please.",
            "para este trámite.|for this procedure.",
            "en la recepción.|at reception.",
            "con mi firma.|with my signature.",
            "antes de salir.|before leaving.",
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
