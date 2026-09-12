"""Materialise the independently reviewed 2026-09-12 H1 sheet.

This is intentionally a decision table keyed by the stable row number and exercise id,
not a heuristic scorer.  Re-running it against a changed draw fails before writing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

WRONG: dict[int, tuple[str, str]] = {
    7: (
        "grammar",
        "`Yo soy mal señor` needs an article and agreement (`Soy un mal señor`).",
    ),
    12: ("answer_set", "`uno` means `one`; bare `a` is not an acceptable match here."),
    17: (
        "grammar",
        "The completed equation lacks `son/es`: `Cuatro por cinco son veinte`.",
    ),
    18: (
        "meaning",
        "`Son pocos` means `they are few`, not existential `there are few`.",
    ),
    25: ("grammar", "The Spanish is a fragment missing the existential verb `hay`."),
    29: (
        "answer_set",
        "With no subject context, this also means `Where is he/she from?`.",
    ),
    30: ("answer_set", "The obvious pro-drop answer `¿Es americano?` is missing."),
    31: ("answer_set", "The obvious pro-drop answer `Es europeo` is missing."),
    53: (
        "answer_set",
        "The gender-neutral English also admits `Soy tu vecina`, which is missing.",
    ),
    64: (
        "answer_set",
        "The supplied answer duplicates the printed word, yielding `TienesTienes`.",
    ),
    68: ("answer_set", "Infinitive `repetir` does not mean third-person `repeats`."),
    71: (
        "answer_set",
        "English `cousin` also admits masculine `Mi primo`, which is missing.",
    ),
    77: (
        "answer_set",
        "The obvious pro-drop answer `Habló fuerte y claro` is missing.",
    ),
    81: (
        "meaning",
        "`Hoy es buena fecha` does not mean conditional `Today would be good`.",
    ),
    86: (
        "answer_set",
        "Distractor `Queréis` also makes a valid context-free sentence.",
    ),
    91: (
        "answer_set",
        "The obvious `beber` translation is missing from the accepted set.",
    ),
    93: (
        "answer_set",
        "Distractor `tarjetas` also makes a valid context-free sentence.",
    ),
    94: ("answer_set", "Infinitive `estar` means `to be`, not finite `is`."),
    100: ("grammar", "Location is `a la izquierda`, not `en la izquierda`."),
    101: ("grammar", "Location is `a la izquierda`, not `en la izquierda`."),
    118: (
        "answer_set",
        "Infinitive `recibir` means `receive`, not past-tense `received`.",
    ),
    119: ("answer_set", "The obvious `Entendemos por qué` is missing."),
    120: (
        "answer_set",
        "The obvious non-pronominal `Quiero comer el queso` is missing.",
    ),
    124: (
        "meaning",
        "`quieres` is `do you want`; the prompt asks conditional `would you like`.",
    ),
    127: ("answer_set", "The obvious `Quiero doce huevos` is missing."),
    136: (
        "answer_set",
        "`interesar = interested` and `preferir = prefers` mismatch form/meaning.",
    ),
    140: ("answer_set", "The obvious conditional `Quisiera dibujar` is missing."),
    149: (
        "meaning",
        "`Entró en el banco` means entered the bank, not merely went to it.",
    ),
    167: ("answer_set", "Singular `grado` is `degree`, not plural `degrees`."),
    168: (
        "answer_set",
        "Peninsular `Hoy hace calor, ¿verdad?` is an obvious missing answer.",
    ),
    174: (
        "answer_set",
        "Distractor `deportes` also makes a valid context-free sentence.",
    ),
    180: ("answer_set", "Singular `bañera` is `bathtub`, not plural `bathtubs`."),
    182: ("meaning", "`lápices` means pencils; ordinary pen is `bolígrafos`."),
    195: (
        "answer_set",
        "With no antecedent, `le` also admits `her`; only `him` is accepted.",
    ),
    198: ("answer_set", "The obvious pro-drop translation `Jamás mienten` is missing."),
    203: ("answer_set", "The obvious pro-drop translation `No es bonita` is missing."),
    210: (
        "answer_set",
        "Infinitive `despertar` means `wake/to wake`, not past `woke`.",
    ),
    219: ("grammar", "An inherently heavy backpack is `es pesada`, not `está pesada`."),
    225: ("answer_set", "`solicitar` means `request/apply for`, not `that`."),
    232: ("answer_set", "`del` means `of/from the`; bare `the` drops the preposition."),
    234: (
        "answer_set",
        "Distractor `Estarían` also makes a valid context-free sentence.",
    ),
    236: (
        "meaning",
        "The broken English prompt says going in; the answer says going to enter.",
    ),
    250: ("answer_set", "The obvious `El proyecto está tomando forma` is missing."),
    254: ("answer_set", "`alumno = pupils` and `colgar = hung` mismatch number/tense."),
    257: ("meaning", "`llegar a la biblioteca` means get to/reach it, not find it."),
    267: ("answer_set", "`alcanzar` means `reach/achieve`, not `was`."),
    276: (
        "answer_set",
        "Distractor `competían` also makes a valid context-free sentence.",
    ),
    279: (
        "answer_set",
        "Several pairs mismatch form or sense (`entrenar`, `lanzar`, `marcar`).",
    ),
    281: ("meaning", "`para comer` means to eat, not specifically `for lunch`."),
    288: ("answer_set", "`encargar` means order/commission/entrust, not `of`."),
    295: (
        "answer_set",
        "With no speaker gender, distractor `invitada` is also correct.",
    ),
}

AWKWARD: dict[int, tuple[str, str]] = {
    2: (
        "naturalness",
        "`Please, yes` / `Por favor, sí` is defensible but context-free and stilted.",
    ),
    39: (
        "naturalness",
        "`La pared es buena` is grammatical but not an ordinary description of a wall.",
    ),
    40: (
        "naturalness",
        "`una cosa de una señora` is a literal, context-free possessive.",
    ),
    41: (
        "naturalness",
        "`El suelo es el primero` is grammatical but pragmatically opaque.",
    ),
    43: (
        "naturalness",
        "A drawer is normally `de la mesa`, not generically `de una mesa`.",
    ),
    59: (
        "naturalness",
        "`un mes bueno` is grammatical but marked here; `un buen mes` is natural.",
    ),
    71: (
        "naturalness",
        "`explica su idioma` is grammatical but an unlikely unqualified utterance.",
    ),
    74: (
        "naturalness",
        "The pair is comprehensible but semantically odd and pedagogically dead.",
    ),
    76: (
        "naturalness",
        "Calling a notebook clean is grammatical but an implausible teaching sentence.",
    ),
    132: (
        "naturalness",
        "`La leche debe caducar hoy` is stilted for an expiry-date statement.",
    ),
    144: (
        "naturalness",
        "`concierto entretenido` is understandable but an unnatural collocation here.",
    ),
    152: (
        "naturalness",
        "`La dirección hasta la plaza es fácil` is not idiomatic for an easy route.",
    ),
    160: (
        "naturalness",
        "A `cliente frecuente el lunes` is an implausible one-day classification.",
    ),
    170: (
        "naturalness",
        "Needing one unspecified glove in spring is grammatical but contrived.",
    ),
    201: (
        "naturalness",
        "Being both similar and the same is internally incoherent, though grammatical.",
    ),
    228: (
        "naturalness",
        "`¿Esperas tú en la fila?` is marked without contrastive emphasis.",
    ),
    264: (
        "naturalness",
        "`El tamaño es grande hoy` is grammatical but pragmatically nonsensical.",
    ),
    269: ("naturalness", "A price range is normally `amplio`, not `grande`."),
    285: (
        "naturalness",
        "`El pan está cortado hoy` has an unexplained, unnatural temporal adjunct.",
    ),
    286: (
        "naturalness",
        "The translation is literal but the source sentence is pragmatically odd.",
    ),
    290: (
        "register",
        "Bare `jugar fútbol` is Latin-American; peninsular Spanish uses `jugar al fútbol`.",
    ),
    297: ("naturalness", "Natural Spanish is `Hay diez velas en el pastel`."),
    300: (
        "naturalness",
        "`La alegría ... es grande` is grammatical but conspicuously stilted.",
    ),
}

EXPECTED_IDS: dict[int, str] = {
    # Sentinel rows make accidental use against another deterministic draw fail loudly.
    1: "116fad83f4658c5d",
    150: "7324fbfd5af4d32c",
    300: "b37490ca857aa9a1",
}
EXPECTED_SAMPLE_SHA256 = (
    "2123fa514647ddd2288bb78474b69daa45896ea0dc572e2b5fe5062199a08a15"
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("sample", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    sample_bytes = args.sample.read_bytes()
    if hashlib.sha256(sample_bytes).hexdigest() != EXPECTED_SAMPLE_SHA256:
        raise SystemExit("sample digest differs from the reviewed 2026-09-12 draw")
    rows = [json.loads(line) for line in sample_bytes.decode("utf-8").splitlines()]
    if len(rows) != 300 or len({row["exercise_id"] for row in rows}) != 300:
        raise SystemExit("expected the unique 300-row H1 draw")
    for number, identifier in EXPECTED_IDS.items():
        if rows[number - 1]["exercise_id"] != identifier:
            raise SystemExit(f"row {number} is not the reviewed 2026-09-12 draw")

    scored = []
    for number, row in enumerate(rows, 1):
        dimensions: dict[str, str | None] = {
            "meaning": "pass",
            "grammar": "pass",
            "naturalness": "pass",
            "register": "pass",
            "answer_set": "pass",
            # The reviewer runtime can decode/probe bytes but cannot render audio to the
            # model.  Null is the rubric's honest unscoreable value; never invent pass.
            "accent_consistency": None,
        }
        verdict = "ok"
        note = ""
        if number in WRONG:
            dimension, note = WRONG[number]
            dimensions[dimension] = "fail"
            verdict = "wrong"
        elif number in AWKWARD:
            dimension, note = AWKWARD[number]
            dimensions[dimension] = "fail"
            verdict = "awkward"
        if row["has_audio"]:
            suffix = (
                "accent: playable Opus bytes verified by ffprobe; auditory accent "
                "judgement unavailable in this reviewer interface, so left null"
            )
            note = f"{note} {suffix}".strip()
        scored.append(
            {
                "exercise_id": row["exercise_id"],
                "verdict": verdict,
                "dimensions": dimensions,
                "reviewer": "opus-agent-reviewer",
                "reviewed_at": "2026-09-12",
                "note": note,
            }
        )
    args.output.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in scored),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
