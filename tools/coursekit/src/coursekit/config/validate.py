"""Constants owned by the validation side of the pipeline.

Two lanes write here, and the file is split accordingly:

* **G6 (`p2-g6-validate`)** owns the *language* thresholds — per-language perplexity
  bands and LanguageTool severity. French has 6,984 rules to Spanish's 1,644, so one
  global threshold is wrong by 4.2x. R1: Japanese has 735 GRAMMAR rules and no spell
  checker, so the degradation to record is `spellcheck_engine: none`. That half is still
  empty by design; the G6 lane fills it.
* **`p2-validate-sample-ci`** owns the *suite* constants below: what V10, V11 and V12
  measure, and the shape of the machine-readable validator report S002 and S137 render.

A constant two stages share belongs in `config/base.py` instead — and a constant that
lives in neither is a rule violation
`tests/test_cli.py::test_no_constant_lives_outside_config` fails the build on.
"""

from __future__ import annotations

from typing import Final

from .base import INGEST_LICENCE_ALLOW_LIST

# ---------------------------------------------------------------------------
# G6 language thresholds — owner: p2-g6-validate
# ---------------------------------------------------------------------------

# (empty by design; the G6 lane adds its bands and severities here)


# ---------------------------------------------------------------------------
# The suite — owner: p2-validate-sample-ci
# ---------------------------------------------------------------------------

#: Every artefact record kind the suite joins into one "shipped item" view. A validator
#: whose input file is absent must FAIL, never pass: `scope2/00` §2.4 makes V1-V12 a
#: hard CI gate that runs before any human review, and a gate that reports green because
#: it read nothing is indistinguishable from a gate with no hole in it. Same reasoning
#: as `flows-present` in `native-e2e.yml` and as INV-PACK-14.
SUITE_REQUIRED_ARTIFACTS: Final[tuple[str, ...]] = (
    "ingested_sentence",
    "selected_item",
    "banded_lemma",
    # V11 compares unit n to unit n+1 and, since founder ruling B17, only HARD-fails the
    # comparison across a section boundary. It therefore has to know which section each
    # unit is in, and `unit_assignment` (G3) is the only artefact that says. It is
    # REQUIRED rather than optional because the alternative default — "treat every unit
    # as one section" — turns every cross-section regression into a warning and lets V11
    # report green over a course that got easier. That is the falsifier in
    # `tests/test_validators_pack.py`.
    "unit_assignment",
)

#: Artefacts the suite reads when they exist and names in the report when they do not.
#: `candidate` is absent for a language with no gap-filled slots, which is a legitimate
#: state; `exercise` and `pack_row` are absent only before G7/G9 have run, which the
#: runner records as a degradation rather than inventing rows.
SUITE_OPTIONAL_ARTIFACTS: Final[tuple[str, ...]] = ("candidate", "exercise", "pack_row")

# -- V10: licence and attribution -------------------------------------------

#: Licence strings that mean "nobody resolved this". V10 fails the pack on any of them.
#: `NOASSERTION` is the string OPUS legacy pages produce and is the exact value that
#: must never reach a shipped sentence; the empty string and `UNKNOWN` are what a
#: half-written ingest writes.
UNRESOLVED_LICENCE_VALUES: Final[tuple[str, ...]] = (
    "",
    "UNKNOWN",
    "unknown",
    "NOASSERTION",
    "NOASSERTION-NONCOMMERCIAL",
    "TODO",
)

#: The licence an LLM-authored sentence carries. G5 writes the text, the repository owns
#: it, and it ships inside a CC BY-NC-SA pack like every other row.
AUTHORED_SENTENCE_LICENCE: Final[str] = "CC-BY-NC-SA-4.0"

#: The attribution owner an LLM-authored sentence carries, so INV-PACK-17's credits
#: surface has a row for machine-authored content too rather than a silent gap.
AUTHORED_SENTENCE_OWNER: Final[str] = "Freelingo contributors (machine-authored)"

