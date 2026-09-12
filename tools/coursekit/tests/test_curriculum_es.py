"""The shipped Spanish curriculum: shape, licence, and the claim no test can make.

`content/es/curriculum.yaml` is the one artefact in this pipeline that nothing downstream
can check. A copied unit title from Cervantes' Plan curricular or from Duolingo passes
`coursekit validate`, V1-V12, the reviewer sample and every job in CI without a mark. The
tests here check what IS checkable — the shape, the licence line, and that the provenance
statement is actually present in both the file and its README — and the rest is stated in
`content/es/README.md` and in the file's own header.
"""

from __future__ import annotations

import unicodedata
from pathlib import Path

import pytest
import yaml

from coursekit.adapters import ADAPTERS
from coursekit.config import PACK_LICENCE
from coursekit.config.g3 import (
    CEFR_CHIP_FOR_PROSE,
    CEFR_PROSE_VALUES,
    PROBE_CLAUSES,
    REGISTER_SLOT_BY_LANGUAGE,
)
from coursekit.inputs import group_is_installed
from coursekit.stages.g3_solve import curriculum_path, load_curriculum

ES = curriculum_path("es")
README = ES.parent / "README.md"

#: The A1 inventory the framework asks for: "~25-30 concepts, ~10-30 unit titles"
#: (`scope2/00` §2.1 input 6), and ~1,000 A1 lexemes.
MIN_CONCEPTS, MAX_CONCEPTS = 25, 30
MIN_UNITS = 10
MIN_LEXEMES, MAX_LEXEMES = 900, 1100

#: The `nlp` group is the hard gate `inputs.require_group` enforces, so a machine without
#: it skips the one test here that loads the pinned model rather than inventing a
#: fallback. Same spelling as `test_g1_analyze.py`, read from the same helper.
needs_nlp = pytest.mark.skipif(
    not group_is_installed("nlp"), reason="the nlp group is not installed"
)


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


# ---------------------------------------------------------------------------
# `forms:` and the declarations ruling B9 removed
# ---------------------------------------------------------------------------

#: Every lexeme the gate proved unreachable and that no normalisation table can rescue,
#: because the pinned model MERGES these rather than merely spelling them differently:
#: measured 2026-09-12, `levantarse`, `levantarlo`, `levantarla`, `levantarle`,
#: `levantarlos` and `levantarles` all give the one lemma `levantar él`, and `él`,
#: `ella`, `ellos`, `lo` and `se` all give `él`. They are named here so a later edit
#: cannot quietly put one back: it would be deferred forever and teach nothing.
UNHOLDABLE = (
    "ella",
    "ellos",
    "nosotros",
    "vosotros",
    "ustedes",
    "lo",
    "me",
    "te",
    "nos",
    "os",
    "se",
    "llamarse",
    "encontrarse",
    "equivocarse",
    "dirigirse",
    "levantarse",
    "vacaciones",
    "un",
)


def _stem(word: str) -> str:
    """The first four characters, accents stripped — enough to tell a form from a word."""
    bare = "".join(
        ch for ch in unicodedata.normalize("NFD", word.lower()) if not unicodedata.combining(ch)
    )
    return bare[:4]


#: The carrier the mid-sentence check below puts a declared form into. Position 1, never
#: 0, and lowercase: `es_core_news_md` re-tags a sentence-initial capital PROPN and keeps
#: the surface as the lemma, so a form at index 0 or with a capital can reach a lemma no
#: ordinary sentence reaches. Measured 2026-09-12 over all 38 declared forms in four
#: other carriers (`Hay …`, `Tengo …`, `Aquí hay … y más.`, `Ella ve … hoy.`): the same
#: answer in every one, so the check is about the position and not about this sentence.
MID_SENTENCE_CARRIER = "Veo {form} aquí."


def test_INV_PACK_06_every_declared_form_is_a_form_of_the_lexeme_it_discharges() -> None:
    """[INV-PACK-06] the gate is discharged by Spanish, not by any string that passes.

    `forms:` exists so a lexeme whose bare form mis-lemmatises can name one that does
    not. That makes it the one place in this file where a wrong entry turns the gate
    green: `bueno: [casa]` would discharge nothing and look like a fix. The loader
    already refuses a key that is not a target lexeme; this refuses a VALUE that is not
    a form of it. Generated plural-of-a-plural strings (`vacacioneses`, `uns`) do not
    survive it, which is how the removals below were told apart from the fixes.

    **And the capitalisation half, which this test could not see before.** `_stem`
    lowercases, so it accepted `Gracias` as a form of `gracias` — and an adversarial
    review found three rows doing exactly that, each reaching its lemma only because a
    sentence-initial capital is read PROPN. The loader now refuses a non-lowercase form
    outright (`_load_forms`); this asserts the same thing from the artefact's side, so
    the rule is visible in the file that would break it.
    """
    curriculum = load_curriculum("es")
    declared = 0
    for _section, unit in curriculum.units():
        for lexeme, forms in unit.forms:
            for form in forms:
                declared += 1
                assert _stem(form) == _stem(lexeme), (
                    f"{unit.title!r} declares {form!r} as a form of {lexeme!r}"
                )
                assert form == unicodedata.normalize("NFC", form.lower()), (
                    f"{unit.title!r} declares the non-lowercase form {form!r}; a capital "
                    f"reaches a lemma only sentence-initially"
                )
    assert declared == 38, f"{declared} forms declared; the shipped file carries 38"


