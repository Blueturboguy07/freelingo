"""OPUS: the metadata API, the pair-direction rule, and a capped read of a huge archive.

Two facts set the shape of this module, both measured live on 2026-09-12:

1. **The pair segment is the two ISO-639-1 codes sorted alphabetically.** `en-es`,
   `en-fr`, `en-ja` — but `de-en`. `object.pouta.csc.fi/OPUS-NLLB/v1/moses/en-de.txt.zip`
   returns **404**; `de-en.txt.zip` returns **200, 21,180,847,796 bytes**. `deep/10` calls
   this "the single most common build-script bug", and it is silent in the worst way: the
   wrong spelling 404s, and a fetcher with a fallback then quietly ingests another corpus.
   So a 404 here raises `NotFound` naming the correct direction, and there is no fallback
   anywhere in this file.

2. **`en-es` is 40,327,884,789 bytes.** The pipeline never downloads it. The API is asked
   for the archive's URL and pair count, the archive's central directory is read from its
   tail with a ranged request, and then only the FRONT of each of the two moses members is
   pulled — enough for `--max-pairs`, which defaults to 2,000,000. That is ~0.5% of the
   archive and about eight times the raw candidate count the ledger needs.

   Sequential streaming cannot do this. A moses archive holds one member per side, and
   the second member begins after the first has ended, so reaching the target side of a
   40 GB archive by streaming means reading 40 GB. Ranged reads of the directory and of
   each member's front are what make "capped" and "streamed" the same sentence.

The API is also the only way to learn what `version=latest` resolved to, and it returns
**no licence field at all** — the licence comes from `/legacy/{CORPUS}-{VERSION}.php` and
is carried on the permit (`sources/licences.py`). Its `size` field is not trustworthy for
NLLB: measured `1` for `en-es` against a 40.3 GB archive (review R2), so nothing here
decides anything from it.
"""

from __future__ import annotations

import codecs
import json
import struct
import zlib
from collections.abc import Iterator
from dataclasses import dataclass

from ..config import L1
from ..config.g0 import (
    MAX_MEMBER_BYTES_DEFAULT,
    MAX_PAIRS_DEFAULT,
    OPUS_API_QUERY,
    OPUS_API_URL,
    OPUS_CORPUS_BY_SOURCE,
    OPUS_DOWNLOAD_URL,
    OPUS_HOSTS,
    OPUS_LEGACY_LICENCE_PAGE,
    OPUS_MOSES_MEMBER,
    OPUS_PAIR_RULE,
    OPUS_PREPROCESSING,
    OPUS_STALE_SIZE_SOURCES,
    OPUS_VERSION_SELECTOR,
    ZIP32_SENTINEL,
    ZIP64_EXTRA_ID,
    ZIP_CENTRAL_HEADER,
    ZIP_DIRECTORY_TAIL_BYTES,
    ZIP_EOCD,
    ZIP_EOCD64,
    ZIP_EOCD64_LOCATOR,
    ZIP_LOCAL_HEADER,
    ZIP_METHOD_DEFLATE,
    ZIP_METHOD_STORE,
    ZIP_RANGE_SLICE_BYTES,
)
from ..inputs import MissingInput, opus_pair
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
    "OpusArchiveError",
    "OpusCorpusInfo",
    "api_url",
    "describe",
    "download_url",
    "legacy_licence_page",
    "member_names",
    "stream_pairs",
]


class OpusArchiveError(MissingInput):
    """The archive is not the shape a moses pair archive is.

    A `MissingInput`, not a generic error: from the caller's point of view "the corpus
    file is not what it claims to be" and "the corpus file is not there" need the same
    loud stop with the file named, which is INV-PACK-12.
    """


