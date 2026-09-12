"""INV-PACK-06 — V1-V4 pass at 100% on the built pack — and V9 beside them.

Two halves, and neither is worth anything alone:

- the **pack** half runs the five checks over a ledger the pipeline actually built from
  the `es-mini` fixture (G3 solves a curriculum, G4 selects from the corpus, the filled
  slots are projected into `exercise` records) and asserts **zero blocking findings**;
- the **falsifier** half runs the same five checks over
  `tests/falsifiers/INV-PACK-06.json`, a ledger corrupted on purpose with one planted
  defect per property, and asserts each one fires.

A suite that has only ever seen good data reports the same green as a suite with a hole
in it. The plan's rule 4 — "an invariant with no owning test is worse than a failing one"
— is about exactly this shape.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

# tests/ is on sys.path under pytest's default prepend import mode; see that module's
# docstring for why the shared G1 analysis lives there and not in conftest.py.
from test_g4_select import (
    ES_CURRICULUM,
    analyse_es_mini,
    banded_rows,
    es_mini_candidates,
    project_exercises,
)

from coursekit.artifacts import validate_record
from coursekit.config import VALIDATOR_IDS
from coursekit.stages.g3_solve import load_curriculum, solve
from coursekit.stages.g4_select import select
from coursekit.validators import VALIDATORS, Finding
from coursekit.validators.ledger import (
    LEDGER_CHECKS,
    build_ledger,
    check_v1,
    check_v2,
    check_v3,
    check_v4,
    check_v9,
    run_ledger_checks,
)

FALSIFIER = Path(__file__).parent / "falsifiers" / "INV-PACK-06.json"
OWNED_BY_THIS_LANE = ("V1", "V2", "V3", "V4", "V9")


def load_falsifier() -> dict[str, Any]:
    return json.loads(FALSIFIER.read_text(encoding="utf-8"))


def blocking(findings: list[Finding]) -> list[Finding]:
    return [finding for finding in findings if finding.severity == "blocking"]


# ---------------------------------------------------------------------------
# The falsifier — this half never needs a model, so it never skips
# ---------------------------------------------------------------------------


def test_the_falsifier_is_contract_shaped_not_merely_malformed() -> None:
    """A falsifier that fails for the wrong reason proves nothing.

    Every record in it validates against the frozen inter-stage contract, so when the
    checks fire it is because the LEDGER is wrong, not because the JSON is.
    """
    document = load_falsifier()
    for record in document["units"]:
        validate_record("unit_assignment", record)
    for record in document["analysed"]:
        validate_record("analysed_sentence", record)
    for record in document["exercises"]:
        validate_record("exercise", record)
    for record in document["selected"]:
        validate_record("selected_item", record)
    assert document["invariant"] == "INV-PACK-06"
    assert not any(item["gap"] for item in document["selected"]), (
        "the falsifier models a FINISHED pack; an outstanding gap softens V3 and V4"
    )


def falsified_ledger():
    document = load_falsifier()
    return build_ledger(
        document["lang"],
        document["units"],
        document["exercises"],
        analysed=document["analysed"],
        selected=document["selected"],
    )


def test_inv_pack_06_the_validators_fail_on_a_deliberately_corrupted_ledger() -> None:
    """[INV-PACK-06] the falsifier: every one of V1-V4 and V9 fires on the planted defect."""
    expected = load_falsifier()["expected_blocking"]
    ledger = falsified_ledger()
    for validator_id, phrases in expected.items():
        findings = blocking(LEDGER_CHECKS[validator_id](ledger))
        assert findings, f"{validator_id} found nothing wrong with a corrupted ledger"
        messages = " | ".join(finding.message for finding in findings)
        for phrase in phrases:
            assert phrase in messages, f"{validator_id}: expected {phrase!r} in {messages}"


def test_inv_pack_06_every_owned_validator_is_exercised_by_the_falsifier() -> None:
    """[INV-PACK-06] no check is along for the ride.

    Without this, a sixth check could be added to `LEDGER_CHECKS`, never fire on anything,
    and the suite above would stay green while claiming the invariant.
    """
    expected = load_falsifier()["expected_blocking"]
    assert set(expected) == set(LEDGER_CHECKS) == set(OWNED_BY_THIS_LANE)


def test_a_clean_ledger_of_the_same_shape_produces_nothing_blocking() -> None:
    """The other direction: the checks are not simply always red.

    One unit teaching one lemma, four distinct sentences that all contain it, four
    consecutive lessons — inside the recycling window, nothing repeated, every tag true.
    Without this the falsifier test above would pass just as happily against five checks
    that block on anything at all.
    """
    document = load_falsifier()
    template = document["analysed"][0]
    gato = next(token for token in template["tokens"] if token["lemma"] == "gato")
    analysed = [
        dict(
            template,
            sentence_id=str(index) * 16,
            tokens=[dict(gato)],
            lemmas=["gato"],
            display_tokens=[gato["surface"]],
        )
        for index in range(4)
    ]
    units = [dict(document["units"][0], target_lemmas=["gato"], recycled_lemmas=[])]
    exercises = [
        dict(
            document["exercises"][0],
            exercise_id=f"{index:016x}",
            lesson_index=1 + index,
            source_sentence_id=row["sentence_id"],
            item_tags={"lemmas": ["gato"], "grammar_concepts": ["being"]},
        )
        for index, row in enumerate(analysed)
    ]
    ledger = build_ledger("es", units, exercises, analysed=analysed, selected=[])
    findings = run_ledger_checks(ledger)
    assert blocking(findings) == [], [finding.message for finding in blocking(findings)]


# ---------------------------------------------------------------------------
# Each check, in isolation
# ---------------------------------------------------------------------------


def test_v1_reads_lemmas_and_never_surface_tokens() -> None:
    """V1's parenthesis is the rule: `hablo` and `hablas` are one lemma and two surfaces.

    A surface-token ledger passes on Spanish by accident and breaks silently on every
    inflected and agglutinative language.
    """
    document = load_falsifier()
    ledger = falsified_ledger()
    findings = check_v1(ledger)
    assert findings
    # The analysed record for S2 carries the surface "es" and the lemma "ser"; the
    # findings are stated in lemmas.
    surfaces = {
        token["surface"]
        for row in document["analysed"]
        for token in row["tokens"]
        if token["surface"] != token["lemma"]
    }
    reported = {str(finding.detail.get("lemma")) for finding in findings}
    assert reported & {"libro", "nuevo"}
    assert not reported & surfaces


def test_v1_flags_a_lemma_no_unit_introduces_at_all() -> None:
    """Untaught is worse than early: the learner meets a word the course never teaches."""
    document = load_falsifier()
    units = [dict(document["units"][0], target_lemmas=["gato"])]
    ledger = build_ledger("es", units, document["exercises"][:1], analysed=document["analysed"])
    messages = " | ".join(finding.message for finding in check_v1(ledger))
    assert "introduced by no unit at all" in messages


def test_v2_does_not_count_an_earlier_units_lemma_as_new() -> None:
    """The clause that makes the rule about the learner rather than about the corpus.

    Without it the rule is unsatisfiable from a corpus: at the start of a course nothing
    has been carried yet, every sentence looks like five new items at once, and the only
    ledger that passes is the empty one.
    """
    document = load_falsifier()
    units = [
        dict(document["units"][0], target_lemmas=["el", "gato", "ser", "pequeño", "nuevo"]),
        dict(document["units"][1], target_lemmas=["libro"]),
    ]
    # An exercise in unit 2 carrying four of unit 1's lemmas plus one of its own.
    exercise = dict(
        document["exercises"][1],
        unit_index=2,
        item_tags={"lemmas": ["el", "libro", "ser", "nuevo"], "grammar_concepts": ["articles"]},
    )
    ledger = build_ledger("es", units, [exercise], analysed=document["analysed"])
    per_exercise = [
        finding for finding in check_v2(ledger) if "new lemmas in one exercise" in finding.message
    ]
    assert per_exercise == []


def test_v3_reports_an_end_of_course_lemma_as_an_end_effect_not_a_defect() -> None:
    findings = check_v3(falsified_ledger())
    info = [finding for finding in findings if finding.severity == "info"]
    assert info
    assert "End effect, not a defect" in info[0].message


def test_v4_catches_both_halves_because_either_alone_reads_as_green() -> None:
    """A wrong tag trains a review the learner never saw; an uncovered lexeme is never
    scheduled at all. D1's stated cost is the first; the second is invisible without the
    coverage half."""
    messages = " | ".join(finding.message for finding in blocking(check_v4(falsified_ledger())))
    assert "which the exercise does not contain" in messages
    assert "appear in no exercise" in messages


def test_v4_softens_to_a_warning_while_a_unit_still_owes_g5_slots() -> None:
    """Pre-G5, "this lexeme appears in no exercise" is a statement about an unfinished
    pack. The finding is still printed; only its severity changes, and it names the gap
    count so nobody reads it as an excuse."""
    document = load_falsifier()
    gapped = [
        dict(item, sentence_id=None, provenance="llm", gap=True) for item in document["selected"]
    ]
    ledger = build_ledger(
        "es",
        document["units"],
        document["exercises"],
        analysed=document["analysed"],
        selected=gapped,
    )
    coverage = [
        finding for finding in check_v4(ledger) if "appear in no exercise" in finding.message
    ]
    assert coverage
    assert all(finding.severity == "warning" for finding in coverage)
    assert "gap slot(s) still with G5" in coverage[0].message


def test_v9_catches_a_repeat_inside_a_unit_and_across_units() -> None:
    messages = " | ".join(finding.message for finding in blocking(check_v9(falsified_ledger())))
    assert "times inside unit 1" in messages
    assert "reuse a sentence from an earlier unit" in messages


# ---------------------------------------------------------------------------
# The built pack
# ---------------------------------------------------------------------------


def es_mini_pack():
    """G3 → G4 → projected exercises over the es-mini fixture. The pack under test."""
    curriculum = load_curriculum("es", path=ES_CURRICULUM)
    g3 = solve(curriculum, banded_rows())
    candidates, census = es_mini_candidates()
    g4 = select(g3.units, candidates, curriculum.concepts, census)
    exercises = project_exercises(g4.items, candidates)
    ledger = build_ledger(
        "es",
        g3.units,
        exercises,
        analysed=list(analyse_es_mini()),
        selected=g4.items,
    )
    return ledger, g4


def test_inv_pack_06_v1_to_v4_pass_on_the_pack_the_pipeline_built() -> None:
    """[INV-PACK-06] V1-V4 (and V9) report zero blocking findings on the es-mini pack.

    "The built pack" here is what G3 and G4 actually produce from the committed Spanish
    curriculum and the 200-sentence `es-mini` fixture, with the filled slots projected
    into `exercise` records because G7 is another lane's. Every gap slot is present in the
    ledger, so V3's recycling shortfall and V4's coverage shortfall report as warnings
    that name the outstanding gap count — the unconditional halves of V1, V2, V4 and V9
    are asserted separately below so this is not green by softening.
    """
    ledger, _ = es_mini_pack()
    findings = run_ledger_checks(ledger)
    assert blocking(findings) == [], [
        f"{finding.validator_id}: {finding.message}" for finding in blocking(findings)
    ]


def test_inv_pack_06_the_unconditional_checks_are_clean_on_the_built_pack() -> None:
    """[INV-PACK-06] V1 and V9 never soften, and they find nothing at all.

    V1 (no lemma before its unit) and V9 (no repeated sentence) have no gap-aware branch:
    a finding from either is blocking whatever state the pack is in. Asserting them EMPTY
    rather than merely non-blocking is what stops the test above from passing because
    everything was downgraded.
    """
    ledger, _ = es_mini_pack()
    assert check_v1(ledger) == []
    assert check_v9(ledger) == []
    per_exercise = [
        finding
        for finding in check_v2(ledger)
        if finding.severity == "blocking" and "one exercise" in finding.message
    ]
    assert per_exercise == []
    unsound = [
        finding
        for finding in check_v4(ledger)
        if "which the exercise does not contain" in finding.message
    ]
    assert unsound == []


def test_the_built_pack_is_not_empty() -> None:
    """The other way INV-PACK-06 could be green for nothing: a pack with no exercises."""
    ledger, g4 = es_mini_pack()
    assert len(ledger.exercises) > 0
    assert len(ledger.exercises) == g4.report.filled
    assert len(ledger.introduction_unit) > 0


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


#: Captured at IMPORT time, and that is not fussiness.
#:
#: `tests/test_cli.py`'s `empty_registry` fixture calls `Registry.reset_for_tests()`,
#: which clears the entries and the `_discovered` flag. Re-discovery then imports the
#: stage and validator modules again — but they are already in `sys.modules`, so
#: `importlib.import_module` hands back the cached module WITHOUT re-running the
#: `@register_stage` / `@register_validator` decorators, and every registration is gone
#: for the rest of the session. That was harmless while nothing was registered; it is a
#: real defect in `coursekit/__init__.py` now that P2's lanes register things, and that
#: file is outside this lane. Reading the registry here, at import, records what the
#: modules actually register without depending on the broken path.
REGISTERED_VALIDATORS_AT_IMPORT = tuple(VALIDATORS.ids())


@pytest.mark.parametrize("validator_id", OWNED_BY_THIS_LANE)
def test_the_ledger_validators_are_registered(validator_id: str) -> None:
    assert validator_id in VALIDATOR_IDS
    assert validator_id in REGISTERED_VALIDATORS_AT_IMPORT
