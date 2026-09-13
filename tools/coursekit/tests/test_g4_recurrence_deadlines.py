"""G4 recurrence preference uses deadlines without replacing the actual V3 gate."""

from types import SimpleNamespace

import pytest
from test_g5_register_targets import analysis, unit

from coursekit.config.g3 import RECYCLE_MIN_OCCURRENCES, RECYCLE_WINDOW_LESSONS
from coursekit.config.g4 import RECYCLE_SCAN_LIMIT
from coursekit.stages.g4_select import Candidate, _pick, select


def candidate(index, lemmas, *, count=3):
    text = " ".join(sorted(lemmas))
    a = analysis(text)
    return Candidate(str(index).zfill(16), frozenset(lemmas), tuple(a["tokens"]), count, text)


def pick(pool, **changes):
    args = dict(
        concept_id="fixture",
        exhibited=lambda *_: True,
        unit_new={"new", "extra"},
        shown=set(),
        lesson_new=set(),
        uses_in_unit={},
        uses_per_course={},
        owed={"urgent": 1, "later": 3},
        require_new=True,
        recurrence_deadlines={"urgent": 15, "later": 20},
        current_lesson=15,
    )
    args.update(changes)
    return _pick(pool, **args)


def test_INV_PACK_06_g4_due_debt_precedes_shorter_later_debt_before_scan_cutoff():
    later = [candidate(i, {"new", "later"}) for i in range(RECYCLE_SCAN_LIMIT + 1)]
    urgent = candidate(9999, {"new", "urgent"}, count=10)
    assert pick(later + [urgent]) is urgent
    assert (
        pick(later + [urgent], current_lesson=16) is later[0]
    )  # expired window cannot be repaired now


@pytest.mark.parametrize("bad", ["new_budget", "no_new", "unit_reuse", "course_reuse", "concept"])
def test_INV_PACK_06_g4_deadline_priority_cannot_override_existing_admission(bad):
    urgent = candidate(2, {"new", "urgent"})
    fallback = candidate(1, {"new", "later"})
    changes = {}
    if bad == "new_budget":
        urgent = candidate(2, {"new", "extra", "urgent"})
    elif bad == "no_new":
        urgent = candidate(2, {"urgent"})
    elif bad == "unit_reuse":
        changes["uses_in_unit"] = {urgent.sentence_id: 1}
    elif bad == "course_reuse":
        changes["uses_per_course"] = {urgent.sentence_id: 1}
    else:
        changes["exhibited"] = lambda c, _: c is not urgent
    assert pick([fallback, urgent], **changes) is fallback


def test_INV_PACK_06_g4_reports_reserved_source_debt_and_gap_authoring_priority():
    u = unit(index=1)
    u["target_lemmas"] = ["alfa"]
    result = select(
        [u],
        [],
        {
            u["grammar_concept"]: SimpleNamespace(
                probe=SimpleNamespace(matches_sentence=lambda _: True)
            )
        },
        {},
    )
    notes = result.report.as_notes()
    assert notes["recurrence_planning_basis"] == "selected_or_reserved_sources"
    assert notes["actual_g7_v3_required"] is True
    assert notes["source_recurrence_debts"] == [
        {
            "lemma": "alfa",
            "introduced_at": 1,
            "window_end": 1 + RECYCLE_WINDOW_LESSONS,
            "remaining_source_appearances": RECYCLE_MIN_OCCURRENCES,
            "window_complete": False,
        }
    ]
    priority = notes["gap_recurrence_priorities"]
    assert priority and priority[0]["lemmas"] == ["alfa"]
    assert priority[0]["window_end"] == 1 + RECYCLE_WINDOW_LESSONS
