"""V10, V11 and V12, each with the falsifier that would let it pass while wrong.

Every test here comes in a pair: the property, and the input that a plausible wrong
implementation returns green on. The pattern is the plan's — "test first from the
invariant's falsifier input" — and it matters more than usual for a validator, because
the only observable difference between "this validator checked and found nothing" and
"this validator did not check" is whether the suite is still trustworthy.
"""

from __future__ import annotations

import pytest

from coursekit.artifacts import artifact_path, write_records
from coursekit.config import INGEST_LICENCE_ALLOW_LIST
from coursekit.config.validate import (
    AUTHORED_SENTENCE_LICENCE,
    MIN_ITEMS_PER_UNIT_FOR_DIFFICULTY,
    REQUIRED_CHARACTERS_BY_LANGUAGE,
    RTL_LANGUAGES,
    SHIPPED_FONT_RANGES,
    allowed_licences_for,
)
from coursekit.runlog import RunLog
from coursekit.validators import Finding, ValidatorContext
from coursekit.validators.pack import (
    SuiteInputMissing,
    covered_by_shipped_font,
    difficulty,
    direction_and_font_coverage,
    every_sentence_carries_a_resolved_licence,
    mean_difficulty_is_non_decreasing,
    shipped_items,
    word_tokens,
)


def context(lang: str = "es") -> ValidatorContext:
    """A validator context with a live runlog entry, without writing the log."""
    runlog = RunLog(lang)
    entry = runlog.stage("V10", tool="coursekit", tool_version="0.1.0").__enter__()
    return ValidatorContext(lang=lang, entry=entry)


def blocking(findings: list[Finding]) -> list[Finding]:
    return [finding for finding in findings if finding.severity == "blocking"]


# ---------------------------------------------------------------------------
# The join
# ---------------------------------------------------------------------------


def test_shipped_items_join_covers_corpus_and_authored_slots(make_es_build) -> None:
    make_es_build(units=3, per_unit=4, llm_every=4)
    items = shipped_items("es")
    assert len(items) == 12
    assert {item.provenance for item in items} == {"corpus", "llm"}
    # An authored slot carries the pack licence and an owner, not an empty licence:
    # a machine-authored sentence still needs a row on the credits surface.
    authored = [item for item in items if item.provenance == "llm"]
    assert authored and all(item.licence and item.attribution_owner for item in authored)


def test_the_join_refuses_to_invent_a_ledger_it_cannot_read() -> None:
    """No `selected_item` file is a failure, not an empty pack that passes everything."""
    with pytest.raises(SuiteInputMissing, match="selected_item"):
        shipped_items("es")


# ---------------------------------------------------------------------------
# V10 — resolved licence and attribution
# ---------------------------------------------------------------------------


def test_v10_passes_a_pack_whose_every_sentence_is_licensed(make_es_build) -> None:
    make_es_build()
    findings = every_sentence_carries_a_resolved_licence(context())
    assert findings == []


def test_v10_fails_a_single_unresolved_licence(make_es_build) -> None:
    """`NOASSERTION` is the exact string an OPUS legacy page produces."""
    built = make_es_build(units=2, per_unit=4, llm_every=0)
    rows = built["ingested"]
    rows[0]["licence"] = "NOASSERTION"
    write_records("ingested_sentence", rows, lang="es")
    found = blocking(every_sentence_carries_a_resolved_licence(context()))
    assert len(found) == 1
    assert "unresolved" in found[0].message


def test_v10_fails_a_licence_that_resolved_to_the_wrong_thing(make_es_build) -> None:
    """The dangerous case is not an empty field, it is a real string off the allow-list.

    CC BY-NC-ND is the licence that cut TED2020: a validator that only looked for empty
    or `UNKNOWN` would let it through, and every intermediate artefact would already
    carry the text by the time anyone noticed.
    """
    built = make_es_build(units=2, per_unit=4, llm_every=0)
    rows = built["ingested"]
    rows[1]["licence"] = "CC-BY-NC-ND-4.0"
    write_records("ingested_sentence", rows, lang="es")
    found = blocking(every_sentence_carries_a_resolved_licence(context()))
    assert any("allow-list" in finding.message for finding in found)


def test_v10_fails_an_nc_corpus_row_even_though_the_pack_itself_is_nc(make_es_build) -> None:
    """The falsifier for a MERGED allow-list, beside the ND one above.

    `AUTHORED_SENTENCE_LICENCE` is `CC-BY-NC-SA-4.0` — the pack's own licence, which
    this repository may put on text it wrote. A first version of V10 built one set,
    `{*INGEST_LICENCE_ALLOW_LIST, AUTHORED_SENTENCE_LICENCE}`, and applied it to every
    row regardless of provenance, so an ingested third-party sentence carrying
    `CC-BY-NC-SA-4.0` produced zero findings. INV-PACK-13 (docs/invariants.md) says NC
    and ND sources are excluded **at ingest, not at package time**; a merged set means
    the NC half of that sentence is enforced nowhere at all.
    """
    built = make_es_build(units=2, per_unit=4, llm_every=0)
    rows = built["ingested"]
    rows[1]["licence"] = AUTHORED_SENTENCE_LICENCE
    write_records("ingested_sentence", rows, lang="es")
    found = blocking(every_sentence_carries_a_resolved_licence(context()))
    assert [finding.subject for finding in found], "an NC corpus row must not pass V10"
    assert any("allow-list" in finding.message for finding in found)
    assert all(finding.detail.get("provenance") == "corpus" for finding in found)