#: The two provenances a shipped sentence can have. `corpus` is text G0 ingested from a
#: third party; `llm` is text this repository authored at G5.
CORPUS_PROVENANCE: Final[str] = "corpus"
AUTHORED_PROVENANCE: Final[str] = "llm"


def allowed_licences_for(provenance: str) -> frozenset[str]:
    """The licences V10 accepts for one provenance. **The split is the point.**

    `AUTHORED_SENTENCE_LICENCE` is `CC-BY-NC-SA-4.0` — the pack licence, which this
    repository may put on its own text and which a THIRD PARTY's text may never arrive
    carrying. Merging the two sets into one allow-list (what the first version of V10
    did) lets a `provenance: "corpus"` row whose ingested licence is `CC-BY-NC-SA-4.0`
    pass with zero findings, which is exactly INV-PACK-13's "NC and ND sources are
    excluded at ingest, not at package time" failing silently at package time.

    An unknown provenance gets the corpus set: the stricter one, because a row whose
    origin nobody recorded is not a row this repository can claim it wrote.
    """
    if provenance == AUTHORED_PROVENANCE:
        return frozenset({AUTHORED_SENTENCE_LICENCE})
    return frozenset(INGEST_LICENCE_ALLOW_LIST)


# -- V11: difficulty drift ---------------------------------------------------

#: Sentence difficulty is a declared proxy, not a measurement, and the weights are named
#: so the number in a validator report can be recomputed by hand. Difficulty is
#: `tokens * w_tokens + mean_decile * w_decile`, where `mean_decile` is the mean
#: frequency decile of the sentence's word tokens against the G2 banded table.
DIFFICULTY_WEIGHT_TOKENS: Final[float] = 1.0
DIFFICULTY_WEIGHT_DECILE: Final[float] = 1.0

#: A token with no row in the banded table is treated as the rarest band. The
#: alternative — skipping it — makes a unit full of unknown vocabulary look EASIER than
#: one built from the ledger, which is precisely the batch drift V11 exists to catch.
UNBANDED_TOKEN_DECILE: Final[int] = 10

#: Floating-point slack on "non-decreasing". Not a tolerance for real drift: two means
#: that differ in the fifteenth decimal place are the same mean.
DIFFICULTY_EPSILON: Final[float] = 1e-9

#: A unit with fewer items than this cannot carry a meaningful mean, so V11 reports it
#: as a blocking finding rather than comparing noise to noise.
MIN_ITEMS_PER_UNIT_FOR_DIFFICULTY: Final[int] = 3

#: **Founder ruling B17, 2026-09-12** (`docs/P2-BLOCKERS.md` §B17 and §Founder rulings):
#: *"V11 hard-fails only across section boundaries; within a section a fall is a warning
#: in the report."*
#:
#: The measurement behind it: the first real `coursekit validate es` run reported **13**
#: unit boundaries where the mean falls, the largest **−3.222 at u18→u19**, and the three
#: worst (units 19, 23, 16) are the gap-heavy ones. An authored gap-fill sentence is
#: shorter and plainer than a corpus sentence that happened to fit the same window, so a
#: unit with many gaps reads easier than the one before it even though its vocabulary is
#: strictly larger. That is a content question the reviewer sample (B3) has to answer, not
#: a reason to block the pack — while a section is the course's own promise of a level
#: (`unit_assignment.section_cefr`), so a fall ACROSS one is a promise broken.
#:
#: `severity` is the whole of the difference: a within-section fall is still counted,
#: still named, and still carries its measured delta into `validator-report.json`.
WITHIN_SECTION_DIFFICULTY_FALL_SEVERITY: Final[str] = "warning"
CROSS_SECTION_DIFFICULTY_FALL_SEVERITY: Final[str] = "blocking"

#: The banded table is keyed by LEMMA and the difficulty proxy reads SURFACE tokens, so
#: coverage is never 100%. Below this fraction the decile term is mostly
#: `UNBANDED_TOKEN_DECILE` and difficulty collapses into sentence length — still a real
#: drift signal, but not the one V11 claims. The runner records the measured coverage in
#: the report and V11 warns below the floor, so a reader can tell which of the two
#: numbers they are looking at.
MIN_BANDED_TOKEN_COVERAGE: Final[float] = 0.5

