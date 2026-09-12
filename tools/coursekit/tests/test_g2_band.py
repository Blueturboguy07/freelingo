"""G2 Band — frequency ordering through the adapter, its share-alike duty, and ELELex.

Three things get their own tests because each one has already been got wrong once in the
research corpus:

- hermitdave ships **surface forms**. Ranking them directly is not a ledger.
- the derived ordering is **CC BY-SA 4.0** and the manifest has to say so.
- the CEFR band is a **per-lemma sanity check**, not the section label the product
  renders (R23). A test asserts G2 cannot emit one even by accident.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from test_g1_analyze import ES_MINI, run_stage, seed_g0

from coursekit.artifacts import ARTIFACTS, read_records
from coursekit.config import CEFR_LANGUAGES
from coursekit.config.g2 import (
    BAND_BY_DECILE,
    BAND_BY_DECILE_CALIBRATION,
    BAND_SOURCE_CEFRLEX_POS_RELAXED,
    DECILE_COUNT,
    ELELEX_ENTRY_COUNT,
    ELELEX_LICENCE,
    ELELEX_MIN_DOCS_FOR_LEVEL,
    ELELEX_POS_MUST_MATCH,
    FREELING_TO_UD,
    FREQUENCY_DERIVED_ORDERING_LICENCE,
    FREQUENCY_FILENAME_BY_LANGUAGE,
    FREQUENCY_IS_SURFACE_FORMS,
    FREQUENCY_MIN_ROWS,
)
from coursekit.inputs import MissingInput, group_is_installed, resolve
from coursekit.ledger import LedgerItem, assert_unique_keys
from coursekit.runlog import UpstreamStageMissing, read_entries
from coursekit.stages.g1_analyze import adapter_for, analyze
from coursekit.stages.g2_band import (
    band,
    build_rows,
    decile_for,
    first_level,
    freeling_to_ud,
    lemma_only_index,
    lemmatise_frequency,
    rank,
    read_elelex,
    read_frequency,
)

needs_nlp = pytest.mark.skipif(
    not group_is_installed("nlp"), reason="the nlp group is not installed"
)

#: An opt-in path to a real ELELex.tsv. The file is CC BY-NC-SA and is NEVER committed to
#: this repository, so the test that reads it is skipped unless an operator points at a
#: local copy: `COURSEKIT_ELELEX=/path/to/ELELex.tsv uv run pytest`.
ELELEX_ENV_VAR = "COURSEKIT_ELELEX"


def write_frequency(path: Path, rows: list[tuple[str, int]]) -> Path:
    """hermitdave's own shape: `surface<space>count`, most frequent first."""
    path.write_text(
        "".join(f"{surface} {count}\n" for surface, count in rows), encoding="utf-8"
    )
    return path


def synthetic_elelex(path: Path, rows: list[tuple[str, str, list[float]]]) -> Path:
    """A CEFRLex-shaped TSV written here, so no NC data is needed to test the parser.

    Quoted fields and the real column names, because both are things the published file
    does and a parser that only handles the tidy version fails on the real one.
    """
    levels = ("a1", "a2", "b1", "b2", "c1")
    header = ["word", "tag"]
    header += [f"level_freq@{level}" for level in levels]
    header += ["total_freq@total"]
    header += [f"nb_doc@{level}" for level in levels]
    header += ["nb_doc@total"]
    lines = ["\t".join(f'"{column}"' for column in header)]
    for lemma, tag, docs in rows:
        cells = [lemma, tag]
        cells += ["0.0"] * len(levels)
        cells += ["0.0"]
        cells += [str(value) for value in docs]
        cells += [str(sum(docs))]
        lines.append("\t".join(f'"{cell}"' for cell in cells))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# The frequency list
# ---------------------------------------------------------------------------


def test_the_frequency_list_parses_hermitdaves_two_columns(tmp_path: Path) -> None:
    path = write_frequency(tmp_path / "es_50k.txt", [("de", 14459520), ("que", 14421005)])
    rows = read_frequency(path, lang="es", require_full=False)
    assert rows == [("de", 14459520), ("que", 14421005)]