@dataclass(frozen=True, slots=True)
class OpusCorpusInfo:
    """One row of the OPUS API's `corpora` array, as this pipeline uses it."""

    corpus: str
    version: str
    pair: str
    url: str
    alignment_pairs: int
    #: KB, per the API. Kept for the runlog and NEVER used to make a decision: R2
    #: measured NLLB reporting 1 for en-es (40.3 GB) and 0 for de-en (21.2 GB).
    size_kb: int
    source_tokens: int
    target_tokens: int

    @property
    def size_is_trustworthy(self) -> bool:
        return self.corpus.lower() not in OPUS_STALE_SIZE_SOURCES


# ---------------------------------------------------------------------------
# URLs
# ---------------------------------------------------------------------------


def _corpus_of(source_id: str) -> tuple[str, str]:
    entry = OPUS_CORPUS_BY_SOURCE.get(source_id)
    if entry is None:
        raise MissingInput(
            f"{source_id!r} is not an OPUS corpus. config/g0.py OPUS_CORPUS_BY_SOURCE names "
            f"{', '.join(sorted(OPUS_CORPUS_BY_SOURCE))}. A corpus with no entry there has no "
            f"version and no legacy licence page, and must not be fetched."
        )
    return entry


def api_url(source_id: str, lang: str) -> str:
    """The metadata query for one corpus and one language pair.

    `source`/`target` are the API's own argument names and are ordered L1-first; they are
    NOT the pair segment, which is alphabetical. Keeping both spellings in one function is
    deliberate — they disagree for German, and every time they have been derived from each
    other somebody has shipped `en-de`.
    """
    corpus, _ = _corpus_of(source_id)
    return OPUS_API_URL + OPUS_API_QUERY.format(
        corpus=corpus,
        source=L1,
        target=lang,
        preprocessing=OPUS_PREPROCESSING,
        version=OPUS_VERSION_SELECTOR,
    )


def download_url(source_id: str, lang: str) -> str:
    """The archive URL, built the way the API builds it. Used only in messages."""
    corpus, version = _corpus_of(source_id)
    return OPUS_DOWNLOAD_URL.format(corpus=corpus, version=version, pair=opus_pair(lang))


def legacy_licence_page(source_id: str) -> str:
    corpus, version = _corpus_of(source_id)
    return OPUS_LEGACY_LICENCE_PAGE.format(corpus=corpus, version=version)


def member_names(corpus: str, lang: str) -> tuple[str, str]:
    """The two moses member names, `(l1_member, lang_member)`.

    Both carry the ALPHABETICAL pair segment in the middle and the plain language code at
    the end: `NLLB.en-es.en` and `NLLB.en-es.es`; for German, `NLLB.de-en.en` and
    `NLLB.de-en.de`.

    Formatted from `config.g0.OPUS_MOSES_MEMBER` rather than spelled here, so the naming
    rule has exactly one definition: a second spelling of a constant is the constant not
    doing its job.
    """
    pair = opus_pair(lang)
    return (
        OPUS_MOSES_MEMBER.format(corpus=corpus, pair=pair, lang=L1),
        OPUS_MOSES_MEMBER.format(corpus=corpus, pair=pair, lang=lang),
    )


# ---------------------------------------------------------------------------
# Metadata
# ---------------------------------------------------------------------------


