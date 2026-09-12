"""Tatoeba: three per-language exports, joined on id, with a per-sentence owner.

**The per-pair export is ids only.** `per_language/spa/spa-eng_links.tsv.bz2` carries
`(spa_id, eng_id)` and no text at all, so a pair build is three files joined on id:

    spa_sentences_detailed.tsv.bz2   id, lang, text, username, date_added, date_modified
    eng_sentences.tsv.bz2            id, lang, text
    spa-eng_links.tsv.bz2            id, translation_id

`sentences_detailed`, not `sentences`, and this is the whole of INV-PACK-12 in one
decision. The plain export has the same first three columns and would parse happily — and
it carries no owner, so V10's "every sentence carries a resolved licence **and attribution
owner**" would pass over a ledger with no owners in it. Tatoeba is CC BY 2.0 FR:
attribution is not decoration, it is the grant. So the plain file is never requested,
never accepted as a substitute, and a row whose column count is not the declared one is
refused by name rather than parsed loosely.

The CC0 escape hatch does not exist for this language set. Measured live 2026-09-12 by
`Content-Length`: `spa_sentences_CC0.tsv.bz2` is **2,266 bytes** (`deu` 1,852, `jpn` 228)
against 9,488,380 for the full `spa` detailed export. Review R4 is confirmed to the byte:
choosing CC0 to avoid the credits screen (S152, reachable from About S137) eliminates
three of the four v1 languages rather than shrinking a pool. French, at 313,297 bytes, is
the only one where the subset is a real thing, and even there it is a sub-pool.

Also confirmed live, R3: the global archive is `sentences_CC0.tar.bz2` — **uppercase**.
Lowercase `sentences_cc0.tar.bz2` returns 404; uppercase returns 200 (7,958,579 bytes).
"""

from __future__ import annotations

import bz2
import codecs
from collections.abc import Iterator
from dataclasses import dataclass

from ..config import ISO3_BY_LANGUAGE
from ..config.g0 import (
    MAX_PAIRS_DEFAULT,
    TATOEBA_CC0_ARCHIVE,
    TATOEBA_CC0_COMPRESSED_BYTES,
    TATOEBA_CC0_PER_LANGUAGE,
    TATOEBA_CC0_VIABLE_ISO3,
    TATOEBA_DETAILED_COLUMNS,
    TATOEBA_EXPORT_BASE,
    TATOEBA_HOSTS,
    TATOEBA_L1_ISO3,
    TATOEBA_L1_SENTENCES,
    TATOEBA_LINKS,
    TATOEBA_LINKS_COLUMNS,
    TATOEBA_NULL_OWNER,
    TATOEBA_PER_LANGUAGE_DIR,
    TATOEBA_REBUILD_NOTE,
    TATOEBA_SENTENCES_COLUMNS,
    TATOEBA_SENTENCES_DETAILED,
)
from ..inputs import MissingInput
from . import register_fetcher
from .licences import (
    IngestPermit,
    NotFound,
    Transport,
    open_transport,
    require,
    with_corpus_version,
)

__all__ = [
    "TatoebaPair",
    "WrongExportShape",
    "export_version",
    "cc0_compressed_bytes",
    "cc0_export_url",
    "cc0_is_a_viable_pool",
    "cc0_global_archive_url",
    "detailed_export_url",
    "fetch_pairs",
    "l1_export_url",
    "links_export_url",
]


class WrongExportShape(MissingInput):
    """A Tatoeba export does not have the columns its name promises.

    INV-PACK-12's second half: "no code path can substitute a differently-shaped file". A
    `MissingInput`, because from the build's point of view the file it needed is still
    missing — something else is standing where it should be.
    """


@dataclass(frozen=True, slots=True)
class TatoebaPair:
    """One joined pair, with the per-sentence attribution V10 and INV-PACK-17 need."""

    sentence_id: int
    text: str
    translation: str
    owner: str
    date_added: str
    date_modified: str


# ---------------------------------------------------------------------------
# URLs
# ---------------------------------------------------------------------------


def _dir_for(iso3: str) -> str:
    return TATOEBA_PER_LANGUAGE_DIR.format(base=TATOEBA_EXPORT_BASE, iso3=iso3)


