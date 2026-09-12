"""[INV-PACK-12] Tatoeba: three files joined on id, and the near-miss that must never win.

The falsifier corpus is `tests/falsifiers/INV-PACK-12.json`. Its load-bearing case is
`plain-export-served-where-detailed-was-asked-for`: `spa_sentences.tsv.bz2` and
`spa_sentences_detailed.tsv.bz2` sit in the same directory (verified live 2026-09-12,
along with `spa_sentences_base`, `spa_sentences_CC0`, `spa_sentences_in_lists`,
`spa_sentences_with_audio`, `spa_tags` and `spa_user_languages`), share their first three
columns, and differ in the one column the licence depends on — `username`. Tatoeba is
CC BY 2.0 FR: attribution is the grant, not a courtesy. A loose parser that took
`fields[0..2]` would build a complete ledger with no owner in it and V10 would pass.

So the test asserts two things per case, and the second is the one that matters: the error
NAMES the file it wanted, and the transport was never asked for the near-miss.

The CC0 numbers here are `Content-Length` measurements taken live on 2026-09-12:

    spa_sentences_CC0.tsv.bz2          2,266 bytes
    spa_sentences_detailed.tsv.bz2 9,488,380 bytes
    sentences_cc0.tar.bz2              HTTP 404   (lowercase — R3)
    sentences_CC0.tar.bz2              HTTP 200, 7,958,579 bytes
"""

from __future__ import annotations

import bz2
import json
from pathlib import Path

import pytest
from test_licences import RecordingTransport

from coursekit.config.g0 import (
    MAX_STREAM_BYTES_DEFAULT,
    TATOEBA_CC0_COMPRESSED_BYTES,
    TATOEBA_DETAILED_COLUMNS,
    TATOEBA_HOSTS,
)
from coursekit.inputs import MissingInput
from coursekit.sources import tatoeba
from coursekit.sources.licences import permit

FALSIFIERS = Path(__file__).parent / "falsifiers"
PACK12 = json.loads((FALSIFIERS / "INV-PACK-12.json").read_text(encoding="utf-8"))["cases"]

DETAILED = tatoeba.detailed_export_url("spa")
LINKS = tatoeba.links_export_url("spa")
ENGLISH = tatoeba.l1_export_url()
LAST_MODIFIED = "Sat, 05 Sep 2026 06:33:35 GMT"


def _bz2(rows: list[str]) -> bytes:
    return bz2.compress(("\n".join(rows) + "\n").encode())


def _exports(
    *,
    detailed: list[str] | None = None,
    links: list[str] | None = None,
    english: list[str] | None = None,
) -> dict[str, bytes]:
    return {
        DETAILED: _bz2(
            detailed
            if detailed is not None
            else [
                "2481\tspa\t¡Intentemos algo!\tShishir\t\\N\t2010-08-08 23:28:48",
                "2482\tspa\tTengo que irme a dormir.\tShishir\t\\N\t2010-09-25 23:27:04",
                "2483\tspa\t¿Qué estás haciendo?\t\\N\t\\N\t2014-01-30 00:05:18",
            ]
        ),
        LINKS: _bz2(links if links is not None else ["2481\t11", "2482\t12", "2483\t13"]),
        ENGLISH: _bz2(
            english
            if english is not None
            else [
                "11\teng\tLet's try something!",
                "12\teng\tI have to go to sleep.",
                "13\teng\tWhat are you doing?",
            ]
        ),
    }


def _transport(**overrides: list[str] | None) -> RecordingTransport:
    return RecordingTransport(
        _exports(**overrides),  # type: ignore[arg-type]
        headers={DETAILED: {"last-modified": LAST_MODIFIED}},
    )


# ---------------------------------------------------------------------------
# The happy path, so the refusals below are not vacuous
# ---------------------------------------------------------------------------


def test_a_pair_build_is_three_files_joined_on_id() -> None:
    """The per-pair export is IDS ONLY: no join, no pair."""
    granted = permit("tatoeba", "es")
    transport = _transport()
    stamped, pairs = tatoeba.fetch_pairs(granted, transport, max_pairs=10)
    rows = list(pairs)
    assert [row.text for row in rows] == [
        "¡Intentemos algo!",
        "Tengo que irme a dormir.",
        "¿Qué estás haciendo?",
    ]
    assert rows[0].translation == "Let's try something!"
    assert set(transport.requests) >= {LINKS, ENGLISH, DETAILED}
    assert stamped.corpus_version == "2026-09-05"


def test_the_per_sentence_owner_is_carried_and_a_null_owner_is_empty_not_the_literal() -> None:
    """V10 needs a per-sentence attribution row. Tatoeba writes `\\N` for an absent owner,
    and a ledger crediting a contributor called "\\N" is worse than one crediting the
    corpus — so the fetcher returns empty and G0 falls back to the corpus-level owner."""
    granted = permit("tatoeba", "es")
    rows = list(tatoeba.fetch_pairs(granted, _transport(), max_pairs=10)[1])
    assert rows[0].owner == "Shishir"
    assert rows[2].owner == ""


