"""Constants owned by G2 Band — frequency ordering, its share-alike duty, and CEFRLex.

Read the licence block before you copy anything out of this file.

Owner: p2-g1-g2-analyze-band. (See the naming note at the top of `config/g1.py`:
`config/band.py` is the empty scaffolded twin and should be deleted, not filled in.)
"""

from __future__ import annotations

from typing import Final

# ---------------------------------------------------------------------------
# Frequency — hermitdave, and the share-alike duty that rides with it
# ---------------------------------------------------------------------------

#: hermitdave/FrequencyWords: "MIT License for code. CC-by-sa-4.0 for content."
#: The lists are CONTENT, so the ordering G2 derives from them is a derivative work and
#: is share-alike. That is fine — the packs ship CC BY-NC-SA 4.0, which is itself
#: share-alike — but it is a duty, not a footnote: the manifest must SAY the ordering is
#: CC BY-SA 4.0 and name the upstream, or the pack redistributes a derivative of an SA
#: work without passing the licence on. `coursekit.stages.g2_band` writes both of these
#: into the runlog, and G9 copies them into the manifest.
FREQUENCY_SOURCE_ID: Final[str] = "hermitdave"
FREQUENCY_DERIVED_ORDERING_LICENCE: Final[str] = "CC-BY-SA-4.0"
FREQUENCY_DERIVED_ORDERING_ATTRIBUTION: Final[str] = (
    "Word frequency ordering derived from hermitdave/FrequencyWords (OpenSubtitles 2018), "
    "licensed CC BY-SA 4.0; the derived ordering is redistributed share-alike."
)

#: The file G2 reads, per language. hermitdave's `content/2018/{lang}/{lang}_50k.txt`,
#: two whitespace-separated columns: surface form, occurrences, most frequent first.
#:
#: There is deliberately no `ja` entry. `ja_50k.txt` returns 404 (the ja directory holds
#: only `ja_full.txt` and `ja_ignored.txt`, whose whitespace-tokenised "words" are
#: sentence fragments, because Japanese has no whitespace). A loop templating
#: `{lang}_50k.txt` failing at fetch time is the GOOD outcome; the bad one is a fallback
#: to `ja_full.txt`, which makes V1 pass over a ledger that means nothing. Japanese
#: frequency is derived in-house — see the `ja_derived_frequency` source in `base.py`.
FREQUENCY_FILENAME_BY_LANGUAGE: Final[dict[str, str]] = {
    "es": "es_50k.txt",
    "fr": "fr_50k.txt",
    "de": "de_50k.txt",
}

#: Measured 2026-09-12: `es_50k.txt` is exactly 50,000 lines, 658,626 bytes. A short file
#: means a truncated download, and a truncated frequency list silently re-ranks the tail
#: of the ledger, which is where the A1/A2 boundary actually lives.
FREQUENCY_MIN_ROWS: Final[int] = 50_000

#: **hermitdave ships SURFACE FORMS, not lemmas**, and this is the single most important
#: fact in this file. `deep/10` says it in one clause; the consequence is that the list
#: must go through the G1 adapter before it touches the ledger, or `casa` and `casas` are
#: two ledger items, `es`/`son`/`soy`/`eres` are four, and every count is wrong by however
#: Spanish inflects. Set false only for a source that is already lemmatised.
FREQUENCY_IS_SURFACE_FORMS: Final[bool] = True

#: Surface forms whose count is smaller than this are not pushed through the adapter.
#: The tail of a 50k subtitle list is typos, transliterations and fragments; each one
#: costs a spaCy call and contributes a lemma nobody will ever teach. The cutoff is a
#: throughput knob and nothing else: it is applied BEFORE lemmatisation, so it can never
#: move a lemma across a band boundary by dropping half of its surface forms — a lemma
#: kept at all keeps every surface at or above the cutoff.
FREQUENCY_MIN_SURFACE_COUNT: Final[int] = 1

#: A surface form that lemmatises to one of these UD tags is counted but never becomes a
#: ledger row of its own: it is noise from a subtitle corpus, not vocabulary.
FREQUENCY_SKIP_POS: Final[tuple[str, ...]] = ("PUNCT", "SPACE", "SYM", "X")

# ---------------------------------------------------------------------------
# The frequency-decile proxy
# ---------------------------------------------------------------------------

