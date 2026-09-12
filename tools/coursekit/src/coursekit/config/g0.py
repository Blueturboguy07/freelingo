"""Constants owned by G0 ingest.

Corpus endpoints, the per-language export filenames, the dedup and length windows, the
register filter, and the script-normalisation rules. Every URL shape and every filename
in here was verified live on 2026-09-12 against the real hosts; the ones the research
corpus stated *wrongly* carry the adversarial-review id (R2, R3, R4, R8) at the row,
because the whole point of `docs/pipeline.md` §5 is that a lane reading the spec instead
of the code gets a failing test rather than a plausible bug.

The file is separate from `config/ingest.py` (which `p2-deps-scaffold` created empty and
left unowned) only because the lane's file list names `config/g0.py`. Nothing imports
`config/ingest.py`.

Owner: p2-g0-ingest
"""

from __future__ import annotations

from typing import Final

# ---------------------------------------------------------------------------
# OPUS
# ---------------------------------------------------------------------------

#: The OPUS metadata API. It answers with alignment_pairs, token counts, `size` (KB) and
#: the download `url` for one corpus/pair/preprocessing/version — and with **no licence
#: field at all**, which is why `LICENCE_PAGE_BY_SOURCE` exists below.
#:
#: Query it rather than string-building a download URL: the API is the only thing that
#: knows which `version=latest` resolves to, and a hand-built URL that 404s is exactly
#: the failure edge case 1 is about.
OPUS_API_URL: Final[str] = "https://opus.nlpl.eu/opusapi/"

#: `?corpus=NLLB&source=en&target=es&preprocessing=moses&version=latest`.
#: `source`/`target` are the API's own argument names and are NOT the pair segment: the
#: pair segment is alphabetical (see `OPUS_PAIR_RULE`), the query arguments are not.
OPUS_API_QUERY: Final[str] = (
    "?corpus={corpus}&source={source}&target={target}&preprocessing={preprocessing}&version={version}"
)

OPUS_PREPROCESSING: Final[str] = "moses"
OPUS_VERSION_SELECTOR: Final[str] = "latest"

#: The bulk download shape, for the record and for the error message. Verified live
#: 2026-09-12: `de-en.txt.zip` -> 200 (21,180,847,796 B) and `en-de.txt.zip` -> 404.
OPUS_DOWNLOAD_URL: Final[str] = (
    "https://object.pouta.csc.fi/OPUS-{corpus}/{version}/moses/{pair}.txt.zip"
)

#: The readable per-corpus licence page. Non-legacy paths 404; this one is where every
#: OPUS licence string in `config.SOURCES` was read from. See `LICENCE_PAGE_BY_SOURCE`
#: below for where a run records it — the runlog, per corpus, NOT per sentence.
OPUS_LEGACY_LICENCE_PAGE: Final[str] = "https://opus.nlpl.eu/legacy/{corpus}-{version}.php"

#: Source id -> (OPUS corpus name, OPUS version). The forbidden corpora are listed on
#: purpose: R8's finding was that JParaCrawl vanished from every list and a build script
#: templated from the corpus table picked it up. A name with no entry here cannot be
#: fetched at all, and a name with an entry still has to clear the licence gate.
OPUS_CORPUS_BY_SOURCE: Final[dict[str, tuple[str, str]]] = {
    "nllb": ("NLLB", "v1"),
    "opensubtitles": ("OpenSubtitles", "v2024"),
    "ccmatrix": ("CCMatrix", "v1"),
    "ted2020": ("TED2020", "v1"),
    "jparacrawl": ("JParaCrawl", "v3.0"),
}

#: The rule, spelled out, because `deep/10` calls it "the single most common build-script
#: bug" and because the failure is silent when a fetcher has a fallback.
OPUS_PAIR_RULE: Final[str] = (
    "OPUS pair segments are the two ISO-639-1 codes sorted ALPHABETICALLY: "
    "en-es, en-fr, en-ja — but de-en, never en-de. A 404 here is a hard build failure, "
    "never a fallback to another corpus."
)

