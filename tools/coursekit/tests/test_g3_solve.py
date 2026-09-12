"""G3 — the curriculum solver, its loader's refusals, and the CEFR claim it emits."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import pytest
import yaml

from coursekit.artifacts import ARTIFACT_SCHEMA_VERSION, validate_record
from coursekit.config import CEFR_LANGUAGES
from coursekit.config.g3 import (
    CEFR_CHIPS_WITHOUT_PROSE,
    CEFR_PROSE_VALUES,
    LESSONS_PER_LEVEL,
    NEW_LEMMAS_PER_LESSON_MAX,
    NEW_LEMMAS_PER_LESSON_TARGET,
    RECYCLE_LEMMAS_MAX,
    RECYCLE_WINDOW_UNITS,
    SECTION_BAND_AGREEMENT_MIN,
)
from coursekit.inputs import group_is_installed
from coursekit.stages import STAGES
from coursekit.stages.g3_solve import (
    CurriculumError,
    curriculum_path,
    derive_level_count,
    derive_section_cefr,
    load_curriculum,
    solve,
    unreachable_lexemes,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
ES_CURRICULUM = REPO_ROOT / "content" / "es" / "curriculum.yaml"

needs_nlp = pytest.mark.skipif(
    not group_is_installed("nlp"), reason="the nlp group is not installed"
)


def fake_lemmatiser(answers: dict[str, str | None]):  # noqa: ANN201
    """A `lemmatise_surfaces` that reads a surface -> lemma table, element for element.

    A fake rather than the real adapter for the refusal tests: the defect under test is
    "the model produces a different lemma", and pinning it to whatever `es_core_news_md`
    happens to do to an invented word would make the test a measurement of spaCy. The
    real adapter is used against the SHIPPED curriculum further down, which is where the
    measurement belongs.
    """

    def lemmatise(surfaces):  # noqa: ANN001, ANN202
        return [
            None
            if answers.get(surface, surface) is None
            else (answers.get(surface, surface), "NOUN")
            for surface in surfaces
        ]

    return lemmatise


# ---------------------------------------------------------------------------
# A minimal, valid curriculum the refusal tests corrupt one field at a time
# ---------------------------------------------------------------------------


def minimal() -> dict[str, Any]:
    return {
        "schema": 1,
        "lang": "es",
        "l1": "en",
        "licence": "CC-BY-NC-SA-4.0",
        "grammar_concepts": [
            {
                "id": "being",
                "label": "Saying what something is",
                "cefr": "A1",
                "probe": {"lemma_any": ["ser"]},
            },
            {
                "id": "having",
                "label": "Saying what you have",
                "cefr": "A1",
                "probe": {"lemma_any": ["tener"]},
            },
        ],
        "sections": [
            {
                "index": 1,
                "cefr_prose": "very early A1",
                "summary": "s",
                "units": [
                    {
                        "title": "One",
                        "function": "f",
                        "grammar_concept": "being",
                        "register_slot": "n/a",
                        "target_lexemes": ["gato", "perro"],
                    },
                    {
                        "title": "Two",
                        "function": "f",
                        "grammar_concept": "having",
                        "register_slot": "binary_t_v",
                        "target_lexemes": ["libro", "mesa"],
                    },
                ],
            }
        ],
    }


def write(tmp_path: Path, document: dict[str, Any]) -> Path:
    target = tmp_path / "curriculum.yaml"
    target.write_text(yaml.safe_dump(document, allow_unicode=True), encoding="utf-8")
    return target


def lexicon(lemmas: list[str], *, band: str = "A1", source: str = "frequency_decile"):
    return [
        {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "lang": "es",
            "lemma": lemma,
            "pos": "NOUN",
            "rank": index + 1,
            "frequency": 100 - index,
            "decile": 1,
            "band": band,
            "band_source": source,
            "band_source_licence": "CC-BY-NC-SA-4.0" if source == "cefrlex" else None,
        }
        for index, lemma in enumerate(lemmas)
    ]


# ---------------------------------------------------------------------------
# The loader refuses what a human editing YAML actually gets wrong
# ---------------------------------------------------------------------------


def test_a_probe_with_no_clauses_is_refused(tmp_path: Path) -> None:
    """An empty probe matches every sentence and makes the grammar constraint vacuous.

    It is the failure mode that looks exactly like a working selector: every slot fills,
    every unit looks complete, and no exercise demonstrates anything in particular.
    """
    document = minimal()
    document["grammar_concepts"][0]["probe"] = {}
    with pytest.raises(CurriculumError, match="matches every sentence"):
        load_curriculum("es", path=write(tmp_path, document))


def test_an_unknown_probe_clause_is_refused(tmp_path: Path) -> None:
    document = minimal()
    document["grammar_concepts"][0]["probe"] = {"lemma_starts_with": ["s"]}
    with pytest.raises(CurriculumError, match="unknown clause"):
        load_curriculum("es", path=write(tmp_path, document))


def test_a_yaml_boolean_in_a_lexeme_list_is_refused(tmp_path: Path) -> None:
    """The Spanish word for "no" is a YAML 1.1 boolean.

    `target_lexemes: [..., no, ...]` parses to `False`, and `str(item)` would turn it into
    the lemma `"False"` — in no lexicon, teaching nothing, visible only as one more
    deferred lexeme in a list of hundreds. Measured on this repository's own curriculum.
    """
    document = minimal()
    document["sections"][0]["units"][0]["target_lexemes"] = ["gato", False]
    with pytest.raises(CurriculumError, match="quote it"):
        load_curriculum("es", path=write(tmp_path, document))


def test_a_lexeme_introduced_twice_is_refused(tmp_path: Path) -> None:
    """A lemma has exactly one introduction unit; V1 is the promise about that."""
    document = minimal()
    document["sections"][0]["units"][1]["target_lexemes"] = ["gato", "mesa"]
    with pytest.raises(CurriculumError, match="already introduced"):
        load_curriculum("es", path=write(tmp_path, document))


def test_an_unknown_grammar_concept_is_refused(tmp_path: Path) -> None:
    document = minimal()
    document["sections"][0]["units"][0]["grammar_concept"] = "nonexistent"
    with pytest.raises(CurriculumError, match="unknown grammar_concept"):
        load_curriculum("es", path=write(tmp_path, document))


def test_a_register_slot_the_language_does_not_have_is_refused(tmp_path: Path) -> None:
    document = minimal()
    document["sections"][0]["units"][0]["register_slot"] = "graded_honorific"
    with pytest.raises(CurriculumError, match="register_slot"):
        load_curriculum("es", path=write(tmp_path, document))


def test_INV_PACK_08_reserved_register_lemma_belongs_in_the_address_unit(
    tmp_path: Path,
) -> None:
    """[INV-PACK-08] B19: `usted` is curriculum, not a unit-1 V6 exemption."""
    document = minimal()
    document["grammar_concepts"].append(
        {
            "id": "formal_informal_address",
            "label": "Choosing formal or informal address",
            "cefr": "A1",
            "probe": {"lemma_any": ["usted", "tú"]},
        }
    )
    document["sections"][0]["units"][0]["target_lexemes"].append("usted")

    with pytest.raises(CurriculumError, match="formal_informal_address"):
        load_curriculum("es", path=write(tmp_path, document))

    document["sections"][0]["units"][0]["target_lexemes"].remove("usted")
    document["sections"][0]["units"][1]["grammar_concept"] = "formal_informal_address"
    document["sections"][0]["units"][1]["target_lexemes"].append("usted")
    curriculum = load_curriculum("es", path=write(tmp_path, document))
    assert "usted" in curriculum.sections[0].units[1].target_lexemes


def test_a_cefr_prose_string_that_does_not_ship_is_refused(tmp_path: Path) -> None:
    """Only seven prose values exist and there is no A2 one (deep/03 §review)."""
    document = minimal()
    document["sections"][0]["cefr_prose"] = "A2"
    with pytest.raises(CurriculumError, match="no A2 prose string"):
        load_curriculum("es", path=write(tmp_path, document))
    assert "A2" not in CEFR_PROSE_VALUES
    assert CEFR_CHIPS_WITHOUT_PROSE == ("A2",)


def test_a_missing_curriculum_is_a_loud_error_not_an_empty_course(tmp_path: Path) -> None:
    with pytest.raises(CurriculumError, match="no fallback"):
        load_curriculum("es", path=tmp_path / "absent.yaml")


def test_the_curriculum_path_is_the_committed_one() -> None:
    assert curriculum_path("es") == ES_CURRICULUM
    assert curriculum_path("es").exists()


# ---------------------------------------------------------------------------
# The new-item rate
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("new_lemmas", [1, 2, 5, 6, 7, 12, 13, 33, 100])
def test_level_count_keeps_the_published_budget(new_lemmas: int) -> None:
    """5-7 new words per lesson (`deep/01` §Ordering), satisfied by construction."""
    levels = derive_level_count(new_lemmas)
    assert levels >= 1
    lessons = levels * LESSONS_PER_LEVEL
    assert new_lemmas / lessons <= NEW_LEMMAS_PER_LESSON_MAX
    per_level = LESSONS_PER_LEVEL * NEW_LEMMAS_PER_LESSON_TARGET
    assert levels == max(1, math.ceil(new_lemmas / per_level))


def test_every_solved_unit_stays_inside_the_rate() -> None:
    curriculum = load_curriculum("es", path=ES_CURRICULUM)
    banded = lexicon([lexeme for _, unit in curriculum.units() for lexeme in unit.target_lexemes])
    result = solve(curriculum, banded)
    for unit in result.units:
        lessons = unit["level_count"] * LESSONS_PER_LEVEL
        assert len(unit["target_lemmas"]) / lessons <= NEW_LEMMAS_PER_LESSON_MAX


# ---------------------------------------------------------------------------
# The solve
# ---------------------------------------------------------------------------


def test_every_emitted_unit_matches_the_frozen_contract(tmp_path: Path) -> None:
    curriculum = load_curriculum("es", path=write(tmp_path, minimal()))
    result = solve(curriculum, lexicon(["gato", "perro", "libro", "mesa"]))
    assert len(result.units) == 2
    for unit in result.units:
        validate_record("unit_assignment", unit)
    assert [unit["unit_index"] for unit in result.units] == [1, 2]


def test_a_lexeme_the_lexicon_never_saw_is_deferred_and_counted(tmp_path: Path) -> None:
    """Never silently dropped: a curriculum losing a third of its vocabulary looks
    exactly like a curriculum that fitted."""
    curriculum = load_curriculum("es", path=write(tmp_path, minimal()))
    result = solve(curriculum, lexicon(["gato", "libro", "filler"]))
    assert result.report.lexemes_authored == 4
    assert result.report.lexemes_deferred == 2
    assert set(result.report.deferred_sample) == {"perro", "mesa"}
    assert result.units[0]["target_lemmas"] == ["gato"]


def test_a_unit_with_nothing_of_its_own_is_back_filled_not_emptied(tmp_path: Path) -> None:
    """`target_lemmas` is minItems 1, and a unit that teaches nothing is a dead node."""
    curriculum = load_curriculum("es", path=write(tmp_path, minimal()))
    result = solve(curriculum, lexicon(["gato", "perro", "spare"]))
    assert result.units[1]["target_lemmas"] == ["spare"]
    assert result.report.lexemes_backfilled == 1


def test_back_fill_never_steals_a_later_units_lexeme(tmp_path: Path) -> None:
    """Teaching unit 2's word in unit 1 moves an introduction the author placed.

    Both directions, because the rule is only interesting if it can bite: with a spare
    lemma the back-fill takes the spare, and with nothing but unit 2's lemmas available
    the solver RAISES rather than helping itself to one.
    """
    document = minimal()
    document["sections"][0]["units"][0]["target_lexemes"] = ["absent-from-lexicon"]
    curriculum = load_curriculum("es", path=write(tmp_path, document))

    result = solve(curriculum, lexicon(["libro", "mesa", "spare"]))
    assert result.units[0]["target_lemmas"] == ["spare"]

    with pytest.raises(CurriculumError, match="no assignable lemma"):
        solve(curriculum, lexicon(["libro", "mesa"]))


def test_recycling_is_scheduled_from_the_previous_units_most_recent_first(tmp_path: Path) -> None:
    curriculum = load_curriculum("es", path=write(tmp_path, minimal()))
    result = solve(curriculum, lexicon(["gato", "perro", "libro", "mesa"]))
    assert result.units[0]["recycled_lemmas"] == []
    assert result.units[1]["recycled_lemmas"] == ["gato", "perro"]
    assert RECYCLE_WINDOW_UNITS >= 1
    assert len(result.units[1]["recycled_lemmas"]) <= RECYCLE_LEMMAS_MAX


def test_the_solve_is_deterministic() -> None:
    curriculum = load_curriculum("es", path=ES_CURRICULUM)
    banded = lexicon([lexeme for _, unit in curriculum.units() for lexeme in unit.target_lexemes])
    assert solve(curriculum, banded).units == solve(curriculum, banded).units


# ---------------------------------------------------------------------------
# section_cefr — a G3 output, checked against G2 (R23)
# ---------------------------------------------------------------------------


def test_the_section_label_comes_from_the_grammar_concepts(tmp_path: Path) -> None:
    """R23: CEFRLex is per-LEMMA and the product labels SECTIONS. The label is a
    curriculum-design output — which concepts a section contains — not a lookup."""
    curriculum = load_curriculum("es", path=write(tmp_path, minimal()))
    section = curriculum.sections[0]
    assert derive_section_cefr(curriculum.concepts, section.units) == "A1"
    result = solve(curriculum, lexicon(["gato", "perro", "libro", "mesa"]))
    assert {unit["section_cefr"] for unit in result.units} == {"A1"}


def test_the_highest_concept_decides_the_section(tmp_path: Path) -> None:
    document = minimal()
    document["grammar_concepts"][1]["cefr"] = "B1"
    document["sections"][0]["cefr_prose"] = "early B1"
    curriculum = load_curriculum("es", path=write(tmp_path, document))
    assert derive_section_cefr(curriculum.concepts, curriculum.sections[0].units) == "B1"


def test_prose_that_belongs_to_another_chip_is_a_contradiction(tmp_path: Path) -> None:
    """S024 renders the chip and the blurb from the same row and must not disagree."""
    document = minimal()
    document["grammar_concepts"][1]["cefr"] = "B2"
    document["sections"][0]["cefr_prose"] = "very early A1"
    curriculum = load_curriculum("es", path=write(tmp_path, document))
    with pytest.raises(CurriculumError, match="would contradict itself"):
        solve(curriculum, lexicon(["gato", "perro", "libro", "mesa"]))


def test_a_decile_lexicon_does_not_get_to_check_a_cefr_claim(tmp_path: Path) -> None:
    """A frequency decile is not a statement about CEFR (Q8, R23).

    Checking an A1 section label against decile bands would either pass meaninglessly or
    fail a correct curriculum. The stage records `cefr_checked: false` instead, which is
    what makes a card read `Beginner · frequency-ordered` rather than `A1 · CEFR-checked`.
    """
    curriculum = load_curriculum("es", path=write(tmp_path, minimal()))
    result = solve(curriculum, lexicon(["gato", "perro", "libro", "mesa"], band="C2"))
    assert result.report.cefr_checked is False
    assert result.ok is True


def test_a_cefrlex_lexicon_that_disagrees_with_the_label_fails_the_stage(tmp_path: Path) -> None:
    """…and when the bands DO carry CEFR authority, the check has teeth."""
    document = minimal()
    lemmas = [f"w{index}" for index in range(20)]
    document["sections"][0]["units"][0]["target_lexemes"] = lemmas[:10]
    document["sections"][0]["units"][1]["target_lexemes"] = lemmas[10:]
    curriculum = load_curriculum("es", path=write(tmp_path, document))

    agreeing = solve(curriculum, lexicon(lemmas, band="A1", source="cefrlex"))
    assert agreeing.report.cefr_checked is True
    assert agreeing.ok is True

    disagreeing = solve(curriculum, lexicon(lemmas, band="B2", source="cefrlex"))
    assert disagreeing.report.cefr_checked is True
    assert disagreeing.ok is False
    assert disagreeing.report.section_checks[0].agreement < SECTION_BAND_AGREEMENT_MIN
    assert "es" in CEFR_LANGUAGES


#: Captured at IMPORT time. `tests/test_cli.py`'s `empty_registry` fixture calls
#: `Registry.reset_for_tests()`, and re-discovery cannot restore anything: the stage
#: modules are already in `sys.modules`, so `importlib.import_module` returns them
#: without re-running the `@register_stage` decorator. That is a defect in
#: `coursekit/__init__.py` — outside this lane — and it only became visible when P2
#: started registering stages. Reading the registry here records what importing the
#: module actually does.
REGISTERED_AT_IMPORT = {stage_id: stage for stage_id, stage in STAGES}


def test_g3_is_registered() -> None:
    stage = REGISTERED_AT_IMPORT.get("g3")
    assert stage is not None
    assert stage.reads == ("banded_lemma",)
    assert stage.writes == ("unit_assignment",)


# ---------------------------------------------------------------------------
# Lexeme reachability — founder ruling B9(c)
# ---------------------------------------------------------------------------


def test_INV_PACK_06_a_declared_lexeme_the_lemmatiser_never_produces_is_named(
    tmp_path: Path,
) -> None:
    """[INV-PACK-06] B9(c): the defect V1 cannot see, because the lemma cannot exist.

    V1 says no lemma appears in an exercise before its introduction unit. A lexeme the
    lemmatiser never produces appears in no exercise at all, so V1 passes over it — and
    `solve` calls it DEFERRED, the same bucket as a good lemma this corpus happened not
    to contain. The unit ships teaching one item fewer than it declares and nothing says
    so. Measured on the shipped Spanish curriculum before this gate: 95 of 990.
    """
    document = minimal()
    document["sections"][0]["units"][0]["target_lexemes"] = ["gato", "llamarse"]
    curriculum = load_curriculum("es", path=write(tmp_path, document))

    failures = unreachable_lexemes(curriculum, fake_lemmatiser({"llamarse": "llamar él"}))
    assert [failure.lexeme for failure in failures] == ["llamarse"]
    assert failures[0].unit_index == 1
    assert failures[0].attempts == (("llamarse", "llamar él"),)
    assert "'llamarse' -> 'llamar él'" in failures[0].as_line()


def test_INV_PACK_06_the_forms_block_discharges_a_lexeme_whose_bare_form_mislemmatises(
    tmp_path: Path,
) -> None:
    """[INV-PACK-06] `trabajo` alone is read as a verb; `trabajos` is the noun.

    This is the ordinary case and it is why the gate needs a per-unit `forms:` list
    rather than a global exception list: which surface reaches a lemma is a fact about
    that word, and the unit that teaches it is where a human can check the answer.
    """
    document = minimal()
    document["sections"][0]["units"][0]["target_lexemes"] = ["gato", "trabajo"]
    answers = {"trabajo": "trabajar", "trabajos": "trabajo"}

    without = load_curriculum("es", path=write(tmp_path, document))
    assert [f.lexeme for f in unreachable_lexemes(without, fake_lemmatiser(answers))] == ["trabajo"]

    document["sections"][0]["units"][0]["forms"] = {"trabajo": ["trabajos"]}
    with_forms = load_curriculum("es", path=write(tmp_path, document))
    assert unreachable_lexemes(with_forms, fake_lemmatiser(answers)) == []
    assert with_forms.sections[0].units[0].taught_forms("trabajo") == (
        "trabajo",
        "trabajos",
    )


def test_a_form_that_is_not_one_word_is_no_evidence(tmp_path: Path) -> None:
    """`lemmatise_surfaces` returns None for a multi-token surface, and None is not a hit.

    The failure line says "(not one word)" rather than printing a lemma, because a
    two-word form cannot be attributed to one lemma — the adapter's own rule.
    """
    document = minimal()
    document["sections"][0]["units"][0]["target_lexemes"] = ["gato", "gusto"]
    document["sections"][0]["units"][0]["forms"] = {"gusto": ["mucho gusto"]}
    curriculum = load_curriculum("es", path=write(tmp_path, document))
    failures = unreachable_lexemes(
        curriculum, fake_lemmatiser({"gusto": "gustar", "mucho gusto": None})
    )
    assert [f.lexeme for f in failures] == ["gusto"]
    assert "(not one word)" in failures[0].as_line()


def test_INV_PACK_12_an_adapter_that_answers_a_different_number_of_probes_is_refused(
    tmp_path: Path,
) -> None:
    """[INV-PACK-12] element-for-element is a contract, and a shifted answer is silent.

    `lemmatise_surfaces` is documented as element for element. An answer list of a
    different length would shift every verdict onto another lexeme — plausible output,
    wrong lexeme — so the gate refuses by name rather than zipping to the shorter list.
    """
    curriculum = load_curriculum("es", path=write(tmp_path, minimal()))
    with pytest.raises(CurriculumError, match="element-for-element"):
        unreachable_lexemes(curriculum, lambda surfaces: [("gato", "NOUN")])


def test_the_report_and_the_result_both_carry_the_unreachable_lexemes(tmp_path: Path) -> None:
    """`SolveResult.ok` is false and the runlog note names them, not just the message."""
    document = minimal()
    curriculum = load_curriculum("es", path=write(tmp_path, document))
    result = solve(curriculum, lexicon(["gato", "perro", "libro", "mesa"]))
    assert result.ok is True
    assert result.report.as_notes()["unreachable_lexemes"] == []

    result.report.unreachable = unreachable_lexemes(curriculum, fake_lemmatiser({"gato": "gatar"}))
    assert result.ok is False
    assert result.report.as_notes()["unreachable_lexemes"] == [
        "u1 'One': 'gato' ('gato' -> 'gatar')"
    ]


def test_forms_must_name_a_lexeme_this_unit_teaches(tmp_path: Path) -> None:
    document = minimal()
    document["sections"][0]["units"][0]["forms"] = {"caballo": ["caballos"]}
    with pytest.raises(CurriculumError, match="checked against nothing"):
        load_curriculum("es", path=write(tmp_path, document))


def test_an_empty_forms_list_is_refused_rather_than_read_as_none(tmp_path: Path) -> None:
    document = minimal()
    document["sections"][0]["units"][0]["forms"] = {"gato": []}
    with pytest.raises(CurriculumError, match="declares nothing"):
        load_curriculum("es", path=write(tmp_path, document))


def test_forms_must_be_a_mapping_and_carry_no_accidental_booleans(tmp_path: Path) -> None:
    document = minimal()
    document["sections"][0]["units"][0]["forms"] = ["gato"]
    with pytest.raises(CurriculumError, match="mapping of lexeme"):
        load_curriculum("es", path=write(tmp_path, document))

    document["sections"][0]["units"][0]["forms"] = {"gato": [False]}
    with pytest.raises(CurriculumError, match="quote it"):
        load_curriculum("es", path=write(tmp_path, document))


def test_INV_PACK_06_a_capitalised_form_is_refused_and_the_message_says_why(
    tmp_path: Path,
) -> None:
    """[INV-PACK-06] the gate may not be discharged by a sentence-initial capital.

    The one way `forms:` can turn the gate green without fixing anything. Measured
    2026-09-12 on the pinned model: `Gracias` -> `gracias` but `gracias` -> `gracia`,
    `Media` -> `media` but `media` -> `medio`, `Paraguas` -> `paraguas` but `paraguas`
    -> `paragua`. All three spellings only reach their lemma because a capital at the
    start of a document is read PROPN and PROPN keeps the surface as the lemma — so the
    lexeme would pass the gate and still be unselectable from any ordinary sentence.

    An adversarial review found exactly those three rows in the first version of this
    lane, with `unreachable_lexemes` reporting 0. Refused at load rather than lowercased
    on the way in: an author who writes `Gracias` believes something about Spanish that
    is wrong, and a loader that quietly lowercased it would accept the belief and fail
    somewhere else.
    """
    document = minimal()
    document["sections"][0]["units"][0]["forms"] = {"gato": ["Gatos"]}
    with pytest.raises(CurriculumError, match="not\nNFC-lowercase|not NFC-lowercase"):
        load_curriculum("es", path=write(tmp_path, document))

    document["sections"][0]["units"][0]["forms"] = {"gato": ["gatos"]}
    unit = load_curriculum("es", path=write(tmp_path, document)).sections[0].units[0]
    assert unit.taught_forms("gato") == ("gato", "gatos")


def test_a_form_repeated_or_equal_to_the_lexeme_is_probed_once(tmp_path: Path) -> None:
    """A duplicate is harmless to the verdict and noise in the failure line, so it goes.

    `taught_forms` is what the gate probes and what the failure message lists; a lexeme
    named twice in `target_lexemes`, or a `forms:` list repeating the lexeme itself,
    would otherwise report the same attempt two or three times.
    """
    document = minimal()
    document["sections"][0]["units"][0]["forms"] = {"gato": ["gato", "gatos", "gatos"]}
    unit = load_curriculum("es", path=write(tmp_path, document)).sections[0].units[0]
    assert unit.taught_forms("gato") == ("gato", "gatos")


def test_a_unit_with_no_forms_block_still_probes_the_lexeme_itself(tmp_path: Path) -> None:
    """The minimum claim: a curriculum declaring `casa` says the model produces `casa`."""
    curriculum = load_curriculum("es", path=write(tmp_path, minimal()))
    unit = curriculum.sections[0].units[0]
    assert unit.forms == ()
    assert unit.taught_forms("gato") == ("gato",)


@needs_nlp
def test_INV_PACK_06_the_shipped_spanish_curriculum_has_no_unreachable_lexeme() -> None:
    """[INV-PACK-06] the gate, run for real, against the file that ships.

    With the pinned model and the B9(a) normalisation table. This is the assertion that
    would have stopped `docs/P2-BLOCKERS.md` §B9 from being discovered by an authoring
    shard two stages downstream.
    """
    from coursekit.stages.g1_analyze import adapter_for

    failures = unreachable_lexemes(load_curriculum("es"), adapter_for("es").lemmatise_surfaces)
    assert failures == [], [failure.as_line() for failure in failures]


def _seed_g2(records: list[dict[str, Any]], lang: str = "es") -> None:
    """Put a banded lexicon where G2 would have left it, and log that G2 ran."""
    from coursekit import __version__
    from coursekit.artifacts import write_records
    from coursekit.config import TOOL_NAME
    from coursekit.runlog import RunLog

    write_records("banded_lemma", records, lang=lang)
    runlog = RunLog(lang)
    with runlog.stage("g2", tool=TOOL_NAME, tool_version=__version__) as entry:
        entry.record_output("banded_lemma")
        entry.written = len(records)


def test_INV_PACK_06_the_stage_itself_fails_on_an_unreachable_lexeme(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[INV-PACK-06] ruling B9(c) end to end: `StageResult(ok=False)`, lexeme named.

    Through the STAGE, not the helper, because the two things that could go wrong are
    both in the wiring: the gate not being called at all, and its verdict not reaching
    the result. It is deliberately not a registered validator — `VALIDATOR_IDS` is what
    `pack-ci`'s `pipeline-ready` job counts, and an unregistered id would skip both pack
    jobs green — so the stage is the only place this can be asserted.
    """
    from coursekit import __version__
    from coursekit.config import TOOL_NAME
    from coursekit.runlog import RunLog
    from coursekit.stages import StageContext
    from coursekit.stages.g1_analyze import adapter_for  # noqa: F401 — patched below
    from coursekit.stages.g3_solve import solve_curriculum

    document = minimal()
    document["sections"][0]["units"][0]["target_lexemes"] = ["gato", "llamarse"]
    path = write(tmp_path, document)
    monkeypatch.setattr(
        "coursekit.stages.g3_solve.load_curriculum",
        lambda lang: load_curriculum(lang, path=path),
    )

    class _Adapter:
        lemmatise_surfaces = staticmethod(fake_lemmatiser({"llamarse": "llamar él"}))

    monkeypatch.setattr("coursekit.stages.g1_analyze.adapter_for", lambda lang: _Adapter())

    _seed_g2(lexicon(["gato", "llamar él", "libro", "mesa"]))
    runlog = RunLog("es")
    with runlog.stage("g3", tool=TOOL_NAME, tool_version=__version__) as entry:
        result = solve_curriculum(StageContext(lang="es", runlog=runlog, entry=entry, options={}))
        if not result.ok:
            entry.status = "failed"

    assert result.ok is False
    assert "unreachable" in result.message
    assert "'llamarse' -> 'llamar él'" in result.message
    assert result.detail is not None
    assert result.detail["unreachable_lexemes"] == [
        "u1 'One': 'llamarse' ('llamarse' -> 'llamar él')"
    ]
    # And the defect it replaces: `llamarse` is in no lexicon, so without the gate the
    # only trace was one more row in the deferred count.
    assert entry.notes["lexemes_deferred"] == 1