def test_the_detailed_export_is_the_one_with_the_owner_column() -> None:
    assert TATOEBA_DETAILED_COLUMNS[3] == "username"
    assert len(TATOEBA_DETAILED_COLUMNS) == 6
    assert DETAILED.endswith("/per_language/spa/spa_sentences_detailed.tsv.bz2")
    assert ENGLISH.endswith("/per_language/eng/eng_sentences.tsv.bz2")
    assert LINKS.endswith("/per_language/spa/spa-eng_links.tsv.bz2")


def test_only_the_tatoeba_host_is_reachable_under_a_tatoeba_permit() -> None:
    assert TATOEBA_HOSTS == ("downloads.tatoeba.org",)


# ---------------------------------------------------------------------------
# The cap, on all three files
# ---------------------------------------------------------------------------


def test_the_english_export_stops_once_every_linked_id_has_text() -> None:
    """ "Capped" has to hold for the English side too, or every run pays ~100 MB.

    The English export is a LOOKUP TABLE for the ids the links file named, not a corpus
    this build reads, and under `--max-pairs 2000` against Tatoeba's ~2 M English
    sentences the wanted ids are a small prefix. Reading past the last one is pure waste
    that no output difference would ever reveal — so the assertion is made structural: a
    row that would RAISE if it were parsed sits immediately after the last wanted id. If
    the reader runs on, the test fails with `WrongExportShape`; if it stops, the row is
    never looked at.
    """
    granted = permit("tatoeba", "es")
    transport = _transport(
        links=["2481\t11", "2482\t12"],
        english=[
            "11\teng\tLet's try something!",
            "12\teng\tI have to go to sleep.",
            "13\teng\tWhat are you doing?\tAN\tEXTRA\tCOLUMN",  # would raise if parsed
        ],
        detailed=[
            "2481\tspa\t¡Intentemos algo!\tShishir\t\\N\t2010-08-08 23:28:48",
            "2482\tspa\tTengo que irme a dormir.\tShishir\t\\N\t2010-09-25 23:27:04",
        ],
    )
    rows = list(tatoeba.fetch_pairs(granted, transport, max_pairs=10)[1])
    assert [row.sentence_id for row in rows] == [2481, 2482]


def test_the_links_and_target_exports_are_both_capped_at_max_pairs() -> None:
    """The other two sides of the same property, so "capped" is not one file's habit."""
    granted = permit("tatoeba", "es")
    rows = list(tatoeba.fetch_pairs(granted, _transport(), max_pairs=1)[1])
    assert len(rows) == 1


def test_a_pathological_export_hits_the_compressed_byte_ceiling_and_raises() -> None:
    """MAX_STREAM_BYTES_DEFAULT is a runaway guard, and it stops rather than truncating.

    A short ledger nobody was told about is the outcome this exists to prevent, so
    exceeding the ceiling raises with the file named instead of quietly returning what it
    had. Driven at `_rows` directly because the real ceiling is two gigabytes and a test
    that allocated that would be the disk risk it is guarding against.
    """
    granted = permit("tatoeba", "es")
    transport = _transport()
    gated = tatoeba.open_transport(granted, transport, hosts=TATOEBA_HOSTS)
    with pytest.raises(tatoeba.WrongExportShape) as raised:
        list(
            tatoeba._rows(
                gated,
                ENGLISH,
                ("id", "lang", "text"),
                remedy="the eng sentences export",
                max_bytes=8,
            )
        )
    assert "compressed bytes" in str(raised.value)
    assert MAX_STREAM_BYTES_DEFAULT == 2_000_000_000


# ---------------------------------------------------------------------------
# INV-PACK-12
# ---------------------------------------------------------------------------


def test_the_falsifier_corpus_was_actually_read() -> None:
    assert len(PACK12) >= 6
    assert any("serve_instead" in case for case in PACK12)


def test_INV_PACK_12_a_missing_export_names_itself_and_no_near_miss_is_requested() -> None:
    """[INV-PACK-12] every missing per-language input fails loudly with the input NAMED.

    Driven by the three `absent` cases in the falsifier corpus, each of which also names
    the files that must never be asked for — the whole content of "no silent fallback".
    """
    granted = permit("tatoeba", "es")
    checked = 0
    for case in PACK12:
        if "absent" not in case:
            continue
        checked += 1
        files = _exports()
        gone = next(url for url in files if url.endswith(str(case["absent"])))
        del files[gone]
        transport = RecordingTransport(files, headers={DETAILED: {"last-modified": LAST_MODIFIED}})

        with pytest.raises(MissingInput) as raised:
            _stamped, pairs = tatoeba.fetch_pairs(granted, transport, max_pairs=10)
            list(pairs)
        assert str(case["must_name"]) in str(raised.value), case["id"]
        for forbidden in case["must_not_request"]:
            assert not transport.asked_for(str(forbidden)), f"{case['id']} reached {forbidden}"
    assert checked == 3


