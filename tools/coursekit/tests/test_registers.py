"""INV-PACK-08: unit register is a curriculum policy, never inferred from answers."""

import pytest

from coursekit.registers import RegisterPolicyError, unit_register


@pytest.mark.parametrize("slot", ["binary_t_v", "n/a"])
@pytest.mark.parametrize(
    "concept",
    [
        "subject_pronouns",
        "ser_identity",
        "noun_number_agreement",
        "contractions_al_del",
        "comparatives_basic",
    ],
)
def test_INV_PACK_08_spanish_ordinary_units_declare_tuteo(slot: str, concept: str) -> None:
    assert unit_register("es", {"register_slot": slot, "grammar_concept": concept}) == "tu"


def test_INV_PACK_08_founder_formal_address_unit_declares_ustedeo() -> None:
    assert (
        unit_register(
            "es", {"register_slot": "binary_t_v", "grammar_concept": "formal_informal_address"}
        )
        == "usted"
    )


@pytest.mark.parametrize("lang", ["fr", "de", "ja", "unknown"])
def test_INV_PACK_08_missing_language_policy_fails_closed(lang: str) -> None:
    with pytest.raises(RegisterPolicyError, match=lang):
        unit_register(lang, {"register_slot": "binary_t_v", "grammar_concept": "greetings"})


@pytest.mark.parametrize(
    "unit",
    [
        {},
        {"register_slot": "binary_t_v"},
        {"register_slot": "binary_t_v", "grammar_concept": ""},
        {"register_slot": "graded_honorific", "grammar_concept": "greetings"},
        {"register_slot": "n/a", "grammar_concept": "formal_informal_address"},
        {"register_slot": "tu", "grammar_concept": "greetings"},
        {"register_slot": "binary_t_v", "grammar_concept": "greetings", "lang": "fr"},
    ],
)
def test_INV_PACK_08_missing_or_conflicting_unit_declaration_fails_closed(unit: dict) -> None:
    with pytest.raises(RegisterPolicyError):
        unit_register("es", unit)


def test_INV_PACK_08_exercise_labels_and_answers_cannot_override_unit_policy() -> None:
    unit = {
        "register_slot": "binary_t_v",
        "grammar_concept": "greetings",
        "register": "usted",
        "accepted_answers": ["¿Cómo está usted?"],
        "unit_index": 23,
    }
    assert unit_register("es", unit) == "tu"


def _sentence_analysis(text: str, tokens: list[tuple[str, str, str]]) -> dict:
    rows = []
    offset = 0
    for surface, pos, morph in tokens:
        start = text.index(surface, offset)
        offset = start + len(surface)
        rows.append(
            {
                "surface": surface,
                "lemma": surface.casefold(),
                "pos": pos,
                "morph": morph,
                "start": start,
                "end": offset,
            }
        )
    return {"tokens": rows}


def test_INV_PACK_08_possible_finite_tuteo_is_rejected_from_formal_unit() -> None:
    from coursekit.registers import register_of, sentence_register_matches

    text = "Disculpa la molestia, mi madre."
    analysis = _sentence_analysis(
        text,
        [
            ("Disculpa", "VERB", "Mood=Imp|Number=Sing|Person=2|VerbForm=Fin"),
            ("la", "DET", ""),
            ("molestia", "NOUN", ""),
            (",", "PUNCT", ""),
            ("mi", "DET", ""),
            ("madre", "NOUN", ""),
            (".", "PUNCT", ""),
        ],
    )
    formal = {"grammar_concept": "formal_informal_address", "register_slot": "binary_t_v"}
    assert register_of(text, "es") == set()
    assert register_of(text, "es", analysis=analysis) == {"tu"}
    assert not sentence_register_matches("es", formal, text, analysis)
    assert sentence_register_matches(
        "es", {**formal, "grammar_concept": "greetings"}, text, analysis
    )


@pytest.mark.parametrize("finite_person", ["2", "3"])
def test_INV_PACK_08_formal_pronoun_person_is_not_verb_agreement(finite_person: str) -> None:
    from coursekit.registers import register_of, sentence_register_matches

    text = "Usted habla."
    analysis = _sentence_analysis(
        text,
        [
            ("Usted", "PRON", "Number=Sing|Person=2|PronType=Prs"),
            ("habla", "VERB", f"Number=Sing|Person={finite_person}|VerbForm=Fin"),
            (".", "PUNCT", ""),
        ],
    )
    formal = {"grammar_concept": "formal_informal_address", "register_slot": "binary_t_v"}
    assert register_of(text, "es", analysis=analysis) == (
        {"usted", "tu"} if finite_person == "2" else {"usted"}
    )
    assert sentence_register_matches("es", formal, text, analysis) is (finite_person == "3")


@pytest.mark.parametrize(
    ("pos", "morph"),
    [
        ("VERB", "Person=2|VerbForm=Inf"),
        ("PRON", "Person=2|VerbForm=Fin"),
        ("NOUN", "Person=2|VerbForm=Fin"),
    ],
)
def test_INV_PACK_08_only_finite_verbs_supply_possible_tuteo(pos: str, morph: str) -> None:
    from coursekit.registers import register_of

    assert (
        register_of(
            "Hablar",
            "es",
            analysis=_sentence_analysis(
                "Hablar",
                [
                    ("Hablar", pos, morph),
                ],
            ),
        )
        == set()
    )


@pytest.mark.parametrize(
    "analysis", [None, {}, {"tokens": []}, {"tokens": "bad"}, {"tokens": [{"surface": "usted"}]}]
)
def test_INV_PACK_08_missing_or_invalid_analysis_cannot_supply_formal_evidence(
    analysis: dict | None,
) -> None:
    from coursekit.registers import sentence_register_matches

    formal = {"grammar_concept": "formal_informal_address", "register_slot": "binary_t_v"}
    assert not sentence_register_matches("es", formal, "Disculpa.", analysis)


def test_INV_PACK_08_sentence_analysis_cannot_be_reused_for_an_isolated_gap() -> None:
    from coursekit.registers import register_of, sentence_register_matches

    text = "Disculpa la molestia."
    analysis = _sentence_analysis(
        text,
        [
            ("Disculpa", "VERB", "Person=2|VerbForm=Fin"),
            ("la", "DET", ""),
            ("molestia", "NOUN", ""),
            (".", "PUNCT", ""),
        ],
    )
    with pytest.raises(RegisterPolicyError, match="analysis"):
        register_of("molestia", "es", analysis=analysis)
    formal = {"grammar_concept": "formal_informal_address", "register_slot": "binary_t_v"}
    assert not sentence_register_matches("es", formal, "molestia", analysis)