def test_a_404_html_page_is_refused_rather_than_read_as_an_empty_language(
    tmp_path: Path,
) -> None:
    """The hazard is specific and measured: `freeling_to_elelex.yaml` answers 404 with
    1,165 bytes of HTML, and `ja_50k.txt` answers 404 too. A fetcher that does not check
    the status code hands this file to the parser, and a parser that shrugs reports a
    language with no vocabulary."""
    path = tmp_path / "es_50k.txt"
    path.write_text("<!DOCTYPE html>\n<html><body>404</body></html>\n", encoding="utf-8")
    with pytest.raises(MissingInput, match="expected `surface"):
        read_frequency(path, lang="es")


def test_a_truncated_fifty_k_list_is_refused(tmp_path: Path) -> None:
    """A short list silently re-ranks the tail, which is where the A1/A2 boundary sits."""
    path = write_frequency(tmp_path / "es_50k.txt", [("de", 10), ("que", 9)])
    with pytest.raises(MissingInput, match=str(FREQUENCY_MIN_ROWS)):
        read_frequency(path, lang="es")


def test_japanese_has_no_fifty_k_list_and_that_is_a_hard_failure() -> None:
    """`ja_50k.txt` 404s. The bad outcome is a fallback to `ja_full.txt`, whose
    whitespace-tokenised 'words' are sentence fragments — V1 then passes vacuously."""
    assert "ja" not in FREQUENCY_FILENAME_BY_LANGUAGE
    assert set(FREQUENCY_FILENAME_BY_LANGUAGE) == {"es", "fr", "de"}


@needs_nlp
def test_surface_forms_are_lemmatised_before_they_touch_the_ledger() -> None:
    """The one fact in `deep/10` §S4 that changes the code: the lists are not lemmatised.

    Without this step `casa` and `casas` are two ledger items and `es`/`son`/`soy` are
    three, every count is wrong by however Spanish inflects, and V1 polices a partition
    of the vocabulary nobody designed.
    """
    assert FREQUENCY_IS_SURFACE_FORMS is True
    counts, stats = lemmatise_frequency(
        adapter_for("es"),
        [("casa", 100), ("casas", 40), ("es", 900), ("son", 300), ("soy", 120), ("!", 5)],
        context_pos={"casa": "NOUN", "ser": "AUX"},
    )
    assert counts[("casa", "NOUN")] == 140
    assert counts[("ser", "AUX")] == 1320
    assert stats["frequency_lemmatised"] == 5
    assert stats["frequency_skipped"] == 1
    assert stats["frequency_pos_from_corpus"] == 5
    assert not any(lemma == "casas" for lemma, _ in counts)


@needs_nlp
def test_a_bare_surface_form_is_a_bad_place_to_read_a_pos_from() -> None:
    """Measured, and it is why `corpus_profile` exists.

    A one-token document is the worst case for a POS tagger: `es_core_news_md` calls bare
    `casa` a PROPN (and `perro`, and `hola`), 6.1% of the top 3,000 Spanish surface forms
    on 2026-09-12. Taken at face value that splits `casa`/PROPN from `casas`/NOUN into two
    ledger rows — the exact failure lemmatising the list was supposed to prevent, one step
    later and with each half ranked at part of its real frequency.
    """
    adapter = adapter_for("es")
    assert adapter.lemmatise_surface("casa") == ("casa", "PROPN")
    assert adapter.lemmatise_surface("casas") == ("casa", "NOUN")

    # With no corpus to appeal to, consolidation still keeps the lemma whole: one row,
    # the full 140, on the tag with the most evidence behind it.
    counts, stats = lemmatise_frequency(adapter, [("casa", 100), ("casas", 40)])
    assert sum(counts.values()) == 140
    assert len(counts) == 1
    assert stats["frequency_pos_consolidated_lemmas"] == 1
    assert stats["frequency_pos_from_corpus"] == 0

    # And with the corpus, the tag is the one a sentence gave it.
    in_context, _ = lemmatise_frequency(
        adapter, [("casa", 100), ("casas", 40)], context_pos={"casa": "NOUN"}
    )
    assert in_context == {("casa", "NOUN"): 140}