def describe(granted: IngestPermit, transport: Transport) -> OpusCorpusInfo:
    """Ask the API what this corpus/pair is, or fail loudly naming the direction.

    An empty `corpora` array and a 404 are the same answer — "that pair does not exist" —
    and both raise. The message states the alphabetical rule and the URL the caller should
    have asked for, because the operator reading it has almost certainly written the pair
    the wrong way round.
    """
    require(granted)
    gated = open_transport(granted, transport, hosts=OPUS_HOSTS)
    url = api_url(granted.source_id, granted.lang)
    try:
        reply = gated.get(url)
    except NotFound as exc:
        raise NotFound(f"{url} -> 404. {OPUS_PAIR_RULE}") from exc
    if reply.status_code == 404:
        raise NotFound(f"{url} -> 404. {OPUS_PAIR_RULE}")
    if not reply.ok:
        raise OpusArchiveError(f"{url} -> HTTP {reply.status_code}; the OPUS API is not answering.")

    try:
        payload = json.loads(reply.text)
    except json.JSONDecodeError as exc:
        raise OpusArchiveError(f"{url} did not return JSON: {exc}") from exc

    rows = payload.get("corpora") or []
    if not rows:
        corpus, _ = _corpus_of(granted.source_id)
        raise NotFound(
            f"the OPUS API has no {corpus} corpus for {L1}-{granted.lang} with "
            f"preprocessing={OPUS_PREPROCESSING}. {OPUS_PAIR_RULE} Expected archive: "
            f"{download_url(granted.source_id, granted.lang)}. This is a hard build failure: "
            f"there is no fallback to another corpus."
        )

    row = rows[0]
    return OpusCorpusInfo(
        corpus=str(row["corpus"]),
        version=str(row["version"]),
        pair=opus_pair(granted.lang),
        url=str(row["url"]),
        alignment_pairs=int(row.get("alignment_pairs") or 0),
        size_kb=int(row.get("size") or 0),
        source_tokens=int(row.get("source_tokens") or 0),
        target_tokens=int(row.get("target_tokens") or 0),
    )


# ---------------------------------------------------------------------------
# A zip directory, read from the tail
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ZipMember:
    name: str
    method: int
    compressed_size: int
    uncompressed_size: int
    local_header_offset: int


def _zip64_extra(extra: bytes, needs: list[str]) -> dict[str, int]:
    """Pull the fields a 32-bit header punted into the zip64 extended-information block.

    `needs` is the ordered list of field names whose 32-bit slots held the sentinel; the
    zip64 block stores exactly those, in that order, as 8-byte values (offset is 8 bytes
    too, per APPNOTE §4.5.3). Order matters and is the part implementations get wrong.
    """
    at = 0
    while at + 4 <= len(extra):
        header_id, size = struct.unpack_from("<HH", extra, at)
        at += 4
        if header_id != ZIP64_EXTRA_ID:
            at += size
            continue
        out: dict[str, int] = {}
        cursor = at
        for name in needs:
            if cursor + 8 > at + size:
                break
            (out[name],) = struct.unpack_from("<Q", extra, cursor)
            cursor += 8
        return out
    return {}


def _read_directory(gated: Transport, url: str) -> list[ZipMember]:
    """The central directory of a possibly-40 GB archive, from two ranged reads.

    Read the tail, find the end-of-central-directory record (and the zip64 pair when the
    32-bit fields are saturated, which every OPUS pair archive worth capping is), then
    read the directory itself. Two requests, about 64 KB each.
    """
    try:
        tail = gated.get(url, byte_range=(-ZIP_DIRECTORY_TAIL_BYTES, None))
    except NotFound as exc:
        raise NotFound(f"{url} -> 404. {OPUS_PAIR_RULE}") from exc
    if tail.status_code == 404:
        raise NotFound(f"{url} -> 404. {OPUS_PAIR_RULE}")
    if not tail.ok and tail.status_code != 206:
        raise OpusArchiveError(
            f"{url} -> HTTP {tail.status_code} for a ranged request. The archive host must "
            f"support Range: a capped read is the only way to take {MAX_PAIRS_DEFAULT} pairs "
            f"out of an archive this size."
        )
    blob = tail.content
    total = _total_size(tail.headers.get("content-range"), len(blob))
    tail_start = total - len(blob)

    eocd_at = blob.rfind(ZIP_EOCD)
    if eocd_at < 0:
        raise OpusArchiveError(
            f"{url} has no end-of-central-directory record in its last "
            f"{ZIP_DIRECTORY_TAIL_BYTES} bytes; it is not a zip archive."
        )
    cd_size, cd_offset = struct.unpack_from("<II", blob, eocd_at + 12)

    if cd_offset == ZIP32_SENTINEL or cd_size == ZIP32_SENTINEL:
        locator_at = blob.rfind(ZIP_EOCD64_LOCATOR, 0, eocd_at)
        if locator_at < 0:
            raise OpusArchiveError(f"{url} needs a zip64 locator and has none.")
        (eocd64_offset,) = struct.unpack_from("<Q", blob, locator_at + 8)
        eocd64_at = eocd64_offset - tail_start
        if eocd64_at < 0 or blob[eocd64_at : eocd64_at + 4] != ZIP_EOCD64:
            raise OpusArchiveError(f"{url}: the zip64 record is outside the tail that was read.")
        cd_size, cd_offset = struct.unpack_from("<QQ", blob, eocd64_at + 40)

    directory = gated.get(url, byte_range=(cd_offset, cd_offset + cd_size - 1)).content
    return _parse_directory(directory, url)