# -- V12: script direction and font coverage --------------------------------

#: Languages whose pack must declare `rtl: true`. None of the four v1 courses is RTL;
#: the tuple is the assertion's other half, and INV-I18N-01's `ar`/`he` launch-arg locale
#: walk at P3 is the render-side twin of this check.
RTL_LANGUAGES: Final[tuple[str, ...]] = ()

#: The meta row a pack declares its direction in. V12 fails a pack that declares none:
#: an absent flag is not "false", it is "nobody decided".
RTL_META_ROW_ID: Final[str] = "rtl"

#: The font the app bundles (plan: Nunito, SIL OFL) and the codepoint ranges it is
#: asserted to cover, as inclusive `(first, last)` pairs.
#:
#: This is the PACK half of INV-PACK-54. It proves no pack string contains a character
#: outside the declared coverage. The other half — that the font file actually shipped in
#: `apps/mobile` still carries these ranges after subsetting — belongs to P3, because the
#: subset lives with the app, and a validator here cannot see it.
SHIPPED_FONT_NAME: Final[str] = "Nunito"
SHIPPED_FONT_RANGES: Final[tuple[tuple[int, int], ...]] = (
    (0x0009, 0x000A),  # tab, newline
    (0x0020, 0x007E),  # Basic Latin, printable
    (0x00A0, 0x00FF),  # Latin-1 Supplement — includes ¡ ¿ á é í ó ú ñ ü
    (0x0100, 0x017F),  # Latin Extended-A — ā, ō for the ja romanisation surfaces
    (0x2010, 0x2027),  # dashes, quotes, ellipsis
    (0x2030, 0x205E),  # ‰ ′ ″ ‹ › ⁄
    (0x20A0, 0x20BF),  # currency signs
)

#: Characters a Spanish pack MUST be able to render. Listed explicitly, and asserted to
#: be inside `SHIPPED_FONT_RANGES`, so a future narrowing of the ranges fails here rather
#: than at the first ¿ a learner sees. `deep/10`'s Spanish inventory plus both cases.
REQUIRED_CHARACTERS_BY_LANGUAGE: Final[dict[str, str]] = {
    "es": "áéíóúñüÁÉÍÓÚÑÜ¿¡",
    "fr": "àâçéèêëîïôùûüÿœÀÂÇÉÈÊËÎÏÔÙÛÜŸŒ",
    "de": "äöüßÄÖÜ",
    "ja": "",
}

# ---------------------------------------------------------------------------
# The machine-readable validator report
# ---------------------------------------------------------------------------

#: Written to the run root beside `runlog.jsonl`. S002's "validator-report summary" and
#: S137's provenance block render `summarise()` over this file, and G9 copies it into the
#: pack manifest.
VALIDATOR_REPORT_FILENAME: Final[str] = "validator-report.json"

#: Bumping this is a breaking change for the two screens that render it.
VALIDATOR_REPORT_VERSION: Final[int] = 1

#: The per-validator outcomes a report may carry.
#:
#: `unregistered` and `skipped` are the two that matter and they are BLOCKING, not
#: informational. A validator nobody wrote and a validator whose dependency group is
#: absent both produce zero findings, and zero findings is what a green suite looks like.
VALIDATOR_OUTCOMES: Final[tuple[str, ...]] = (
    "ok",
    "warned",
    "failed",
    "skipped",
    "unregistered",
)

#: Outcomes that fail the pack.
BLOCKING_OUTCOMES: Final[tuple[str, ...]] = ("failed", "skipped", "unregistered")

#: The validators the P2 gate asserts at 100% — the plan's P2 row, "V1-V4 100%".
HARD_GATE_VALIDATOR_IDS: Final[tuple[str, ...]] = ("V1", "V2", "V3", "V4")