def test_the_ranking_tie_break_is_deterministic() -> None:
    """`Counter` iterates in insertion order, so without a tie-break two runs over the
    same data can put a lemma on either side of a band boundary depending on which
    surface form the adapter happened to see first."""
    from collections import Counter

    first = Counter({("zorro", "NOUN"): 5, ("ave", "NOUN"): 5, ("el", "DET"): 9})
    second = Counter({("ave", "NOUN"): 5, ("el", "DET"): 9, ("zorro", "NOUN"): 5})
    assert rank(first) == rank(second)
    assert [lemma for lemma, _, _ in rank(first)] == ["el", "ave", "zorro"]


def test_the_deciles_are_the_arithmetic_the_fixture_is_derived_under() -> None:
    """`tests/fixtures/es-mini/banded.jsonl` and this stage must agree, or the fixture
    stops describing what the pipeline produces."""
    total = 348
    assert decile_for(0, total) == 1
    assert decile_for(total - 1, total) == DECILE_COUNT
    for position in range(total):
        assert decile_for(position, total) == min(
            DECILE_COUNT, (position * DECILE_COUNT) // total + 1
        )
    assert BAND_BY_DECILE[1] == "A1"
    assert BAND_BY_DECILE[4] == "A1"
    assert BAND_BY_DECILE[7] == "A2"
    assert BAND_BY_DECILE[9] == "B1"
    assert BAND_BY_DECILE[DECILE_COUNT] == "B2"

    # The fixture was derived under exactly this table, and four other P2 lanes test
    # against it. Asserted here so a change to the table is a change somebody had to make
    # on purpose, with the fixture in front of them.
    fixture = [json.loads(line) for line in (ES_MINI / "banded.jsonl").read_text().splitlines()]
    assert len(fixture) == total
    for row in fixture:
        if row["band_source"] == "frequency_decile":
            assert row["band"] == BAND_BY_DECILE[row["decile"]], row


def test_the_decile_proxy_records_its_deviation_from_the_spec() -> None:
    """scope2/00 line 110 asks for a proxy "calibrated against fr/es/de/en". This one is
    hand-picked, and the deviation is recorded rather than hidden.

    The gap is invisible in a green build by construction — the proxy is only read where
    the lexicon is absent, so nothing ever compares the two — which is why the measurement
    is a committed script and its result is a constant rather than a sentence in a commit
    message. This test is what stops the constant and the table drifting apart.
    """
    script = Path(__file__).resolve().parents[1] / "scripts" / "calibrate_band_deciles.py"
    assert script.exists(), "the calibration must be reproducible, not a remembered number"
    assert BAND_BY_DECILE_CALIBRATION["script"] == "scripts/calibrate_band_deciles.py"

    # Measured, not aspirational: a decile explains about two fifths of a CEFR band.
    assert BAND_BY_DECILE_CALIBRATION["agreement"] == pytest.approx(0.380)
    assert BAND_BY_DECILE_CALIBRATION["best_monotone_fit_agreement"] == pytest.approx(0.412)
    assert (
        BAND_BY_DECILE_CALIBRATION["best_monotone_fit_agreement"]
        > BAND_BY_DECILE_CALIBRATION["agreement"]
    ), "keeping the shipped table is only a decision if the fit is actually better"

    # The spec names four calibration languages; one of them is what we have.
    assert BAND_BY_DECILE_CALIBRATION["calibrated_against"] == ("es",)
    # ...and these two ship on it anyway, which is the founder-visible half.
    assert BAND_BY_DECILE_CALIBRATION["applied_to"] == ("de", "ja")
    assert set(BAND_BY_DECILE_CALIBRATION["applied_to"]) & set(CEFR_LANGUAGES) == set()
    assert "calibrated against fr/es/de/en" in BAND_BY_DECILE_CALIBRATION["deviation_from_spec"]

    # The fit is monotone, or it would be at odds with V11 over a ledger-ordered course.
    fit = BAND_BY_DECILE_CALIBRATION["best_monotone_fit"]
    order = ["A1", "A2", "B1", "B2", "C1"]
    ranks = [order.index(fit[decile]) for decile in sorted(fit)]
    assert ranks == sorted(ranks)
    assert [order.index(BAND_BY_DECILE[d]) for d in sorted(BAND_BY_DECILE)] == sorted(
        order.index(BAND_BY_DECILE[d]) for d in sorted(BAND_BY_DECILE)
    )
    assert fit != BAND_BY_DECILE, "a recorded deviation with no deviation is a stale record"