def test_v10_still_accepts_the_pack_licence_on_the_text_this_repo_wrote(make_es_build) -> None:
    """The other side of the same split: the authored rows are the ONLY NC-SA rows."""
    make_es_build(units=2, per_unit=4, llm_every=2)
    assert every_sentence_carries_a_resolved_licence(context()) == []
    authored = [item for item in shipped_items("es") if item.provenance == "llm"]
    assert authored and all(item.licence == AUTHORED_SENTENCE_LICENCE for item in authored)


def test_the_allow_list_is_a_function_of_provenance_and_the_two_sets_are_disjoint() -> None:
    corpus = allowed_licences_for("corpus")
    authored = allowed_licences_for("llm")
    assert AUTHORED_SENTENCE_LICENCE not in corpus
    assert authored == {AUTHORED_SENTENCE_LICENCE}
    assert corpus == set(INGEST_LICENCE_ALLOW_LIST)
    # An unrecorded provenance gets the STRICTER set: a row nobody classified is not a
    # row this repository can claim it wrote.
    assert allowed_licences_for("") == corpus
    assert allowed_licences_for("scraped-somewhere") == corpus


def test_v10_fails_a_resolved_licence_with_no_attribution_owner(make_es_build) -> None:
    """INV-PACK-17's half: the licence is fine and S152 has nothing to render."""
    built = make_es_build(units=2, per_unit=4, llm_every=0)
    rows = built["ingested"]
    rows[0]["attribution_required"] = True
    rows[0]["attribution_owner"] = None
    write_records("ingested_sentence", rows, lang="es")
    found = blocking(every_sentence_carries_a_resolved_licence(context()))
    assert any("attribution" in finding.message for finding in found)


def test_v10_fails_an_oracle_only_sentence_that_reached_a_lesson_slot(make_es_build) -> None:
    built = make_es_build(units=2, per_unit=4, llm_every=0)
    rows = built["ingested"]
    rows[0]["licence_verdict"] = "oracle_only"
    write_records("ingested_sentence", rows, lang="es")
    found = blocking(every_sentence_carries_a_resolved_licence(context()))
    assert any("oracle_only" in finding.message for finding in found)


def test_v10_fails_on_an_empty_pack_rather_than_passing_fast(make_es_build) -> None:
    """THE falsifier. Zero sentences produce zero findings, which is what green is.

    `docs/ci.md` names the same shape for `maestro test` over an empty directory, and
    the invariant registry names it as INV-PACK-14. A suite that can be satisfied by
    deleting its input is not a gate.
    """
    make_es_build(units=1, per_unit=1)
    write_records("selected_item", [], lang="es")
    found = blocking(every_sentence_carries_a_resolved_licence(context()))
    assert len(found) == 1
    assert "had no shipped sentence to check" in found[0].message


def test_v10_fails_when_its_artefact_is_absent_rather_than_reporting_a_pass() -> None:
    found = blocking(every_sentence_carries_a_resolved_licence(context()))
    assert found and "selected_item" in found[0].message


# ---------------------------------------------------------------------------
# V11 — difficulty drift
# ---------------------------------------------------------------------------


def test_difficulty_is_the_declared_formula() -> None:
    """Recomputed by hand, so the number in a report is checkable rather than trusted."""
    from coursekit.validators.pack import ShippedItem

    item = ShippedItem(
        unit_index=1,
        lesson_index=1,
        slot_index=0,
        item_id="a" * 16,
        provenance="corpus",
        text="alfa beta gamma",
        translation="-",
        licence="CC0-1.0",
        licence_verdict="shippable",
        attribution_required=False,
        attribution_owner=None,
        token_count=3,
    )
    value, banded, total = difficulty(item, {"alfa": 2, "beta": 4})
    # 3 tokens; deciles 2, 4 and (unbanded) 10 -> mean 16/3.
    assert (banded, total) == (2, 3)
    assert value == pytest.approx(3 + 16 / 3)


def test_v11_passes_a_curriculum_that_gets_harder(make_es_build) -> None:
    make_es_build(units=4, per_unit=6)
    assert blocking(mean_difficulty_is_non_decreasing(context())) == []


def test_v11_fails_when_a_later_unit_is_easier(make_es_build) -> None:
    """Batch-level drift: every sentence is legal and the batch went backwards."""
    make_es_build(units=4, per_unit=6, difficulty_of_unit=lambda unit: 10 if unit < 3 else 1)
    found = blocking(mean_difficulty_is_non_decreasing(context()))
    assert found and "goes forwards" in found[0].message