#: Decile -> CEFR band, for rows with no lexicon entry. Deciles 1-4 -> A1, 5-7 -> A2,
#: 8-9 -> B1, 10 -> B2. This is the fallback the framework specifies where no CEFRLex
#: resource exists, and it is what German and Japanese ship on — which is why their cards
#: read "Beginner - frequency-ordered - no CEFR resource" and not "A1 - CEFR-checked".
#: Matches the rule the `es-mini` fixture is derived under, so the two cannot drift.
BAND_BY_DECILE: Final[dict[int, str]] = {
    1: "A1",
    2: "A1",
    3: "A1",
    4: "A1",
    5: "A2",
    6: "A2",
    7: "A2",
    8: "B1",
    9: "B1",
    10: "B2",
}

#: The number of deciles. Named because `10` appears in the decile arithmetic and a
#: reader should not have to infer that it is the same 10 as the key above.
DECILE_COUNT: Final[int] = 10

# ---------------------------------------------------------------------------
# CEFRLex / ELELex — and the licence reasoning, which is the point of this block
# ---------------------------------------------------------------------------

#: ELELex is **CC BY-NC-SA 4.0**, and NC is a field-of-use restriction that AGPL-3.0
#: forbids adding to conveyed work.
#:
#: IT IS USED HERE ONLY BECAUSE OF THE PLAN'S LICENCE SPLIT: **code is AGPL-3.0, content
#: packs are CC BY-NC-SA 4.0**. The split exists precisely so a pack can carry
#: CEFRLex-derived grading while the app stays open source, and the allow-list is per
#: artefact — NC data is allowed into a pack and FORBIDDEN in code.
#:
#: So, concretely, for anyone reading this file looking for something to reuse:
#:
#: - A band that came from ELELex may be written onto a `banded_lemma` row, may ride in
#:   a pack, and must carry `band_source: "cefrlex"` and this licence string on the row,
#:   so G9 can put it in the manifest's attribution table.
#: - ELELex itself is `oracle_only` in `config/base.py`. The TSV is consulted on the
#:   build machine and is never redistributed, never vendored into this repository, and
#:   never committed to a test fixture.
#: - **Nothing derived from it may be moved into `packages/`, `apps/` or anywhere else
#:   under AGPL.** If you are copying this constant into TypeScript, stop: you are moving
#:   an NC dependency into AGPL code, which is the thing the split exists to prevent.
#:
#: German gets no lexicon at all (DAFlex publishes no files: no filenames, no counts, no
#: tagger, "reference article forthcoming") and Japanese has no CEFRLex, which is why
#: `CEFR_LANGUAGES` in `base.py` is ("es", "fr") and not all four.
ELELEX_LICENCE: Final[str] = "CC-BY-NC-SA-4.0"
ELELEX_ATTRIBUTION: Final[str] = (
    "CEFR bands from ELELex (CEFRLex, CENTAL, UCLouvain), licensed CC BY-NC-SA 4.0; "
    "consulted at build time, band values redistributed inside a CC BY-NC-SA 4.0 pack."
)

#: **R23, and it is a rule, not a caveat.** The CEFR label the product actually renders is
#: attached to a SECTION (`scope/08` measured Spanish as 8 sections: 1-3 A1, 4 A2, 5-6 B1,
#: 7-8 B2, each card reading "A1 - SEE DETAILS"). A per-lemma lexicon cannot produce a
#: section label and a frequency decile cannot either. The section label is a **G3**
#: curriculum output — which sections contain which grammar concepts — and ELELex is at
#: best a per-lemma sanity check on that assignment.
#:
#: G2 therefore MUST NOT emit a section label, and G3 MUST NOT read one from here. The
#: `unit_assignment` record owns `section_cefr`; the `banded_lemma` record owns `band`.
#: They are different claims with different evidence, and conflating them is how the pack
#: ends up asserting a CEFR level it cannot defend.
CEFR_BAND_IS_PER_LEMMA_ONLY: Final[bool] = True

#: The ELELex distribution, as published at
#: `cental.uclouvain.be/cefrlex/static/resources/es/ELELex.tsv`.
ELELEX_FILENAME: Final[str] = "ELELex.tsv"