def test_the_frequency_filename_and_the_source_url_cannot_drift() -> None:
    """The hermitdave filename is knowledge in two places. Tie them together.

    `config/g2.FREQUENCY_FILENAME_BY_LANGUAGE` names the file G2 reads and
    `config/base.SOURCES["hermitdave"].url` is the one the error message tells an operator
    to curl. Nothing made them agree, so a language could be told to fetch one file and
    read another — and the failure surfaces as "the frequency list is not at <path>" with
    a curl line that just wrote it.
    """
    for lang, filename in FREQUENCY_FILENAME_BY_LANGUAGE.items():
        assert resolve("hermitdave", lang).url.endswith(f"/{filename}"), lang
    # And the language deep/10 says has no 50k list must have no entry here either.
    assert "ja" not in FREQUENCY_FILENAME_BY_LANGUAGE


# ---------------------------------------------------------------------------
# ELELex — the licence, the mapping, and R23
# ---------------------------------------------------------------------------


def test_the_licence_reasoning_lives_next_to_the_constant() -> None:
    """The task this file was written for asks for the reasoning IN `config/g2.py`, so
    nobody later copies the dependency into AGPL code. Asserted rather than trusted,
    because a comment is the first thing a refactor drops."""
    source = (
        Path(__file__).resolve().parents[1] / "src" / "coursekit" / "config" / "g2.py"
    ).read_text(encoding="utf-8")
    for phrase in (
        "CC BY-NC-SA 4.0",
        "AGPL-3.0",
        "ONLY BECAUSE",
        "FORBIDDEN in code",
        "never vendored into this repository",
    ):
        assert phrase in source, phrase
    assert ELELEX_LICENCE == "CC-BY-NC-SA-4.0"
    assert CEFR_LANGUAGES == ("es", "fr")


def test_the_freeling_mapping_is_ours_because_the_published_one_is_not_there() -> None:
    """`deep/10` names `freeling_to_elelex.yaml` beside the TSV; that path 404s (verified
    2026-09-12, four spellings). Same class as R3 and R11 — a filename read once and
    never fetched. So the table is written against the EAGLES tagset and the tags the
    published file actually contains."""
    assert freeling_to_ud("NCM") == "NOUN"
    assert freeling_to_ud("NCF") == "NOUN"
    assert freeling_to_ud("NP0") == "PROPN"
    assert freeling_to_ud("AQ0") == "ADJ"
    assert freeling_to_ud("VM") == "VERB"
    assert freeling_to_ud("VA") == "AUX"
    assert freeling_to_ud("VS") == "AUX"
    assert freeling_to_ud("SP") == "ADP"
    assert freeling_to_ud("RG") == "ADV"
    assert freeling_to_ud("CC") == "CCONJ"
    assert freeling_to_ud("CS") == "SCONJ"
    assert freeling_to_ud("I") == "INTJ"
    assert freeling_to_ud("PP0") == "PRON"
    assert freeling_to_ud("DI") == "DET"
    # Longest prefix wins, or `Zu` would be read as `Z`.
    assert freeling_to_ud("Zu") == "NOUN"
    assert freeling_to_ud("Z") == "NUM"
    assert set(FREELING_TO_UD.values()) <= {
        "NOUN",
        "PROPN",
        "ADJ",
        "VERB",
        "AUX",
        "ADV",
        "ADP",
        "DET",
        "PRON",
        "CCONJ",
        "SCONJ",
        "INTJ",
        "NUM",
        "PUNCT",
    }