#: Corpora whose API `size` field is stale and must never be used to decide whether a
#: download is worth making. R2 measured NLLB reporting `size: 1` for en-fr and `0` for
#: de-en while the real archives are 30.1 GB and 21.2 GB.
OPUS_STALE_SIZE_SOURCES: Final[tuple[str, ...]] = ("nllb",)

#: The cap, in aligned pairs, on any OPUS pull. `en-es` alone is 40,327,884,789 bytes
#: (verified live 2026-09-12), so "download the corpus" is not an option the pipeline
#: has. Two million pairs is ~8x the ~250k raw candidates the ledger needs.
MAX_PAIRS_DEFAULT: Final[int] = 2_000_000

#: A second, independent cap, in COMPRESSED bytes off the wire, applied per streamed file
#: by `sources/tatoeba.py`. `max_pairs` alone does not bound a stream whose rows are
#: pathological (a links export that is 99% self-links yields no pairs and never stops),
#: and a build machine that fills its disk is the failure mode the plan's disk risk is
#: about. The OPUS side has its own, tighter, per-member bound below.
MAX_STREAM_BYTES_DEFAULT: Final[int] = 2_000_000_000

#: Moses archives hold one file per side, named `<CORPUS>.<pair>.<lang>`. Spelled once:
#: `sources/opus.py` formats THIS constant rather than re-spelling the pattern, so the
#: member-naming rule has one definition and a test can assert against it.
OPUS_MOSES_MEMBER: Final[str] = "{corpus}.{pair}.{lang}"

#: How many redirect hops `GatedTransport` will follow. Each hop is re-gated — host
#: allow-list and licence verdict — before it is made; httpx never follows one itself
#: (`HttpTransport` sets `follow_redirects=False`). Three is the OPUS API's one hop with
#: room, and a chain longer than this is a host doing something nobody classified.
MAX_REDIRECT_HOPS: Final[int] = 3

#: The only hosts an OPUS permit may reach. `GatedTransport` refuses anything else, so a
#: redirect or a mis-templated URL cannot quietly fetch from somewhere nobody classified.
OPUS_HOSTS: Final[tuple[str, ...]] = ("opus.nlpl.eu", "object.pouta.csc.fi")

#: Bytes of the archive tail read to find the central directory. 64 KB comfortably holds
#: the end-of-central-directory record, the zip64 locator and a two-entry directory.
ZIP_DIRECTORY_TAIL_BYTES: Final[int] = 65_536

#: How much of ONE member is pulled before the reader gives up on reaching `max_pairs`.
#: A moses member of 2,000,000 A1-length lines is tens of megabytes compressed; this is
#: an order of magnitude of headroom and still 0.5% of the 40.3 GB `en-es` archive.
MAX_MEMBER_BYTES_DEFAULT: Final[int] = 400_000_000

#: The member window is pulled in slices this size, and the loop stops the moment
#: `max_pairs` lines have been decoded. So the cap that actually binds is the line count,
#: the byte cap is the backstop, and peak memory is one slice — not one window.
ZIP_RANGE_SLICE_BYTES: Final[int] = 8_388_608

#: Zip record signatures. Named rather than inline so the reader reads as a parser and a
#: reviewer can check them against APPNOTE.TXT §4.3.
ZIP_LOCAL_HEADER: Final[bytes] = b"PK\x03\x04"
ZIP_CENTRAL_HEADER: Final[bytes] = b"PK\x01\x02"
ZIP_EOCD: Final[bytes] = b"PK\x05\x06"
ZIP_EOCD64: Final[bytes] = b"PK\x06\x06"
ZIP_EOCD64_LOCATOR: Final[bytes] = b"PK\x06\x07"

