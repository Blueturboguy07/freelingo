"""G2 Band — frequency rank per lemma, plus a per-lemma CEFR band where a lexicon exists.

Three things this stage does that are easy to get wrong, each of which has already been
got wrong once in the research corpus:

**hermitdave ships surface forms.** `es_50k.txt` is `word<space>occurrences` straight out
of OpenSubtitles 2018, and its "words" are inflected forms. Ranking them directly gives a
ledger in which `casa` and `casas` are two items and `ser` is five, which is not a ledger.
So every surface form goes through the G1 adapter before it touches the ledger, and the
counts are summed onto `(lemma, POS)`.

**The derived ordering is share-alike.** hermitdave is "MIT License for code. CC-by-sa-4.0
for content", and an ordering derived from the content is a derivative of it. The pack is
CC BY-NC-SA 4.0, which is compatible, but the duty is to SAY so: this stage writes the
licence and the attribution string into the runlog, and G9 copies them into the manifest.
A pack that ships the ordering without declaring it redistributes an SA derivative
without passing the licence on.

**The CEFR band is a per-lemma sanity check, not the label the product renders** (R23).
The measured product attaches CEFR to *sections* — Spanish ships 8, and each card reads
"A1 - SEE DETAILS" — which is a **G3** curriculum output about which grammar concepts sit
where. A per-lemma lexicon cannot produce that, and neither can a frequency decile. So
this stage bands lemmas and stops; `section_cefr` belongs to the `unit_assignment` record
and nothing here may write it.

ELELex is CC BY-NC-SA 4.0 and is consulted **only on the build machine**, only because
the packs themselves ship CC BY-NC-SA per the plan's licence split. The reasoning, and
the line nobody may cross with it, is written out at `config/g2.ELELEX_LICENCE`.
"""

from __future__ import annotations

import csv
from collections import Counter
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from ..artifacts import read_records, write_records
from ..config import ARTIFACT_SCHEMA_VERSION, CEFR_LANGUAGES
from ..config.g2 import (
    BAND_BY_DECILE,
    BAND_BY_DECILE_CALIBRATION,
    BAND_SOURCE_CEFRLEX_POS_RELAXED,
    DECILE_COUNT,
    ELELEX_ATTRIBUTION,
    ELELEX_DOC_COUNT_COLUMN,
    ELELEX_ENTRY_COUNT,
    ELELEX_FILENAME,
    ELELEX_LEMMA_COLUMN,
    ELELEX_LEVELS,
    ELELEX_LICENCE,
    ELELEX_MIN_DOCS_FOR_LEVEL,
    ELELEX_POS_MUST_MATCH,
    ELELEX_TAG_COLUMN,
    FREELING_TO_UD,
    FREQUENCY_DERIVED_ORDERING_ATTRIBUTION,
    FREQUENCY_DERIVED_ORDERING_LICENCE,
    FREQUENCY_FILENAME_BY_LANGUAGE,
    FREQUENCY_MIN_ROWS,
    FREQUENCY_MIN_SURFACE_COUNT,
    FREQUENCY_SKIP_POS,
    FREQUENCY_SOURCE_ID,
)
from ..inputs import MissingInput, licence_row, resolve
from ..ledger import (
    LedgerItem,
    assert_unique_keys,
    is_lexical_pos,
    ledger_declaration,
    ledger_unit,
)
from ..runlog import require_successful
from . import StageContext, StageResult, register_stage
from .g1_analyze import adapter_for

__all__ = ["band"]


