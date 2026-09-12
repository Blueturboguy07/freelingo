"""G0 end to end: the gate, the ledger, and the filters between them.

`test_licences.py` and `test_sources_*.py` prove the two invariants at the door. This
file proves the door is the only way in — that the *stage*, run the way `coursekit build`
runs it, refuses a forbidden corpus before a socket exists, names a missing input, and
emits rows that carry the licence, the verdict and the attribution owner V10 and
INV-PACK-17 need.

The page a licence was READ FROM is recorded per corpus per run, in the G0 runlog entry's
`notes.licence_pages` — not on the rows. `artifacts.INGESTED_SENTENCE` is
`additionalProperties: false` and `runlog.LicenceRow` has five fixed fields, both owned by
`p2-deps-scaffold`, so a per-sentence page is a schema request (recorded in
`docs/owned/p2-g0-ingest.json`). `…_the_runlog_records_the_page_each_licence_was_read_from`
asserts what actually exists, which is the version of edge case 4 this lane can keep.

Two corpora, and the difference between them is the licence posture in one assertion:
`tatoeba` rows come out `shippable` with an owner, `nllb` rows come out `oracle_only` with
ODC-By. Both are ingested; only one may ever fill a lesson slot, and G4 is where that is
enforced (`inputs.forbid_unshippable`). Conflating the two would either lose the oracle the
plan's selection stage needs or ship the crawl text.
"""

from __future__ import annotations

import bz2
import importlib
import io
import json
import zipfile

import pytest
from test_licences import RecordingTransport

from coursekit.artifacts import ARTIFACTS, artifact_path, read_records
from coursekit.config.g0 import (
    INGEST_CORPORA_BY_LANGUAGE,
    MAX_TOKENS,
    MIN_TOKENS,
    REJECT_REASONS,
    UNRESOLVED_LICENCE,
)
from coursekit.inputs import ForbiddenSource, MissingInput
from coursekit.runlog import RunLog, read_entries
from coursekit.sources import opus, tatoeba
from coursekit.sources.licences import permit
from coursekit.stages import STAGES
from coursekit.stages.g0_ingest import IngestReport, ingest, normalise, token_count
from coursekit.stages.g0_ingest import _rows as _g0_rows

DETAILED = tatoeba.detailed_export_url("spa")
LINKS = tatoeba.links_export_url("spa")
ENGLISH = tatoeba.l1_export_url()
API = opus.api_url("nllb", "es")
ARCHIVE = "https://object.pouta.csc.fi/OPUS-NLLB/v1/moses/en-es.txt.zip"
LAST_MODIFIED = "Sat, 05 Sep 2026 06:33:35 GMT"

#: Original Spanish/English pairs written for this test, all inside the 3-12 token A1
#: window. Not sampled from Tatoeba: a fixture carrying corpus text of unclear provenance
#: inside the suite that enforces INV-PACK-13 is the thing the invariant is about.
TATOEBA_ROWS = [
    ("La casa blanca es muy grande.", "The white house is very big."),
    ("Mi hermana trabaja en la ciudad.", "My sister works in the city."),
    ("Hoy hace mucho frío aquí.", "It is very cold here today."),
]
NLLB_ROWS = [
    ("El tren llega a las ocho.", "The train arrives at eight."),
    ("Quiero comprar pan y leche.", "I want to buy bread and milk."),
]


def _bz2(rows: list[str]) -> bytes:
    return bz2.compress(("\n".join(rows) + "\n").encode())