#: The zip64 extended-information extra field id, and the sentinel a 32-bit field carries
#: when the real value lives there. Both are needed: every OPUS pair archive worth
#: capping is over 4 GB, which is exactly when zip64 kicks in.
ZIP64_EXTRA_ID: Final[int] = 0x0001
ZIP32_SENTINEL: Final[int] = 0xFFFFFFFF

#: Deflate and store, the only two methods a moses archive uses.
ZIP_METHOD_STORE: Final[int] = 0
ZIP_METHOD_DEFLATE: Final[int] = 8

# ---------------------------------------------------------------------------
# Tatoeba
# ---------------------------------------------------------------------------

TATOEBA_EXPORT_BASE: Final[str] = "https://downloads.tatoeba.org/exports"
TATOEBA_PER_LANGUAGE_DIR: Final[str] = "{base}/per_language/{iso3}/"

#: ISO-639-3 for the learner's language. Tatoeba keys per-language exports by 639-3, so
#: `en` never appears in one of these paths.
TATOEBA_L1_ISO3: Final[str] = "eng"

#: The three files a pair build needs, and the reason each one is the file it is.
#:
#: `sentences_detailed` rather than `sentences`: it adds the owner and the created /
#: last-modified dates, and V10 needs a PER-SENTENCE attribution row, not a corpus-level
#: one. The plain export has three columns and would parse happily — which is precisely
#: the "differently-shaped file" INV-PACK-12 forbids substituting.
TATOEBA_SENTENCES_DETAILED: Final[str] = "{iso3}_sentences_detailed.tsv.bz2"
TATOEBA_L1_SENTENCES: Final[str] = "{iso3}_sentences.tsv.bz2"
#: The per-pair export is IDS ONLY. A pair build is
#: `{lang}_sentences_detailed` + `eng_sentences` + `{lang}-eng_links`, joined on id.
TATOEBA_LINKS: Final[str] = "{iso3}-eng_links.tsv.bz2"

#: R3: the archive is `sentences_CC0.tar.bz2` — UPPERCASE. Verified live 2026-09-12:
#: lowercase `sentences_cc0.tar.bz2` -> 404, uppercase -> 200 (7,958,579 B).
TATOEBA_CC0_ARCHIVE: Final[str] = "sentences_CC0.tar.bz2"
TATOEBA_CC0_PER_LANGUAGE: Final[str] = "{iso3}_sentences_CC0.tsv.bz2"

#: R4, re-verified live 2026-09-12 by `Content-Length`: the CC0 subset is not a route to
#: avoiding the credits screen, it is a route to having no course. `spa` is 2,266
#: COMPRESSED BYTES against 9,488,380 for the full detailed export.
TATOEBA_CC0_COMPRESSED_BYTES: Final[dict[str, int]] = {
    "spa": 2266,
    "deu": 1852,
    "jpn": 228,
    "fra": 313297,
}

#: The languages for which the CC0 subset is a real pool. Everything else must ship
#: attribution (INV-PACK-17) or not ship at all.
TATOEBA_CC0_VIABLE_ISO3: Final[tuple[str, ...]] = ("fra",)

#: Where the Tatoeba licence string was read from. Recorded in the G0 runlog entry, per
#: corpus — see `LICENCE_PAGE_BY_SOURCE`.
TATOEBA_LICENCE_PAGE: Final[str] = "https://tatoeba.org/en/downloads"

#: Tatoeba rebuilds weekly, Saturdays 06:30 UTC.
TATOEBA_REBUILD_NOTE: Final[str] = "exports rebuild weekly, Saturday 06:30 UTC"

#: The only host a Tatoeba permit may reach.
TATOEBA_HOSTS: Final[tuple[str, ...]] = ("downloads.tatoeba.org",)