def detailed_export_url(iso3: str) -> str:
    """`…/per_language/spa/spa_sentences_detailed.tsv.bz2` — owner and dates included."""
    return _dir_for(iso3) + TATOEBA_SENTENCES_DETAILED.format(iso3=iso3)


def l1_export_url() -> str:
    """`…/per_language/eng/eng_sentences.tsv.bz2` — the English side, text only."""
    return _dir_for(TATOEBA_L1_ISO3) + TATOEBA_L1_SENTENCES.format(iso3=TATOEBA_L1_ISO3)


def links_export_url(iso3: str) -> str:
    """`…/per_language/spa/spa-eng_links.tsv.bz2` — ids only, which is the point."""
    return _dir_for(iso3) + TATOEBA_LINKS.format(iso3=iso3)


def cc0_export_url(iso3: str) -> str:
    """The per-language CC0 subset. Uppercase `CC0`, per R3."""
    return _dir_for(iso3) + TATOEBA_CC0_PER_LANGUAGE.format(iso3=iso3)


def cc0_global_archive_url() -> str:
    """`…/exports/sentences_CC0.tar.bz2`. UPPERCASE; lowercase 404s (R3)."""
    return f"{TATOEBA_EXPORT_BASE}/{TATOEBA_CC0_ARCHIVE}"


def cc0_compressed_bytes(iso3: str) -> int | None:
    """The measured size of the CC0 subset, or None for a language nobody measured."""
    return TATOEBA_CC0_COMPRESSED_BYTES.get(iso3)


def cc0_is_a_viable_pool(iso3: str) -> bool:
    """Is the CC0 subset large enough to build a course from? Only for `fra`.

    Exists so the answer is a function with the measured numbers behind it rather than an
    assumption somebody re-derives. Attribution (INV-PACK-17, S152) is the shipping path
    for es, de and ja, and this is the line that says so in code.
    """
    return iso3 in TATOEBA_CC0_VIABLE_ISO3


# ---------------------------------------------------------------------------
# Version
# ---------------------------------------------------------------------------


def export_version(gated: Transport, iso3: str) -> str:
    """The export's build date, as its corpus version. One 1-byte ranged request.

    Tatoeba has no version in its per-language URLs — the exports are simply rebuilt in
    place every Saturday at 06:30 UTC — so "which Tatoeba is this?" is answered by the
    file's `Last-Modified` and by nothing else. It has to ride on the row: a pack built
    from two different weeks' exports and stamped with one version is a provenance claim
    nobody can check.
    """
    url = detailed_export_url(iso3)
    try:
        reply = gated.get(url, byte_range=(0, 0))
    except NotFound as exc:
        raise MissingInput(
            f"{url} -> 404 while reading its version. There is no fallback (INV-PACK-12); "
            f"{TATOEBA_REBUILD_NOTE}."
        ) from exc
    stamp = reply.header("last-modified")
    if not stamp:
        raise MissingInput(
            f"{url} returned no Last-Modified header, so this run cannot say WHICH weekly "
            f"export it read. A provenance row nobody can check is worse than a failed "
            f"build (V10, INV-PACK-13)."
        )
    return _as_date(stamp)


