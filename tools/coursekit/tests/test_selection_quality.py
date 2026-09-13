"""Source-level V11 repairs never bypass the remaining source constraints."""

from dataclasses import replace

import pytest

from coursekit import selection_quality as quality
from coursekit.config.g3 import RECYCLE_MIN_OCCURRENCES, RECYCLE_WINDOW_LESSONS
from coursekit.validators.pack import difficulty


def choices():
    return tuple(
        quality.SourceChoice(
            u, u, s, f"s{u}{s}", f"{prefix} {suffix}", frozenset({"alfa", "beta", suffix})
        )
        for u, prefix in [(1, "alfa beta gamma"), (2, "alfa beta")]
        for s, suffix in enumerate(["uno", "dos", "tres"])
    )


def inputs(rows):
    return {
        "expected_slots": [r.slot for r in rows],
        "section_by_unit": {1: 1, 2: 2},
        "deciles": {
            w: 1 for w in ["alfa", "beta", "gamma", "delta", "epsilon", "uno", "dos", "tres"]
        },
    }


def test_v11_report_uses_existing_metric_and_complete_denominator():
    rows = choices()
    args = inputs(rows)
    report = quality.source_difficulty_report(rows, **args)
    assert report["complete"] and report["blocking"]
    assert report["counts"] == {"1": 3, "2": 3}
    assert report["means"]["1"] == sum(difficulty(r, args["deciles"])[0] for r in rows[:3]) / 3
    assert report["cross_section_deficits"] == [
        {
            "from_unit": 1,
            "to_unit": 2,
            "from_section": 1,
            "to_section": 2,
            "before": 5.0,
            "after": 4.0,
            "mean_deficit": 1.0,
            "required_total_gain": 3.0,
        }
    ]


@pytest.mark.parametrize("bad", ["missing", "duplicate", "unexpected", "section"])
def test_v11_report_cannot_hide_bad_source_join(bad):
    rows = choices()
    args = inputs(rows)
    if bad == "missing":
        rows = rows[:-1]
    elif bad == "duplicate":
        rows += (rows[-1],)
    elif bad == "unexpected":
        rows += (replace(rows[-1], slot_index=99),)
    else:
        args["section_by_unit"] = {1: 1}
    report = quality.source_difficulty_report(rows, **args)
    assert not report["complete"] and report["blocking"]


def test_v11_small_unit_cannot_pass_a_noisy_mean():
    rows = choices()[:1]
    report = quality.source_difficulty_report(rows, **inputs(rows))
    assert report["too_small_units"] == [1] and report["blocking"]


def test_v11_within_section_fall_retains_its_existing_nonblocking_status():
    rows = choices()
    args = inputs(rows)
    args["section_by_unit"] = {1: 1, 2: 1}
    report = quality.source_difficulty_report(rows, **args)
    assert not report["blocking"] and not report["cross_section_deficits"]
    assert len(report["within_section_falls"]) == 1


def test_v11_repair_keeps_reviewed_quality_preference_and_is_deterministic():
    rows = choices()
    options = {
        r.slot: [
            replace(r, source_id=r.source_id + "preferred", text=r.text + " gamma"),
            replace(r, source_id=r.source_id + "longest", text=r.text + " gamma delta epsilon"),
        ]
        for r in rows[3:]
    }
    calls = []

    def allowed(old, new, current):
        calls.append(new.source_id)
        return True

    result = quality.repair_source_selection(rows, options, **inputs(rows), admissible=allowed)
    assert not result.report["blocking"] and result.choices[:3] == rows[:3]
    assert all(r.source_id.endswith("preferred") for r in result.choices[3:])
    assert len(result.replacements) == 3 and all("longest" not in r for r in calls)
    assert all(r.source_id == f"s{r.unit_index}{r.slot_index}" for r in rows)
    reverse = quality.repair_source_selection(
        tuple(reversed(rows)),
        dict(reversed(list(options.items()))),
        **inputs(rows),
        admissible=lambda *_: True,
    )
    assert reverse == result


@pytest.mark.parametrize(
    "bad", ["target", "wrong_slot", "register", "duplicate_source", "duplicate_text", "identity"]
)
def test_v11_repair_cannot_trade_constraints_for_difficulty(bad):
    rows = choices()
    old = rows[3]
    new = replace(old, source_id="replacement", text=old.text + " gamma delta epsilon")
    if bad == "identity":
        new = replace(new, source_id=old.source_id)
    elif bad == "target":
        new = replace(new, lemmas=frozenset({"beta"}))
    elif bad == "wrong_slot":
        new = replace(new, lesson_index=999)
    elif bad == "duplicate_source":
        new = replace(new, source_id=rows[0].source_id)
    elif bad == "duplicate_text":
        new = replace(new, text=rows[0].text)
    result = quality.repair_source_selection(
        rows, {old.slot: [new]}, **inputs(rows), admissible=lambda *_: bad != "register"
    )
    assert result.choices == rows and result.replacements == ()
    assert result.report["cross_section_deficits"][0]["required_total_gain"] == 3.0


def test_v11_exhausted_replacement_pool_reports_residual_deficit():
    rows = choices()
    old = rows[3]
    new = replace(old, source_id="reviewed", text=old.text + " gamma")
    result = quality.repair_source_selection(
        rows, {old.slot: [new]}, **inputs(rows), admissible=lambda *_: True
    )
    assert result.report["blocking"] and len(result.replacements) == 1
    assert result.report["cross_section_deficits"][0]["required_total_gain"] == pytest.approx(2.0)


def test_INV_PACK_06_recurrence_plan_counts_actual_exercises_and_inclusive_original_window():
    end = 1 + RECYCLE_WINDOW_LESSONS
    appearances = [
        (1, frozenset({"alfa"})),
        *[(end, frozenset({"alfa"})) for _ in range(RECYCLE_MIN_OCCURRENCES - 1)],
        (end + 1, frozenset({"alfa"})),
    ]
    assert quality.recurrence_deficits(appearances, last_lesson=end + 1) == [
        {
            "lemma": "alfa",
            "introduced_at": 1,
            "window_end": end,
            "recycled": RECYCLE_MIN_OCCURRENCES - 1,
            "deficit": 1,
            "severity": "blocking",
        }
    ]
    assert (
        quality.recurrence_deficits(
            appearances[:-1] + [(end, frozenset({"alfa"}))], last_lesson=end + 1
        )
        == []
    )


def test_INV_PACK_06_recurrence_plan_preserves_end_effect_and_rejects_wrong_order():
    assert (
        quality.recurrence_deficits([(5, frozenset({"nuevo"}))], last_lesson=5)[0]["severity"]
        == "info"
    )
    with pytest.raises(ValueError, match="order"):
        quality.recurrence_deficits([(5, frozenset({"x"})), (4, frozenset({"x"}))], last_lesson=10)
