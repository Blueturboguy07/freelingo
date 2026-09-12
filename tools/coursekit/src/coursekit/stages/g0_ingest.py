"""G0 — ingest: licence gate, corpus pull, normalise, filter, dedup, ledger.

The stage is short because the two hard parts live where they can be enforced rather than
remembered:

- **INV-PACK-13** is `sources/licences.py`. A corpus is fetched by handing a fetcher an
  `IngestPermit`, permits are minted by one function, and that function refuses anything
  whose verdict is `forbidden`, whose licence is off `INGEST_LICENCE_ALLOW_LIST`, or whose
  licence has no page it was resolved from. A forbidden corpus therefore makes **zero
  network calls** — not "zero rows in the output", which a filter at the far end would
  also achieve while leaving TED text in every intermediate artefact.
- **INV-PACK-12** is `inputs.py` plus the fetchers' shape checks. Every missing
  per-language input raises with the input NAMED, and a differently-shaped file is never
  accepted as a substitute — `spa_sentences.tsv.bz2` shares three columns with
  `spa_sentences_detailed.tsv.bz2` and carries no owner, so it would make V10 pass over a
  ledger with no attribution in it.

What is left here is the part that is genuinely G0's: turning pairs into `ingested_sentence`
rows. Normalise before the dedup hash (a decomposed "canción" and a composed one are one
sentence, and G1's lemmatiser would otherwise count one lemma twice); length-filter to the
A1 window; drop markup, crawl artefacts, profanity and untranslated rows; dedup; emit.

Two corpora for Spanish, and the difference between them is the whole licence posture.
`tatoeba` is CC BY 2.0 FR and `shippable`: its text may appear verbatim in a pack, and
every row carries the contributor who owns it so S152 can credit them. `nllb` is ODC-By
and `oracle_only`: it is ingested — capped at `--max-pairs`, default 2,000,000, out of an
archive measured at 40,327,884,789 bytes — because the plan uses it for selection and
validation statistics, and it may never fill a lesson slot. `inputs.forbid_unshippable`
is where G4 enforces that; G0's job is to make sure the verdict is on the row.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field

from ..artifacts import dedup_hash, sentence_id, write_records
from ..config import L1
from ..config.g0 import (
    INGEST_CORPORA_BY_LANGUAGE,
    INVISIBLE_CHARS,
    MAX_CHARS,
    MAX_PAIRS_DEFAULT,
    MAX_TOKENS,
    MIN_TOKENS,
    NORMALISATION_FORM,
    PROFANITY_TOKENS,
    REGISTER_REJECT_SUBSTRINGS,
    REJECT_REASONS,
    SPACELESS_LANGUAGES,
    SPACELESS_MAX_CHARS,
    SPACELESS_MIN_CHARS,
    TOKEN_PATTERN,
    UNRESOLVED_LICENCE,
)
from ..inputs import MissingInput
from ..runlog import StageEntry
from ..sources import opus, tatoeba
from ..sources.licences import HttpTransport, IngestPermit, Transport, permit
from . import StageContext, StageResult, register_stage

__all__ = ["Candidate", "IngestReport", "ingest", "normalise", "token_count"]

_TOKEN = re.compile(TOKEN_PATTERN, re.UNICODE)


@dataclass(frozen=True, slots=True)
class Candidate:
    """One pair as it arrives from a fetcher, before G0 has judged it."""

    text: str
    translation: str
    owner: str | None


@dataclass(slots=True)
class IngestReport:
    """What the run did, in the shape the runlog's `notes` wants."""

    read: int = 0
    written: int = 0
    rejected: int = 0
    per_corpus: dict[str, int] = field(default_factory=dict)
    rejected_by: dict[str, int] = field(default_factory=dict)

    def reject(self, reason: str) -> None:
        if reason not in REJECT_REASONS:  # pragma: no cover — a typo, caught in review
            raise ValueError(f"{reason!r} is not one of config/g0.py REJECT_REASONS")
        self.rejected += 1
        self.rejected_by[reason] = self.rejected_by.get(reason, 0) + 1


# ---------------------------------------------------------------------------
# Normalisation and filters
# ---------------------------------------------------------------------------


