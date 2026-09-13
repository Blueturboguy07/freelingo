#!/usr/bin/env python3
"""Author fresh candidates for G4 gaps and shifted introductions caused by reviewed-pair quarantine.

Pass the new G4 selected-items JSONL, not the pre-quarantine round-4 gap brief.
The source selection is read-only; the generated shard is raw authoring input and
must still pass the unchanged G5/G6 filters in the integrated build.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from coursekit.stages.g5_gapfill import Slot, ledger_digest

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "content/es/candidates/p2r5-quarantine-resample.jsonl"
AUTHOR = "codex (agent; Freelingo p2r5-quarantine-resample lane)"

PAIRS = {
    (2, 9, 4): (
        "trece",
        [
            ("Trece, por favor.", "Thirteen, please."),
            ("Sí, somos trece.", "Yes, there are thirteen of us."),
            ("No, somos trece.", "No, there are thirteen of us."),
            ("Somos trece, señor.", "There are thirteen of us, sir."),
            ("Somos trece, señora.", "There are thirteen of us, ma'am."),
            ("Hola, somos trece.", "Hello, there are thirteen of us."),
            ("Bueno, somos trece.", "Well, there are thirteen of us."),
            ("Somos trece, sí.", "There are thirteen of us, yes."),
            ("Doce y uno son trece.", "Twelve plus one is thirteen."),
            ("Once y dos son trece.", "Eleven plus two is thirteen."),
            ("Diez y tres son trece.", "Ten plus three is thirteen."),
            ("Nueve y cuatro son trece.", "Nine plus four is thirteen."),
            ("Ocho y cinco son trece.", "Eight plus five is thirteen."),
            ("Siete y seis son trece.", "Seven plus six is thirteen."),
            ("Trece y uno son catorce.", "Thirteen plus one is fourteen."),
            ("Trece y dos son quince.", "Thirteen plus two is fifteen."),
            ("Trece y siete son veinte.", "Thirteen plus seven is twenty."),
            ("Trece y trece son veintiséis.", "Thirteen plus thirteen is twenty-six."),
            ("Somos trece personas.", "There are thirteen of us."),
            ("Hay trece libros.", "There are thirteen books."),
        ],
    ),
    (12, 71, 7): (
        "postre",
        [
            ("Yo como fruta de postre.", "I eat fruit for dessert."),
            ("Yo como una manzana de postre.", "I eat an apple for dessert."),
            ("Yo como un plátano de postre.", "I eat a banana for dessert."),
            ("Mi hermana come una naranja de postre.", "My sister eats an orange for dessert."),
            ("Mi hermano come queso de postre.", "My brother eats cheese for dessert."),
            ("Mi madre come fruta de postre.", "My mother eats fruit for dessert."),
            ("Mi padre come una manzana de postre.", "My father eats an apple for dessert."),
            ("El niño come un plátano de postre.", "The boy eats a banana for dessert."),
            ("La niña come fruta de postre.", "The girl eats fruit for dessert."),
            ("El postre está en la mesa.", "The dessert is on the table."),
            ("El postre está frío.", "The dessert is cold."),
            ("El postre está caliente.", "The dessert is hot."),
            ("Yo quiero un postre.", "I want a dessert."),
            ("Mi hermana quiere otro postre.", "My sister wants another dessert."),
            ("Mi hermano pide un postre.", "My brother orders a dessert."),
            ("Yo prefiero fruta de postre.", "I prefer fruit for dessert."),
            ("El camarero trae el postre.", "The waiter brings the dessert."),
            ("El postre tiene mucho azúcar.", "The dessert has a lot of sugar."),
            ("Yo no quiero postre.", "I do not want dessert."),
            ("El postre es de chocolate.", "The dessert is made of chocolate."),
        ],
    ),
    (26, 151, 4): (
        "beca",
        [
            ("Mi hermana quiere una beca.", "My sister wants a scholarship."),
            ("Mi hermano quiere una beca.", "My brother wants a scholarship."),
            ("Mi amiga quiere una beca.", "My friend wants a scholarship."),
            ("Mi amigo quiere una beca.", "My friend wants a scholarship."),
            ("Mi hija quiere una beca.", "My daughter wants a scholarship."),
            ("Mi hijo quiere una beca.", "My son wants a scholarship."),
            ("Yo quiero una beca.", "I want a scholarship."),
            ("Tú quieres una beca.", "You want a scholarship."),
            ("Ella quiere una beca.", "She wants a scholarship."),
            ("Él quiere una beca.", "He wants a scholarship."),
            ("Mi hermana puede pedir una beca.", "My sister can apply for a scholarship."),
            ("Mi hermano puede pedir una beca.", "My brother can apply for a scholarship."),
            ("La beca es para mi hermana.", "The scholarship is for my sister."),
            ("La beca es para mi hermano.", "The scholarship is for my brother."),
            ("La beca es para este curso.", "The scholarship is for this course."),
            ("El alumno tiene una beca.", "The student has a scholarship."),
            ("La alumna tiene una beca.", "The student has a scholarship."),
            ("Mi hermana tiene una beca.", "My sister has a scholarship."),
            ("Mi hermano tiene una beca.", "My brother has a scholarship."),
            ("Yo necesito una beca.", "I need a scholarship."),
        ],
    ),
    (29, 165, 7): (
        "bocadillo",
        [
            ("¿Quieres un bocadillo?", "Do you want a sandwich?"),
            ("¿Deseas un bocadillo?", "Would you like a sandwich?"),
            ("¿Tomas un bocadillo?", "Are you having a sandwich?"),
            ("¿Pides un bocadillo?", "Are you ordering a sandwich?"),
            ("¿Prefieres un bocadillo?", "Do you prefer a sandwich?"),
            ("¿Quieres otro bocadillo?", "Do you want another sandwich?"),
            ("¿Quieres un bocadillo de queso?", "Do you want a cheese sandwich?"),
            ("¿Quieres un bocadillo de carne?", "Do you want a meat sandwich?"),
            ("¿Quieres un bocadillo de pollo?", "Do you want a chicken sandwich?"),
            ("¿Quieres un bocadillo caliente?", "Do you want a hot sandwich?"),
            ("¿Quieres un bocadillo frío?", "Do you want a cold sandwich?"),
            ("¿Quieres un bocadillo grande?", "Do you want a large sandwich?"),
            ("¿Quieres un bocadillo pequeño?", "Do you want a small sandwich?"),
            ("¿Quieres un bocadillo con tomate?", "Do you want a sandwich with tomato?"),
            ("¿Quieres un bocadillo sin tomate?", "Do you want a sandwich without tomato?"),
            ("¿Quieres un bocadillo y un café?", "Do you want a sandwich and a coffee?"),
            ("¿Quieres un bocadillo y un té?", "Do you want a sandwich and a tea?"),
            ("¿Quieres un bocadillo y un zumo?", "Do you want a sandwich and a juice?"),
            ("¿Quieres un bocadillo y agua?", "Do you want a sandwich and water?"),
            ("¿Quieres el bocadillo para llevar?", "Do you want the sandwich to go?"),
        ],
    ),
}


# The quarantine also changes which lemma three already-empty slots introduce.
# Resample them instead of editing the old raw rows into agreement with a new slot.
PAIRS.update(
    {
        (2, 9, 5): (
            "cuarenta",
            [
                ("Cuarenta, por favor.", "Forty, please."),
                ("Sí, somos cuarenta.", "Yes, there are forty of us."),
                ("No, somos cuarenta.", "No, there are forty of us."),
                ("Somos cuarenta, señor.", "There are forty of us, sir."),
                ("Somos cuarenta, señora.", "There are forty of us, ma'am."),
                ("Hola, somos cuarenta.", "Hello, there are forty of us."),
                ("Bueno, somos cuarenta.", "Well, there are forty of us."),
                ("Somos cuarenta, sí.", "There are forty of us, yes."),
                ("Treinta y diez son cuarenta.", "Thirty plus ten is forty."),
                ("Veinte y veinte son cuarenta.", "Twenty plus twenty is forty."),
                ("Cuatro por diez son cuarenta.", "Four times ten is forty."),
                ("Diez por cuatro son cuarenta.", "Ten times four is forty."),
                ("Diez y treinta son cuarenta.", "Ten plus thirty is forty."),
                ("Dos por veinte son cuarenta.", "Two times twenty is forty."),
                ("Veinte por dos son cuarenta.", "Twenty times two is forty."),
                ("Ocho por cinco son cuarenta.", "Eight times five is forty."),
                ("Cinco por ocho son cuarenta.", "Five times eight is forty."),
                ("Somos cuarenta personas.", "There are forty of us."),
                ("Hay cuarenta libros.", "There are forty books."),
                ("La cuenta es de cuarenta euros.", "The bill is forty euros."),
            ],
        ),
        (2, 9, 6): (
            None,
            [
                ("Sí, somos cuatro.", "Yes, there are four of us."),
                ("No, somos cuatro.", "No, there are four of us."),
                ("Hola, somos cuatro.", "Hello, there are four of us."),
                ("Somos cuatro, señor.", "There are four of us, sir."),
                ("Somos cuatro, señora.", "There are four of us, ma'am."),
                ("Somos cuatro, sí.", "There are four of us, yes."),
                ("Bueno, somos cuatro.", "Well, there are four of us."),
                ("¿Somos cinco o seis?", "Are there five or six of us?"),
                ("Dos y tres son cinco.", "Two plus three is five."),
                ("Dos y cuatro son seis.", "Two plus four is six."),
                ("Dos y cinco son siete.", "Two plus five is seven."),
                ("Tres y cuatro son siete.", "Three plus four is seven."),
                ("Cuatro y cuatro son ocho.", "Four plus four is eight."),
                ("Cinco y cinco son diez.", "Five plus five is ten."),
                ("Seis y seis son doce.", "Six plus six is twelve."),
                ("Siete y siete son catorce.", "Seven plus seven is fourteen."),
                ("Cinco por tres son quince.", "Five times three is fifteen."),
                ("Tres por cuatro son doce.", "Three times four is twelve."),
                ("Somos cuatro personas.", "There are four of us."),
                ("Hay cuatro sillas.", "There are four chairs."),
            ],
        ),
        (26, 151, 5): (
            "biblioteca",
            [
                (
                    "Mi hermana quiere estudiar en la biblioteca.",
                    "My sister wants to study in the library.",
                ),
                (
                    "Mi hermano quiere estudiar en la biblioteca.",
                    "My brother wants to study in the library.",
                ),
                ("Yo quiero estudiar en la biblioteca.", "I want to study in the library."),
                ("Tú quieres estudiar en la biblioteca.", "You want to study in the library."),
                (
                    "El alumno quiere estudiar en la biblioteca.",
                    "The student wants to study in the library.",
                ),
                (
                    "La alumna quiere estudiar en la biblioteca.",
                    "The student wants to study in the library.",
                ),
                (
                    "Mi amiga quiere estudiar en la biblioteca.",
                    "My friend wants to study in the library.",
                ),
                (
                    "Mi amigo quiere estudiar en la biblioteca.",
                    "My friend wants to study in the library.",
                ),
                (
                    "Mi hermana puede estudiar en la biblioteca.",
                    "My sister can study in the library.",
                ),
                (
                    "Mi hermano puede estudiar en la biblioteca.",
                    "My brother can study in the library.",
                ),
                ("Yo puedo estudiar en la biblioteca.", "I can study in the library."),
                ("Tú puedes estudiar en la biblioteca.", "You can study in the library."),
                (
                    "El alumno puede estudiar en la biblioteca.",
                    "The student can study in the library.",
                ),
                (
                    "Mi hermana empieza a estudiar en la biblioteca.",
                    "My sister starts studying in the library.",
                ),
                (
                    "Mi hermano empieza a estudiar en la biblioteca.",
                    "My brother starts studying in the library.",
                ),
                ("La biblioteca cierra a las cinco.", "The library closes at five."),
                ("La biblioteca abre a las nueve.", "The library opens at nine."),
                ("Mi hermana lee en la biblioteca.", "My sister reads in the library."),
                ("Mi hermano lee en la biblioteca.", "My brother reads in the library."),
                ("Yo busco un libro en la biblioteca.", "I am looking for a book in the library."),
            ],
        ),
    }
)

# Specific authored equivalence judgements, with their own back-translations.
# They are claims that G5/G6 must check; this script never certifies acceptance.
ALTERNATES = {
    ((2, 9, 4), "Trece, por favor."): [("Por favor, trece.", "Thirteen, please.")],
    ((2, 9, 5), "Cuarenta, por favor."): [("Por favor, cuarenta.", "Forty, please.")],
    ((12, 71, 7), "Yo como fruta de postre."): [
        ("Yo tomo fruta de postre.", "I have fruit for dessert."),
    ],
    ((12, 71, 7), "La niña come fruta de postre."): [
        ("La niña toma fruta de postre.", "The girl has fruit for dessert."),
    ],
    ((29, 165, 7), "¿Prefieres un bocadillo?"): [
        ("¿Tú prefieres un bocadillo?", "Do you prefer a sandwich?"),
    ],
    ((29, 165, 7), "¿Quieres un bocadillo?"): [
        ("¿Tú quieres un bocadillo?", "Do you want a sandwich?"),
    ],
}


# English friend/student has no gender cue in these eight reviewed reserve pairs.
# Both existing Spanish canonicals are independently authored and mean that English.
ALTERNATES.update(
    {
        ((26, 151, 4), "Mi amiga quiere una beca."): [
            ("Mi amigo quiere una beca.", "My friend wants a scholarship."),
        ],
        ((26, 151, 4), "Mi amigo quiere una beca."): [
            ("Mi amiga quiere una beca.", "My friend wants a scholarship."),
        ],
        ((26, 151, 4), "El alumno tiene una beca."): [
            ("La alumna tiene una beca.", "The student has a scholarship."),
        ],
        ((26, 151, 4), "La alumna tiene una beca."): [
            ("El alumno tiene una beca.", "The student has a scholarship."),
        ],
        ((26, 151, 5), "El alumno quiere estudiar en la biblioteca."): [
            (
                "La alumna quiere estudiar en la biblioteca.",
                "The student wants to study in the library.",
            ),
        ],
        ((26, 151, 5), "La alumna quiere estudiar en la biblioteca."): [
            (
                "El alumno quiere estudiar en la biblioteca.",
                "The student wants to study in the library.",
            ),
        ],
        ((26, 151, 5), "Mi amiga quiere estudiar en la biblioteca."): [
            (
                "Mi amigo quiere estudiar en la biblioteca.",
                "My friend wants to study in the library.",
            ),
        ],
        ((26, 151, 5), "Mi amigo quiere estudiar en la biblioteca."): [
            (
                "Mi amiga quiere estudiar en la biblioteca.",
                "My friend wants to study in the library.",
            ),
        ],
    }
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selected-items", required=True, type=Path)
    args = parser.parse_args()
    selection = {
        Slot.of(row): row
        for line in args.selected_items.read_text(encoding="utf-8").splitlines()
        if (row := json.loads(line))
    }
    rows = []
    for key, (new_lemma, pairs) in PAIRS.items():
        slot = Slot(*key)
        selected = selection[slot]
        expected_new = [new_lemma] if new_lemma else []
        assert selected["gap"] and selected["new_lemmas"] == expected_new, slot
        assert len(pairs) == len({text for text, _ in pairs}) == 20, slot
        for text, translation in pairs:
            rows.append(
                {
                    "accepted_alternates": [
                        {
                            "text": surface,
                            "backtranslation": {
                                "back_translation": back_translation,
                                "judged_by": "agent",
                                "rubric_version": "1",
                                "score": 4,
                            },
                        }
                        for surface, back_translation in ALTERNATES.get((key, text), [])
                    ],
                    "author": AUTHOR,
                    "backtranslation": {
                        "back_translation": translation,
                        "judged_by": "agent",
                        "rubric_version": "1",
                        "score": 4,
                    },
                    "generated_at": "2026-09-13",
                    "ledger_digest": ledger_digest(
                        selected["known_lemmas"], selected["new_lemmas"]
                    ),
                    "new_lemmas": list(selected["new_lemmas"]),
                    "provenance": "llm",
                    "slot": dict(
                        zip(("unit_index", "lesson_index", "slot_index"), key, strict=True)
                    ),
                    "text": text,
                    "translation": translation,
                }
            )
    OUT.write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )
    print(f"wrote {len(rows)} fresh quarantine-resample candidates")


if __name__ == "__main__":
    main()