def test_a_multiword_tag_is_unmappable_rather_than_guessed() -> None:
    """The published file carries rows tagged "NCM, NP0", "VM VM" and
    "VM, PP0, CS, VM, PP0". A guess there bands a lemma against the wrong part of speech,
    which is worse than leaving it on its decile."""
    assert freeling_to_ud("NCM, NP0") is None
    assert freeling_to_ud("VM VM") is None
    assert freeling_to_ud("") is None
    assert freeling_to_ud("QQ") is None


def test_the_lexicon_bands_by_level_of_first_appearance(tmp_path: Path) -> None:
    path = synthetic_elelex(
        tmp_path / "ELELex.tsv",
        [
            ("casa", "NCF", [88.0, 179.0, 212.0, 96.0, 55.0]),
            ("efímero", "AQ0", [0.0, 0.0, 0.0, 1.0, 0.0]),
            ("paradigma", "NCM", [0.0, 0.0, 0.0, 0.0, 2.0]),
            ("inaudito", "AQ0", [0.0, 0.0, 0.0, 0.0, 0.0]),
            ("caminar", "VM VM", [9.0, 0.0, 0.0, 0.0, 0.0]),
        ],
    )
    lexicon, stats = read_elelex(path)
    assert lexicon[("casa", "NOUN")] == "A1"
    assert lexicon[("efímero", "ADJ")] == "B2"
    assert lexicon[("paradigma", "NOUN")] == "C1"
    # Attested nowhere: no band at all rather than a default.
    assert ("inaudito", "ADJ") not in lexicon
    # Unmappable tag: counted, not guessed.
    assert ("caminar", "VERB") not in lexicon
    assert stats["cefr_lexicon_unmappable_tags"] == {"VM VM": 1}
    assert stats["cefr_lexicon_entries"] == 5
    assert stats["cefr_lexicon_entry_count_matches"] is False


def test_the_lowest_level_wins_when_two_tags_map_to_one_ud_tag(tmp_path: Path) -> None:
    """`AQ0` and `AQS` are both ADJ. Teaching the earlier of two levels is the
    conservative direction: it never asserts a lemma is harder than it is."""
    path = synthetic_elelex(
        tmp_path / "ELELex.tsv",
        [
            ("grande", "AQS", [0.0, 0.0, 4.0, 0.0, 0.0]),
            ("grande", "AQ0", [7.0, 0.0, 0.0, 0.0, 0.0]),
        ],
    )
    lexicon, _ = read_elelex(path)
    assert lexicon[("grande", "ADJ")] == "A1"


def test_the_document_threshold_is_the_one_that_partitions_the_lexicon() -> None:
    """At 3 documents two thirds of the real file falls out and silently reverts to the
    decile proxy while the pack still claims CEFR-checked. 1 is the standard CEFRLex
    reading and the only value that bands every entry."""
    assert ELELEX_MIN_DOCS_FOR_LEVEL == 1
    assert first_level({f"nb_doc@{level}": "0.0" for level in ("a1", "a2", "b1", "b2", "c1")}) is (
        None
    )
    assert first_level(
        {
            "nb_doc@a1": "0.0",
            "nb_doc@a2": "1.0",
            "nb_doc@b1": "9.0",
            "nb_doc@b2": "0.0",
            "nb_doc@c1": "0.0",
        }
    ) == "A2"


def test_R23_a_banded_lemma_cannot_carry_a_section_cefr_label() -> None:
    """The measured product attaches CEFR to SECTIONS (Spanish ships 8: 1-3 A1, 4 A2,
    5-6 B1, 7-8 B2). That is a G3 curriculum output about which grammar concepts sit
    where; a per-lemma lexicon cannot produce it and a frequency decile cannot either.

    The artefact contract already separates them; this asserts G2 keeps to its side.
    """
    banded = ARTIFACTS["banded_lemma"].schema["properties"]
    units = ARTIFACTS["unit_assignment"].schema["properties"]
    assert "section_cefr" in units
    assert "section_cefr" not in banded
    assert "section_index" not in banded

    rows, _ = build_rows("es", [("casa", "NOUN", 100), ("gato", "NOUN", 10)], {})
    for row in rows:
        assert "section_cefr" not in row
        assert row["band"] in BAND_BY_DECILE.values()


