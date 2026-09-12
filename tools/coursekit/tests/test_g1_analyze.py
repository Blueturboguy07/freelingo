"""G1 Analyze — the adapter, its frozen self-test, and the stage around them.

The tests that matter here are the ones about the self-test corpus. Everything else in
this file checks that a stage does what a stage does; `test_the_selftest_catches_a_moved
_lemma` checks the thing the stage exists to prevent, which is a lemmatiser changing
under a ledger that was already partitioned by it.

The model-loading tests are skipped without the `nlp` group and run in CI, which syncs it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from coursekit import __version__
from coursekit.adapters import ADAPTERS
from coursekit.adapters.spacy_es import parse_fingerprint
from coursekit.artifacts import read_records, write_records
from coursekit.config import TOOL_NAME
from coursekit.config.g1 import (
    ADAPTER_BY_LANGUAGE,
    ADAPTER_SELFTEST,
    ADAPTER_SELFTEST_ES,
    ADAPTER_SELFTEST_ES_DIGEST,
    CONTENT_POS,
    NON_LEXICAL_POS,
    SPACY_MODEL_BY_LANGUAGE,
    SPACY_MODEL_VERSION,
)
from coursekit.inputs import MissingInput, group_is_installed, resolve
from coursekit.ledger import content_units, count_units, units
from coursekit.runlog import RunLog, UpstreamStageMissing, read_entries
from coursekit.stages import StageContext
from coursekit.stages.g1_analyze import adapter_for, analyze

ES_MINI = Path(__file__).parent / "fixtures" / "es-mini"

needs_nlp = pytest.mark.skipif(
    not group_is_installed("nlp"), reason="the nlp group is not installed"
)


def seed_g0(lang: str = "es", *, limit: int | None = None) -> list[dict]:
    """Put the es-mini fixture where G0 would have left it, and log that G0 ran."""
    records = list(read_records("ingested_sentence", path=ES_MINI / "sentences.jsonl"))
    if limit is not None:
        records = records[:limit]
    write_records("ingested_sentence", records, lang=lang)
    runlog = RunLog(lang)
    with runlog.stage("g0", tool=TOOL_NAME, tool_version=__version__) as entry:
        entry.record_output("ingested_sentence")
        entry.written = len(records)
    return records


def run_stage(stage, stage_id: str, lang: str = "es", **options: str):  # noqa: ANN001, ANN201
    """Invoke one stage the way `_run.run_stages` does, and return `(result, entry)`."""
    runlog = RunLog(lang)
    with runlog.stage(stage_id, tool=TOOL_NAME, tool_version=__version__) as entry:
        result = stage(StageContext(lang=lang, runlog=runlog, entry=entry, options=options))
        if not result.ok:
            entry.status = "failed"
    return result, entry


# ---------------------------------------------------------------------------
# Registration and wiring
# ---------------------------------------------------------------------------


def test_the_spanish_adapter_is_registered_by_language() -> None:
    assert "es" in ADAPTERS.ids()
    adapter = adapter_for("es")
    assert adapter.lang == "es"
    assert adapter.name == ADAPTER_BY_LANGUAGE["es"] == "spacy_es"
    assert adapter.model == SPACY_MODEL_BY_LANGUAGE["es"]
    assert adapter.model_version == SPACY_MODEL_VERSION


def test_the_adapter_name_is_also_its_source_id_so_the_licence_row_cannot_drift() -> None:
    """A stage recording a licence for one analyser while running another is invisible."""
    source = resolve(ADAPTER_BY_LANGUAGE["es"], "es")
    assert source.id == "spacy_es"
    assert source.source.kind == "morphology"
    assert source.url is not None and source.url.endswith(
        f"es_core_news_md-{SPACY_MODEL_VERSION}-py3-none-any.whl"
    )


def test_a_language_with_no_adapter_is_a_named_failure_not_a_fallback() -> None:
    """`scope2/00` §2.1 puts the morphology adapter in the 'None. Hard gate' column."""
    with pytest.raises(MissingInput, match="no morphology adapter"):
        adapter_for("de")


# ---------------------------------------------------------------------------
# The self-test corpus — the reason this stage has a gate at all
# ---------------------------------------------------------------------------


def test_the_frozen_corpus_and_its_digest_describe_each_other() -> None:
    from coursekit.adapters.spacy_es import selftest_digest

    assert selftest_digest("es") == ADAPTER_SELFTEST_ES_DIGEST
    assert ADAPTER_SELFTEST["es"] is ADAPTER_SELFTEST_ES
    assert len(ADAPTER_SELFTEST_ES) == 12


def test_the_frozen_corpus_sits_on_the_lemmatisers_seams() -> None:
    """A corpus of easy words would pass under any lemmatiser and prove nothing.

    Each of these is a place two Spanish lemmatisers routinely differ: the contractions,
    the clitic, the gender/number agreements, ser/estar, existential `hay`.
    """
    frozen = " ".join(expected for _, expected in ADAPTER_SELFTEST_ES)
    for probe in ("al/", "del/", "se/", "hay/", "blanca/blanco", "rojas/rojo", "es/ser"):
        assert probe in frozen, probe


def test_the_frozen_corpus_records_what_the_model_does_not_what_is_correct() -> None:
    """Four of the answers are wrong Spanish and are frozen anyway.

    The table is the lemmatiser's identity, not a grammar. A later 'fix' that quietly
    improves one of these moves lemmas between units in packs that are already built —
    the same V1 failure as a model bump, arriving as a well-meant patch.
    """
    frozen = " ".join(expected for _, expected in ADAPTER_SELFTEST_ES)
    for defect in ("Nosotros/yo/", "muy/mucho/", "desayuna/desayuna/", "trabajé/trabajé/"):
        assert defect in frozen, defect


@needs_nlp
def test_the_pinned_lemmatiser_still_reproduces_the_frozen_corpus() -> None:
    assert adapter_for("es").self_test() == []


@needs_nlp
def test_the_selftest_catches_a_moved_lemma_and_names_it(monkeypatch: pytest.MonkeyPatch) -> None:
    """The falsifier for the gate. A silent lemmatiser swap retro-introduces lemmas
    before their unit and makes V1 pass vacuously, and this is the only thing in the
    pipeline positioned to notice — every test downstream of G2 re-derives the ledger
    with the new lemmatiser and agrees with itself.

    Moving the frozen table stands in for moving the model: the comparison is symmetric,
    and monkeypatching a table is a great deal cheaper than installing a second wheel.
    """
    from coursekit.adapters import spacy_es

    moved = tuple(
        (sentence, expected.replace("casa/casa/NOUN", "casa/casar/VERB"))
        for sentence, expected in ADAPTER_SELFTEST_ES
    )
    monkeypatch.setitem(spacy_es.ADAPTER_SELFTEST, "es", moved)

    failures = adapter_for("es").self_test()
    assert len(failures) == 1
    assert "casa/casar/VERB -> casa/casa/NOUN" in failures[0]

    with pytest.raises(spacy_es.AdapterSelfTestFailed, match="REBUILD EVERY PACK"):
        adapter_for("es").require_self_test()


@needs_nlp
def test_the_selftest_reports_a_changed_segmentation_as_such(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`al` splitting into `a` + `el` is the classic Spanish tokeniser change, and it
    changes the token COUNT — a per-token diff would print twelve confusing lines."""
    from coursekit.adapters import spacy_es

    sentence, expected = ADAPTER_SELFTEST_ES[4]
    split_al = expected.replace("al/al/ADP", "a/a/ADP el/el/DET")
    monkeypatch.setitem(spacy_es.ADAPTER_SELFTEST, "es", ((sentence, split_al),))
    failures = adapter_for("es").self_test()
    assert len(failures) == 1
    assert "segmentation changed" in failures[0]


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------


