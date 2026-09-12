"""INV-PACK-06 — the ledger validators V1-V4, and V9 beside them.

### What this file proves, stated as narrowly as it is true

The registry's claim is "V1-V4 pass at 100% on the built pack. Japanese runs the ledger
on Mode-A segmentation" (`docs/invariants.md`:262). The only pack P2 can build today is
the one G3 and G4 produce from the 200-sentence `es-mini` fixture over the 30-unit Spanish
curriculum, and **G4's own gate rejects that pack**: 756 slots, 98 filled, 658 gaps, a gap
fraction of 0.8704 against `MAX_GAP_FRACTION` 0.60 (measured 2026-09-12; asserted in
`test_g4_select.py::test_the_stage_refuses_the_es_mini_pack_and_names_the_ceiling`). 200
sentences cannot carry 756 slots, and no arrangement of them can.

That matters for what this file may claim, because V3 and V4's coverage half **soften to
warnings while a unit still owes G5 gap slots** — and in that pack every unit does. So:

- **V1, V2's per-exercise half, V4's tag-soundness half and V9 are clean on a pack the
  pipeline actually built** — those four have no gap-aware branch and are asserted EMPTY,
  not merely non-blocking, in `test_the_unconditional_checks_are_clean_on_the_built_pack`.
- **V3 and V4's coverage half are exercised on the falsifier and on the four-exercise
  synthetic ledger below, and on no built pack.** They are real checks with real red
  paths; what they have not yet met is a corpus large enough to make them meaningful.
  That is a P2 corpus question (G0 is another lane) and it is written down in
  `docs/owned/p2-g3-g4.json` rather than papered over here.
- The **Japanese clause is enforced** by `_check_segmentation` and tested below against a
  Mode-C ledger (EC-PACK-07), on synthetic rows: a ja pack needs SudachiPy and a ja
  curriculum, which is P7.

The earlier version of this file asserted "V1-V4 pass at 100% on the built pack" from a
`select()` call that never reached the stage, so the ledger it certified was one the
pipeline refuses to hand to G5. The validators were right; the sentence around them was
too wide. This is the narrow one.

### The two halves

- the **pack** half builds the ledger the pipeline actually produces and asserts what the
  paragraph above says it asserts;
- the **falsifier** half runs the same five checks over
  `tests/falsifiers/INV-PACK-06.json`, a ledger corrupted on purpose with one planted
  defect per property — including no gaps at all, so V3 and V4's coverage half are
  blocking there — and asserts each one fires.

A suite that has only ever seen good data reports the same green as a suite with a hole
in it. The plan's rule 4 — "an invariant with no owning test is worse than a failing one"
— is about exactly this shape.

### Why the id is in the test names via `parametrize`

`docs/README.md` §Adding coverage defines an owning test as one whose NAME carries the id
in brackets, and `scripts/coverage-map.ts` reads names. A Python function name cannot
contain brackets, so the id rides in a `parametrize` value and pytest reports the node as
`test_…[INV-PACK-06]` — the bracketed form, in the name, greppable. The coverage map still
cannot see it (it walks `packages/`, `apps/`, `e2e/` for `*.test.ts`); that is ESC-01 in
`docs/owned/p2-g3-g4.json` and it is phase machinery, but this side of it is done.
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
    run_g4_over_es_mini,
)

from coursekit.artifacts import ARTIFACT_SCHEMA_VERSION, validate_record
from coursekit.config import VALIDATOR_IDS
from coursekit.config.g4 import LEDGER_SPLIT_MODE, MAX_GAP_FRACTION
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

#: Puts `[INV-PACK-06]` in the pytest NODE ID of every test that claims the invariant.
#: See the module docstring: a Python function name cannot carry brackets, so the id rides
#: in a parametrize value and `pytest -k 'INV-PACK-06'` selects exactly the owning tests.
inv_pack_06 = pytest.mark.parametrize("invariant", ["INV-PACK-06"])


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


@inv_pack_06
def test_the_validators_fail_on_a_deliberately_corrupted_ledger(invariant: str) -> None:
    """[INV-PACK-06] the falsifier: every one of V1-V4 and V9 fires on the planted defect."""
    assert invariant == "INV-PACK-06"
    expected = load_falsifier()["expected_blocking"]
    ledger = falsified_ledger()
    for validator_id, phrases in expected.items():
        findings = blocking(LEDGER_CHECKS[validator_id](ledger))
        assert findings, f"{validator_id} found nothing wrong with a corrupted ledger"
        messages = " | ".join(finding.message for finding in findings)
        for phrase in phrases:
            assert phrase in messages, f"{validator_id}: expected {phrase!r} in {messages}"


@inv_pack_06
def test_every_owned_validator_is_exercised_by_the_falsifier(invariant: str) -> None:
    """[INV-PACK-06] no check is along for the ride.

    Without this, a sixth check could be added to `LEDGER_CHECKS`, never fire on anything,
    and the suite above would stay green while claiming the invariant.
    """
    assert invariant == "INV-PACK-06"
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


@inv_pack_06
def test_the_stage_that_built_this_pack_rejects_it_and_the_claim_says_so(
    invariant: str,
) -> None:
    """[INV-PACK-06] the pack G4 hands over is a pack G4 REFUSES, and the test says which.

    This assertion exists because the previous version of this file did not make it. The
    pack half called `select()` and never reached the stage, so the ledger it certified
    "clean" is one `g4_select.run()` returns `ok=False` on. Measured 2026-09-12 at this
    commit: 756 slots, 98 filled, 658 gaps, gap_fraction 0.8704, against
    `MAX_GAP_FRACTION` 0.60 — 87.04% of the course is a gap list for G5.

    So the claim this file carries for INV-PACK-06 is the narrow one, and it is written
    here as well as in the module docstring and in `docs/owned/p2-g3-g4.json`:

        **V1, V2's per-exercise half, V4's tag-soundness half and V9 are clean on a pack
        G4 itself rejects. V3 and V4's coverage half are exercised only on the falsifier
        and on the four-exercise synthetic ledger.**

    Enlarging the fixture until the pipeline's own gate passes is a corpus job — G0 is
    another lane and 756 slots need thousands of sentences — so the claim is stated at the
    size it is true at, rather than the fixture being inflated to make a sentence fit.
    """
    assert invariant == "INV-PACK-06"
    verdict, _ = run_g4_over_es_mini()
    assert verdict.ok is False
    assert verdict.detail["slots"] == 756
    assert verdict.detail["filled"] == 98
    assert verdict.detail["gaps"] == 658
    assert verdict.detail["gap_fraction"] == pytest.approx(0.8704, abs=5e-5)
    assert MAX_GAP_FRACTION == 0.60
    assert "over the 60% ceiling" in verdict.message


@inv_pack_06
def test_v1_to_v4_and_v9_report_nothing_blocking_on_the_pack_the_pipeline_built(
    invariant: str,
) -> None:
    """[INV-PACK-06] no blocking finding on the es-mini pack — softening included, named.

    "The built pack" is what G3 and G4 actually produce from the committed Spanish
    curriculum and the 200-sentence `es-mini` fixture, with the filled slots projected
    into `exercise` records because G7 is another lane's. Every gap slot is in the ledger,
    so V3's recycling shortfall and V4's coverage shortfall report as WARNINGS naming the
    outstanding gap count. This test is therefore carried, for those two, by the softening
    rule — which is why the census below is asserted rather than merely `== []`: a reader
    can see exactly which findings exist and at which severity, and the next test asserts
    the four checks that never soften are EMPTY.
    """
    assert invariant == "INV-PACK-06"
    ledger, _ = es_mini_pack()
    findings = run_ledger_checks(ledger)
    assert blocking(findings) == [], [
        f"{finding.validator_id}: {finding.message}" for finding in blocking(findings)
    ]
    #: The whole finding census, so "zero blocking" cannot hide "everything softened".
    census: dict[tuple[str, str], int] = {}
    for finding in findings:
        key = (finding.validator_id, finding.severity)
        census[key] = census.get(key, 0) + 1
    assert set(census) <= {("V2", "warning"), ("V3", "info"), ("V3", "warning"), ("V4", "warning")}
    assert census.get(("V3", "warning"), 0) > 0, (
        "V3 is softened here, not satisfied — if it ever reports nothing at all on this "
        "fixture the softening rule has stopped working and this test would go quiet"
    )


@inv_pack_06
def test_the_unconditional_checks_are_clean_on_the_built_pack(invariant: str) -> None:
    """[INV-PACK-06] V1, V9, V2-per-exercise and V4-tag-soundness are EMPTY, not softened.

    These four have no gap-aware branch: a finding from any of them is blocking whatever
    state the pack is in. Asserting them empty rather than merely non-blocking is what
    stops the test above from passing because everything was downgraded, and they are the
    four the narrow claim actually rests on.
    """
    assert invariant == "INV-PACK-06"
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


# ---------------------------------------------------------------------------
# EC-PACK-07 — the Japanese half of the invariant
# ---------------------------------------------------------------------------


def _ja_ledger(split_mode: str, lemmas: list[str]) -> Any:
    """One ja exercise over one sentence, segmented the given way.

    Deliberately synthetic. A real ja ledger needs SudachiPy, a ja curriculum and a ja
    corpus, all of which are P7; what EC-PACK-07 is about is not the tokeniser's accuracy
    but the CONSEQUENCE of running the ledger on the wrong mode, and that is visible with
    hand-written rows. `外国人観光客` ("foreign tourist") is the canonical case: Mode C
    makes it one token, Mode A splits it into 外国 / 人 / 観光 / 客.
    """
    analysed = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "sentence_id": "a" * 16,
        "lang": "ja",
        "adapter": {
            "name": "sudachipy",
            "version": "0.6.10",
            "model": "sudachidict_core",
            "split_mode": split_mode,
        },
        "tokens": [
            {"surface": lemma, "lemma": lemma, "pos": "NOUN", "morph": "", "start": i, "end": i + 1}
            for i, lemma in enumerate(lemmas)
        ],
        "lemmas": sorted(set(lemmas)),
        "display_tokens": list(lemmas),
    }
    validate_record("analysed_sentence", analysed)
    units = [
        {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "lang": "ja",
            "section_index": 1,
            "section_cefr": "A1",
            "unit_index": 1,
            "unit_title": "Meet a visitor",
            "function": "Identify who someone is",
            "grammar_concept": "nouns",
            "register_slot": "graded_honorific",
            "target_lemmas": lemmas,
            "recycled_lemmas": [],
            "level_count": 1,
        }
    ]
    exercise = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "lang": "ja",
        "exercise_id": "0" * 16,
        "unit_index": 1,
        "lesson_index": 1,
        "type": "translate",
        "prompt": "Translate this sentence.",
        "accepted_answers": ["a foreign tourist"],
        "distractors": [],
        "alignment": [],
        "item_tags": {"lemmas": sorted(set(lemmas)), "grammar_concepts": ["nouns"]},
        "audio_ref": None,
        "register": "graded_honorific",
        "source_sentence_id": analysed["sentence_id"],
    }
    validate_record("exercise", exercise)
    for unit in units:
        validate_record("unit_assignment", unit)
    return build_ledger("ja", units, [exercise], analysed=[analysed], selected=[])


@inv_pack_06
def test_a_mode_c_japanese_ledger_is_refused_because_v2_would_pass_vacuously(
    invariant: str,
) -> None:
    """[INV-PACK-06] EC-PACK-07: Mode C makes V2 pass while four morphemes are introduced.

    The registry's second clause is "Japanese runs the ledger on Mode-A segmentation".
    This is the case it exists for, shown in both directions:

    - under **Mode C** the compound is ONE token, so V2's per-exercise count is 1, inside
      the budget of 1, and the check is green while the learner meets four unseen words.
      The ledger is refused for the segmentation instead — otherwise the green is the
      *only* thing anyone would see.
    - under **Mode A** the same content is four lemmas, the segmentation check passes, and
      V2 fires on the real defect: `4 new lemmas in one exercise`.

    A validator that reports the same green on both is worse than one that reports red on
    neither, and until `_check_segmentation` existed this one did.
    """
    assert invariant == "INV-PACK-06"
    assert LEDGER_SPLIT_MODE["ja"] == "A"

    compound = ["外国人観光客"]
    morphemes = ["外国", "人", "観光", "客"]

    mode_c = check_v2(_ja_ledger("C", compound))
    vacuous = [f for f in mode_c if "new lemmas in one exercise" in f.message]
    assert vacuous == [], "Mode C really does hide the defect — that is the whole point"
    segmentation = [f for f in mode_c if "EC-PACK-07" in f.message]
    assert segmentation and segmentation[0].severity == "blocking"
    assert "VACUOUSLY" in segmentation[0].message
    assert segmentation[0].detail == {"required": "A", "found": ["C"]}

    mode_a = check_v2(_ja_ledger("A", morphemes))
    assert [f for f in mode_a if "EC-PACK-07" in f.message] == []
    fired = [f for f in mode_a if "new lemmas in one exercise" in f.message]
    assert fired and fired[0].severity == "blocking"
    assert "4 new lemmas" in fired[0].message


def test_a_spanish_ledger_needs_no_split_mode_and_is_not_punished_for_having_none() -> None:
    """spaCy has no segmentation modes, so `split_mode: null` is the correct ja-free state.

    The check is a positive per-language requirement, which means it has to be right about
    the languages that have no modes too — otherwise every es pack in the suite goes red.
    """
    ledger, _ = es_mini_pack()
    assert ledger.split_modes == frozenset({None})
    assert "es" not in LEDGER_SPLIT_MODE
    assert [f for f in check_v2(ledger) if "EC-PACK-07" in f.message] == []


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
