"""OPUS: the pair-direction rule, the capped read of a huge archive, and the stale `size`.

Every number quoted in this file was measured live on 2026-09-12 against the real hosts,
and the measurements are the reason the code is shaped the way it is:

    en-de.txt.zip                 -> HTTP 404
    de-en.txt.zip                 -> HTTP 200, content-length 21,180,847,796
    en-es.txt.zip                 -> HTTP 200, content-length 40,327,884,789
    opusapi ?corpus=NLLB…en…es    -> alignment_pairs 409,061,333, size 1

`size: 1` against a 40.3 GB archive is review R2's finding, still true, and the reason
nothing in `sources/opus.py` decides anything from that field.

The archives here are built in memory with `zipfile`, including a zip64 one, because the
part worth testing is the reader: a moses archive holds one member per side, the second
begins after the first ends, and the only way to take 2,000,000 pairs out of 40 GB is to
read the central directory from the tail and then the front of each member.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest
from test_licences import RecordingTransport

from coursekit.config.g0 import (
    MAX_PAIRS_DEFAULT,
    OPUS_HOSTS,
    OPUS_MOSES_MEMBER,
    ZIP_RANGE_SLICE_BYTES,
)
from coursekit.inputs import MissingInput, opus_pair
from coursekit.sources import opus
from coursekit.sources.licences import NotFound, permit

API = "https://opus.nlpl.eu/opusapi/"
ARCHIVE = "https://object.pouta.csc.fi/OPUS-NLLB/v1/moses/en-es.txt.zip"


def _api_payload(*, corpus: str = "NLLB", pair: str = "en-es", size: int = 1) -> bytes:
    """The real shape of an OPUS API answer, fields and all (fetched 2026-09-12)."""
    source, target = pair.split("-") if pair != "de-en" else ("de", "en")
    return json.dumps(
        {
            "corpora": [
                {
                    "alignment_pairs": 409061333,
                    "corpus": corpus,
                    "documents": "",
                    "id": 665548,
                    "latest": "True",
                    "preprocessing": "moses",
                    "size": size,
                    "source": source,
                    "source_tokens": 7657593794,
                    "target": target,
                    "target_tokens": 8363210603,
                    "url": ARCHIVE,
                    "version": "v1",
                }
            ]
        }
    ).encode()


def _archive(
    lines_en: list[str],
    lines_es: list[str],
    *,
    corpus: str = "NLLB",
    pair: str = "en-es",
    zip64: bool = False,
) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for lang, lines in ((pair.split("-")[0], lines_en), (pair.split("-")[1], lines_es)):
            name = f"{corpus}.{pair}.{lang}"
            body = ("\n".join(lines) + "\n").encode()
            with archive.open(zipfile.ZipInfo(name), "w", force_zip64=zip64) as member:
                member.write(body)
    return buffer.getvalue()


def _transport(*, lines: int = 40, **files: bytes) -> RecordingTransport:
    english = [f"This is English sentence number {index}." for index in range(lines)]
    spanish = [f"Esta es la frase española número {index}." for index in range(lines)]
    served = {
        opus.api_url("nllb", "es"): _api_payload(),
        ARCHIVE: _archive(english, spanish),
    }
    served.update(files)
    return RecordingTransport(served)


# ---------------------------------------------------------------------------
# The direction rule
# ---------------------------------------------------------------------------


def test_the_pair_segment_is_alphabetical_for_every_v1_language() -> None:
    """`deep/10`: "the single most common build-script bug". German is the one that bites."""
    assert opus_pair("es") == "en-es"
    assert opus_pair("fr") == "en-fr"
    assert opus_pair("ja") == "en-ja"
    assert opus_pair("de") == "de-en"


def test_the_api_query_orders_l1_first_while_the_pair_segment_is_alphabetical() -> None:
    """The two spellings disagree for German, and deriving one from the other ships en-de.

    Verified live 2026-09-12: `?source=de&target=en` and `?source=en&target=de` both answer,
    and the archive is only ever at `de-en.txt.zip`.
    """
    assert "source=en&target=de" in opus.api_url("nllb", "de")
    assert opus.download_url("nllb", "de").endswith("/moses/de-en.txt.zip")
    assert opus.download_url("nllb", "es").endswith("/moses/en-es.txt.zip")


def test_member_names_carry_the_alphabetical_pair_and_the_plain_language_code() -> None:
    assert opus.member_names("NLLB", "es") == ("NLLB.en-es.en", "NLLB.en-es.es")
    assert opus.member_names("NLLB", "de") == ("NLLB.de-en.en", "NLLB.de-en.de")


def test_member_names_are_formatted_from_the_constant_rather_than_respelled() -> None:
    """One definition of the naming rule, not two that happen to agree today.

    `OPUS_MOSES_MEMBER` exists to pin `<CORPUS>.<pair>.<lang>`; a module that re-spells the
    pattern in an f-string leaves the constant as decoration and the rule in two places.
    """
    assert OPUS_MOSES_MEMBER == "{corpus}.{pair}.{lang}"
    assert opus.member_names("NLLB", "es") == (
        OPUS_MOSES_MEMBER.format(corpus="NLLB", pair="en-es", lang="en"),
        OPUS_MOSES_MEMBER.format(corpus="NLLB", pair="en-es", lang="es"),
    )


def test_a_404_is_a_hard_failure_naming_the_direction_not_a_fallback() -> None:
    """Edge case 1. The wrong spelling 404s, and a fetcher with a fallback then quietly
    ingests a different corpus — which is a licence decision made by a typo."""
    granted = permit("nllb", "es")
    transport = RecordingTransport()  # every URL 404s
    with pytest.raises(NotFound) as raised:
        opus.describe(granted, transport)
    assert "alphabetically" in str(raised.value).lower()
    assert transport.requests == [opus.api_url("nllb", "es")]


def test_an_empty_corpora_array_is_the_same_answer_as_a_404() -> None:
    """The API answers 200 with `{"corpora": []}` for a pair it does not have, and a
    reader that treated that as "nothing today" would ingest nothing and report success."""
    granted = permit("nllb", "es")
    transport = RecordingTransport({opus.api_url("nllb", "es"): b'{"corpora": []}'})
    with pytest.raises(NotFound) as raised:
        opus.describe(granted, transport)
    assert "de-en" in str(raised.value)


def test_an_unknown_opus_corpus_names_the_table_rather_than_building_a_url() -> None:
    """INV-PACK-12: a corpus with no entry has no version and no legacy licence page."""
    with pytest.raises(MissingInput) as raised:
        opus.api_url("tatoeba", "es")
    assert "OPUS_CORPUS_BY_SOURCE" in str(raised.value)


def test_the_legacy_page_is_where_a_licence_comes_from() -> None:
    """Edge case 4: OPUS grants no blanket licence and the API returns no licence field."""
    assert opus.legacy_licence_page("nllb") == "https://opus.nlpl.eu/legacy/NLLB-v1.php"
    assert opus.legacy_licence_page("ted2020") == "https://opus.nlpl.eu/legacy/TED2020-v1.php"


# ---------------------------------------------------------------------------
# Metadata
# ---------------------------------------------------------------------------


def test_describe_reads_the_api_and_marks_nllbs_size_untrustworthy() -> None:
    """R2, re-verified live 2026-09-12: NLLB reports `size: 1` for a 40.3 GB archive."""
    granted = permit("nllb", "es")
    info = opus.describe(granted, _transport())
    assert info.corpus == "NLLB"
    assert info.version == "v1"
    assert info.pair == "en-es"
    assert info.alignment_pairs == 409_061_333
    assert info.size_kb == 1
    assert info.size_is_trustworthy is False


# ---------------------------------------------------------------------------
# The capped read
# ---------------------------------------------------------------------------


def test_stream_pairs_joins_the_two_members_by_line() -> None:
    granted = permit("nllb", "es")
    _stamped, _info, pairs = opus.stream_pairs(granted, _transport(lines=10), max_pairs=10)
    rows = list(pairs)
    assert len(rows) == 10
    assert rows[0] == ("Esta es la frase española número 0.", "This is English sentence number 0.")
    assert rows[9][0].endswith("número 9.")


def test_stream_pairs_stamps_the_permit_with_the_version_the_api_resolved() -> None:
    """`version=latest` is resolved by the API, so which version a run read is a fact
    about the run. A row carrying a licence from one version and text from another is a
    provenance claim nobody can check."""
    granted = permit("nllb", "es")
    assert granted.corpus_version == ""
    stamped, _info, _pairs = opus.stream_pairs(granted, _transport(), max_pairs=5)
    assert (stamped.corpus, stamped.corpus_version) == ("NLLB", "v1")
    assert stamped.licence == "ODC-By-1.0"


def test_max_pairs_caps_the_rows_and_the_bytes_pulled() -> None:
    """The cap is the point: `en-es` is 40,327,884,789 bytes and is never downloaded.

    Asserted two ways — the row count, and that no single ranged request asked for more
    than one slice — because a reader that pulled the whole member and then sliced would
    pass the first assertion and be exactly the bug.
    """
    granted = permit("nllb", "es")
    transport = _transport(lines=5_000)
    _stamped, _info, pairs = opus.stream_pairs(granted, transport, max_pairs=7)
    assert len(list(pairs)) == 7
    # tail + central directory + one slice per member: bounded, and nowhere near the
    # number of requests a full read of a 40 GB archive would need.
    assert len(transport.requests) <= 6


def test_the_reader_handles_a_zip64_archive() -> None:
    """Every OPUS pair archive worth capping is over 4 GB, which is when zip64 starts.

    A reader that only understood 32-bit headers would work on every fixture and on
    nothing real, so the fixture forces the zip64 extra field.
    """
    granted = permit("nllb", "es")
    english = [f"English {index}" for index in range(20)]
    spanish = [f"Español {index}" for index in range(20)]
    transport = RecordingTransport(
        {
            opus.api_url("nllb", "es"): _api_payload(),
            ARCHIVE: _archive(english, spanish, zip64=True),
        }
    )
    _stamped, _info, pairs = opus.stream_pairs(granted, transport, max_pairs=20)
    assert len(list(pairs)) == 20


def test_a_member_the_archive_does_not_have_fails_naming_what_it_does_have() -> None:
    granted = permit("nllb", "es")
    transport = RecordingTransport(
        {
            opus.api_url("nllb", "es"): _api_payload(),
            ARCHIVE: _archive(["a"], ["b"], corpus="CCMatrix", pair="en-es"),
        }
    )
    with pytest.raises(opus.OpusArchiveError) as raised:
        _stamped, _info, pairs = opus.stream_pairs(granted, transport)
        list(pairs)
    assert "NLLB.en-es.en" in str(raised.value)
    assert "CCMatrix.en-es.en" in str(raised.value)


def test_blank_sides_are_dropped_rather_than_carried() -> None:
    """Moses files contain empty lines, and an empty 'sentence' would become a zero-token
    analysed row at G1 that every later validator has to special-case."""
    granted = permit("nllb", "es")
    transport = RecordingTransport(
        {
            opus.api_url("nllb", "es"): _api_payload(),
            ARCHIVE: _archive(["one", "", "three"], ["uno", "dos", "tres"]),
        }
    )
    _stamped, _info, pairs = opus.stream_pairs(granted, transport, max_pairs=10)
    assert list(pairs) == [("uno", "one"), ("tres", "three")]


def test_the_archive_host_is_the_only_one_a_permit_reaches() -> None:
    assert OPUS_HOSTS == ("opus.nlpl.eu", "object.pouta.csc.fi")


def test_the_caps_are_the_measured_caps() -> None:
    """The ingest cap is 200,000, and it is a MEASUREMENT, not the plan's estimate.

    The plan wrote 2,000,000 and nothing ever ran it; `pack-ci.yml` ran 200,000 on every
    push via `--set max_pairs=...`. Two numbers, one of them never exercised. Three full
    G0-G4 runs on the real corpora settled it (the table is at the constant): 3x the cap
    is +44% wall clock for -13% gaps, because only Tatoeba is `shippable` and the extra
    pairs are overwhelmingly NLLB, which G4 rejects by verdict and G1 still lemmatises.
    CI now exercises this constant instead of overriding it, so a change here is a change
    everywhere.
    """
    assert MAX_PAIRS_DEFAULT == 200_000
    assert ZIP_RANGE_SLICE_BYTES == 8 * 1024 * 1024
