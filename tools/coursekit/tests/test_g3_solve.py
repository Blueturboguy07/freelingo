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
from coursekit.stages import STAGES
from coursekit.stages.g3_solve import (
    CurriculumError,
    curriculum_path,
    derive_level_count,
    derive_section_cefr,
    load_curriculum,
    solve,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
ES_CURRICULUM = REPO_ROOT / "content" / "es" / "curriculum.yaml"


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