def test_INV_PACK_12_no_registered_adapter_fails_g3_by_name_and_never_skips_the_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[INV-PACK-12] the missing per-language source fails loudly, and does not degrade.

    Ruling B9(c) gave G3 a dependency it did not have: the reachability gate needs the
    lemmatiser, so `solve_curriculum` now asks for the adapter on every run. There are
    three things it could do without one and only one of them is right:

    - raise, and print a Python traceback where every other stage prints one line
      (ruling B14 settled that question for G7);
    - carry on with `report.unreachable` empty, which reads as "nothing unreachable" —
      the single worst outcome, because an unreachable lexeme is silent by nature and
      that is how it got into the shipped curriculum in the first place;
    - **return `StageResult(ok=False)` naming the missing adapter.** This.

    The `nlp` group is not needed for this test and must not be: the point is what
    happens when the adapter is absent.
    """
    from coursekit import __version__
    from coursekit.config import TOOL_NAME
    from coursekit.inputs import MissingInput
    from coursekit.runlog import RunLog
    from coursekit.stages import StageContext
    from coursekit.stages.g3_solve import solve_curriculum

    monkeypatch.setattr(
        "coursekit.stages.g3_solve.load_curriculum",
        lambda lang: load_curriculum(lang, path=write(tmp_path, minimal())),
    )

    def _no_adapter(lang: str) -> None:
        raise MissingInput(f"no morphology adapter is registered for {lang!r}")

    monkeypatch.setattr("coursekit.stages.g1_analyze.adapter_for", _no_adapter)

    _seed_g2(lexicon(["gato", "libro", "mesa"]))
    runlog = RunLog("es")
    with runlog.stage("g3", tool=TOOL_NAME, tool_version=__version__) as entry:
        result = solve_curriculum(StageContext(lang="es", runlog=runlog, entry=entry, options={}))
        if not result.ok:
            entry.status = "failed"

    assert result.ok is False
    assert "no morphology adapter is registered for 'es'" in result.message
    assert "not a reason to skip the gate" in result.message