def test_a_cefrlex_band_carries_its_licence_and_a_decile_band_does_not() -> None:
    """G9 needs the NC attribution for exactly the rows that came from ELELex, and must
    not put one in the manifest of a pack that contains nothing derived from it."""
    ordered = [("casa", "NOUN", 100), ("gato", "NOUN", 10)]
    rows, _ = build_rows("es", ordered, {("casa", "NOUN"): "A1"})
    by_lemma = {row["lemma"]: row for row in rows}

    assert by_lemma["casa"]["band_source"] == "cefrlex"
    assert by_lemma["casa"]["band_source_licence"] == ELELEX_LICENCE
    assert by_lemma["gato"]["band_source"] == "frequency_decile"
    assert by_lemma["gato"]["band_source_licence"] is None


def test_a_pos_mismatch_refuses_the_band_and_is_counted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`ELELEX_POS_MUST_MATCH` is True: lemma in the lexicon, wrong POS, no CEFR band.

    This is where spaCy and FreeLing actually differ — `ser` is AUX to one and VS to the
    other — so it is not a rare path, and a disagreement is indistinguishable from "the
    lexicon never carried this lemma" unless somebody counts it.
    """
    assert ELELEX_POS_MUST_MATCH is True
    ordered = [("ser", "AUX", 100), ("casa", "NOUN", 10)]
    lexicon = {("ser", "VERB"): "A1", ("casa", "NOUN"): "A1"}

    rows, stats = build_rows("es", ordered, lexicon)
    by_lemma = {row["lemma"]: row for row in rows}

    assert by_lemma["ser"]["band_source"] == "frequency_decile"
    assert by_lemma["ser"]["band"] == BAND_BY_DECILE[by_lemma["ser"]["decile"]]
    assert by_lemma["ser"]["band_source_licence"] is None
    assert by_lemma["casa"]["band_source"] == "cefrlex"

    assert stats["cefr_pos_disagreements"] == 1
    assert stats["cefr_pos_relaxed"] == 0


def test_relaxing_the_pos_match_bands_the_lemma_under_a_weaker_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`ELELEX_POS_MUST_MATCH = False` relaxes the POS match. It used to do the opposite.

    The lexicon is keyed by `(lemma, POS)`, so the original
    `lexicon.get(key) if ELELEX_POS_MUST_MATCH else None` switched the whole lexicon OFF:
    every es/fr pack silently fell back to the decile proxy while `band_source` truthfully
    read `frequency_decile` and the course card still read "A1 - CEFR-checked". The flag's
    other branch is pinned here because a branch nobody has executed is a branch that does
    not work.

    Patched on `build_rows.__globals__` rather than by dotted module path, and that is not
    style. `Registry.restore_for_tests()` restores registration by EVICTING its modules
    from `sys.modules`, so the next discovery builds a *fresh* `coursekit.stages.g2_band`
    object while this file's `build_rows` — bound at import time — keeps the old one. A
    dotted-path patch then sets the flag on a module nobody calls, the function reads the
    real `True`, and the test fails with `frequency_decile` for a reason that has nothing
    to do with banding. It passed alone and failed after `tests/test_cli.py` had run,
    which is how it reached integration. A function's own globals are the thing it
    actually reads, whatever `sys.modules` has been through.
    """
    monkeypatch.setitem(build_rows.__globals__, "ELELEX_POS_MUST_MATCH", False)
    ordered = [("ser", "AUX", 100), ("casa", "NOUN", 10), ("xyzzy", "NOUN", 1)]
    lexicon = {("ser", "VERB"): "A1", ("casa", "NOUN"): "A2"}

    rows, stats = build_rows("es", ordered, lexicon)
    by_lemma = {row["lemma"]: row for row in rows}

    # Relaxed: banded from ELELex, under a source name that says the match was weaker,
    # and still carrying the NC licence because the band still came from ELELex.
    assert by_lemma["ser"]["band"] == "A1"
    assert by_lemma["ser"]["band_source"] == BAND_SOURCE_CEFRLEX_POS_RELAXED
    assert by_lemma["ser"]["band_source"] != "cefrlex"
    assert by_lemma["ser"]["band_source_licence"] == ELELEX_LICENCE

    # An exact match is untouched, and a lemma the lexicon has never heard of is not
    # dragged in by the relaxation.
    assert by_lemma["casa"]["band_source"] == "cefrlex"
    assert by_lemma["xyzzy"]["band_source"] == "frequency_decile"

    assert stats["cefr_pos_disagreements"] == 1
    assert stats["cefr_pos_relaxed"] == 1

    # The falsifier for the old semantics: with the flag off, the lexicon must still band.
    assert any(row["band_source"] != "frequency_decile" for row in rows), (
        "turning the POS match off must not turn ELELex banding off"
    )