@needs_nlp
def test_every_token_carries_a_ud_tag_a_lemma_a_morph_bundle_and_its_offsets() -> None:
    """`scope2/00` §2.3 G1: 'segment -> lemmatize -> morph-feature bundle per token'."""
    record = adapter_for("es").analyse(
        sentence_id="0" * 16, text="Las flores rojas son bonitas."
    )
    assert record["lang"] == "es"
    assert record["adapter"]["model"] == f"es_core_news_md-{SPACY_MODEL_VERSION}"
    assert record["adapter"]["split_mode"] is None

    surfaces = [token["surface"] for token in record["tokens"]]
    assert surfaces == ["Las", "flores", "rojas", "son", "bonitas", "."]
    assert [token["pos"] for token in record["tokens"]] == [
        "DET",
        "NOUN",
        "ADJ",
        "AUX",
        "ADJ",
        "PUNCT",
    ]
    assert record["lemmas"] == ["el", "flor", "rojo", "ser", "bonito"]
    assert record["display_tokens"] == ["Las", "flores", "rojas", "son", "bonitas"]

    text = "Las flores rojas son bonitas."
    for token in record["tokens"]:
        assert text[token["start"] : token["end"]] == token["surface"]

    flores = record["tokens"][1]
    assert "Number=Plur" in flores["morph"]
    assert "Gender=Fem" in flores["morph"]