@register_stage(
    "g2",
    reads=("analysed_sentence",),
    writes=("banded_lemma",),
    requires_group="nlp",
)
def band(ctx: StageContext) -> StageResult:
    """Rank the frequency list through the adapter, band it, and declare the licences."""
    require_successful(ctx.lang, ("g1",))
    adapter = adapter_for(ctx.lang)
    adapter.require_self_test()

    source = resolve(FREQUENCY_SOURCE_ID, ctx.lang)
    path = frequency_path(ctx)
    # A deliberately small list passed with `--set frequency=` is a fixture, not a
    # truncated download, so only the default path is held to the published row count.
    surface_rows = read_frequency(
        path, lang=ctx.lang, require_full="frequency" not in ctx.options
    )
    ctx.entry.record_input(source.id)
    ctx.entry.record_licence(licence_row(source))

    pos_in_context, corpus_pairs = corpus_profile(ctx.lang)
    counts, frequency_stats = lemmatise_frequency(
        adapter, surface_rows, context_pos=pos_in_context
    )
    if not counts:
        return StageResult(
            ok=False,
            message=(
                f"{path} produced no ledger lemmas from {len(surface_rows)} surface "
                f"form(s). A frequency list that lemmatises to nothing is a truncated "
                f"or mis-parsed file, not an empty language."
            ),
        )

    ordered = rank(counts)
    items = [LedgerItem(lang=ctx.lang, lemma=lemma, pos=pos) for lemma, pos, _ in ordered]
    assert_unique_keys(items)

    lexicon, lexicon_stats = load_lexicon(ctx)
    rows, band_stats = build_rows(ctx.lang, ordered, lexicon)

    written = write_records("banded_lemma", rows, lang=ctx.lang)
    ctx.entry.record_output("banded_lemma")
    ctx.entry.read = len(surface_rows)
    ctx.entry.written = written
    ctx.entry.rejected = frequency_stats["frequency_skipped"]

    band_sources = Counter(row["band_source"] for row in rows)
    covered = sum(1 for key in corpus_pairs if key in counts)
    ctx.entry.note(
        ledger=ledger_declaration(ctx.lang),
        ledger_unit=ledger_unit(ctx.lang),
        frequency_file=path.name,
        frequency_surface_rows=len(surface_rows),
        # The share-alike declaration. G9 copies these two into the manifest.
        derived_ordering_licence=FREQUENCY_DERIVED_ORDERING_LICENCE,
        derived_ordering_share_alike=True,
        derived_ordering_attribution=FREQUENCY_DERIVED_ORDERING_ATTRIBUTION,
        band_sources=dict(band_sources),
        corpus_coverage={
            "corpus_lemmas": len(corpus_pairs),
            "covered": covered,
            "coverage": round(covered / len(corpus_pairs), 4) if corpus_pairs else 0.0,
        },
        # R23, restated where a reader of the run will see it.
        section_cefr_is_a_g3_output=True,
        band_by_decile_calibration=dict(BAND_BY_DECILE_CALIBRATION),
        **frequency_stats,
        **lexicon_stats,
        **band_stats,
    )
    if lexicon:
        # Only when a band actually came from it. A licence row recorded for a lexicon
        # that was absent would put an NC attribution in the manifest of a pack that
        # contains nothing derived from it.
        cefrlex = resolve("cefrlex", ctx.lang)
        ctx.entry.record_input(cefrlex.id)
        ctx.entry.record_licence(licence_row(cefrlex))

    return StageResult(
        ok=True,
        detail={
            "lemmas": written,
            "band_sources": dict(band_sources),
            "derived_ordering_licence": FREQUENCY_DERIVED_ORDERING_LICENCE,
        },
    )


# ---------------------------------------------------------------------------
# The frequency list
# ---------------------------------------------------------------------------


def frequency_path(ctx: StageContext) -> Path:
    """Where the frequency list is, or a failure carrying the one-line fetch.

    G2 reads a LOCAL file and never fetches. A stage that downloads on demand makes every
    run depend on a network and on whatever `master` says today, and the whole reason the
    spaCy model is pinned by wheel URL is that a moving input re-partitions the ledger
    with no diff.
    """
    override = ctx.options.get("frequency")
    if override:
        path = Path(override)
    else:
        filename = FREQUENCY_FILENAME_BY_LANGUAGE.get(ctx.lang)
        if filename is None:
            raise MissingInput(
                f"hermitdave publishes no 50k list for {ctx.lang!r}. For Japanese that is "
                f"a 404 and it is the good outcome: `ja_full.txt` is whitespace-tokenised "
                f"subtitle text whose 'words' are sentence fragments, and falling back to "
                f"it makes V1 pass over a ledger that means nothing. Derive Japanese "
                f"frequency in-house from Mode-A lemmas (source `ja_derived_frequency`)."
            )
        path = source_dir(ctx) / filename
    if not path.exists():
        source = resolve(FREQUENCY_SOURCE_ID, ctx.lang)
        raise MissingInput(
            f"the frequency list for {ctx.lang!r} is not at {path}. Fetch it once:\n"
            f"  curl -fsSL -o {path} {source.url}\n"
            f"or point the stage at a copy with `--set frequency=<path>`. "
            f"{source.source.remedy}"
        )
    return path


