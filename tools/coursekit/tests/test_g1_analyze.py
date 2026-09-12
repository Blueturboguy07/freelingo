"""G1 Analyze — the adapter, its frozen self-test, and the stage around them.

The tests that matter here are the ones about the self-test corpus. Everything else in
this file checks that a stage does what a stage does; `test_the_selftest_catches_a_moved
_lemma` checks the thing the stage exists to prevent, which is a lemmatiser changing
under a ledger that was already partitioned by it.

The model-loading tests are skipped without the `nlp` group and run in CI, which syncs it.
"""

from __future__ import annotations

import json
import unicodedata
from pathlib import Path

import pytest

from coursekit import __version__
from coursekit.adapters import ADAPTERS
from coursekit.adapters.spacy_es import ledger_lemma, parse_fingerprint
from coursekit.artifacts import read_records, write_records
from coursekit.config import TOOL_NAME
from coursekit.config.g1 import (
    ADAPTER_BY_LANGUAGE,
    ADAPTER_SELFTEST,
    ADAPTER_SELFTEST_ES,
    ADAPTER_SELFTEST_ES_DIGEST,
    ADAPTER_SELFTEST_ES_NORMALISED,
    CONTENT_POS,
    LEMMA_NORMALISATION_BY_LANGUAGE,
    LEMMA_NORMALISATION_ES,
    LEMMA_NORMALISATION_PROBE,
    LESSON_ONE_WINDOW_ES,
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
    assert len(ADAPTER_SELFTEST_ES) == 18  # 12 + the six B9(a) witness sentences


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
    record = adapter_for("es").analyse(sentence_id="0" * 16, text="Las flores rojas son bonitas.")
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
    lemma_disagreements = []
    for _, expected in ADAPTER_SELFTEST_ES:
        for surface, lemma, pos in parse_fingerprint(expected):
            known = lemma_map.get(surface.lower())
            if known is None:
                continue
            if known[0] != lemma:
                # The RAW lemmas may differ by position — and must still land on the same
                # LEDGER key once the B9(a) table has run, because that key is what V1,
                # the new-item budget and FSRS are all about.
                assert ledger_lemma("es", known[0]) == ledger_lemma("es", lemma), surface
                lemma_disagreements.append((surface, known[0], lemma))
            if known[1] != pos:
                tag_disagreements.append((surface, known[1], pos))
            checked += 1
    assert checked > 30, f"only {checked} tokens overlap; the check is not checking much"
    assert tag_disagreements == [
        ("mañana", "ADV", "NOUN"),
        ("poco", "PRON", "ADV"),
        ("buenos", "PROPN", "ADJ"),
        ("días", "PROPN", "NOUN"),
        ("buenas", "PROPN", "ADJ"),
        ("Media", "NUM", "PROPN"),
        ("buenas", "PROPN", "ADJ"),
        ("noches", "PROPN", "NOUN"),
    ], tag_disagreements
    # Every one of these is a prenominal form of `bueno`, or a word the model re-tags
    # PROPN after a sentence-initial capital: the fixture sighted it in one position and
    # the frozen corpus in the other. They are listed by name so that a NINTH one — a
    # real drift between the fixture and the corpus — fails, and every one of them is
    # proven above to collapse onto one ledger key.
    assert lemma_disagreements == [
        ("buenos", "buenos", "buen"),
        ("días", "días", "día"),
        ("buenas", "buenas", "buena"),
        ("Gracias", "gracia", "gracias"),
        ("Media", "medio", "media"),
        ("buenas", "buenas", "buena"),
        ("noches", "noches", "noche"),
    ], lemma_disagreements
    assert {ledger_lemma("es", raw) for _s, raw, _f in lemma_disagreements} == {
        "bueno",
        "día",
        "gracia",
        "medio",
        "noche",
    }


def test_the_falsifier_corpus_is_committed_and_readable() -> None:
    """A committed falsifying input per invariant (plan §Verification)."""
    for invariant in ("INV-PACK-40", "INV-PACK-51"):
        data = json.loads(
            (Path(__file__).parent / "falsifiers" / f"{invariant}.json").read_text(encoding="utf-8")
        )
        assert data["invariant"] == invariant
        assert data["cases"]
        for entry in data["cases"]:
            assert entry["id"] and entry["why"] and entry["expect"]


# ---------------------------------------------------------------------------
# The lemma-normalisation table — founder ruling B9(a)
# ---------------------------------------------------------------------------


def test_INV_PACK_40_the_normalisation_table_is_declared_once_and_the_adapter_reads_it() -> None:
    """[INV-PACK-40] the cross-lane contract: one table, one reader, no copies.

    `config/g1.py` declares it, `ledger_lemma` is the only thing that looks at it, and
    the grep half of this — no downstream stage or validator carrying its own copy — is
    `test_ledger_unit.py`. Here: the mapping really is derived from the rows, so the
    documented table and the applied table cannot drift apart.
    """
    assert LEMMA_NORMALISATION_BY_LANGUAGE["es"] == {
        raw: ledger for raw, ledger, _surfaces in LEMMA_NORMALISATION_ES
    }
    assert ledger_lemma("es", "buenos") == "bueno"
    assert ledger_lemma("es", "casa") == "casa"


def test_INV_PACK_40_every_row_is_well_formed_and_terminates() -> None:
    """[INV-PACK-40] the table partitions the ledger, so its shape is load-bearing.

    A row whose ledger lemma is itself another row's raw lemma would need two passes to
    settle, and `ledger_lemma` makes exactly one — so a chain would leave the answer
    depending on dict order. Refused by assertion rather than by a second pass: a
    fixed-point loop over a table this size hides the mistake instead of reporting it.
    """
    raws = [raw for raw, _ledger, _surfaces in LEMMA_NORMALISATION_ES]
    assert len(raws) == len(set(raws)), "a raw lemma is mapped twice"
    for raw, ledger, surfaces in LEMMA_NORMALISATION_ES:
        assert raw != ledger, f"{raw!r} maps to itself; the row says nothing"
        assert ledger not in raws, f"{raw!r} -> {ledger!r} is a chain, not a mapping"
        assert surfaces, (
            f"{raw!r} -> {ledger!r} carries no surface; a row with no measurement is a wish"
        )
        assert ledger == unicodedata.normalize("NFC", ledger.lower()), (
            f"{ledger!r} is not the NFC-lowercase form the adapter outputs"
        )


@needs_nlp
def test_INV_PACK_06_every_declared_surface_really_produces_its_raw_lemma() -> None:
    """[INV-PACK-06] the third column is a measurement, and this re-takes it — RAW.

    Every surface on every row is handed to the pinned model and its **raw** lemma is
    read back, through `raw_lemma_of_surface`, which is the one accessor that has not
    been through the table.

    **Why not `record["lemmas"][0]` or `lemmatise_surface`.** Both return the lemma with
    the B9(a) table already applied, so comparing either to the row's LEDGER column is
    circular: any row whose raw side is wrong still normalises to the right answer via
    some other row, or via no row at all, and the test passes. An adversarial review
    found exactly that — the first version read `record["lemmas"][0]`, and two rows
    (`días`, `tardes`) claimed a raw lemma the model does not produce for the surfaces
    they named. Column one of the table was unverified by anything.
    """
    adapter = adapter_for("es")
    for raw, ledger, surfaces in LEMMA_NORMALISATION_ES:
        for surface in surfaces:
            produced = adapter.raw_lemma_of_surface(surface)
            assert produced == raw, (
                f"the table says the bare surface {surface!r} produces the RAW lemma "
                f"{raw!r} (and so normalises to {ledger!r}); the model gives {produced!r}"
            )
            assert ledger_lemma("es", produced) == ledger


@needs_nlp
def test_INV_PACK_06_the_probe_the_third_column_was_measured_with_is_the_gates_own() -> None:
    """[INV-PACK-06] one probe for the evidence and for the gate, or the column lies.

    `LEMMA_NORMALISATION_PROBE` is the bare surface, which is exactly what
    `lemmatise_surface` takes and therefore exactly what G3's reachability gate runs.
    Measured 2026-09-12: the same surface gives different raw lemmas in different
    positions (`cuchara` alone -> `cucharo`, inside a sentence -> `cuchara`), so a third
    column measured with a carrier sentence would be evidence about a call the pipeline
    never makes.
    """
    assert LEMMA_NORMALISATION_PROBE == "{surface}"
    adapter = adapter_for("es")
    for surface in ("cuchara", "paraguas", "tos"):
        bare = adapter.raw_lemma_of_surface(surface)
        assert adapter.lemmatise_surface(surface) is not None
        assert ledger_lemma("es", bare) == adapter.lemmatise_surface(surface)[0]


@needs_nlp
def test_INV_PACK_06_the_lesson_one_greeting_is_inside_the_lesson_that_teaches_it() -> None:
    """[INV-PACK-06] B9, the phase blocker, as an assertion.

    G4 deals lesson 1 of unit 1 five lemmas and nothing else. Before ruling B9(a),
    `Hola, buenos días.` analysed to `['hola', 'buen', 'día']` and `buen` was not one of
    them, so the greeting the lesson exists to teach was out of vocabulary in the lesson
    that teaches both of its words (`docs/P2-BLOCKERS.md` §B9). V1 cannot catch that: a
    lemma outside the window is not a lemma taught too early, it is a sentence nothing
    can select.
    """
    adapter = adapter_for("es")
    window = set(LESSON_ONE_WINDOW_ES)
    for text, expected in (
        ("Hola, buenos días.", ["hola", "bueno", "día"]),
        ("Hola, buenas noches.", ["hola", "bueno", "noche"]),
        ("Buenas tardes.", ["bueno", "tarde"]),
        ("Buenos días.", ["bueno", "día"]),
        ("Buenas noches.", ["bueno", "noche"]),
        ("Buen día.", ["bueno", "día"]),
    ):
        lemmas = adapter.analyse(sentence_id="1" * 16, text=text)["lemmas"]
        assert lemmas == expected, text
        assert set(lemmas) <= window, f"{text!r} leaves the lesson-1 window: {lemmas}"


@needs_nlp
def test_the_frozen_corpus_still_records_the_RAW_lemma_the_table_repairs() -> None:
    """The two sides are kept apart on purpose, and this is the test that says so.

    If the raw fingerprints were quietly re-frozen as the normalised ones, the corpus
    would stop being able to tell a model change from a table change — and the model is
    the thing that moves without anyone touching this repository.
    """
    frozen = dict(ADAPTER_SELFTEST_ES)
    raw = frozen["Hola, buenos días y buenas tardes."]
    assert "buenos/buen/ADJ" in raw
    assert "buenas/buena/ADJ" in raw
    assert "buenos/bueno" not in raw
    assert "Gracias/gracias/NOUN" in frozen["Gracias por el paraguas y la cuchara."]
    assert "Media/media/PROPN" in frozen["Media hora más, buenas noches."]
    assert "tos/to/ADJ" in frozen["Tengo tos y fiebre esta noche."]
    assert adapter_for("es")._fingerprint_sentence("Hola, buenos días y buenas tardes.") == raw


@needs_nlp
def test_the_normalised_expectations_are_frozen_beside_the_raw_ones() -> None:
    """And the other side: the post-table fingerprint, for the rows that fire."""
    adapter = adapter_for("es")
    assert set(ADAPTER_SELFTEST_ES_NORMALISED) <= {s for s, _ in ADAPTER_SELFTEST_ES}
    for sentence, expected in ADAPTER_SELFTEST_ES_NORMALISED.items():
        assert adapter._fingerprint_sentence(sentence, normalise=True) == expected


@needs_nlp
def test_a_sentence_with_no_normalised_row_is_left_alone_by_the_table() -> None:
    """The half that stops a new row firing somewhere nobody looked.

    Every frozen sentence ABSENT from the normalised dict must normalise to its own raw
    fingerprint. Add a row for a common lemma and this fails, naming the sentence — which
    is the only warning a table edit gets before it re-partitions a built pack.
    """
    adapter = adapter_for("es")
    for sentence, raw in ADAPTER_SELFTEST_ES:
        if sentence in ADAPTER_SELFTEST_ES_NORMALISED:
            continue
        assert adapter._fingerprint_sentence(sentence, normalise=True) == raw, sentence


@needs_nlp
def test_the_selftest_catches_a_deleted_normalisation_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A table that stops firing is invisible to the raw fingerprints. Not to this."""
    from coursekit.adapters import spacy_es

    monkeypatch.setattr(spacy_es, "LEMMA_NORMALISATION_BY_LANGUAGE", {})
    failures = adapter_for("es").self_test()
    assert failures, "deleting every row left the self-test green"
    assert any("normalised" in line for line in failures)
    assert any("buen" in line for line in failures)


def test_INV_PACK_12_a_language_with_no_measured_table_is_normalised_by_nothing() -> None:
    """[INV-PACK-12] no silent fallback: fr/de/ja get no rows, not the Spanish ones.

    A normalisation table is a measurement of one lemmatiser. Reusing Spanish rows for
    French would be the differently-shaped fallback INV-PACK-12 forbids — and it would
    be invisible, because `buen` is a French word for nothing and the row would simply
    never fire until the day it did.
    """
    assert set(LEMMA_NORMALISATION_BY_LANGUAGE) == {"es"}
    assert ledger_lemma("fr", "buen") == "buen"
    assert ledger_lemma("de", "gran") == "gran"


def test_the_digest_describes_all_three_frozen_tables(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Editing a normalisation row must move the digest the runlog and manifest carry."""
    from coursekit.adapters import spacy_es

    before = spacy_es.selftest_digest("es")
    assert before == ADAPTER_SELFTEST_ES_DIGEST
    monkeypatch.setattr(
        spacy_es,
        "LEMMA_NORMALISATION_ES",
        (*LEMMA_NORMALISATION_ES, ("malo", "mal", ("mal",))),
    )
    assert spacy_es.selftest_digest("es") != before