def normalise(text: str) -> str:
    """NFC, invisibles removed, whitespace collapsed. Applied before the dedup hash.

    NFC rather than NFD, and stripping rather than transliterating: Spanish diacritics are
    lexical (`año` is not `ano`), so a G0 that folded them would merge two lemmas and V1
    would then pass over a ledger that means nothing. What is folded here is only what is
    invisible — zero-width joiners, BOMs, soft hyphens and repeated whitespace — every one
    of which survives a round trip and splits a dedup bucket in two.
    """
    for character in INVISIBLE_CHARS:
        text = text.replace(character, "")
    text = unicodedata.normalize(NORMALISATION_FORM, text)
    return " ".join(text.split())


def token_count(text: str, lang: str) -> int:
    """A rough token count for the LENGTH FILTER ONLY. G1 owns real tokenisation.

    For a language with no word spacing the count is characters, not whitespace "words":
    counting whitespace tokens in Japanese is the same mistake edge case 6 catches in
    `ja_full.txt`, where whitespace-split "words" are sentence fragments.
    """
    if lang in SPACELESS_LANGUAGES:
        return len([character for character in text if not character.isspace()])
    return len(_TOKEN.findall(text))


def _length_verdict(text: str, lang: str) -> tuple[int, str | None]:
    count = token_count(text, lang)
    low, high = (
        (SPACELESS_MIN_CHARS, SPACELESS_MAX_CHARS)
        if lang in SPACELESS_LANGUAGES
        else (MIN_TOKENS, MAX_TOKENS)
    )
    if count < low:
        return count, "too_short"
    if count > high or len(text) > MAX_CHARS:
        return count, "too_long"
    return count, None


def _register_verdict(text: str, translation: str, lang: str) -> str | None:
    for side in (text, translation):
        for marker in REGISTER_REJECT_SUBSTRINGS:
            if marker in side:
                return "register"
    for side, code in ((text, lang), (translation, L1)):
        deny = PROFANITY_TOKENS.get(code, ())
        if not deny:
            continue
        if code in SPACELESS_LANGUAGES:
            if any(token in side for token in deny):
                return "profanity"
            continue
        tokens = {token.casefold() for token in _TOKEN.findall(side)}
        if tokens & set(deny):
            return "profanity"
    return None


# ---------------------------------------------------------------------------
# The ledger
# ---------------------------------------------------------------------------


def _rows(
    granted: IngestPermit,
    candidates: Iterable[Candidate],
    *,
    report: IngestReport,
    seen: set[str],
    max_pairs: int,
) -> Iterator[dict[str, object]]:
    """Judge candidates and emit `ingested_sentence` records for the survivors."""
    if granted.licence == UNRESOLVED_LICENCE:  # pragma: no cover — permit() refuses first
        raise MissingInput(
            f"{granted.source_id}: licence is {UNRESOLVED_LICENCE}; a sentence whose licence "
            f"did not resolve must never reach the ledger."
        )
    lang = granted.lang
    kept = 0
    for candidate in candidates:
        report.read += 1
        text = normalise(candidate.text)
        translation = normalise(candidate.translation)
        if not text or not translation:
            report.reject("empty")
            continue
        if text == translation:
            # Identical sides are a mining artefact (a URL, a number, a proper noun), not
            # a translation pair, and they teach nothing.
            report.reject("untranslated")
            continue

        count, too = _length_verdict(text, lang)
        if too is not None:
            report.reject(too)
            continue
        bad = _register_verdict(text, translation, lang)
        if bad is not None:
            report.reject(bad)
            continue

        key = dedup_hash(text.casefold())
        if key in seen:
            report.reject("duplicate")
            continue
        seen.add(key)

        owner = candidate.owner or granted.attribution_owner
        if granted.attribution_required and not owner:  # pragma: no cover — belt/braces
            raise MissingInput(
                f"{granted.source_id} requires attribution and this row has no owner; "
                f"INV-PACK-17 needs every such sentence reachable from S152."
            )

        yield {
            "schema_version": 1,
            "sentence_id": sentence_id(lang, text),
            "lang": lang,
            "l1": L1,
            "text": text,
            "translation": translation,
            "source_id": granted.source_id,
            "corpus": granted.corpus,
            "corpus_version": granted.corpus_version,
            "licence": granted.licence,
            "licence_verdict": granted.verdict,
            "attribution_required": granted.attribution_required,
            "attribution_owner": owner if granted.attribution_required else None,
            "token_count": max(count, 1),
            "dedup_hash": key,
        }
        report.written += 1
        kept += 1
        if kept >= max_pairs:
            return