def _total_size(content_range: str | None, fallback: int) -> int:
    """`bytes 40327819253-40327884788/40327884789` -> 40327884789."""
    if content_range and "/" in content_range:
        size = content_range.rsplit("/", 1)[1].strip()
        if size.isdigit():
            return int(size)
    return fallback


def _parse_directory(blob: bytes, url: str) -> list[ZipMember]:
    members: list[ZipMember] = []
    at = 0
    while at + 46 <= len(blob) and blob[at : at + 4] == ZIP_CENTRAL_HEADER:
        method = struct.unpack_from("<H", blob, at + 10)[0]
        csize, usize = struct.unpack_from("<II", blob, at + 20)
        name_len, extra_len, comment_len = struct.unpack_from("<HHH", blob, at + 28)
        (offset,) = struct.unpack_from("<I", blob, at + 42)
        name = blob[at + 46 : at + 46 + name_len].decode("utf-8", "replace")
        extra = blob[at + 46 + name_len : at + 46 + name_len + extra_len]

        needs = [
            name
            for name, value in (
                ("uncompressed_size", usize),
                ("compressed_size", csize),
                ("local_header_offset", offset),
            )
            if value == ZIP32_SENTINEL
        ]
        wide = _zip64_extra(extra, needs) if needs else {}
        members.append(
            ZipMember(
                name=name,
                method=method,
                compressed_size=wide.get("compressed_size", csize),
                uncompressed_size=wide.get("uncompressed_size", usize),
                local_header_offset=wide.get("local_header_offset", offset),
            )
        )
        at += 46 + name_len + extra_len + comment_len
    if not members:
        raise OpusArchiveError(f"{url}: the central directory holds no entries.")
    return members