def _archive(spanish: list[str], english: list[str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("NLLB.en-es.en", "\n".join(english) + "\n")
        archive.writestr("NLLB.en-es.es", "\n".join(spanish) + "\n")
    return buffer.getvalue()


def _api() -> bytes:
    return json.dumps(
        {
            "corpora": [
                {
                    "alignment_pairs": 409061333,
                    "corpus": "NLLB",
                    "documents": "",
                    "id": 665548,
                    "latest": "True",
                    "preprocessing": "moses",
                    "size": 1,
                    "source": "en",
                    "source_tokens": 7657593794,
                    "target": "es",
                    "target_tokens": 8363210603,
                    "url": ARCHIVE,
                    "version": "v1",
                }
            ]
        }
    ).encode()


def _transport(
    *,
    tatoeba_rows: list[tuple[str, str]] | None = None,
    nllb_rows: list[tuple[str, str]] | None = None,
    drop: str | None = None,
) -> RecordingTransport:
    spanish = tatoeba_rows if tatoeba_rows is not None else TATOEBA_ROWS
    crawl = nllb_rows if nllb_rows is not None else NLLB_ROWS
    files = {
        DETAILED: _bz2(
            [
                f"{2480 + index}\tspa\t{text}\tShishir\t\\N\t2010-08-08 23:28:48"
                for index, (text, _) in enumerate(spanish)
            ]
        ),
        LINKS: _bz2([f"{2480 + index}\t{10 + index}" for index in range(len(spanish))]),
        ENGLISH: _bz2(
            [f"{10 + index}\teng\t{english}" for index, (_, english) in enumerate(spanish)]
        ),
        API: _api(),
        ARCHIVE: _archive([row[0] for row in crawl], [row[1] for row in crawl]),
    }
    if drop is not None:
        files = {url: blob for url, blob in files.items() if not url.endswith(drop)}
    return RecordingTransport(files, headers={DETAILED: {"last-modified": LAST_MODIFIED}})


def _entry(lang: str = "es"):
    """A live runlog entry, the way the dispatcher hands one to a stage."""
    log = RunLog(lang)
    return log, log.stage("g0", tool="coursekit", tool_version="test")


def _run(transport: RecordingTransport, *, lang: str = "es", **kwargs):
    log, ctx = _entry(lang)
    with ctx as entry:
        report = ingest(lang, entry, transport, **kwargs)
    return report, entry, log


@pytest.fixture(autouse=True)
def _stage_is_registered() -> None:
    """Undo another module's `empty_registry` fixture, which cannot undo itself.

    `Registry.reset_for_tests()` clears the entries **and** the discovered flag, and
    `discover()` then re-imports the stage modules — but Python has already cached them,
    so `@register_stage` never runs a second time and the registry stays empty for the
    rest of the session. Nothing noticed while no stage existed; the first lane to land
    one is the lane that trips over it.

    The reload below is a workaround inside this lane's files, not the fix: the fix is in
    `coursekit/__init__.py`, which is `p2-deps-scaffold`'s. Recorded as a blocker rather
    than patched here.
    """
    from coursekit.stages import g0_ingest

    if STAGES.get("g0") is None:
        importlib.reload(g0_ingest)


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------


def test_the_stage_is_registered_as_g0_and_writes_the_contract_record() -> None:
    """`coursekit build es --only g0` reaches this lane's code and nothing else changed."""
    stage = STAGES.get("g0")
    assert stage is not None
    assert stage.writes == ("ingested_sentence",)
    assert stage.reads == ()
    assert ARTIFACTS["ingested_sentence"].stage == "g0"


def test_spanish_ingests_tatoeba_and_nllb() -> None:
    assert INGEST_CORPORA_BY_LANGUAGE["es"] == ("tatoeba", "nllb")


# ---------------------------------------------------------------------------
# INV-PACK-13, from the stage's own entry point
# ---------------------------------------------------------------------------


def test_INV_PACK_13_the_stage_refuses_a_forbidden_corpus_before_any_request() -> None:
    """[INV-PACK-13] NC/ND is excluded AT INGEST: no request, no rows, no artefact.

    Three assertions, and the first is the invariant. A pipeline that filtered TED2020 at
    package time would pass the second and third and would have written CC BY-NC-ND text
    to this machine's disk on the way.
    """
    transport = _transport()
    transport.requests.clear()
    with pytest.raises(ForbiddenSource):
        _run(transport, corpora=("ted2020",))
    assert transport.requests == []
    assert not artifact_path("es", "ingested_sentence").exists()


def test_INV_PACK_13_every_emitted_row_carries_a_resolved_licence_and_an_owner() -> None:
    """[INV-PACK-13] V10's row-level half: licence, verdict, and an attribution owner.

    `attribution_owner` may only be null where `attribution_required` is false, which is
    what makes INV-PACK-17's "reachable from S152" a checkable claim rather than a hope.
    """
    _report, _entry_, _log = _run(_transport())
    rows = list(read_records("ingested_sentence", lang="es"))
    assert rows
    for row in rows:
        assert row["licence"] != UNRESOLVED_LICENCE
        assert row["licence_verdict"] in {"shippable", "oracle_only"}
        if row["attribution_required"]:
            assert row["attribution_owner"]

    by_source = {row["source_id"] for row in rows}
    assert by_source == {"tatoeba", "nllb"}
    tatoeba_rows = [row for row in rows if row["source_id"] == "tatoeba"]
    nllb_rows = [row for row in rows if row["source_id"] == "nllb"]
    assert {row["licence"] for row in tatoeba_rows} == {"CC-BY-2.0-FR"}
    assert {row["licence_verdict"] for row in tatoeba_rows} == {"shippable"}
    assert {row["attribution_owner"] for row in tatoeba_rows} == {"Shishir"}
    assert {row["licence"] for row in nllb_rows} == {"ODC-By-1.0"}
    assert {row["licence_verdict"] for row in nllb_rows} == {"oracle_only"}
    assert {row["corpus_version"] for row in nllb_rows} == {"v1"}
    assert {row["corpus_version"] for row in tatoeba_rows} == {"2026-09-05"}


def test_INV_PACK_13_the_runlog_carries_one_licence_row_per_corpus_read() -> None:
    """[INV-PACK-13] the run-level half. A validator that cannot tell "clean" from "did
    not run" reports the same green either way, so the licences a run touched are a fact
    about the run and are written even when the stage fails."""
    _report, _entry_, _log = _run(_transport())
    entries = read_entries("es", stage="g0")
    assert len(entries) == 1
    licences = {row["source_id"]: row for row in entries[0]["licences"]}
    assert set(licences) == {"tatoeba", "nllb"}
    assert licences["nllb"]["verdict"] == "oracle_only"
    assert licences["tatoeba"]["attribution_required"] is True
    assert entries[0]["inputs"] == ["tatoeba", "nllb"]
    assert entries[0]["outputs"] == ["ingested_sentence"]


def test_INV_PACK_13_the_runlog_records_the_page_each_licence_was_read_from() -> None:
    """[INV-PACK-13] edge case 4: the licence string must be traceable to a page.

    OPUS grants no blanket licence and its API returns no licence field, so "ODC-By-1.0"
    is a claim until a run says where it read it. That is `notes.licence_pages`, per
    corpus per run — the honest scope of what this lane can persist, because the
    `ingested_sentence` schema is closed and owned elsewhere. The last assertion is the
    one that keeps it honest: the ROWS do not carry it, so nothing downstream may pretend
    they do.
    """
    _report, _entry_, _log = _run(_transport())
    entries = read_entries("es", stage="g0")
    pages = entries[0]["notes"]["licence_pages"]
    assert pages == {
        "tatoeba": "https://tatoeba.org/en/downloads",
        "nllb": "https://opus.nlpl.eu/legacy/NLLB-v1.php",
    }
    assert set(pages) == {row["source_id"] for row in entries[0]["licences"]}

    rows = list(read_records("ingested_sentence", lang="es"))
    assert rows and all("licence_page" not in row for row in rows)


def test_INV_PACK_13_a_failed_stage_still_records_which_corpora_it_touched() -> None:
    """[INV-PACK-13] a missing entry and a failed entry send a reader to different places.

    Two halves. A corpus the gate REFUSED was never touched, so it leaves no licence row —
    recording one would claim a read that never happened. A corpus the gate ALLOWED and
    that then died mid-fetch was touched, and its licence row and page must survive the
    failure: recording provenance at the end of the loop body means the one run that
    failed is the one run with nothing to read.
    """
    with pytest.raises(ForbiddenSource):
        _run(_transport(), corpora=("ted2020",))
    entries = read_entries("es", stage="g0")
    assert [entry["status"] for entry in entries] == ["failed"]
    assert entries[0]["licences"] == []

    # Allowed, then the target-side export is missing: a mid-fetch death.
    with pytest.raises(MissingInput):
        _run(_transport(drop="spa_sentences_detailed.tsv.bz2"), corpora=("tatoeba",))
    failed = read_entries("es", stage="g0")[-1]
    assert failed["status"] == "failed"
    assert [row["source_id"] for row in failed["licences"]] == ["tatoeba"]
    assert failed["inputs"] == ["tatoeba"]


# ---------------------------------------------------------------------------
# INV-PACK-12, from the stage's own entry point
# ---------------------------------------------------------------------------


def test_INV_PACK_12_a_missing_per_language_input_stops_the_stage_by_name() -> None:
    """[INV-PACK-12] the stage fails loudly with the input named, and writes nothing.

    Not "writes fewer rows". A G0 that logged the miss and carried on with NLLB alone would
    produce a ledger whose every shippable sentence was silently gone, and every validator
    downstream would pass over it.
    """
    transport = _transport(drop="spa_sentences_detailed.tsv.bz2")
    with pytest.raises(MissingInput) as raised:
        _run(transport, corpora=("tatoeba",))
    assert "spa_sentences_detailed.tsv.bz2" in str(raised.value)
    assert not transport.asked_for("spa_sentences.tsv.bz2")
    assert not artifact_path("es", "ingested_sentence").exists()


def test_INV_PACK_12_a_corpus_with_no_reader_is_a_failure_not_a_skip() -> None:
    """[INV-PACK-12] a corpus G0 cannot read must name itself and stop.

    Two different refusals, and the order between them is deliberate. OpenSubtitles is
    stopped by the LICENCE gate before anyone asks whether a reader exists — the stronger
    answer. `tatoeba_cc0` clears the gate for French (CC0-1.0, on the allow-list) and then
    stops because nothing in G0 knows its file layout: a source with no reader is a build
    failure, never a silently skipped corpus.
    """
    with pytest.raises(ForbiddenSource) as refused:
        _run(_transport(), corpora=("opensubtitles",))
    assert "opensubtitles" in str(refused.value)
    assert "allow-list" in str(refused.value)

    with pytest.raises(MissingInput) as raised:
        _run(_transport(), corpora=("tatoeba_cc0",), lang="fr")
    assert "tatoeba_cc0" in str(raised.value)
    assert "no fetcher" in str(raised.value)


def test_INV_PACK_12_a_language_with_no_configured_corpora_names_the_table() -> None:
    """[INV-PACK-12] an empty input list is a missing input, not an empty build."""
    with pytest.raises(MissingInput) as raised:
        _run(_transport(), corpora=())
    assert "INGEST_CORPORA_BY_LANGUAGE" in str(raised.value)


# ---------------------------------------------------------------------------
# Normalisation and the filters
# ---------------------------------------------------------------------------


def test_normalise_folds_what_is_invisible_and_nothing_that_is_lexical() -> None:
    """Spanish diacritics are lexical: `año` is not `ano`. Folding them would merge two
    lemmas and V1 would then pass over a ledger that means nothing."""
    decomposed = "canci" + "o\u0301" + "n"  # NFD: o + combining acute
    assert decomposed != "canci\u00f3n"
    assert normalise(decomposed) == "canci\u00f3n"
    assert normalise("hola​  mundo﻿") == "hola mundo"
    assert normalise("  el   año  ") == "el año"
    assert normalise("el año") != normalise("el ano")


def test_the_length_window_is_the_a1_one_and_japanese_counts_characters() -> None:
    """Counting whitespace "words" in Japanese is the mistake edge case 6 catches in
    `ja_full.txt`, where the whitespace-split tokens are sentence fragments."""
    assert (MIN_TOKENS, MAX_TOKENS) == (3, 12)
    assert token_count("La casa es blanca.", "es") == 4
    assert token_count("私は学生です。", "ja") == 7


def test_rows_outside_the_window_and_duplicates_are_rejected_with_a_named_reason() -> None:
    rows = [
        ("Hola.", "Hi."),  # 1 token -> too_short
        ("La casa blanca es muy grande.", "The white house is very big."),
        ("la casa blanca es muy grande.", "The white house is very big."),  # dedup on fold
        (" ".join(["palabra"] * 20), "a word " * 20),  # too_long
    ]
    report, _entry_, _log = _run(_transport(tatoeba_rows=rows), corpora=("tatoeba",))
    assert report.written == 1
    assert report.rejected_by == {"too_short": 1, "duplicate": 1, "too_long": 1}


def test_markup_profanity_and_untranslated_rows_never_reach_the_ledger() -> None:
    """Crawl-mined bitext is full of all three, and NLLB is crawl-mined."""
    rows = [
        ("Visita https://ejemplo.es hoy.", "Visit https://example.es today."),
        ("Esto es una mierda enorme.", "This is a huge mess."),
        ("Barcelona Madrid Sevilla", "Barcelona Madrid Sevilla"),
        ("El tren llega a las ocho.", "The train arrives at eight."),
    ]
    report, _entry_, _log = _run(_transport(nllb_rows=rows), corpora=("nllb",))
    assert report.written == 1
    assert report.rejected_by == {"register": 1, "profanity": 1, "untranslated": 1}


def test_an_unresolved_licence_is_a_stop_not_a_counted_rejection() -> None:
    """There is no `unresolved_licence` reject reason, and the absence is the invariant.

    A counted rejection would mean the corpus was fetched, parsed and then dropped — which
    is "filtered at package time" wearing an ingest-shaped coat. So `REJECT_REASONS` does
    not carry it (`IngestReport.reject` refuses any reason that is not in the tuple, so a
    future `report.reject("unresolved_licence")` raises), and `_rows` re-asserts the
    decision as a raise for anything that somehow got past `permit()`.
    """
    assert "unresolved_licence" not in REJECT_REASONS
    with pytest.raises(ValueError):
        IngestReport().reject("unresolved_licence")

    granted = permit("nllb", "es")
    forged = object.__new__(type(granted))
    for name, value in (
        ("source_id", "nllb"),
        ("lang", "es"),
        ("url", None),
        ("corpus", "NLLB"),
        ("corpus_version", "v1"),
        ("licence", UNRESOLVED_LICENCE),
        ("licence_page", ""),
        ("verdict", "oracle_only"),
        ("attribution_required", True),
        ("attribution_owner", "x"),
    ):
        object.__setattr__(forged, name, value)
    with pytest.raises(MissingInput) as raised:
        list(_g0_rows(forged, [], report=IngestReport(), seen=set(), max_pairs=1))
    assert UNRESOLVED_LICENCE in str(raised.value)


def test_max_pairs_caps_what_is_kept_per_corpus() -> None:
    report, entry, _log = _run(_transport(), max_pairs=1)
    assert report.per_corpus == {"tatoeba": 1, "nllb": 1}
    assert entry.notes["max_pairs"] == 1


def test_a_ledger_with_no_rows_is_a_failed_stage_never_a_fast_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reason `coursekit build` exits 2 on an unregistered stage, one level down.

    A stage that read 3,000 candidates, kept none, and reported green is the most
    expensive thing this tool can do: `coursekit validate` then runs over an empty ledger
    and every row-level validator passes vacuously. Driven through the REGISTERED stage,
    with the real transport swapped out, so the assertion covers the wiring the CLI uses
    rather than the helper the other tests call.
    """
    from coursekit.stages import StageContext, g0_ingest

    transport = _transport(
        tatoeba_rows=[("Hola.", "Hi.")],  # one token: rejected as too_short
        nllb_rows=[("No.", "No.")],  # identical sides: rejected as untranslated
    )
    monkeypatch.setattr(g0_ingest, "HttpTransport", lambda: transport)

    stage = STAGES.get("g0")
    assert stage is not None
    log = RunLog("es")
    with log.stage("g0", tool="coursekit", tool_version="test") as entry:
        result = stage.run(StageContext(lang="es", runlog=log, entry=entry, options={}))
    assert result.ok is False
    assert "kept none" in result.message
    assert "too_short" in result.message


def test_a_full_run_through_the_registered_stage_reports_what_it_wrote(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other half: the success path is reachable, so the failure path above is not
    a stage that always fails."""
    from coursekit.stages import StageContext, g0_ingest

    monkeypatch.setattr(g0_ingest, "HttpTransport", lambda: _transport())
    stage = STAGES.get("g0")
    assert stage is not None
    log = RunLog("es")
    with log.stage("g0", tool="coursekit", tool_version="test") as entry:
        result = stage.run(
            StageContext(lang="es", runlog=log, entry=entry, options={"max_pairs": "50"})
        )
    assert result.ok is True
    assert result.detail["per_corpus"] == {"tatoeba": 3, "nllb": 2}
    assert len(list(read_records("ingested_sentence", lang="es"))) == 5