def _candidates(
    source_id: str,
    granted: IngestPermit,
    transport: Transport,
    *,
    max_pairs: int,
) -> tuple[IngestPermit, Iterator[Candidate]]:
    """Dispatch to the one fetcher that knows this source's file layout.

    An explicit two-way branch rather than a registry lookup: the two fetchers return
    different shapes (Tatoeba yields an owner per sentence; OPUS yields bare pairs), and a
    uniform signature would have to erase exactly the field V10 needs.
    """
    if source_id == "tatoeba":
        stamped, pairs = tatoeba.fetch_pairs(granted, transport, max_pairs=max_pairs)
        return stamped, (
            Candidate(text=pair.text, translation=pair.translation, owner=pair.owner or None)
            for pair in pairs
        )
    if source_id == "nllb":
        stamped, _info, pairs = opus.stream_pairs(granted, transport, max_pairs=max_pairs)
        return stamped, (
            Candidate(text=text, translation=translation, owner=None)
            for text, translation in pairs
        )
    raise MissingInput(
        f"G0 has no fetcher for {source_id!r}. config/g0.py INGEST_CORPORA_BY_LANGUAGE lists "
        f"it for a language, and nothing here knows how to read it. A corpus with no reader "
        f"is a build failure, never a skipped source."
    )


def ingest(
    lang: str,
    entry: StageEntry,
    transport: Transport,
    *,
    max_pairs: int = MAX_PAIRS_DEFAULT,
    corpora: tuple[str, ...] | None = None,
) -> IngestReport:
    """Run G0 for one language and write `g0/ingested.jsonl`. Returns the report.

    Separate from the registered stage so the tests drive it with a recording transport —
    which is the only way to assert INV-PACK-13's real property, that a refused corpus
    never reaches the network.
    """
    wanted = corpora if corpora is not None else INGEST_CORPORA_BY_LANGUAGE.get(lang)
    if not wanted:
        raise MissingInput(
            f"no ingest corpora are configured for {lang!r}. config/g0.py "
            f"INGEST_CORPORA_BY_LANGUAGE names {', '.join(sorted(INGEST_CORPORA_BY_LANGUAGE))}."
        )

    report = IngestReport()
    seen: set[str] = set()
    records: list[dict[str, object]] = []

    for source_id in wanted:
        # The gate, before anything opens a socket. An exception here is the correct
        # end of the build: a corpus nobody classified is never "skipped".
        granted = permit(source_id, lang)
        stamped, candidates = _candidates(source_id, granted, transport, max_pairs=max_pairs)
        before = report.written
        records.extend(
            _rows(stamped, candidates, report=report, seen=seen, max_pairs=max_pairs)
        )
        report.per_corpus[source_id] = report.written - before

        entry.record_input(source_id)
        entry.record_licence(stamped.licence_row())

    write_records("ingested_sentence", records, lang=lang)
    entry.record_output("ingested_sentence")
    entry.read = report.read
    entry.written = report.written
    entry.rejected = report.rejected
    entry.note(
        max_pairs=max_pairs,
        corpora=list(wanted),
        per_corpus=dict(report.per_corpus),
        rejected_by=dict(report.rejected_by),
        length_window=[MIN_TOKENS, MAX_TOKENS],
        normalisation=NORMALISATION_FORM,
    )
    return report


@register_stage("g0", reads=(), writes=("ingested_sentence",))
def run(ctx: StageContext) -> StageResult:
    """The registered stage. Options: `max_pairs`, `corpora`."""
    raw = ctx.options.get("max_pairs")
    try:
        max_pairs = int(raw) if raw else MAX_PAIRS_DEFAULT
    except ValueError as exc:
        raise MissingInput(f"--set max_pairs={raw!r} is not an integer") from exc

    chosen = ctx.options.get("corpora")
    corpora = tuple(part.strip() for part in chosen.split(",") if part.strip()) if chosen else None

    report = ingest(
        ctx.lang, ctx.entry, HttpTransport(), max_pairs=max_pairs, corpora=corpora
    )
    if report.written == 0:
        return StageResult(
            ok=False,
            message=(
                f"{ctx.lang}: G0 read {report.read} candidate pairs and kept none. "
                f"Rejections: {report.rejected_by or 'none'}. An empty ledger is a failed "
                f"stage, never a fast one."
            ),
        )
    return StageResult(
        ok=True,
        message=f"{report.written} sentences from {', '.join(report.per_corpus)}",
        detail={"per_corpus": report.per_corpus, "rejected_by": report.rejected_by},
    )