def test_INV_PACK_12_a_differently_shaped_file_is_never_accepted_as_a_substitute() -> None:
    """[INV-PACK-12] the plain export shares three columns with the detailed one.

    Three columns where six are declared: a parser taking `fields[0..2]` finds every id and
    every text it wanted and emits a ledger with no owner. The column count is checked
    exactly, not as a minimum, and the two `serve_instead` cases prove it in both
    directions — too few columns and too many.
    """
    granted = permit("tatoeba", "es")
    checked = 0
    for case in PACK12:
        served = case.get("serve_instead")
        if not served:
            continue
        checked += 1
        files = _exports()
        target = next(url for url in files if url.endswith(str(served["url_suffix"])))
        files[target] = _bz2([str(row) for row in served["rows"]])
        transport = RecordingTransport(files, headers={DETAILED: {"last-modified": LAST_MODIFIED}})

        with pytest.raises(tatoeba.WrongExportShape) as raised:
            _stamped, pairs = tatoeba.fetch_pairs(granted, transport, max_pairs=10)
            list(pairs)
        message = str(raised.value)
        assert str(case["must_name"]) in message, case["id"]
        assert "columns" in message
    assert checked == 2


def test_INV_PACK_12_a_missing_version_header_stops_the_build() -> None:
    """[INV-PACK-12] Tatoeba has no version in its URLs — the export date IS the version.

    A run that cannot say which weekly rebuild it read produces a provenance row nobody
    can check, and a pack built from two different weeks stamped as one is exactly the
    claim V10 exists to make checkable.
    """
    granted = permit("tatoeba", "es")
    transport = RecordingTransport(_exports())  # no last-modified anywhere
    with pytest.raises(MissingInput) as raised:
        tatoeba.fetch_pairs(granted, transport, max_pairs=10)
    assert "Last-Modified" in str(raised.value)


def test_INV_PACK_12_the_frequency_list_for_japanese_refuses_before_a_url_exists() -> None:
    """[INV-PACK-12] EC-PACK-08 itself: `ja_50k.txt` is a 404 and `ja_full.txt` is not it.

    `content/2018/ja/` holds only `ja_full.txt` and `ja_ignored.txt`, whose
    whitespace-tokenised "words" are sentence fragments. A fetch loop templated over four
    languages must stop here — and it stops at RESOLUTION, before a URL is built, which is
    the only place a fallback could not be added later by accident.
    """
    from coursekit.inputs import resolve

    with pytest.raises(MissingInput) as raised:
        resolve("hermitdave", "ja")
    assert "hermitdave" in str(raised.value)
    assert "ja_50k.txt" in str(raised.value) or "404" in str(raised.value)
    assert resolve("hermitdave", "es").url is not None


# ---------------------------------------------------------------------------
# The CC0 measurements (R3, R4)
# ---------------------------------------------------------------------------


def test_the_cc0_archive_is_uppercase_and_the_per_language_form_matches() -> None:
    """R3, re-verified live 2026-09-12: lowercase 404s, uppercase is 7,958,579 bytes."""
    assert tatoeba.cc0_global_archive_url().endswith("/sentences_CC0.tar.bz2")
    assert "sentences_cc0" not in tatoeba.cc0_global_archive_url()
    assert tatoeba.cc0_export_url("spa").endswith("/spa_sentences_CC0.tsv.bz2")


def test_the_spanish_cc0_subset_is_2266_bytes_and_therefore_not_a_route() -> None:
    """R4, re-verified live 2026-09-12 by Content-Length.

    2,266 compressed bytes against 9,488,380 for the full `spa` detailed export. "Use the
    CC0 subset and skip the credits screen" is not a tradeoff for this language set, it is
    the end of three of the four courses — which is why INV-PACK-17 and S152 exist.
    """
    assert TATOEBA_CC0_COMPRESSED_BYTES["spa"] == 2266
    assert TATOEBA_CC0_COMPRESSED_BYTES["deu"] == 1852
    assert TATOEBA_CC0_COMPRESSED_BYTES["jpn"] == 228
    assert TATOEBA_CC0_COMPRESSED_BYTES["fra"] == 313297
    assert tatoeba.cc0_is_a_viable_pool("fra") is True
    for iso3 in ("spa", "deu", "jpn"):
        assert tatoeba.cc0_is_a_viable_pool(iso3) is False