def test_the_lemma_only_index_takes_the_lowest_level() -> None:
    """Same conservative direction as the tag collapse in `read_elelex`: teaching a lemma
    earlier than the lexicon's hardest reading of it never asserts a word is harder than
    it is."""
    folded = lemma_only_index({("bajo", "ADP"): "B1", ("bajo", "ADJ"): "A2"})
    assert folded == {"bajo": "A2"}


# ---------------------------------------------------------------------------
# The stage
# ---------------------------------------------------------------------------


def test_g2_refuses_to_run_before_g1() -> None:
    with pytest.raises(UpstreamStageMissing, match="g1"):
        run_stage(band, "g2")


@needs_nlp
def test_g2_needs_a_local_frequency_list_and_never_fetches_one() -> None:
    """A stage that downloads on demand makes every run depend on whatever `master` says
    today — the same moving-input hazard the spaCy wheel-URL pin exists for."""
    seed_g0(limit=3)
    run_stage(analyze, "g1")
    with pytest.raises(MissingInput, match="curl"):
        run_stage(band, "g2")


@needs_nlp
def test_g2_ranks_the_fixture_and_declares_the_derived_orderings_licence() -> None:
    """The share-alike duty, end to end.

    hermitdave is "MIT License for code. CC-by-sa-4.0 for content", so an ordering
    derived from the content is a derivative of it. The pack is CC BY-NC-SA, which is
    compatible — but a pack that ships the ordering without declaring it redistributes
    an SA derivative without passing the licence on.
    """
    seed_g0()
    run_stage(analyze, "g1")
    result, entry = run_stage(
        band, "g2", frequency=str(ES_MINI / "frequency.tsv")
    )
    assert result.ok, result.message

    assert entry.notes["derived_ordering_licence"] == FREQUENCY_DERIVED_ORDERING_LICENCE
    assert entry.notes["derived_ordering_licence"] == "CC-BY-SA-4.0"
    assert entry.notes["derived_ordering_share_alike"] is True
    assert "hermitdave" in entry.notes["derived_ordering_attribution"]
    assert entry.notes["section_cefr_is_a_g3_output"] is True
    assert entry.notes["ledger_unit"] == "lemma"
    # The POS compromise, recorded rather than assumed away: how many tags came from a
    # sentence and how many from a bare surface form.
    assert entry.notes["frequency_pos_from_corpus"] > 0
    assert "frequency_pos_context_free" in entry.notes
    assert "frequency_pos_consolidated_lemmas" in entry.notes

    logged = read_entries("es", stage="g2")[0]
    assert logged["inputs"] == ["hermitdave"]
    assert logged["licences"][0]["licence"] == "CC-BY-SA-4.0"
    assert logged["licences"][0]["attribution_required"] is True