@needs_nlp
def test_INV_PACK_06_a_declared_form_reaches_its_lexeme_mid_sentence_and_lowercase() -> None:
    """[INV-PACK-06] the gate may not be discharged by a position artefact.

    The gate itself probes a BARE surface, because that is the call `lemmatise_surface`
    and the G2 frequency tail make. A bare surface is unavoidably sentence-initial, so
    on its own it cannot tell a real repair (`trabajos` -> `trabajo`) from a
    capitalisation trick (`Gracias` -> `gracias`, where `gracias` -> `gracia`). This is
    the corroborating half: **for every lexeme that declares forms, at least one of them
    reaches the lexeme with the word lowercase and NOT first in the sentence**, which is
    the only position a corpus sentence can actually offer.

    Measured 2026-09-12: `Muchas gracias por todo.` -> `gracia`, `Son las dos y media.`
    -> `medio`, `Tengo un paraguas nuevo.` -> `paraguas`. All three were declared with a
    capitalised `forms:` entry in the first version of this lane, all three passed the
    gate, and none of them could be selected from an ordinary sentence — the exact
    defect B9(c) exists to catch.
    """
    adapter = ADAPTERS.get("es")()
    curriculum = load_curriculum("es")
    for _section, unit in curriculum.units():
        for lexeme, forms in unit.forms:
            reached = []
            for form in forms:
                record = adapter.analyse(
                    sentence_id="0" * 16, text=MID_SENTENCE_CARRIER.format(form=form)
                )
                at = [i for i, token in enumerate(record["tokens"]) if token["surface"] == form]
                if at and at[0] > 0 and record["tokens"][at[0]]["lemma"] == lexeme:
                    reached.append(form)
            assert reached, (
                f"{unit.title!r}: no form of {lexeme!r} in {list(forms)} reaches it "
                f"lowercase and mid-sentence; the only thing discharging the gate is the "
                f"bare one-word probe"
            )


def test_INV_PACK_06_no_lexeme_the_ledger_cannot_hold_is_declared_again() -> None:
    """[INV-PACK-06] ruling B9(c)'s removals, pinned by name.

    A reflexive infinitive or a collapsing pronoun declared as a `target_lexeme` is a
    lemma the pinned lemmatiser never produces. It is not a build failure today only
    because it is not there; `unreachable_lexemes` fails the stage the moment one comes
    back, and this test says which words to think twice about.
    """
    curriculum = load_curriculum("es")
    declared = {lexeme for _s, unit in curriculum.units() for lexeme in unit.target_lexemes}
    assert declared.isdisjoint(UNHOLDABLE), sorted(declared & set(UNHOLDABLE))
    reflexive = sorted(
        lexeme
        for lexeme in declared
        if lexeme.endswith("se") and lexeme[:-2].endswith(("ar", "er", "ir"))
    )
    assert reflexive == [], f"{reflexive} lemmatise to `<verb> él`, a two-word lemma"


def test_the_reflexive_unit_still_teaches_the_routine_it_is_titled_after() -> None:
    """Ruling B9(c) moved the unit's lexemes to the base verbs; it did not gut the unit.

    The ledger item for what the learner says — "se levanta" — IS `levantar`; the
    reflexive construction is the unit's grammar concept, which Q2 option C schedules as
    an item of its own, and the concept's probe matches the CLITIC, not the verb. So the
    unit teaches the same Spanish through a vocabulary the ledger can hold.
    """
    curriculum = load_curriculum("es")
    unit = next(
        unit for _s, unit in curriculum.units() if unit.grammar_concept == "reflexive_daily_routine"
    )
    assert "morning" in unit.title
    assert len(unit.target_lexemes) >= 10
    for expected in ("levantar", "duchar", "lavar", "despertar", "acostar"):
        assert expected in unit.target_lexemes
    probe = curriculum.concepts["reflexive_daily_routine"].probe
    assert probe.pos_any == ("PRON",)
    assert probe.morph_any == ("Reflex=Yes",)
