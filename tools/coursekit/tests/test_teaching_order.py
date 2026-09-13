"""[INV-PACK-06] packaged order teaches prerequisites before compound exercises."""

from __future__ import annotations

from dataclasses import replace

import pytest

from coursekit.packbuild.sqlite import exercise_rows, fixture_inputs
from coursekit.validators.ledger import build_ledger, check_v2

pytestmark = pytest.mark.parametrize("invariant", ["INV-PACK-06"])


def inputs():
    base = fixture_inputs()
    prototype = base.exercises[0]
    units = (
        dict(
            base.units[0],
            unit_index=1,
            target_lemmas=["bueno", "noche"],
            grammar_concept="greeting",
        ),
    )
    # Hash order would teach both words together first.
    exercises = tuple(
        dict(
            prototype,
            exercise_id=eid,
            source_sentence_id=None,
            unit_index=1,
            lesson_index=1,
            accepted_answers=[answer],
            item_tags={"lemmas": lemmas, "grammar_concepts": []},
        )
        for eid, answer, lemmas in [
            ("0" * 16, "Buenas noches", ["bueno", "noche"]),
            ("f" * 16, "good", ["bueno"]),
            ("e" * 16, "night", ["noche"]),
        ]
    )
    return replace(base, units=units, exercises=exercises, selected=(), candidates=())


def order(rows):
    return [r["exercise_id"] for r in sorted(rows, key=lambda r: r["slot_index"])]


def test_runtime_pack_and_validator_use_same_prerequisite_order(invariant):
    source = inputs()
    ledger = build_ledger("es", source.units, source.exercises)
    packaged = order(exercise_rows(source))
    assert packaged == [r["exercise_id"] for r in ledger.in_course_order()]
    assert packaged[-1] == "0" * 16
    assert not [f for f in check_v2(ledger) if f.severity == "blocking"]


def test_missing_introductions_stay_blocking_in_actual_pack_order(invariant):
    source = inputs()
    source = replace(source, exercises=(source.exercises[0],))
    ledger = build_ledger("es", source.units, source.exercises)
    assert order(exercise_rows(source)) == ["0" * 16]
    assert any("2 new lemmas" in f.message and f.severity == "blocking" for f in check_v2(ledger))


def test_order_is_stable_under_input_permutation_and_presentation_changes(invariant):
    source = inputs()
    changed = replace(
        source,
        exercises=tuple(
            dict(r, distractors=["changed"], audio_ref=None) for r in reversed(source.exercises)
        ),
    )
    assert order(exercise_rows(source)) == order(exercise_rows(changed))


def test_order_never_moves_an_introduction_back_from_a_later_lesson(invariant):
    source = inputs()
    source = replace(
        source,
        exercises=(source.exercises[0], *(dict(r, lesson_index=2) for r in source.exercises[1:])),
    )
    ledger = build_ledger("es", source.units, source.exercises)
    assert ledger.in_course_order()[0]["exercise_id"] == "0" * 16
    assert any("2 new lemmas" in f.message and f.severity == "blocking" for f in check_v2(ledger))


def test_per_lesson_new_item_ceiling_is_not_hidden_by_reordering(invariant):
    source = inputs()
    lemmas = [f"word{i}" for i in range(8)]
    units = (dict(source.units[0], target_lemmas=lemmas),)
    exercises = tuple(
        dict(
            source.exercises[0],
            exercise_id=f"{i:016x}",
            item_tags={"lemmas": [lemma], "grammar_concepts": []},
        )
        for i, lemma in enumerate(lemmas)
    )
    ledger = build_ledger("es", units, exercises)
    assert any(
        "introduces 8 new lemmas" in f.message and f.severity == "blocking"
        for f in check_v2(ledger)
    )