@needs_nlp
def test_punctuation_rides_in_tokens_and_is_never_a_ledger_unit() -> None:
    record = adapter_for("es").analyse(sentence_id="1" * 16, text="¿Cuántos años tienes?")
    assert any(token["pos"] in NON_LEXICAL_POS for token in record["tokens"])
    assert units(record) == ("cuántos", "año", "tener")
    assert content_units(record) == ("año", "tener")
    assert all(pos in CONTENT_POS for pos in ("NOUN", "VERB"))


@needs_nlp
def test_a_sentence_with_no_lexical_token_is_refused_rather_than_written() -> None:
    """A row with no ledger unit cannot be taught and would pass every downstream check."""
    with pytest.raises(MissingInput, match="no lexical token"):
        adapter_for("es").analyse(sentence_id="2" * 16, text="... ¿?")


@needs_nlp
def test_lemmatise_surface_is_what_a_frequency_list_needs() -> None:
    adapter = adapter_for("es")
    assert adapter.lemmatise_surface("casas") == ("casa", "NOUN")
    assert adapter.lemmatise_surface("somos") == ("ser", "AUX")
    # Not a word: never a ledger row.
    assert adapter.lemmatise_surface("...") is None
    # Two words: a frequency row that is really two cannot be attributed to one lemma.
    assert adapter.lemmatise_surface("por favor") is None


@needs_nlp
def test_the_batched_and_single_surface_paths_give_the_same_answer() -> None:
    """`lemmatise_surfaces` exists for throughput — 50,000 rows is minutes of call
    overhead one at a time — so the one thing it must never do is answer differently.

    Both go through the same `_single_token`, which is what makes the agreement
    structural rather than a coincidence; this is the test that would notice if somebody
    optimised one of them apart from the other.
    """
    adapter = adapter_for("es")
    surfaces = ["casa", "casas", "es", "somos", "...", "por favor", "mañana", "rápido"]
    assert adapter.lemmatise_surfaces(surfaces) == [
        adapter.lemmatise_surface(surface) for surface in surfaces
    ]


@needs_nlp
def test_surface_forms_of_one_lemma_agree_which_is_the_whole_point_of_g1() -> None:
    """`casa`/`casas` are one ledger item and `es`/`son`/`soy` are one.

    If they were not, every frequency count would be wrong by however Spanish inflects,
    and V1 would police a partition of the vocabulary nobody designed.
    """
    adapter = adapter_for("es")
    assert {adapter.lemmatise_surface(form)[0] for form in ("casa", "casas")} == {"casa"}
    assert {adapter.lemmatise_surface(form)[0] for form in ("es", "son", "soy")} == {"ser"}


# ---------------------------------------------------------------------------
# The stage
# ---------------------------------------------------------------------------


def test_g1_refuses_to_run_before_g0() -> None:
    with pytest.raises(UpstreamStageMissing, match="g0"):
        run_stage(analyze, "g1")


@needs_nlp
def test_g1_analyses_the_whole_fixture_and_records_the_ledger_declaration() -> None:
    seeded = seed_g0()
    result, entry = run_stage(analyze, "g1")
    assert result.ok, result.message

    analysed = list(read_records("analysed_sentence", lang="es"))
    assert len(analysed) == len(seeded) == 200
    assert {record["sentence_id"] for record in analysed} == {
        record["sentence_id"] for record in seeded
    }

    declaration = entry.notes["ledger"]
    assert declaration["ledger_unit"] == "lemma"
    assert declaration["length_window_units"] == [3, 12]
    assert declaration["new_items_per_lesson"] == 7
    assert declaration["mean_content_words_per_sentence"] > 0
    assert entry.notes["adapter_selftest"] == "ok"
    assert entry.notes["adapter"]["model"] == f"es_core_news_md-{SPACY_MODEL_VERSION}"


@needs_nlp
def test_g1_reports_mean_content_words_per_sentence_for_the_pack() -> None:
    """INV-PACK-40's reporting half, measured rather than asserted at a value.

    The number itself is a property of the corpus and will move when the corpus does;
    what must hold is that it is measured over CONTENT words, so it is strictly below
    the mean token count. A mean over every token would report much the same figure for a
    lesson that teaches three things and one that teaches seven.
    """
    seed_g0()
    _, entry = run_stage(analyze, "g1")
    analysed = list(read_records("analysed_sentence", lang="es"))

    mean_content = entry.notes["mean_content_words_per_sentence"]
    mean_tokens = sum(count_units(record) for record in analysed) / len(analysed)
    assert 0 < mean_content < mean_tokens


