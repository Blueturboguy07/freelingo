"""Shared constants for the whole pipeline. No literal is written outside `config/`.

`base.py` holds what *every* stage needs: the language set, the artefact layout, the
exit-code contract, the dependency groups, and the per-language source registry with
its licence verdicts. Anything that belongs to exactly one stage belongs in that
stage's submodule (`config/ingest.py`, `config/band.py`, ...), which is owned by the
lane that implements the stage.

The source registry is here rather than in `inputs.py` on purpose: a corpus URL, a
licence string and a verdict are constants, and `tests/test_cli.py` fails the build if
a module-level constant shows up anywhere outside this package. `inputs.py` holds the
*resolution logic* and none of the data.

Every licence verdict below is sourced from `deep/10` and its adversarial review; the
review found ten stated constants wrong, and the ones that touch this table are called
out by their review id (R1-R19) at the row.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

# ---------------------------------------------------------------------------
# Languages
# ---------------------------------------------------------------------------

#: Languages with a v1 course, in ship order (plan P2, P7).
LANGUAGES: Final[tuple[str, ...]] = ("es", "fr", "de", "ja")

#: One locale per course (EC-PACK-17 ruling).
LOCALE_BY_LANGUAGE: Final[dict[str, str]] = {
    "es": "es-ES",
    "fr": "fr-FR",
    "de": "de-DE",
    "ja": "ja-JP",
}

#: ISO-639-3, the code Tatoeba's per-language exports are keyed by.
ISO3_BY_LANGUAGE: Final[dict[str, str]] = {
    "es": "spa",
    "fr": "fra",
    "de": "deu",
    "ja": "jpn",
}

#: The learner's language. v1 is English only (`scope2/00` §2.1 input 5).
L1: Final[str] = "en"

#: CEFR grading is claimed only where a CEFRLex resource exists (Q8 ruling).
CEFR_LANGUAGES: Final[tuple[str, ...]] = ("es", "fr")

# ---------------------------------------------------------------------------
# Pack constants
# ---------------------------------------------------------------------------

#: Audio budget per language, including Stories and Radio (plan, re-declared).
#: R13 refuted the inherited 35-40 MB figure as arithmetically impossible: 8,000
#: utterances at any intelligible bitrate is ~120 MB, so the budget was re-declared
#: rather than the utterance count quietly reduced. INV-PACK-15 asserts against this.
AUDIO_BUDGET_MB: Final[int] = 120

#: Opus bitrate the bank is transcoded to in G9.
OPUS_BITRATE_KBPS: Final[int] = 20

#: The reviewer-sample gate: a pack ships only at or below this wrong-item rate.
MAX_DEFECT_RATE: Final[float] = 0.02

#: Reviewer sample size per language.
REVIEWER_SAMPLE_ITEMS: Final[int] = 300

#: Content packs are CC BY-NC-SA 4.0; NC/ND data is allowed into packs, never into code.
PACK_LICENCE: Final[str] = "CC-BY-NC-SA-4.0"
CODE_LICENCE: Final[str] = "AGPL-3.0-only"

#: INV-PACK-13: the ingest allow-list. A licence that is not on this list fails at
#: ingest, not at package time — the invariant registry calls this "the only invariant
#: whose failure cannot be fixed after release". ND is absent everywhere; NC is absent
#: here because this list governs *shipped sentences*, which ride in a CC BY-NC-SA pack
#: but must themselves be redistributable under it.
INGEST_LICENCE_ALLOW_LIST: Final[tuple[str, ...]] = (
    "CC0-1.0",
    "CC-BY-2.0-FR",
    "CC-BY-4.0",
    "CC-BY-SA-3.0",
    "CC-BY-SA-4.0",
    "ODC-By-1.0",
)

#: The name written into every runlog entry's `tool` field.
TOOL_NAME: Final[str] = "coursekit"

#: The three audio pipelines the budget covers (INV-PACK-15; R14 found the inherited
#: cost model counted lessons only).
AUDIO_PIPELINES: Final[tuple[str, ...]] = ("lesson", "story", "radio")

# ---------------------------------------------------------------------------
# The stage and validator ledger
# ---------------------------------------------------------------------------

#: G0-G9, in order. `coursekit build` runs exactly this list.
#: G6 is a validation stage: it annotates G5 candidates and writes a runlog entry, and
#: is the one stage in the list that emits no artefact record of its own.
BUILD_STAGE_IDS: Final[tuple[str, ...]] = (
    "g0",
    "g1",
    "g2",
    "g3",
    "g4",
    "g5",
    "g6",
    "g7",
    "g8",
    "g9",
)

STAGE_TITLES: Final[dict[str, str]] = {
    "g0": "Ingest — corpus fetch, dedup, length and register filter, licence row",
    "g1": "Analyze — segment, lemmatise, morph features (Mode A for ja)",
    "g2": "Band — frequency rank and CEFR/decile band per lemma",
    "g3": "Solve curriculum — assign lemmas and grammar concepts to units",
    "g4": "Select — pick corpus sentences inside the ledger; emit the gap list",
    "g5": "Gap-fill — the only authoring stage; candidates re-enter at G6",
    "g6": "Validate language — perplexity band, grammar rules, back-translation",
    "g7": "Expand — align, expand into exercise shapes, generate distractors",
    "g8": "Bake audio — synthesise the cast, content-addressed",
    "g9": "Package — read-only SQLite pack, manifest, attribution table",
    "sample": "Sample — draw the paid native-speaker sample",
    "sign": "Sign — ed25519 signature over the manifest (INV-PACK-18)",
}

#: The stage each CLI verb dispatches to, beyond `build`/`validate`.
BAKE_STAGE_ID: Final[str] = "g8"
PACK_STAGE_ID: Final[str] = "g9"
SAMPLE_STAGE_ID: Final[str] = "sample"
SIGN_STAGE_ID: Final[str] = "sign"

#: V1-V12 from `scope2/00` §2.4, then the Freelingo-specific validators. `coursekit
#: validate` runs exactly this list and refuses to report a pass while one is missing.
VALIDATOR_IDS: Final[tuple[str, ...]] = (
    "V1",
    "V2",
    "V3",
    "V4",
    "V5",
    "V6",
    "V7",
    "V8",
    "V9",
    "V10",
    "V11",
    "V12",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
)

VALIDATOR_TITLES: Final[dict[str, str]] = {
    "V1": "No lemma appears before its introduction unit (lemma-level, never surface)",
    "V2": "<=1 new lemma-or-inflection per exercise; <=K new lemmas per lesson",
    "V3": "Every introduced lemma re-appears >=N times within K lessons",
    "V4": "Tag soundness and coverage — every D1 tag is a lemma actually present",
    "V5": "Distractor is not an accepted answer, same POS, not a valid alternative",
    "V6": "Every accepted answer is in the unit's register; ja script variants enumerated",
    "V7": "Every renderable string has audio; every audio file has a string",
    "V8": "Perplexity inside the band; grammar rules where an engine exists",
    "V9": "No duplicate sentence hash within a unit; cross-unit repeats bounded",
    "V10": "Every sentence carries a resolved licence and attribution owner",
    "V11": "Mean sentence difficulty non-decreasing across units",
    "V12": "RTL flag where required; every character exists in the shipped font",
    "F1": "INV-PACK-13 — the ingest licence allow-list, checked before G0 reads a byte",
    "F2": "INV-PACK-15 — codec, bitrate and total bytes against the declared budget",
    "F3": "INV-PACK-17 — every attribution-requiring asset is reachable from S152",
    "F4": "INV-PACK-18 — the manifest signature verifies against the shipped public key",
    "F5": "INV-PACK-16 — the ja characters stage covers every taught glyph",
}

#: The exercise shapes a pack may carry. S043 "Put the events in order" is out of v1
#: (no grading contract, no taxonomy home) and is therefore absent by decision.
EXERCISE_TYPES: Final[tuple[str, ...]] = (
    "translate",
    "reverse_translate",
    "word_bank",
    "listen",
    "match",
    "cloze",
    "speak",
    "select_character",
)

#: The pack's tables (`scope2/00` §2.5 plus the Freelingo additions).
PACK_TABLES: Final[tuple[str, ...]] = (
    "lexeme",
    "grammar_concept",
    "sentence",
    "exercise",
    "exercise_item_tag",
    "unit",
    "unit_item",
    "story",
    "radio_episode",
    "character_lesson",
    "audio",
    "meta",
)

# ---------------------------------------------------------------------------
# Run directory layout
# ---------------------------------------------------------------------------

#: Run directories live under `<repo>/build/<lang>/<stage>/`. `build/` is already in
#: `.gitignore`, which is the point: a run directory is reproducible output and is
#: never committed.
BUILD_ROOT_DIRNAME: Final[str] = "build"

#: Override for a run directory somewhere else (a scratch disk, a CI workspace).
BUILD_ROOT_ENV_VAR: Final[str] = "COURSEKIT_BUILD_ROOT"

#: One provenance log per language, at the run root, entries keyed by stage.
RUNLOG_FILENAME: Final[str] = "runlog.jsonl"

#: Every artefact file is JSON Lines: append-friendly, diffable, and streamable, so a
#: 250k-row ledger never has to be held in memory to be validated.
ARTIFACT_SUFFIX: Final[str] = ".jsonl"

#: The schema version stamped on every record. A bump is a breaking contract change
#: and requires every wave-2 lane to be re-run, so it is a founder-visible number.
ARTIFACT_SCHEMA_VERSION: Final[int] = 1

# ---------------------------------------------------------------------------
# Exit codes — the CLI contract other lanes and CI depend on
# ---------------------------------------------------------------------------

EXIT_OK: Final[int] = 0
#: Bad arguments: an unknown language, a stage id that is not in the ledger.
EXIT_USAGE: Final[int] = 1
#: The command exists, the stage or validator behind it is not registered yet.
#: Never 0. A half-built pipeline must not report a pass.
EXIT_NOT_REGISTERED: Final[int] = 2
#: A required input or dependency group is absent. Loud, never a degraded run.
EXIT_MISSING_INPUT: Final[int] = 3
#: A registered stage or validator ran and failed.
EXIT_FAILED: Final[int] = 4

# ---------------------------------------------------------------------------
# Dependency groups
# ---------------------------------------------------------------------------

#: Every optional group declared in `pyproject.toml`, and what it carries.
DEPENDENCY_GROUPS: Final[dict[str, str]] = {
    "nlp": "spaCy 3.8 + the es_core_news_md 3.8.0 wheel pinned by URL",
    "lm": "kenlm, pinned to a commit archive",
    "align": "simalign + torch (CPU) + transformers",
    "tts": "kokoro-onnx + soundfile + numpy",
}

#: The import that proves a group is actually present in this interpreter. Declaring a
#: group in `pyproject.toml` is not the same as having it installed, and the difference
#: is the whole reason `inputs.require_group` exists.
DEPENDENCY_GROUP_PROBES: Final[dict[str, str]] = {
    "nlp": "spacy",
    "lm": "kenlm",
    "align": "simalign",
    "tts": "kokoro_onnx",
}

#: The groups `uv sync --locked` installs in `pack-ci.yml`. Kept in step with
#: `[tool.uv] default-groups` in `pyproject.toml`; `tests/test_cli.py` asserts they
#: agree, because a drift here is a CI job that silently stops testing a stage.
CI_SYNCED_GROUPS: Final[tuple[str, ...]] = ("dev", "nlp", "lm")

#: How a developer installs a group that CI does not carry.
GROUP_INSTALL_COMMAND: Final[str] = "uv sync --group {group}"

# ---------------------------------------------------------------------------
# The per-language source registry
# ---------------------------------------------------------------------------

Verdict = Literal["shippable", "oracle_only", "forbidden"]

#: What a source is for. `inputs.resolve` never crosses kinds.
SourceKind = Literal[
    "corpus",
    "frequency",
    "lexicon",
    "morphology",
    "lm",
    "align",
    "tts_voice",
    "furigana",
    "strokes",
    "grammar_rules",
]


#: Source kinds whose CONTENT ends up inside a pack, so the ingest allow-list governs
#: them (INV-PACK-13). The rest — morphology, lm, align, grammar_rules — are build-time
#: TOOLS whose own licence (MIT, LGPL, Apache) never travels with the pack, which is
#: exactly why an LGPL KenLM and a GPL Piper are usable at all.
#:
#: `tts_voice` is in neither list on purpose. A voice engine's code licence is not its
#: voices' licence — Piper is GPL-3.0 code whose single Japanese voice is CC BY-NC-SA
#: (review R7) — so the licence that matters rides on each `baked_clip` record, recorded
#: per voice file at G9, and no table-level assertion can stand in for it.
DATA_SOURCE_KINDS: Final[tuple[str, ...]] = (
    "corpus",
    "frequency",
    "lexicon",
    "furigana",
    "strokes",
)


@dataclass(frozen=True, slots=True)
class Source:
    """One per-language data source, with the licence verdict that governs it.

    `verdict` is the whole point of this table. `shippable` text may appear verbatim in
    a pack; `oracle_only` may inform frequency, perplexity and alignment and may never
    be shipped as a sentence; `forbidden` must never enter the ledger at all, because
    filtering at package time leaves the text in every intermediate artefact.
    """

    id: str
    kind: SourceKind
    languages: tuple[str, ...]
    licence: str
    verdict: Verdict
    attribution_required: bool
    attribution_owner: str | None
    #: `{lang}`, `{iso3}` and `{locale}` are substituted by `inputs.resolve`.
    url: str | None
    #: The optional dependency group a stage needs to consume this source.
    requires_group: str | None
    #: What a human does when this source is missing. Never a fallback.
    remedy: str
    note: str


#: Every source the four v1 courses draw on. Rows carry the adversarial review id where
#: the review corrected what `deep/10` stated.
SOURCES: Final[dict[str, Source]] = {
    # -- corpora -----------------------------------------------------------
    "tatoeba": Source(
        id="tatoeba",
        kind="corpus",
        languages=("es", "fr", "de", "ja"),
        licence="CC-BY-2.0-FR",
        verdict="shippable",
        attribution_required=True,
        attribution_owner="Tatoeba contributors",
        url="https://downloads.tatoeba.org/exports/per_language/{iso3}/{iso3}_sentences.tsv.bz2",
        requires_group=None,
        remedy=(
            "Tatoeba rebuilds weekly, Saturday 06:30 UTC; re-run `coursekit build` after it lands."
        ),
        note=(
            "Attribution-only, so every shipped sentence needs a credits row reachable "
            "from S152 (INV-PACK-17)."
        ),
    ),
    "tatoeba_cc0": Source(
        id="tatoeba_cc0",
        kind="corpus",
        languages=("fr",),
        licence="CC0-1.0",
        verdict="shippable",
        attribution_required=False,
        attribution_owner=None,
        url="https://downloads.tatoeba.org/exports/per_language/{iso3}/{iso3}_sentences_CC0.tsv.bz2",
        requires_group=None,
        remedy="There is no remedy for es/de/ja: the CC0 subset does not exist at usable size.",
        note=(
            "R3: the archive is `sentences_CC0.tar.bz2` — UPPERCASE CC0. The lowercase "
            "spelling 404s. R4: the per-language CC0 exports measure 228 B (jpn), "
            "2,266 B (spa) and 1,852 B (deu) against 313,297 B for fra, so choosing CC0 "
            "to avoid the credits screen eliminates three of the four v1 languages. "
            "Listed for fr only, and even there it is a sub-pool of `tatoeba`."
        ),
    ),
    "nllb": Source(
        id="nllb",
        kind="corpus",
        languages=("es", "fr", "de", "ja"),
        licence="ODC-By-1.0",
        verdict="oracle_only",
        attribution_required=True,
        attribution_owner="NLLB / OPUS (Schwenk et al. 1911.04944; Fan et al. 2010.11125)",
        url="https://object.pouta.csc.fi/OPUS-NLLB/v1/moses/{pair}.txt.zip",
        requires_group=None,
        remedy=(
            "Stream with `--max-pairs`; the full sets are 2.5-40 GB and are never downloaded whole."
        ),
        note=(
            "R2: NLLB v1 is the same LASER-mined bitext as CCMatrix v1 (identical "
            "alignment_pairs on all four pairs) but its legacy page DOES state a "
            "licence — ODC-By 1.0 — which the earlier 'no licence at all' reading "
            "missed. ODC-By covers the database, not each crawled sentence's copyright, "
            "so the plan keeps it ORACLE-ONLY pending the lawyer question (plan risk 2) "
            "and ships Tatoeba text. The API's `size` field for NLLB is stale (1 for "
            "en-fr, 0 for de-en): a script that trusts it thinks the set is a stub."
        ),
    ),
    "opensubtitles": Source(
        id="opensubtitles",
        kind="corpus",
        languages=("es", "fr", "de", "ja"),
        licence="NOASSERTION",
        verdict="oracle_only",
        attribution_required=True,
        attribution_owner="OpenSubtitles.org (Lison & Tiedemann, LREC 2016)",
        url="https://object.pouta.csc.fi/OPUS-OpenSubtitles/v2024/moses/{pair}.txt.zip",
        requires_group=None,
        remedy="Frequency, KenLM and alignment priors only; never a shipped sentence.",
        note="No licence on the OPUS legacy page — a link-back request is not a grant.",
    ),
    "ccmatrix": Source(
        id="ccmatrix",
        kind="corpus",
        languages=("es", "fr", "de", "ja"),
        licence="NOASSERTION",
        verdict="oracle_only",
        attribution_required=True,
        attribution_owner="CCMatrix / OPUS (Schwenk et al. 1911.04944)",
        url="https://object.pouta.csc.fi/OPUS-CCMatrix/v1/moses/{pair}.txt.zip",
        requires_group=None,
        remedy="Use `nllb` instead: byte-identical pair counts, and it carries ODC-By.",
        note="No licence stated. Kept only so a build script that names it gets a verdict.",
    ),
    "ted2020": Source(
        id="ted2020",
        kind="corpus",
        languages=("es", "fr", "de", "ja"),
        licence="CC-BY-NC-ND-4.0",
        verdict="forbidden",
        attribution_required=True,
        attribution_owner="TED Conferences LLC",
        url=None,
        requires_group=None,
        remedy="There is none. Remove TED2020 from any corpus list rather than filtering it later.",
        note=(
            "The TED Talks Usage Policy is CC BY-NC-ND 4.0. Every exercise shape is a "
            "derivative and an AGPL app can be forked commercially, so both clauses "
            "bite. Forbidden AT INGEST so no TED text ever reaches an intermediate "
            "artefact."
        ),
    ),
    "jparacrawl": Source(
        id="jparacrawl",
        kind="corpus",
        languages=("ja",),
        licence="NOASSERTION-NONCOMMERCIAL",
        verdict="forbidden",
        attribution_required=True,
        attribution_owner="NTT Communication Science Laboratories",
        url=None,
        requires_group=None,
        remedy="There is none. Japanese bitext comes from Tatoeba, with NLLB as the oracle.",
        note=(
            "R8: the OPUS legacy page says 'For commercial use, please contact NTT "
            "Communication Science Laboratories' — non-commercial by default, the same "
            "category that forced the TED2020 cut. `deep/10` listed 25,740,836 ja pairs "
            "in its corpus table and then gave the corpus no verdict anywhere, which is "
            "exactly how a build script templated from that table picks it up."
        ),
    ),
    # -- frequency ---------------------------------------------------------
    "hermitdave": Source(
        id="hermitdave",
        kind="frequency",
        languages=("es", "fr", "de"),
        licence="CC-BY-SA-4.0",
        verdict="shippable",
        attribution_required=True,
        attribution_owner="hermitdave/FrequencyWords",
        url=(
            "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/"
            "content/2018/{lang}/{lang}_50k.txt"
        ),
        requires_group="nlp",
        remedy="Lemmatise through the G1 adapter before the list touches the ledger.",
        note=(
            "'MIT License for code. CC-by-sa-4.0 for content.' A derived ordering "
            "shipped in the pack is share-alike and the manifest must say so. The "
            "lists are SURFACE FORMS, not lemmas. R9: `content/2018` holds 62 language "
            "directories, not the 69 `deep/10` stated. Japanese is deliberately absent "
            "from `languages` above: `ja_50k.txt` returns 404 and the only ja files are "
            "`ja_full.txt` / `ja_ignored.txt`, whose whitespace-tokenised 'words' are "
            "sentence fragments that would make V1 pass vacuously."
        ),
    ),
    "ja_derived_frequency": Source(
        id="ja_derived_frequency",
        kind="frequency",
        languages=("ja",),
        licence="CC-BY-2.0-FR",
        verdict="shippable",
        attribution_required=True,
        attribution_owner="Tatoeba contributors (counts derived in-house)",
        url=None,
        requires_group="nlp",
        remedy=(
            "Derive from Mode-A SudachiPy lemmas over cleaned Tatoeba jpn; there is "
            "no list to fetch."
        ),
        note="Japanese frequency is computed, not downloaded — see `hermitdave` above.",
    ),
    # -- lexicon -----------------------------------------------------------
    "cefrlex": Source(
        id="cefrlex",
        kind="lexicon",
        languages=("es", "fr"),
        licence="CC-BY-NC-SA-4.0",
        verdict="oracle_only",
        attribution_required=True,
        attribution_owner="CENTAL, UCLouvain (Francois et al., LREC 2014)",
        url="https://cental.uclouvain.be/cefrlex/static/resources/{lang}/",
        requires_group=None,
        remedy=(
            "Drop to the frequency-decile proxy; German has no files and Japanese has no resource."
        ),
        note=(
            "NC, so it can be consulted on the build machine and its per-lemma band "
            "shipped inside a CC BY-NC-SA pack — never inside AGPL code. R23: the "
            "product attaches CEFR to SECTIONS, which is a G3 curriculum output; the "
            "per-lemma lexicon is at best a sanity check on that assignment, so the "
            "band_source field records which of the two produced a row. R11: the "
            "French filenames are `FleLex_TT.csv` / `FleLex_CRF.csv` — lowercase 'e'."
        ),
    ),
    # -- morphology --------------------------------------------------------
    "spacy_es": Source(
        id="spacy_es",
        kind="morphology",
        languages=("es",),
        licence="MIT",
        verdict="shippable",
        attribution_required=False,
        attribution_owner=None,
        url=(
            "https://github.com/explosion/spacy-models/releases/download/"
            "es_core_news_md-3.8.0/es_core_news_md-3.8.0-py3-none-any.whl"
        ),
        requires_group="nlp",
        remedy="`uv sync --group nlp`. The wheel is pinned by URL in pyproject.toml.",
        note=(
            "Pinned by URL, never by name: `spacy download` resolves against a live "
            "manifest, and a lemmatiser change silently re-partitions the ledger and "
            "can retro-introduce a lemma before its unit — a V1 hazard that no test "
            "downstream of G2 can see."
        ),
    ),
    "sudachipy": Source(
        id="sudachipy",
        kind="morphology",
        languages=("ja",),
        licence="Apache-2.0",
        verdict="shippable",
        attribution_required=False,
        attribution_owner=None,
        url=None,
        requires_group="nlp",
        remedy="`uv add --group nlp sudachipy sudachidict_core` lands with the P7 Japanese kit.",
        note=(
            "Sudachi.rs (>=0.6); the 0.5 SudachiPy repo is archived. Mode A for the "
            "ledger so a compound cannot smuggle unseen morphemes past V1; Mode C for "
            "the display string and the audio unit. Store both."
        ),
    ),
    # -- validation engines ------------------------------------------------
    "languagetool": Source(
        id="languagetool",
        kind="grammar_rules",
        languages=("es", "fr", "de", "ja"),
        licence="LGPL-2.1-or-later",
        verdict="shippable",
        attribution_required=False,
        attribution_owner=None,
        url=None,
        requires_group=None,
        remedy=(
            "Run a build-time sidecar (Java 17 + Maven); never call the rate-limited public API."
        ),
        note=(
            "R1: `deep/10` read the live table's SPELL CHECK column as 'grammar checks' "
            "and the quoted 'spell checking only (no grammar checks)' sentence is about "
            "NORWEGIAN. Japanese has 735 XML GRAMMAR rules and NO spell checker — the "
            "exact inverse of what was written. V8 therefore runs grammar rules on "
            "Japanese (a thin ruleset, 10.6% of French's 6,984, so per-language "
            "severity thresholds still apply) and records `spellcheck_engine: none`, "
            "not `grammar_engine: none`."
        ),
    ),
    "kenlm": Source(
        id="kenlm",
        kind="lm",
        languages=("es", "fr", "de", "ja"),
        licence="LGPL-2.1-only",
        verdict="shippable",
        attribution_required=False,
        attribution_owner=None,
        url=None,
        requires_group="lm",
        remedy="`uv sync --group lm`, then train per language: no pre-built models exist.",
        note=(
            "R17: the repo's LICENSE says 'Most of the code here is licensed under the "
            "LGPL' with per-file exceptions (util/getopt, util/murmur_hash, "
            "util/string_piece, util/double-conversion) and ships COPYING.3 / "
            "COPYING.LESSER.3, so the clean 'LGPL-2.1 and GPL-3.0' line overstates it. "
            "Build-time only. Japanese must be trained on Mode-A-segmented text and "
            "queried the same way, or perplexity is nonsense."
        ),
    ),
    "simalign": Source(
        id="simalign",
        kind="align",
        languages=("es", "fr", "de", "ja"),
        licence="MIT",
        verdict="shippable",
        attribution_required=False,
        attribution_owner=None,
        url=None,
        requires_group="align",
        remedy="`uv sync --group align` — torch + transformers, not carried by CI.",
        note=(
            "Training-free. Published mBERT-Argmax F1: eng-fra .94, eng-deu .81, "
            "eng-hin .55. NO eng-spa or eng-jpn figure exists, so Spanish is "
            "spot-checked and the Japanese word-bank/hint feature is gated behind a "
            "manual 200-pair gold sample before any beta."
        ),
    ),
    # -- voices ------------------------------------------------------------
    "kokoro": Source(
        id="kokoro",
        kind="tts_voice",
        languages=("es", "fr", "ja"),
        licence="Apache-2.0",
        verdict="shippable",
        attribution_required=False,
        attribution_owner=None,
        url=None,
        requires_group="tts",
        remedy="`uv sync --group tts`; the ONNX weights download on first use.",
        note=(
            "Code and weights Apache-2.0. lang_codes cover e (es), f (fr) and j (ja) "
            "and there is NO German. Its G2P engine misaki first-classes ja "
            "(pyopenjtalk + full UniDic with pitch accent); es/fr fall to a generic "
            "espeak path. This is the only open Japanese voice left standing — see "
            "`piper`."
        ),
    ),
    "piper": Source(
        id="piper",
        kind="tts_voice",
        languages=("de",),
        licence="GPL-3.0-only",
        verdict="shippable",
        attribution_required=False,
        attribution_owner=None,
        url="https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/",
        requires_group="tts",
        remedy="Build-time tool only; the synthesiser never links into the app.",
        note=(
            "GPL-3.0 at OHF-Voice/piper1-gpl, so it is a build-time tool and nothing "
            "more. German only. R7: the single Japanese voice "
            "`ja/ja_JA/hi_fi_captain/medium` has a MODEL_CARD stating CC BY-NC-SA 4.0, "
            "the identical NC conflict that cut TED2020 — and the HF repo card's "
            "`license: mit` was never asserted over the Japanese tree, whose path is "
            "`ja/ja_JA` (`ja/ja_JP` 404s). Per-voice licences are not uniform: G9 "
            "records one per voice file, as it does per sentence."
        ),
    ),
    # -- Japanese surfaces -------------------------------------------------
    "jmdict_furigana": Source(
        id="jmdict_furigana",
        kind="furigana",
        languages=("ja",),
        licence="CC-BY-SA-4.0",
        verdict="shippable",
        attribution_required=True,
        attribution_owner="JmdictFurigana (Doublevil) / EDRDG JMdict",
        url="https://github.com/Doublevil/JmdictFurigana/releases/latest",
        requires_group=None,
        remedy="Releases land on the 25th of each month; pin the release tag, not `latest`.",
        note=(
            "Ruby spans are precomputed at build time so the app carries no Japanese "
            "NLP at runtime. R12: only the JSON is compressed — there is no "
            "`JmdictFurigana.txt.gz`."
        ),
    ),
    "kanjivg": Source(
        id="kanjivg",
        kind="strokes",
        languages=("ja",),
        licence="CC-BY-SA-3.0",
        verdict="shippable",
        attribution_required=True,
        attribution_owner="KanjiVG (Ulrich Apel)",
        url="https://github.com/KanjiVG/kanjivg/releases/latest",
        requires_group=None,
        remedy="Required by the G3b characters stage; there is no substitute source.",
        note=(
            "R22: the captured product has an Alphabet/Characters lesson type with "
            "stroke-order tracing that G0-G9 as originally written cannot produce. "
            "KanjiVG is attribution + share-alike and therefore shippable, unlike most "
            "of what the audio track had to reject."
        ),
    ),
}
