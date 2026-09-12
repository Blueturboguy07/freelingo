"""The shipped Spanish curriculum: shape, licence, and the claim no test can make.

`content/es/curriculum.yaml` is the one artefact in this pipeline that nothing downstream
can check. A copied unit title from Cervantes' Plan curricular or from Duolingo passes
`coursekit validate`, V1-V12, the reviewer sample and every job in CI without a mark. The
tests here check what IS checkable — the shape, the licence line, and that the provenance
statement is actually present in both the file and its README — and the rest is stated in
`content/es/README.md` and in the file's own header.
"""

from __future__ import annotations

from pathlib import Path

import yaml

from coursekit.config import PACK_LICENCE
from coursekit.config.g3 import (
    CEFR_CHIP_FOR_PROSE,
    CEFR_PROSE_VALUES,
    PROBE_CLAUSES,
    REGISTER_SLOT_BY_LANGUAGE,
)
from coursekit.stages.g3_solve import curriculum_path, load_curriculum

ES = curriculum_path("es")
README = ES.parent / "README.md"

#: The A1 inventory the framework asks for: "~25-30 concepts, ~10-30 unit titles"
#: (`scope2/00` §2.1 input 6), and ~1,000 A1 lexemes.
MIN_CONCEPTS, MAX_CONCEPTS = 25, 30
MIN_UNITS = 10
MIN_LEXEMES, MAX_LEXEMES = 900, 1100


def raw() -> dict:
    return yaml.safe_load(ES.read_text(encoding="utf-8"))


def test_the_shipped_curriculum_loads() -> None:
    curriculum = load_curriculum("es")
    assert curriculum.lang == "es"
    assert curriculum.l1 == "en"


def test_it_is_cc_by_nc_sa_and_says_so_in_three_places() -> None:
    """The code is AGPL and the packs are CC BY-NC-SA; a reader must not have to guess."""
    curriculum = load_curriculum("es")
    assert curriculum.licence == PACK_LICENCE
    assert PACK_LICENCE == "CC-BY-NC-SA-4.0"
    # The SPDX id in the data, the human spelling in the header and in the README.
    assert f"licence: {PACK_LICENCE}" in ES.read_text(encoding="utf-8")
    assert "CC BY-NC-SA 4.0" in ES.read_text(encoding="utf-8")
    assert "CC BY-NC-SA 4.0" in README.read_text(encoding="utf-8")


def test_the_originality_claim_is_made_explicitly() -> None:
    """The one failure this file can have that no test catches, stated where it belongs."""
    text = ES.read_text(encoding="utf-8")
    readme = README.read_text(encoding="utf-8")
    assert "ORIGINALLY AUTHORED FOR THIS REPOSITORY" in text
    assert "originality:" in text
    for source in ("Cervantes", "Duolingo", "Council of Europe"):
        assert source in readme, f"the README must name {source} among what was not copied"
    assert "written for this repository" in readme


def test_the_inventory_is_the_size_the_framework_asks_for() -> None:
    curriculum = load_curriculum("es")
    assert MIN_CONCEPTS <= len(curriculum.concepts) <= MAX_CONCEPTS
    assert len(curriculum.units()) >= MIN_UNITS


def test_section_one_has_about_ten_units() -> None:
    curriculum = load_curriculum("es")
    first = curriculum.sections[0]
    assert first.index == 1
    assert 8 <= len(first.units) <= 12


def test_it_carries_about_a_thousand_a1_lexemes_and_no_lemma_twice() -> None:
    curriculum = load_curriculum("es")
    lexemes = [lexeme for _, unit in curriculum.units() for lexeme in unit.target_lexemes]
    assert MIN_LEXEMES <= len(lexemes) <= MAX_LEXEMES
    assert len(lexemes) == len(set(lexemes)), "a lemma has exactly one introduction unit"


def test_every_concept_is_used_and_every_used_concept_exists() -> None:
    """An unused concept renders in S024's `Grammar concepts` list and teaches nothing."""
    curriculum = load_curriculum("es")
    used = [unit.grammar_concept for _, unit in curriculum.units()]
    assert set(used) == set(curriculum.concepts)


def test_every_probe_has_at_least_one_clause() -> None:
    curriculum = load_curriculum("es")
    for concept in curriculum.concepts.values():
        assert not concept.probe.is_empty(), concept.id
        assert any(getattr(concept.probe, clause) for clause in PROBE_CLAUSES)


def test_every_section_declares_a_prose_string_that_actually_ships() -> None:
    """Seven values, no A2 (`deep/03` §review, str:2325-2331)."""
    curriculum = load_curriculum("es")
    for section in curriculum.sections:
        assert section.cefr_prose in CEFR_PROSE_VALUES
        assert CEFR_CHIP_FOR_PROSE[section.cefr_prose] == "A1"


def test_the_register_slots_are_spanish_ones() -> None:
    curriculum = load_curriculum("es")
    slots = {unit.register_slot for _, unit in curriculum.units()}
    assert slots <= {"n/a", REGISTER_SLOT_BY_LANGUAGE["es"]}
    assert REGISTER_SLOT_BY_LANGUAGE["es"] in slots, "some unit must exercise tú vs usted"


def test_sections_four_to_eight_are_absent_rather_than_stubbed() -> None:
    """S023 renders FUTURE sections. An empty section is an unwritten one; a stub is a
    can-do promise nobody authored."""
    curriculum = load_curriculum("es")
    assert [section.index for section in curriculum.sections] == [1, 2, 3]


def test_no_unit_title_is_a_bare_grammar_label() -> None:
    """Titles are can-do phrases ("Order at a café"), not the grammar underneath.

    A title that reads `Present tense` is the section-details `Grammar concepts` list
    leaking into the path, and it is also the shape most likely to have been copied.
    """
    curriculum = load_curriculum("es")
    labels = {concept.label.lower() for concept in curriculum.concepts.values()}
    for _, unit in curriculum.units():
        assert unit.title.lower() not in labels
        assert len(unit.title.split()) >= 3, unit.title


def test_the_yaml_carries_no_accidental_booleans() -> None:
    """`no` is the Spanish word and a YAML 1.1 boolean. The loader refuses one; this
    catches the whole file at once rather than at the first unit that has one."""
    document = raw()
    for section in document["sections"]:
        for unit in section["units"]:
            for lexeme in unit["target_lexemes"]:
                assert isinstance(lexeme, str), (unit["title"], lexeme)
    for concept in document["grammar_concepts"]:
        for values in concept["probe"].values():
            assert all(isinstance(value, str) for value in values), concept["id"]


def test_the_readme_and_the_file_agree_about_where_cefr_comes_from() -> None:
    """R23, in both places a reader looks."""
    readme = README.read_text(encoding="utf-8")
    text = ES.read_text(encoding="utf-8")
    assert "R23" in readme and "R23" in text
    assert "section_cefr" in text
    assert Path(README).exists()