def source_dir(ctx: StageContext) -> Path:
    """`<run root>/<lang>/sources/` — downloaded inputs, beside the stage outputs."""
    return ctx.dir.parent / "sources"


def read_frequency(path: Path, *, lang: str, require_full: bool = True) -> list[tuple[str, int]]:
    """hermitdave's two columns: surface form, occurrences. Most frequent first.

    A short file is refused when it claims to be the published list. Measured
    2026-09-12, `es_50k.txt` is exactly 50,000 lines; a truncated download silently
    re-ranks the tail, which is where the A1/A2 boundary actually lives. `require_full`
    is False for a path an operator passed deliberately — a fixture is small on purpose,
    and the check would otherwise make small-scale testing impossible and get deleted.
    """
    rows: list[tuple[str, int]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        text = line.strip()
        if not text:
            continue
        # rsplit with a maxsplit is a FIELD parse, not tokenisation: the count is the
        # last whitespace-delimited field and everything before it is the surface,
        # spaces and all. A surface that really is two words is then handed to the
        # adapter, which returns None for it rather than attributing a two-word row to
        # one lemma. Whitespace rather than a literal space so hermitdave's
        # space-separated lists and a tab-separated fixture parse identically.
        parts = text.rsplit(None, 1)
        if len(parts) != 2 or not parts[1].isdigit():
            raise MissingInput(
                f"{path}:{number}: expected `surface<whitespace>count`, got {line!r}. "
                f"A 1,165-byte HTML 404 page parses as zero rows and would otherwise "
                f"read as an empty language."
            )
        rows.append((parts[0], int(parts[1])))

    if require_full and lang in FREQUENCY_FILENAME_BY_LANGUAGE and len(rows) < FREQUENCY_MIN_ROWS:
        raise MissingInput(
            f"{path} carries {len(rows)} rows; hermitdave's 50k lists carry "
            f"{FREQUENCY_MIN_ROWS}. A truncated list re-ranks the tail of the ledger, "
            f"which is exactly where the A1/A2 boundary sits. Re-fetch it. "
            f"(Use `--set frequency=<path>` for a deliberately small fixture.)"
        )
    return rows


def corpus_profile(lang: str) -> tuple[dict[str, str], set[tuple[str, str]]]:
    """What G1 saw IN CONTEXT: the dominant UD tag per lemma, and every `(lemma, POS)`.

    This exists because of a measured problem, not a preference. hermitdave hands G2 bare
    surface forms with no sentence around them, and a one-token document is the worst
    case for a POS tagger: `es_core_news_md` tags **6.1% of the top 3,000 Spanish surface
    forms as PROPN** (measured 2026-09-12), including `casa`, `perro` and `hola`. Taken at
    face value that splits `casa`/PROPN from `casas`/NOUN into two ledger rows — the exact
    failure lemmatising the list was supposed to prevent, arriving one step later.

    G1 has already analysed the corpus in context, where the tagger is doing its real job.
    So the corpus decides the POS for every lemma it has seen, and the context-free guess
    is only the fallback for the tail. Both counts are reported.
    """
    pos_counts: dict[str, Counter[str]] = {}
    pairs: set[tuple[str, str]] = set()
    try:
        for record in read_records("analysed_sentence", lang=lang):
            for token in record["tokens"]:
                if not is_lexical_pos(token["pos"]):
                    continue
                pos_counts.setdefault(token["lemma"], Counter())[token["pos"]] += 1
                pairs.add((token["lemma"], token["pos"]))
    except FileNotFoundError:  # pragma: no cover — require_successful ran first
        return {}, set()
    return {lemma: _dominant(counter) for lemma, counter in pos_counts.items()}, pairs


def _dominant(counter: Counter[str]) -> str:
    """The most-seen tag, ties broken lexicographically so two runs agree."""
    return min(counter.items(), key=lambda item: (-item[1], item[0]))[0]


def lemmatise_frequency(
    adapter,  # noqa: ANN001 — the adapters are structurally typed
    rows: Iterable[tuple[str, int]],
    *,
    context_pos: dict[str, str] | None = None,
) -> tuple[Counter[tuple[str, str]], dict[str, Any]]:
    """Push every surface form through the adapter and sum onto `(lemma, POS)`.

    Three things happen, and the second and third are why this is not a one-liner:

    1. Every surface goes through the G1 adapter, because hermitdave ships surface forms.
    2. A lemma the corpus has seen takes the corpus's POS, not the context-free guess
       (see `corpus_profile`).
    3. A lemma that still carries more than one POS is consolidated onto the tag with the
       most evidence. `casa`/PROPN and `casa`/NOUN are one word; keeping them apart would
       rank one of them at half its real frequency and put it in the wrong decile.

    Consolidation is deliberately lossy in one direction: `bajo` as a preposition and
    `bajo` as an adjective fold together, because `scope2/00` §2.3 asks G2 for a rank
    **per lemma** and the POS on the row exists to match a lexicon and to disambiguate
    homographs, not to split a lemma's frequency. Two genuinely distinct senses are split
    by the sense inventory G3 and G9 own, and INV-PACK-51 is what refuses them a shared
    ledger key when they are.

    Skipped rows — punctuation, symbols, multi-word entries — are COUNTED, because a skip
    rate that jumps is the first sign the list or the model changed.
    """
    context_pos = context_pos or {}
    counts: Counter[tuple[str, str]] = Counter()
    lemmatised = 0
    from_corpus = 0

    kept: list[tuple[str, int]] = []
    skipped = 0
    for surface, count in rows:
        if count < FREQUENCY_MIN_SURFACE_COUNT:
            skipped += 1
            continue
        kept.append((surface, count))

    # Batched, because a 50,000-row list through one `nlp()` call per surface is minutes
    # of pure call overhead for the same answer.
    analyses = adapter.lemmatise_surfaces([surface for surface, _ in kept])
    for (_surface, count), analysed in zip(kept, analyses, strict=True):
        if analysed is None:
            skipped += 1
            continue
        lemma, pos = analysed
        if pos in FREQUENCY_SKIP_POS:
            skipped += 1
            continue
        in_context = context_pos.get(lemma)
        if in_context is not None:
            pos = in_context
            from_corpus += 1
        counts[(lemma, pos)] += count
        lemmatised += 1

    counts, consolidated = consolidate_pos(counts)
    return counts, {
        "frequency_lemmatised": lemmatised,
        "frequency_skipped": skipped,
        "frequency_pos_from_corpus": from_corpus,
        "frequency_pos_context_free": lemmatised - from_corpus,
        "frequency_pos_consolidated_lemmas": consolidated,
    }


def consolidate_pos(counts: Counter[tuple[str, str]]) -> tuple[Counter[tuple[str, str]], int]:
    """Fold a lemma's competing POS tags onto the one with the most evidence."""
    by_lemma: dict[str, Counter[str]] = {}
    for (lemma, pos), count in counts.items():
        by_lemma.setdefault(lemma, Counter())[pos] += count
    folded: Counter[tuple[str, str]] = Counter()
    consolidated = 0
    for lemma, tags in by_lemma.items():
        if len(tags) > 1:
            consolidated += 1
        folded[(lemma, _dominant(tags))] = sum(tags.values())
    return folded, consolidated


def rank(counts: Counter[tuple[str, str]]) -> list[tuple[str, str, int]]:
    """`(lemma, POS, frequency)`, most frequent first, ties broken lexicographically.

    The tie-break is not decoration. Ranks become deciles become bands, and `Counter`
    iteration order follows insertion, so without it two runs over the same data can put
    a lemma on either side of a band boundary depending on which surface form the
    adapter saw first.
    """
    return [
        (lemma, pos, frequency)
        for (lemma, pos), frequency in sorted(
            counts.items(), key=lambda item: (-item[1], item[0][0], item[0][1])
        )
    ]


def decile_for(position: int, total: int) -> int:
    """1-10 by rank position. Same arithmetic the `es-mini` fixture is derived under."""
    return min(DECILE_COUNT, (position * DECILE_COUNT) // total + 1)


# ---------------------------------------------------------------------------
# The lexicon (CC BY-NC-SA — read `config/g2.ELELEX_LICENCE` first)
# ---------------------------------------------------------------------------


def load_lexicon(ctx: StageContext) -> tuple[dict[tuple[str, str], str], dict[str, Any]]:
    """ELELex, if this language has one and the operator put the file where it goes.

    Absent is a normal state, not a failure: German has no published DAFlex files and
    Japanese has no CEFRLex at all, so those packs band by decile and their cards read
    "Beginner - frequency-ordered - no CEFR resource". Returning `({}, ...)` is how that
    is expressed; the stats say which of the two happened so a manifest cannot claim
    "CEFR-checked" over a run where the file was simply missing.
    """
    if ctx.lang not in CEFR_LANGUAGES:
        return {}, {
            "cefr_lexicon": "none",
            "cefr_lexicon_reason": (
                f"no CEFRLex resource exists for {ctx.lang!r}; the pack bands by "
                f"frequency decile and must not claim a CEFR-checked level"
            ),
        }
    override = ctx.options.get("elelex")
    path = Path(override) if override else source_dir(ctx) / ELELEX_FILENAME
    if not path.exists():
        return {}, {
            "cefr_lexicon": "absent",
            "cefr_lexicon_reason": (
                f"{path} is not present, so every row bands by decile. ELELex is "
                f"CC BY-NC-SA and is never vendored into this repository; put a copy "
                f"beside the run to band against it."
            ),
        }
    lexicon, stats = read_elelex(path)
    stats["cefr_lexicon"] = "elelex"
    stats["cefr_lexicon_licence"] = ELELEX_LICENCE
    stats["cefr_lexicon_attribution"] = ELELEX_ATTRIBUTION
    return lexicon, stats


def read_elelex(path: Path) -> tuple[dict[tuple[str, str], str], dict[str, Any]]:
    """`(lemma, UD POS) -> CEFR band`, plus what the file could not be made to say.

    A lemma's band is the lowest level at which it is attested in at least
    `ELELEX_MIN_DOCS_FOR_LEVEL` documents. Rows whose FreeLing tag does not map to a UD
    tag are counted as unmappable and dropped rather than guessed at — the published file
    carries a handful of multiword rows ("NCM, NP0", "VM VM") with no single POS, and a
    guess there bands a lemma against the wrong part of speech.
    """
    lexicon: dict[tuple[str, str], str] = {}
    unmappable: Counter[str] = Counter()
    entries = 0
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t", quotechar='"')
        for row in reader:
            entries += 1
            pos = freeling_to_ud(row[ELELEX_TAG_COLUMN])
            if pos is None:
                unmappable[row[ELELEX_TAG_COLUMN]] += 1
                continue
            level = first_level(row)
            if level is None:
                continue
            key = (row[ELELEX_LEMMA_COLUMN].casefold(), pos)
            # Lowest level wins when a lemma appears under two tags mapping to one UD tag
            # (AQ0 and AQS both become ADJ). Teaching the earlier of two levels is the
            # conservative direction: it never asserts a lemma is harder than it is.
            if key not in lexicon or ELELEX_LEVELS.index(
                level.casefold()
            ) < ELELEX_LEVELS.index(lexicon[key].casefold()):
                lexicon[key] = level
    stats: dict[str, Any] = {
        "cefr_lexicon_entries": entries,
        "cefr_lexicon_mapped": len(lexicon),
        "cefr_lexicon_unmappable_tags": dict(unmappable.most_common(10)),
        "cefr_lexicon_entry_count_matches": entries == ELELEX_ENTRY_COUNT,
    }
    if entries != ELELEX_ENTRY_COUNT:
        stats["cefr_lexicon_reason"] = (
            f"{path} carries {entries} entries, not the published {ELELEX_ENTRY_COUNT}. "
            f"A partial or HTML-error download bands a handful of lemmas and falls back "
            f"to deciles for the rest while the pack still claims CEFR-checked."
        )
    return lexicon, stats


def freeling_to_ud(tag: str) -> str | None:
    """FreeLing (EAGLES) tag -> UD POS, longest prefix first. None when it cannot be said.

    `deep/10` says the mapping ships as `freeling_to_elelex.yaml` next to the TSV. It does
    not: that path 404s (with an HTML body, so an unchecked fetch gets 1,165 bytes of
    error page). `config/g2.FREELING_TO_UD` is ours, written against the EAGLES tagset and
    the tags the published file actually contains.
    """
    cleaned = tag.strip().strip('"')
    if not cleaned or " " in cleaned or "," in cleaned:
        return None
    for length in range(len(cleaned), 0, -1):
        mapped = FREELING_TO_UD.get(cleaned[:length])
        if mapped is not None:
            return mapped
    return None


def first_level(row: dict[str, str]) -> str | None:
    """The lowest CEFR level at which this lemma is attested often enough to count."""
    for level in ELELEX_LEVELS:
        column = ELELEX_DOC_COUNT_COLUMN.format(level=level)
        try:
            documents = float(row[column])
        except (KeyError, TypeError, ValueError):
            return None
        if documents >= ELELEX_MIN_DOCS_FOR_LEVEL:
            return level.upper()
    return None


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------


def lemma_only_index(lexicon: dict[tuple[str, str], str]) -> dict[str, str]:
    """`lemma -> level`, folding the POS away, lowest level wins.

    The index the POS-relaxed fallback reads. Lowest level for the same reason
    `read_elelex` takes the lowest across two tags mapping to one UD tag: teaching a lemma
    earlier than the lexicon's hardest reading of it never asserts a word is harder than
    it is.
    """
    folded: dict[str, str] = {}
    for (lemma, _pos), level in lexicon.items():
        seen = folded.get(lemma)
        if seen is None or ELELEX_LEVELS.index(level.casefold()) < ELELEX_LEVELS.index(
            seen.casefold()
        ):
            folded[lemma] = level
    return folded


def build_rows(
    lang: str,
    ordered: list[tuple[str, str, int]],
    lexicon: dict[tuple[str, str], str],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """One `banded_lemma` per ranked lemma, plus how each band was arrived at.

    Three ways a row can get its band, and the row says which:

    - **`cefrlex`** — the lexicon carries this exact `(lemma, POS)`. Carries the NC licence
      string so G9 can put it in the manifest's attribution table.
    - **`cefrlex_pos_relaxed`** — the lexicon carries the lemma under a different part of
      speech, and `ELELEX_POS_MUST_MATCH` is False. Also carries the licence, because the
      band still came from ELELex; a weaker claim, named as one.
    - **`frequency_decile`** — no lexicon entry, or a POS disagreement under the default
      `ELELEX_POS_MUST_MATCH = True`. Null licence, which is what `tests/test_artifacts.py`
      already asserts about the fixture.

    The POS disagreements are COUNTED either way. They are where spaCy and FreeLing
    actually differ (AUX/VERB, DET/PRON), so a count that jumps is a tagger change or a
    lexicon change, and it is otherwise invisible: a disagreement looks exactly like a
    lemma the lexicon never carried.
    """
    by_lemma = lemma_only_index(lexicon) if lexicon else {}
    stats = {"cefr_pos_disagreements": 0, "cefr_pos_relaxed": 0}
    rows: list[dict[str, Any]] = []
    total = len(ordered)
    for position, (lemma, pos, frequency) in enumerate(ordered):
        decile = decile_for(position, total)
        folded = lemma.casefold()
        level = lexicon.get((folded, pos))
        if level is not None:
            band_value, band_source, band_licence = level, "cefrlex", ELELEX_LICENCE
        elif folded in by_lemma:
            # The lemma is in the lexicon; only the part of speech disagrees.
            stats["cefr_pos_disagreements"] += 1
            if ELELEX_POS_MUST_MATCH:
                band_value, band_source, band_licence = (
                    BAND_BY_DECILE[decile],
                    "frequency_decile",
                    None,
                )
            else:
                stats["cefr_pos_relaxed"] += 1
                band_value, band_source, band_licence = (
                    by_lemma[folded],
                    BAND_SOURCE_CEFRLEX_POS_RELAXED,
                    ELELEX_LICENCE,
                )
        else:
            band_value, band_source, band_licence = (
                BAND_BY_DECILE[decile],
                "frequency_decile",
                None,
            )
        rows.append(
            {
                "schema_version": ARTIFACT_SCHEMA_VERSION,
                "lang": lang,
                "lemma": lemma,
                "pos": pos,
                "rank": position + 1,
                "frequency": frequency,
                "decile": decile,
                "band": band_value,
                "band_source": band_source,
                "band_source_licence": band_licence,
            }
        )
    return rows, stats