#: The column contract for each export. A file whose row does not have exactly this many
#: fields is refused by name rather than parsed loosely — a three-column `sentences`
#: export standing in for the six-column `sentences_detailed` one would produce a ledger
#: with no owner at all and a V10 that passes vacuously.
TATOEBA_DETAILED_COLUMNS: Final[tuple[str, ...]] = (
    "id",
    "lang",
    "text",
    "username",
    "date_added",
    "date_last_modified",
)
TATOEBA_SENTENCES_COLUMNS: Final[tuple[str, ...]] = ("id", "lang", "text")
TATOEBA_LINKS_COLUMNS: Final[tuple[str, ...]] = ("id", "translation_id")

#: Tatoeba writes `\N` for an absent owner. Such a row is credited to the corpus-level
#: owner; it is never emitted with a null owner, because the licence requires attribution.
TATOEBA_NULL_OWNER: Final[str] = "\\N"

# ---------------------------------------------------------------------------
# Licence resolution
# ---------------------------------------------------------------------------

#: The page each source's licence string was resolved FROM (edge case 4: "OPUS licence
#: assumed from the front page" — OPUS grants no blanket licence and its API returns no
#: licence field).
#:
#: WHERE A RUN RECORDS IT, exactly: `stages/g0_ingest.py` writes `notes.licence_pages`
#: ({source_id: url}) into the G0 runlog entry, so the page is PER CORPUS PER RUN. It is
#: **not** on the emitted `ingested_sentence` rows and not on `runlog.LicenceRow`:
#: `artifacts.INGESTED_SENTENCE` is `additionalProperties: false` with no such property
#: and `LicenceRow` has five fixed fields, and both are owned by `p2-deps-scaffold`. A
#: per-sentence page needs a schema change requested there — recorded in
#: `docs/owned/p2-g0-ingest.json` `blockedOn` — and until it lands nothing in this lane
#: claims otherwise. The per-corpus record is still the audit trail edge case 4 needs:
#: every corpus a run read names the page its licence string came from.
#:
#: A source with no page here resolves to `UNRESOLVED_LICENCE` and can never be ingested.
LICENCE_PAGE_BY_SOURCE: Final[dict[str, str]] = {
    "tatoeba": TATOEBA_LICENCE_PAGE,
    "tatoeba_cc0": TATOEBA_LICENCE_PAGE,
    "nllb": "https://opus.nlpl.eu/legacy/NLLB-v1.php",
    "opensubtitles": "https://opus.nlpl.eu/legacy/OpenSubtitles-v2024.php",
    "ccmatrix": "https://opus.nlpl.eu/legacy/CCMatrix-v1.php",
    "ted2020": "https://opus.nlpl.eu/legacy/TED2020-v1.php",
    "jparacrawl": "https://opus.nlpl.eu/legacy/JParaCrawl-v3.0.php",
}

#: The value a licence resolves to when nothing resolved it. It is a real string rather
#: than `None` so it can be searched for, and G9 fails on it — but it must never get that
#: far: a row carrying it is refused at ingest.
UNRESOLVED_LICENCE: Final[str] = "UNRESOLVED"

# ---------------------------------------------------------------------------
# Which corpora each language ingests
# ---------------------------------------------------------------------------

#: Per language, in order. `tatoeba` is the shipped-text pool (attribution-only,
#: CC BY 2.0 FR); `nllb` is ODC-By and rides as the capped selection/validation oracle
#: the plan's corpus posture asks for (R2). Neither list may contain a corpus whose
#: licence is off `INGEST_LICENCE_ALLOW_LIST` — `sources.licences` refuses it anyway, and
#: `tests/test_licences.py` proves the two agree.
INGEST_CORPORA_BY_LANGUAGE: Final[dict[str, tuple[str, ...]]] = {
    "es": ("tatoeba", "nllb"),
    "fr": ("tatoeba", "nllb"),
    "de": ("tatoeba", "nllb"),
    "ja": ("tatoeba", "nllb"),
}

# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------