def _member_lines(
    gated: Transport,
    url: str,
    member: ZipMember,
    *,
    max_lines: int,
    max_bytes: int,
) -> Iterator[str]:
    """The first `max_lines` lines of one member, from the front of its compressed data.

    Ranged requests of `ZIP_RANGE_SLICE_BYTES`, starting at the member's local header,
    which is parsed once to skip the name and extra fields; `zlib.decompressobj(-15)` over
    what follows. The loop stops the moment `max_lines` is reached, so peak memory is one
    slice and the bytes actually pulled are proportional to `--max-pairs`, not to the
    archive. That is what makes this bounded rather than "download the corpus, then slice".

    The final, possibly truncated line is dropped: it is an artefact of where the cap fell,
    not a sentence, and a half sentence in the ledger is indistinguishable from a real
    short one.
    """
    if member.method not in (ZIP_METHOD_STORE, ZIP_METHOD_DEFLATE):
        raise OpusArchiveError(
            f"{member.name} in {url} uses compression method {member.method}; a moses archive "
            f"uses store (0) or deflate (8)."
        )
    # The member's own length is the first bound, `max_bytes` the second. Both are
    # needed: without the first, a STORED member's reader runs straight off the end of
    # its data and starts decoding the NEXT member's local header as sentences — which is
    # exactly what a test caught before this line existed.
    remaining = min(max_bytes, member.compressed_size or max_bytes)
    at = member.local_header_offset
    decompressor = zlib.decompressobj(-zlib.MAX_WBITS)
    # Incremental, for the same reason as `sources/tatoeba.py`: an inflate block ends
    # wherever it ends, and a multi-byte character straddling two of them must not become
    # two replacement characters.
    text = codecs.getincrementaldecoder("utf-8")("replace")
    pending = ""
    emitted = 0
    header_seen = False

    while True:
        if header_seen and remaining <= 0:
            return
        take = ZIP_RANGE_SLICE_BYTES if not header_seen else min(ZIP_RANGE_SLICE_BYTES, remaining)
        blob = gated.get(url, byte_range=(at, at + take - 1)).content
        if not blob:
            return
        at += len(blob)

        if not header_seen:
            if blob[:4] != ZIP_LOCAL_HEADER:
                raise OpusArchiveError(
                    f"{url}: no local file header at offset {member.local_header_offset} for "
                    f"{member.name}; the central directory and the archive disagree."
                )
            name_len, extra_len = struct.unpack_from("<HH", blob, 26)
            blob = blob[30 + name_len + extra_len :]
            header_seen = True
        if len(blob) > remaining:
            blob = blob[:remaining]
        remaining -= len(blob)

        raw = blob if member.method == ZIP_METHOD_STORE else decompressor.decompress(blob)
        if raw:
            pending += text.decode(raw)
            lines = pending.split("\n")
            pending = lines.pop()
            for line in lines:
                yield line.rstrip("\r")
                emitted += 1
                if emitted >= max_lines:
                    return
        if member.method == ZIP_METHOD_DEFLATE and decompressor.eof:
            return
    # `pending` is deliberately dropped: see the docstring.


# ---------------------------------------------------------------------------
# The fetcher
# ---------------------------------------------------------------------------


@register_fetcher("nllb")
def stream_pairs(
    granted: IngestPermit,
    transport: Transport,
    *,
    max_pairs: int = MAX_PAIRS_DEFAULT,
    max_member_bytes: int = MAX_MEMBER_BYTES_DEFAULT,
) -> tuple[IngestPermit, OpusCorpusInfo, Iterator[tuple[str, str]]]:
    """`(permit-with-version, corpus info, an iterator of (lang_text, l1_text))`.

    The permit comes back carrying the version the API actually resolved, so a row can
    never carry a licence read from one version's page and text from another.

    Pairs are line-aligned across the two members, so the two capped reads are zipped by
    index. A pair whose either side is blank is dropped here rather than downstream: moses
    files do contain empty lines, and an empty "sentence" that reached G1 would become a
    zero-token analysed row that every later validator has to special-case.
    """
    require(granted)
    gated = open_transport(granted, transport, hosts=OPUS_HOSTS)
    info = describe(granted, transport)
    stamped = with_corpus_version(granted, info.corpus, info.version)

    directory = _read_directory(gated, info.url)
    by_name = {member.name: member for member in directory}
    l1_name, lang_name = member_names(info.corpus, granted.lang)
    for wanted in (l1_name, lang_name):
        if wanted not in by_name:
            raise OpusArchiveError(
                f"{info.url} has no member named {wanted!r}; it holds "
                f"{', '.join(sorted(by_name))}. {OPUS_PAIR_RULE}"
            )

    def pairs() -> Iterator[tuple[str, str]]:
        l1_lines = _member_lines(
            gated, info.url, by_name[l1_name], max_lines=max_pairs, max_bytes=max_member_bytes
        )
        lang_lines = _member_lines(
            gated, info.url, by_name[lang_name], max_lines=max_pairs, max_bytes=max_member_bytes
        )
        for l1_text, lang_text in zip(l1_lines, lang_lines, strict=False):
            if l1_text.strip() and lang_text.strip():
                yield lang_text.strip(), l1_text.strip()

    return stamped, info, pairs()