@needs_nlp
def test_g2_writes_ranked_banded_rows_that_are_monotone_in_frequency() -> None:
    seed_g0()
    run_stage(analyze, "g1")
    run_stage(band, "g2", frequency=str(ES_MINI / "frequency.tsv"))

    rows = list(read_records("banded_lemma", lang="es"))
    assert rows
    assert [row["rank"] for row in rows] == list(range(1, len(rows) + 1))
    frequencies = [row["frequency"] for row in rows]
    assert frequencies == sorted(frequencies, reverse=True)
    # Every row bands by decile: no ELELex copy sits beside the run, and a pack must
    # never claim CEFR-checked over a run where the lexicon was simply absent.
    assert {row["band_source"] for row in rows} == {"frequency_decile"}
    assert all(row["band_source_licence"] is None for row in rows)


@needs_nlp
def test_g2_bands_against_elelex_when_a_copy_is_beside_the_run(tmp_path: Path) -> None:
    # The whole fixture, not a slice: `casa` has to appear in a sentence for G1 to give
    # it a NOUN tag in context, and the lexicon is keyed on (lemma, POS). A slice that
    # never mentions the word leaves it on the context-free PROPN reading and the lookup
    # misses — which is the failure this pairing is here to prove does not happen.
    seed_g0()
    run_stage(analyze, "g1")
    lexicon = synthetic_elelex(
        tmp_path / "ELELex.tsv",
        [
            ("casa", "NCF", [88.0, 0.0, 0.0, 0.0, 0.0]),
            ("hermana", "NCF", [0.0, 4.0, 0.0, 0.0, 0.0]),
        ],
    )
    _, entry = run_stage(
        band,
        "g2",
        frequency=str(ES_MINI / "frequency.tsv"),
        elelex=str(lexicon),
    )
    rows = {row["lemma"]: row for row in read_records("banded_lemma", lang="es")}
    assert rows["casa"]["band"] == "A1"
    assert rows["casa"]["band_source"] == "cefrlex"
    assert rows["casa"]["band_source_licence"] == ELELEX_LICENCE
    assert rows["hermana"]["band"] == "A2"

    assert entry.notes["cefr_lexicon"] == "elelex"
    assert entry.notes["cefr_lexicon_licence"] == ELELEX_LICENCE
    logged = read_entries("es", stage="g2")[0]
    assert "cefrlex" in logged["inputs"]
    assert any(row["source_id"] == "cefrlex" for row in logged["licences"])


@needs_nlp
def test_INV_PACK_51_the_ranked_ledger_has_no_two_items_on_one_key() -> None:
    """[INV-PACK-51] no two distinct ledger items share `(normalized_form, reading_form, POS)`.

    Checked on the stage's own output rather than only on the falsifier, because a G2
    that produced a collision would ship one: the row that lost would simply not be
    written, and a Words row would be missing with nothing to point at.
    """
    seed_g0()
    run_stage(analyze, "g1")
    run_stage(band, "g2", frequency=str(ES_MINI / "frequency.tsv"))

    rows = list(read_records("banded_lemma", lang="es"))
    assert_unique_keys(
        LedgerItem(lang="es", lemma=row["lemma"], pos=row["pos"], sense=row["lemma"])
        for row in rows
    )
    keys = {(row["lemma"], row["pos"]) for row in rows}
    assert len(keys) == len(rows)


@pytest.mark.skipif(
    not os.environ.get(ELELEX_ENV_VAR), reason=f"set {ELELEX_ENV_VAR} to a local ELELex.tsv"
)
def test_the_real_elelex_parses_to_the_published_entry_count() -> None:
    """Opt-in, because ELELex is CC BY-NC-SA and is never committed here.

    Run as `COURSEKIT_ELELEX=/path/to/ELELex.tsv uv run pytest -k real_elelex`. Measured
    2026-09-12 against the published file: 14,290 entries, every one of which lands on a
    band at a one-document threshold.
    """
    lexicon, stats = read_elelex(Path(os.environ[ELELEX_ENV_VAR]))
    assert stats["cefr_lexicon_entries"] == ELELEX_ENTRY_COUNT
    assert stats["cefr_lexicon_entry_count_matches"] is True
    assert len(lexicon) > 12_000
    assert set(lexicon.values()) == {"A1", "A2", "B1", "B2", "C1"}
