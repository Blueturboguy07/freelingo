"""INV-PACK-08: unit register is a curriculum policy, never inferred from answers."""

import pytest

from coursekit.registers import RegisterPolicyError, unit_register


@pytest.mark.parametrize("slot", ["binary_t_v", "n/a"])
@pytest.mark.parametrize("concept", ["subject_pronouns", "ser_identity", "noun_number_agreement",
                                     "contractions_al_del", "comparatives_basic"])
def test_INV_PACK_08_spanish_ordinary_units_declare_tuteo(slot: str, concept: str) -> None:
    assert unit_register("es", {"register_slot": slot, "grammar_concept": concept}) == "tu"


def test_INV_PACK_08_founder_formal_address_unit_declares_ustedeo() -> None:
    assert unit_register("es", {"register_slot": "binary_t_v",
                                "grammar_concept": "formal_informal_address"}) == "usted"


@pytest.mark.parametrize("lang", ["fr", "de", "ja", "unknown"])
def test_INV_PACK_08_missing_language_policy_fails_closed(lang: str) -> None:
    with pytest.raises(RegisterPolicyError, match=lang):
        unit_register(lang, {"register_slot": "binary_t_v", "grammar_concept": "greetings"})


@pytest.mark.parametrize("unit", [
    {}, {"register_slot": "binary_t_v"},
    {"register_slot": "binary_t_v", "grammar_concept": ""},
    {"register_slot": "graded_honorific", "grammar_concept": "greetings"},
    {"register_slot": "n/a", "grammar_concept": "formal_informal_address"},
    {"register_slot": "tu", "grammar_concept": "greetings"},
    {"register_slot": "binary_t_v", "grammar_concept": "greetings", "lang": "fr"},
])
def test_INV_PACK_08_missing_or_conflicting_unit_declaration_fails_closed(unit: dict) -> None:
    with pytest.raises(RegisterPolicyError):
        unit_register("es", unit)


def test_INV_PACK_08_exercise_labels_and_answers_cannot_override_unit_policy() -> None:
    unit = {"register_slot": "binary_t_v", "grammar_concept": "greetings",
            "register": "usted", "accepted_answers": ["¿Cómo está usted?"], "unit_index": 23}
    assert unit_register("es", unit) == "tu"