#: 14,290 entries plus one header row. Verified 2026-09-12: the file is 14,291 lines and
#: 1,442,791 bytes, which matches the count `deep/10` states. Asserted at load, because a
#: partial or HTML-error download is otherwise a lexicon that silently bands a handful of
#: lemmas and falls back to deciles for the rest.
ELELEX_ENTRY_COUNT: Final[int] = 14_290

#: The columns G2 reads. `word` holds LEMMAS despite the column name (`trabajar`, not
#: `trabajo`); `tag` is a FreeLing tag; `nb_doc@<level>` is the number of documents at
#: that CEFR level in which the lemma occurs.
ELELEX_LEMMA_COLUMN: Final[str] = "word"
ELELEX_TAG_COLUMN: Final[str] = "tag"
ELELEX_LEVELS: Final[tuple[str, ...]] = ("a1", "a2", "b1", "b2", "c1")
ELELEX_DOC_COUNT_COLUMN: Final[str] = "nb_doc@{level}"

#: A lemma's band is the LOWEST CEFR level at which it is attested in at least this many
#: documents. 1 is the standard CEFRLex reading (level of first appearance) and it is the
#: only value that partitions the lexicon completely.
#:
#: Calibrated on the real file, 2026-09-12, counting entries per resulting band:
#:
#:     >= 1 doc    A1 3674  A2 3576  B1 3018  B2 2119  C1 1903   unbanded     0
#:     >= 3 docs   A1 1404  A2 1555  B1 1085  B2  494  C1  322   unbanded 9,430
#:     >= 5 docs   A1  893  A2 1080  B1  710  B2  312  C1  129   unbanded 11,166
#:
#: At 3 documents two thirds of the lexicon falls out and silently reverts to the decile
#: proxy while the pack still claims "CEFR-checked", which is a worse failure than a
#: coarse band. Raising this number is a founder-visible change for that reason.
ELELEX_MIN_DOCS_FOR_LEVEL: Final[int] = 1

#: FreeLing (EAGLES) tag -> UD POS, so an ELELex row can be matched against a lemma the
#: spaCy adapter produced. Keyed by the tag prefix, longest match first.
#:
#: **`deep/10` says this mapping ships as `freeling_to_elelex.yaml` alongside the TSV. It
#: does not.** Verified 2026-09-12: that path and four plausible spellings of it all
#: return 404 (the server answers with an HTML error page, so a fetcher that does not
#: check the status code gets 1,165 bytes of HTML and a mapping of nothing). This table
#: is therefore ours, written against the EAGLES tagset and the 40 distinct tags the
#: real file actually contains. Same class of finding as R3 and R11: a filename in the
#: spec that was read once and never fetched.
#:
#: The multi-tag rows in the published file ("NCM, NP0", "VM VM", "VM, PP0, CS, VM, PP0")
#: are multiword or dirty entries with no single POS. They map to nothing and are counted
#: as unmappable rather than guessed at, because a guess here silently bands a lemma
#: against the wrong part of speech.
FREELING_TO_UD: Final[dict[str, str]] = {
    "NC": "NOUN",
    "NP": "PROPN",
    "N": "NOUN",
    "AQ": "ADJ",
    "AO": "ADJ",
    "AP": "ADJ",
    "A": "ADJ",
    "VA": "AUX",
    "VS": "AUX",
    "VM": "VERB",
    "VP": "VERB",
    "V": "VERB",
    "RG": "ADV",
    "RN": "ADV",
    "R": "ADV",
    "SP": "ADP",
    "S": "ADP",
    "D": "DET",
    "P": "PRON",
    "CC": "CCONJ",
    "CS": "SCONJ",
    "I": "INTJ",
    "Zu": "NOUN",
    "Z": "NUM",
    "W": "NOUN",
    "F": "PUNCT",
}

#: The AUX/VERB and DET/PRON splits are the two places spaCy and FreeLing disagree often
#: enough to matter (`ser` is AUX to spaCy and VS to FreeLing; `su` is DET to spaCy and
#: DP to FreeLing, but `suyo` is PRON to both). A POS mismatch on an otherwise matching
#: lemma is recorded as a disagreement and the row falls back to its decile, rather than
#: taking a band that was computed for a different part of speech.
ELELEX_POS_MUST_MATCH: Final[bool] = True