#: The A1 length window, in tokens, per `scope2/00` §2.3.
MIN_TOKENS: Final[int] = 3
MAX_TOKENS: Final[int] = 12

#: Longest sentence, in characters, that is worth tokenising at all. A guard on the
#: stream, not a linguistic rule.
MAX_CHARS: Final[int] = 400

#: The pre-analysis token pattern is NOT declared here. It lives in `coursekit.ledger`
#: as `letter_runs`, with the pre-analysis counter beside it, because INV-PACK-40's grep
#: gate reads the whole tree and a word-class regex in a config file is the same second
#: definition wherever it is written. G0 calls `ledger.pre_analysis_count`.

#: Languages whose script carries no word spacing, where a whitespace token count is
#: meaningless. Counting whitespace "words" for Japanese is the same mistake edge case 6
#: catches in `ja_full.txt`.
SPACELESS_LANGUAGES: Final[tuple[str, ...]] = ("ja",)
SPACELESS_MIN_CHARS: Final[int] = 4
SPACELESS_MAX_CHARS: Final[int] = 40

#: Unicode normal form applied before the dedup hash and before the ledger. NFC, not
#: NFD: a decomposed "canción" and a composed one are the same sentence, and G1's
#: lemmatiser would otherwise count one lemma twice.
NORMALISATION_FORM: Final[str] = "NFC"

#: Characters stripped before normalisation: zero-width joiners, BOMs and the soft
#: hyphen, all of which survive a round trip and all of which split a dedup bucket.
INVISIBLE_CHARS: Final[tuple[str, ...]] = ("​", "‌", "‍", "﻿", "­")

#: Substrings that mark a row as markup, boilerplate or a crawl artefact rather than a
#: sentence. Crawl-mined bitext (NLLB) is full of these and every one of them would
#: otherwise reach a lesson slot.
REGISTER_REJECT_SUBSTRINGS: Final[tuple[str, ...]] = (
    "http://",
    "https://",
    "www.",
    "<",
    ">",
    "{",
    "}",
    "@",
    "©",
    "&amp;",
    "&nbsp;",
    "[...]",
)

#: The profanity/register deny list, held as lowercase whole tokens so "puta" rejects and
#: "disputa" does not. Deliberately short: this is a lesson-content filter for an A1
#: course, not a moderation system, and a long list here would quietly delete ordinary
#: vocabulary. G6 and the paid reviewer sample are the real quality gates.
PROFANITY_TOKENS: Final[dict[str, tuple[str, ...]]] = {
    "en": ("fuck", "fucking", "shit", "bitch", "cunt", "whore", "bastard", "dick"),
    "es": ("puta", "puto", "mierda", "joder", "coño", "cabrón", "gilipollas", "polla"),
    "fr": ("merde", "putain", "salope", "connard", "enculé", "bite"),
    "de": ("scheiße", "scheisse", "fotze", "arschloch", "hure", "wichser"),
    "ja": ("くそ", "ちくしょう", "ばかやろう"),
}

#: Reject reasons, as they appear in the runlog's `notes.rejected_by`. Named so the
#: counts are comparable across runs and so a spike in one of them is legible.
#:
#: There is no `unresolved_licence` reason here on purpose, and the omission is the
#: invariant: an unresolved licence is not a row G0 *rejects*, it is a build G0 *stops*.
#: A counted rejection would mean the corpus was fetched, parsed and then dropped — which
#: is "filtered at package time" wearing an ingest-shaped coat (INV-PACK-13). `permit()`
#: refuses it before a socket exists, and `stages/g0_ingest._rows` re-asserts it as a
#: raise. `tests/test_g0_ingest.py` asserts the reason set and the raise together, so
#: adding the reason back without changing the behaviour turns that test red.
REJECT_REASONS: Final[tuple[str, ...]] = (
    "too_short",
    "too_long",
    "empty",
    "duplicate",
    "register",
    "profanity",
    "untranslated",
)