def test_v11_fails_a_unit_too_small_to_have_a_mean(make_es_build) -> None:
    make_es_build(units=3, per_unit=MIN_ITEMS_PER_UNIT_FOR_DIFFICULTY - 1)
    found = blocking(mean_difficulty_is_non_decreasing(context()))
    assert found and "noise" in found[0].message


def test_v11_warns_rather_than_lies_when_the_banded_table_barely_matches(
    make_es_build,
) -> None:
    """Coverage is the honesty half: below the floor the number is sentence length."""
    make_es_build(units=4, per_unit=6)
    write_records("banded_lemma", [], lang="es")
    findings = mean_difficulty_is_non_decreasing(context())
    warnings = [finding for finding in findings if finding.severity == "warning"]
    assert warnings and "difficulty proxy" in warnings[0].message


def test_v11_fails_on_an_empty_pack(make_es_build) -> None:
    make_es_build(units=1, per_unit=1)
    write_records("selected_item", [], lang="es")
    assert blocking(mean_difficulty_is_non_decreasing(context()))


# ---------------------------------------------------------------------------
# V12 — direction and font coverage
# ---------------------------------------------------------------------------


def test_the_declared_font_ranges_cover_every_character_spanish_needs() -> None:
    """á é í ó ú ñ ü ¿ ¡ — and the same in upper case.

    Asserted against the ranges, not against a pack, so narrowing `SHIPPED_FONT_RANGES`
    fails here rather than at the first ¿ a learner sees.
    """
    for character in REQUIRED_CHARACTERS_BY_LANGUAGE["es"]:
        assert covered_by_shipped_font(character), character


def test_no_v1_language_is_right_to_left() -> None:
    assert RTL_LANGUAGES == ()


def test_v12_passes_a_latin_pack_that_declares_its_direction(make_es_build) -> None:
    make_es_build(rtl=False)
    assert blocking(direction_and_font_coverage(context())) == []


def test_v12_fails_a_character_outside_the_shipped_font(make_es_build) -> None:
    """A CJK glyph in a Spanish pack renders as a box on a device and as nothing here."""
    make_es_build(units=2, per_unit=4, extra_character=" 漢")
    found = blocking(direction_and_font_coverage(context()))
    assert any("U+6F22" in finding.message for finding in found)


def test_v12_fails_a_pack_that_declares_no_direction_at_all(make_es_build) -> None:
    """An absent flag is not false; it is nobody having decided."""
    make_es_build(rtl=None)
    found = blocking(direction_and_font_coverage(context()))
    assert any("nobody having decided" in finding.message for finding in found)


def test_v12_fails_a_wrong_direction_flag(make_es_build) -> None:
    make_es_build(rtl=True)
    found = blocking(direction_and_font_coverage(context()))
    assert any("requires rtl=False" in finding.message for finding in found)


def test_v12_fails_when_g9_has_not_run(make_es_build) -> None:
    make_es_build(with_pack_rows=False)
    found = blocking(direction_and_font_coverage(context()))
    assert any("G9 has not run" in finding.message for finding in found)


def test_v12_checks_exercise_strings_too_not_only_sentences(make_es_build) -> None:
    """A distractor is rendered. A validator that read only sentences would miss it."""
    built = make_es_build(units=2, per_unit=4)
    exercises = built["exercises"]
    exercises[0]["distractors"] = ["क"]  # Devanagari KA
    write_records("exercise", exercises, lang="es")
    found = blocking(direction_and_font_coverage(context()))
    assert any("U+0915" in finding.message for finding in found)


def test_v12_records_that_it_did_not_check_the_bundled_font_subset(make_es_build) -> None:
    """The other half of INV-PACK-54 lives in `apps/mobile` and lands at P3.

    Recorded in the runlog rather than left unsaid, because "V12 green" would otherwise
    be read as "the shipped .ttf carries these glyphs", which nothing here checked.
    """
    make_es_build()
    ctx = context()
    direction_and_font_coverage(ctx)
    assert ctx.entry.notes["bundled_font_subset_checked"] is False


def test_the_font_ranges_are_ordered_and_disjoint() -> None:
    """A typo that swallows the whole plane would make V12 pass on anything."""
    previous_last = -1
    for first, last in SHIPPED_FONT_RANGES:
        assert first <= last
        assert first > previous_last
        previous_last = last
    assert previous_last < 0x3000, "the declared ranges reach into CJK; V12 would pass 漢"


def test_word_tokens_drops_digits_and_underscores() -> None:
    assert word_tokens("Hola 2 mundo_uno") == ["hola", "mundo", "uno"]


def test_absent_artefacts_fail_every_pack_validator() -> None:
    """One sweep, because 'passes because it read nothing' is the shared failure mode."""
    for validator in (
        every_sentence_carries_a_resolved_licence,
        mean_difficulty_is_non_decreasing,
        direction_and_font_coverage,
    ):
        assert not artifact_path("es", "selected_item").exists()
        assert blocking(validator(context())), validator.__name__