@needs_nlp
def test_g1_records_the_adapter_licence_and_writes_a_runlog_entry() -> None:
    seed_g0(limit=5)
    run_stage(analyze, "g1")
    entries = read_entries("es", stage="g1")
    assert len(entries) == 1
    entry = entries[0]
    assert entry["status"] == "ok"
    assert entry["inputs"] == ["spacy_es"]
    assert entry["outputs"] == ["analysed_sentence"]
    assert entry["counts"]["read"] == 5
    assert entry["counts"]["written"] == 5
    assert entry["licences"][0]["source_id"] == "spacy_es"


@needs_nlp
def test_g1_fails_when_g0_filtered_with_a_different_notion_of_a_token() -> None:
    """[INV-PACK-40] the numeric half of the grep gate, on real data.

    A G0 that counted its own tokens lets through sentences the ledger measures outside
    the pack's window. The grep gate catches the code; this catches the corpus, which is
    what a lane that vendors a pre-built G0 output would hit.
    """
    long_sentence = dict(
        next(iter(read_records("ingested_sentence", path=ES_MINI / "sentences.jsonl")))
    )
    long_sentence["text"] = (
        "El niño pequeño come pan con aceite y bebe agua fría en la casa blanca de "
        "mi abuela por la mañana."
    )
    long_sentence["translation"] = "irrelevant"
    write_records("ingested_sentence", [long_sentence], lang="es")
    runlog = RunLog("es")
    with runlog.stage("g0", tool=TOOL_NAME, tool_version=__version__) as entry:
        entry.record_output("ingested_sentence")

    result, _ = run_stage(analyze, "g1")
    assert not result.ok
    assert "length window" in result.message
    assert "INV-PACK-40" in result.message


def test_the_fixture_lemma_map_agrees_with_the_frozen_corpus_on_every_lemma() -> None:
    """The two frozen artefacts in this repository must describe one lemmatiser.

    `tests/fixtures/es-mini/lemma-map.tsv` and `config/g1.ADAPTER_SELFTEST_ES` were
    produced by the same wheel; if a bump ever updated one and not the other, the fixture
    would keep re-deriving a ledger the adapter no longer produces. Runs with no model
    loaded, so it fails on a contributor's machine too.

    **Lemmas only, and the POS pinned separately.** The two artefacts disagree on the tag
    for exactly two surfaces, and both disagreements are correct: `mañana` is ADV in the
    fixture map (first sighted in "hasta mañana") and NOUN in the frozen corpus ("por la
    mañana"), and `poco` is PRON in one context and ADV in the other. A UD tag is a
    property of a token in a sentence, not of a surface form. That is not drift — it is
    the same fact that makes `corpus_profile` exist in G2, where a POS read off a bare
    surface form is the fallback and the corpus's in-context tag wins. The LEMMA is the
    ledger key, so that is asserted for every overlapping token; the two tag
    disagreements are pinned by name, so a THIRD one is a failure.
    """
    lemma_map = {}
    for line in (ES_MINI / "lemma-map.tsv").read_text(encoding="utf-8").splitlines():
        surface, lemma, pos = line.split("\t")
        lemma_map[surface] = (lemma, pos)

    checked = 0
    tag_disagreements = []
    for _, expected in ADAPTER_SELFTEST_ES:
        for surface, lemma, pos in parse_fingerprint(expected):
            known = lemma_map.get(surface.lower())
            if known is None:
                continue
            assert known[0] == lemma, surface
            if known[1] != pos:
                tag_disagreements.append((surface, known[1], pos))
            checked += 1
    assert checked > 30, f"only {checked} tokens overlap; the check is not checking much"
    assert tag_disagreements == [
        ("mañana", "ADV", "NOUN"),
        ("poco", "PRON", "ADV"),
    ], tag_disagreements


def test_the_falsifier_corpus_is_committed_and_readable() -> None:
    """A committed falsifying input per invariant (plan §Verification)."""
    for invariant in ("INV-PACK-40", "INV-PACK-51"):
        data = json.loads(
            (Path(__file__).parent / "falsifiers" / f"{invariant}.json").read_text(
                encoding="utf-8"
            )
        )
        assert data["invariant"] == invariant
        assert data["cases"]
        for entry in data["cases"]:
            assert entry["id"] and entry["why"] and entry["expect"]
