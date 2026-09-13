"""[INV-PACK-06] visible dialogue words affect exposure without receiving taught tags."""

from dataclasses import replace

import pytest
from test_teaching_order import inputs, order

from coursekit.packbuild.sqlite import exercise_rows
from coursekit.validators.ledger import build_ledger, check_v1, check_v2, check_v3, check_v4

pytestmark = pytest.mark.parametrize("invariant", ["INV-PACK-06"])


def one_word_source():
    source = inputs()
    row = dict(source.exercises[0], item_tags={"lemmas": ["bueno"], "grammar_concepts": []})
    return replace(source, exercises=(row,))


def test_visible_role_words_cannot_hide_from_new_item_budget(invariant):
    source = one_word_source()
    eid = source.exercises[0]["exercise_id"]
    ledger = build_ledger(
        "es", source.units, source.exercises, extra_exposure_lemmas={eid: frozenset({"noche"})}
    )
    assert ledger.content_lemmas(source.exercises[0]) == frozenset({"bueno"})
    assert ledger.exposure_lemmas(source.exercises[0]) == frozenset({"bueno", "noche"})
    assert any(f.severity == "blocking" and "2 new lemmas" in f.message for f in check_v2(ledger))
    assert any("noche" in f.detail.get("missing", []) for f in check_v4(ledger))


def test_future_unit_word_in_first_turn_is_blocking(invariant):
    source = one_word_source()
    first = dict(source.units[0], target_lemmas=["bueno"])
    second = dict(first, unit_index=2, target_lemmas=["noche"])
    ledger = build_ledger(
        "es",
        [first, second],
        source.exercises,
        extra_exposure_lemmas={source.exercises[0]["exercise_id"]: {"noche"}},
    )
    assert any(f.severity == "blocking" and f.detail["lemma"] == "noche" for f in check_v1(ledger))


def test_actual_pack_order_uses_the_same_visible_prerequisites(invariant):
    source = one_word_source()
    second = dict(
        source.exercises[0],
        exercise_id="e" * 16,
        item_tags={"lemmas": ["noche"], "grammar_concepts": []},
    )
    mapping = {source.exercises[0]["exercise_id"]: frozenset({"noche"})}
    source = replace(source, exercises=(*source.exercises, second), extra_exposure_lemmas=mapping)
    ledger = build_ledger("es", source.units, source.exercises, extra_exposure_lemmas=mapping)
    expected = ["e" * 16, "0" * 16]
    assert order(exercise_rows(source)) == expected
    assert [row["exercise_id"] for row in ledger.in_course_order()] == expected
    assert not any(f.severity == "blocking" for f in check_v2(ledger))
    assert source.exercises[0]["item_tags"]["lemmas"] == ["bueno"]


def test_wrong_reply_appearances_do_not_satisfy_recycling(invariant):
    source = one_word_source()
    prototype = source.exercises[0]
    rows = [
        dict(
            prototype,
            exercise_id=f"{i:016x}",
            lesson_index=lesson,
            item_tags={"lemmas": [lemma], "grammar_concepts": []},
        )
        for i, lesson, lemma in [
            (1, 1, "noche"),
            (2, 2, "bueno"),
            (3, 3, "bueno"),
            (4, 13, "bueno"),
        ]
    ]
    extra = {row["exercise_id"]: {"noche"} for row in rows[1:]}
    ledger = build_ledger("es", source.units, rows, extra_exposure_lemmas=extra)
    assert any(
        f.subject == "noche" and f.severity == "blocking" and f.detail["recycled"] == 0
        for f in check_v3(ledger)
    )


def test_empty_exposure_map_cannot_remove_the_canonical_source_words(invariant):
    source = inputs()
    only = (source.exercises[0],)
    ledger = build_ledger(
        "es", source.units, only, extra_exposure_lemmas={only[0]["exercise_id"]: frozenset()}
    )
    assert any("2 new lemmas" in f.message for f in check_v2(ledger))


def test_orphan_exposure_map_is_refused(invariant):
    source = inputs()
    with pytest.raises(ValueError, match="unknown exercise"):
        build_ledger(
            "es", source.units, source.exercises, extra_exposure_lemmas={"absent": {"noche"}}
        )
    source = replace(source, extra_exposure_lemmas={"absent": {"noche"}})
    with pytest.raises(ValueError, match="unknown exercise"):
        exercise_rows(source)


@pytest.mark.parametrize("same_unit", [True, False])
def test_role_repetition_keeps_the_selected_slot_denominator(invariant, same_unit):
    from coursekit.validators.ledger import Ledger, SentenceUse, check_v9

    second_unit = 1 if same_unit else 2
    canonical = (SentenceUse(1, 1, 0, "a", "first"), SentenceUse(second_unit, 2, 0, "b", "second"))
    extras = (
        SentenceUse(1, 1, 0, "c", "question"),
        SentenceUse(second_unit, 2, 0, "c", "question"),
    )
    ledger = Ledger(
        lang="es",
        units=(),
        exercises=(),
        introduction_unit={},
        target_lemmas={},
        concept_of={},
        gaps={},
        lemmas_of={},
        sentence_uses=canonical,
        extra_sentence_uses=extras,
    )
    findings = check_v9(ledger)
    if same_unit:
        assert any(f.severity == "blocking" and "inside unit 1" in f.message for f in findings)
    else:
        assert any(f.detail == {"repeats": 1, "sourced": 2} for f in findings)


def test_correct_reply_and_format_siblings_cannot_inflate_repetition(invariant):
    from coursekit.validators.ledger import Ledger, SentenceUse, check_v9

    canonical = (SentenceUse(1, 1, 0, "a", "first"),)
    ledger = Ledger(
        lang="es",
        units=(),
        exercises=(),
        introduction_unit={},
        target_lemmas={},
        concept_of={},
        gaps={},
        lemmas_of={},
        sentence_uses=canonical,
        extra_sentence_uses=canonical * 4,
    )
    assert check_v9(ledger) == []


def test_extra_role_forms_reach_the_existing_inflection_check(invariant):
    source = one_word_source()
    first = source.exercises[0]
    later = dict(first, exercise_id="d" * 16, lesson_index=2)
    forms = frozenset({("bueno", "Gender=Masc"), ("bueno", "Gender=Fem")})
    ledger = build_ledger(
        "es", source.units, (first, later), extra_exposure_forms={later["exercise_id"]: forms}
    )
    assert ledger.content_forms(later) is None
    assert ledger.exposure_forms(later) == forms
    assert any(
        f.subject == later["exercise_id"]
        and f.severity == "warning"
        and "new inflections" in f.message
        for f in check_v2(ledger)
    )