def _as_date(http_date: str) -> str:
    """`Sat, 05 Sep 2026 06:33:35 GMT` -> `2026-09-05`, or the header verbatim."""
    from email.utils import parsedate_to_datetime

    try:
        return parsedate_to_datetime(http_date).date().isoformat()
    except (TypeError, ValueError):
        return http_date


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def _rows(
    gated: Transport,
    url: str,
    columns: tuple[str, ...],
    *,
    remedy: str,
) -> Iterator[list[str]]:
    """Stream one bz2 TSV export, refusing a file whose shape is not the declared one.

    The shape check is on the FIRST row and then on every row, and it is exact rather than
    "at least". `sentences` has three columns and `sentences_detailed` has six; accepting
    "at least three" is precisely how a file that carries no owner ends up standing in for
    one that does.
    """
    decompressor = bz2.BZ2Decompressor()
    # An INCREMENTAL decoder, not `bytes.decode` per chunk: bz2 hands back blocks whose
    # boundaries fall wherever they fall, and a multi-byte character split across two of
    # them would decode to two replacement characters. Spanish accents and every Japanese
    # character are multi-byte, so this is not a corner case — it is most of the corpus.
    text = codecs.getincrementaldecoder("utf-8")("replace")
    pending = ""
    number = 0
    try:
        for chunk in gated.stream(url):
            raw = decompressor.decompress(chunk)
            if not raw:
                continue
            pending += text.decode(raw)
            lines = pending.split("\n")
            pending = lines.pop()
            for line in lines:
                line = line.rstrip("\r")
                if not line:
                    continue
                number += 1
                fields = line.split("\t")
                if len(fields) != len(columns):
                    raise WrongExportShape(
                        f"{url} line {number} has {len(fields)} columns; "
                        f"{', '.join(columns)} is {len(columns)}. A differently-shaped export "
                        f"is never accepted as a substitute (INV-PACK-12): the plain "
                        f"`sentences` export shares its first three columns with "
                        f"`sentences_detailed` and carries no owner, which would make V10 pass "
                        f"over a ledger with no attribution in it."
                    )
                yield fields
    except NotFound as exc:
        raise MissingInput(
            f"{url} -> 404. The build needs this exact file; there is no substitute and no "
            f"fallback (INV-PACK-12). Remedy: {remedy} ({TATOEBA_REBUILD_NOTE})."
        ) from exc
    if pending.strip():
        fields = pending.rstrip("\r").split("\t")
        if len(fields) == len(columns):
            yield fields


@register_fetcher("tatoeba")
def fetch_pairs(
    granted: IngestPermit,
    transport: Transport,
    *,
    max_pairs: int = MAX_PAIRS_DEFAULT,
) -> tuple[IngestPermit, Iterator[TatoebaPair]]:
    """`(permit, an iterator of joined pairs)`. Three files, one join, no fallbacks.

    Read in the order that keeps memory proportional to the PAIR count rather than to
    Tatoeba: links first (which is the only file that says which English sentences matter),
    then the English side filtered to those ids, then the target side streamed.
    """
    require(granted)
    iso3 = ISO3_BY_LANGUAGE[granted.lang]
    gated = open_transport(granted, transport, hosts=TATOEBA_HOSTS)

    links_url = links_export_url(iso3)
    l1_url = l1_export_url()
    detailed_url = detailed_export_url(iso3)

    translation_of: dict[int, int] = {}
    for fields in _rows(
        gated,
        links_url,
        TATOEBA_LINKS_COLUMNS,
        remedy=f"the per-language links export for {iso3}-{TATOEBA_L1_ISO3}",
    ):
        try:
            left, right = int(fields[0]), int(fields[1])
        except ValueError:
            continue
        translation_of.setdefault(left, right)
        if len(translation_of) >= max_pairs:
            break

    wanted = set(translation_of.values())
    l1_text: dict[int, str] = {}
    for fields in _rows(
        gated,
        l1_url,
        TATOEBA_SENTENCES_COLUMNS,
        remedy=f"the {TATOEBA_L1_ISO3} sentences export",
    ):
        try:
            identifier = int(fields[0])
        except ValueError:
            continue
        if identifier in wanted:
            l1_text[identifier] = fields[2]

    # Last, deliberately. The ids file is the only one that says which pairs exist, and
    # the English side is the only one that says whether they have text; a build that
    # pulled the 9.5 MB target-side export first and only then discovered it had no
    # alignment would read as a slow network rather than as a missing input.
    stamped = with_corpus_version(granted, "Tatoeba", export_version(gated, iso3))

    def pairs() -> Iterator[TatoebaPair]:
        emitted = 0
        for fields in _rows(
            gated,
            detailed_url,
            TATOEBA_DETAILED_COLUMNS,
            remedy=f"the {iso3} sentences_detailed export (owner + dates; V10 needs both)",
        ):
            try:
                identifier = int(fields[0])
            except ValueError:
                continue
            linked = translation_of.get(identifier)
            if linked is None:
                continue
            translation = l1_text.get(linked)
            if translation is None:
                continue
            owner = fields[3].strip()
            yield TatoebaPair(
                sentence_id=identifier,
                text=fields[2],
                translation=translation,
                owner="" if owner in ("", TATOEBA_NULL_OWNER) else owner,
                date_added=fields[4],
                date_modified=fields[5],
            )
            emitted += 1
            if emitted >= max_pairs:
                return

    return stamped, pairs()
