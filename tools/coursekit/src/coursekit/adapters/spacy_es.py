"""The Spanish morphology adapter: spaCy 3.8 + `es_core_news_md` 3.8.0.

Segment, lemmatise, and emit a UD POS tag plus a morph-feature bundle per token, on both
sides of the pair. `scope2/00` §2.1 lists this as one of the four inputs whose fallback
column reads "**None.** Hard gate", and `inputs.require_group("nlp")` is where that gate
is enforced.

## The self-test corpus, and what it is actually for

`self_test()` runs `config/g1.ADAPTER_SELFTEST_ES` — eighteen original A1 sentences — and
fails if one token's lemma or UD tag has moved. `stages/g1_analyze` calls it before it
analyses a single corpus row. It also checks the OTHER side, the post-B9(a) fingerprint,
for the six sentences the normalisation table changes something in.

The hazard it exists for is not "spaCy might be broken". It is that **a silent
lemmatiser swap retro-introduces lemmas before their unit and makes V1 pass vacuously.**
V1 says no lemma appears in an exercise before its introduction unit, and the ledger's
partition into lemmas IS the lemmatiser's output. Swap the lemmatiser and the partition
moves: two items become one, one becomes two, and the units they were assigned to no
longer match the sentences that were selected for them. Every test downstream of G2 still
passes, because every one of them re-derives the ledger with the new lemmatiser and
agrees with itself. The pack is wrong and the suite is green.

`pyproject.toml` pins the model by wheel URL so `spacy download` cannot resolve a new one
against the live manifest. This is the belt for that pair of braces: a contributor with a
stale venv, a patched spaCy, an accidental `spacy-lookups-data`, or a `uv sync` that
silently picked up a different build gets a loud failure naming the token that moved.

Four of the frozen answers are wrong Spanish (`Nosotros` -> `yo`, `se` -> `él`,
`muy` -> `mucho`, `trabajé` unlemmatised). They are frozen anyway, because the table
records what the pinned model DOES. A later "fix" that quietly improves them moves lemmas
between units in packs that are already built, which is the same failure from the other
direction.

## And the one place a raw lemma is allowed to move (founder ruling B9(a))

`ledger_lemma` applies `config/g1.LEMMA_NORMALISATION_ES` on the way out of `analyse()`
and `_single_token`, so a corpus sentence and a bare frequency row land on the same
ledger key. That is a deliberate, declared, digest-covered exception to "freeze what the
model does" and not a loosening of it: the frozen fingerprints above still record the RAW
answer, and a second frozen table (`ADAPTER_SELFTEST_ES_NORMALISED`) records what the
first one becomes. Raw catches the MODEL moving; normalised catches the TABLE stopping.
Neither alone can tell the two apart, which is why both are frozen.

The table exists because without it `Buenos días.` was out of vocabulary in the lesson
that teaches both `bueno` and `día` (`docs/P2-BLOCKERS.md` §B9). What it may and may not
contain is decision D-B9A-01, argued beside the table itself.
"""

from __future__ import annotations

import hashlib
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from ..adapters import register_adapter
from ..artifacts import validate_record
from ..config import ARTIFACT_SCHEMA_VERSION
from ..config.g1 import (
    ADAPTER_BY_LANGUAGE,
    ADAPTER_SELFTEST,
    ADAPTER_SELFTEST_ES_DIGEST,
    ADAPTER_SELFTEST_ES_NORMALISED,
    LEMMA_NORMALISATION_BY_LANGUAGE,
    LEMMA_NORMALISATION_ES,
    LEMMA_NORMALISATION_PROBE,
    NON_LEXICAL_POS,
    SPACY_BATCH_SIZE,
    SPACY_DISABLED_COMPONENTS,
    SPACY_MODEL_BY_LANGUAGE,
    SPACY_MODEL_VERSION,
)
from ..inputs import MissingInput, require_group

__all__ = [
    "AdapterSelfTestFailed",
    "SpacyEsAdapter",
    "ledger_lemma",
    "parse_fingerprint",
    "selftest_digest",
]


def ledger_lemma(lang: str, raw_lemma: str) -> str:
    """The ledger lemma for one raw spaCy lemma: NFC-lowercased, then normalised.

    The ONE implementation of founder ruling B9(a), called from `analyse()` and from
    `_single_token` (so `lemmatise_surface` and `lemmatise_surfaces` agree with it), and
    the only reader of `config/g1.LEMMA_NORMALISATION_BY_LANGUAGE`.

    The table is keyed on the NFC-lowercased raw lemma rather than on whatever spaCy
    handed over, so a row cannot be missed because the model returned `Buenas` where the
    table says `buenas`; the values are already NFC-lowercase and
    `test_g1_analyze.py` asserts it, so the normalised answer needs no second pass.

    A language with no table is normalised by nothing. That is the right default and not
    a silent fallback: the mapping is a measurement of one lemmatiser, so inventing rows
    for fr/de/ja from the Spanish ones would be exactly the quiet re-partition this
    module exists to make loud.
    """
    lemma = unicodedata.normalize("NFC", raw_lemma.lower())
    return LEMMA_NORMALISATION_BY_LANGUAGE.get(lang, {}).get(lemma, lemma)


class AdapterSelfTestFailed(RuntimeError):
    """The pinned lemmatiser stopped producing what the frozen corpus records.

    Loud and fatal, never a warning. A warning here is read as noise and the pack ships
    with a ledger partitioned by a lemmatiser nobody chose.
    """


@dataclass(frozen=True, slots=True)
class SpacyEsAdapter:
    """Spanish. One instance per process; `spacy.load` is the expensive part."""

    lang: str
    name: str
    model: str
    model_version: str

    # -- identity ----------------------------------------------------------

    def fingerprint(self) -> dict[str, Any]:
        """The `adapter` block that rides on EVERY `analysed_sentence` row.

        Per row rather than per run, because a run that was resumed or re-driven with
        `--only g1` after a model change produces a file with two partitions in it, and
        the row is the only place that is visible.
        """
        import spacy

        return {
            "name": self.name,
            "version": spacy.__version__,
            "model": f"{self.model}-{self.model_version}",
            "split_mode": None,
        }

    # -- analysis ----------------------------------------------------------

    def analyse(self, *, sentence_id: str, text: str) -> dict[str, Any]:
        """One `analysed_sentence` record: tokens, ledger lemmas, display tokens.

        `lemmas` is the ledger key set and the ONLY thing V1 and V2 may read.
        `display_tokens` is what the learner sees in a word bank, so punctuation is out
        of it; punctuation stays in `tokens[]` with its character offsets, because the
        grader and the tile layout need the spans.
        """
        doc = _pipeline(self.model)(text)
        tokens: list[dict[str, Any]] = []
        for token in doc:
            if token.is_space:
                continue
            tokens.append(
                {
                    "surface": token.text,
                    "lemma": ledger_lemma(self.lang, token.lemma_),
                    "pos": token.pos_,
                    "morph": str(token.morph),
                    "start": token.idx,
                    "end": token.idx + len(token.text),
                }
            )
        if not tokens:
            raise MissingInput(
                f"{self.model} produced no tokens for {text!r}. An empty analysis is "
                f"never a row: it would carry no lemmas and pass every downstream check."
            )
        lexical = [token for token in tokens if token["pos"] not in NON_LEXICAL_POS]
        if not lexical:
            raise MissingInput(
                f"{self.model} found no lexical token in {text!r} (every token is "
                f"punctuation or a symbol). A sentence with no ledger unit cannot be "
                f"taught and must be dropped at G0, not carried."
            )
        record = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "sentence_id": sentence_id,
            "lang": self.lang,
            "adapter": self.fingerprint(),
            "tokens": tokens,
            "lemmas": [token["lemma"] for token in lexical],
            "display_tokens": [token["surface"] for token in lexical],
        }
        validate_record("analysed_sentence", record, where=f"{self.name}:{sentence_id}")
        return record

    def lemmatise_surface(self, surface: str) -> tuple[str, str] | None:
        """`(lemma, UD POS)` for one bare surface form, or None if it is not a word.

        **This is what a frequency list needs**, and it is a compromise with its eyes
        open. hermitdave's lists are surface forms with no context, so the model is asked
        to tag a one-word document, and its POS is much worse than it would be inside a
        sentence — measured 2026-09-12, `es_core_news_md` calls 6.1% of the top 3,000
        Spanish surface forms PROPN, `casa` and `perro` among them. The alternative —
        count surface forms and skip lemmatisation — is not a compromise but a broken
        ledger: `casa` and `casas` become two items and `ser` becomes five. So G2 takes
        the POS from G1's in-context corpus wherever it has one and uses this only for
        the tail, and records how many rows came from each.

        A multi-token surface (hermitdave's tail carries a few) returns None: a frequency
        row that is really two words cannot be attributed to one lemma, and guessing
        which half to keep is worse than dropping a rank.
        """
        return _single_token(_pipeline(self.model)(surface), lang=self.lang)

    def lemmatise_surfaces(self, surfaces: Sequence[str]) -> list[tuple[str, str] | None]:
        """`lemmatise_surface` over a whole list, in order, through `nlp.pipe`.

        Part of the adapter contract, not a convenience: a frequency list is 50,000 rows
        and one `nlp()` call each is minutes of call overhead for an answer `pipe`
        produces in a fraction of the time. Same result, element for element — the
        per-surface method is what defines the answer and this is the batched route through
        the same code.
        """
        ordered = list(surfaces)
        pipeline = _pipeline(self.model)
        return [
            _single_token(doc, lang=self.lang)
            for doc in pipeline.pipe(ordered, batch_size=SPACY_BATCH_SIZE)
        ]

    # -- measurement -------------------------------------------------------

    def raw_lemma_of_surface(self, surface: str) -> str | None:
        """The **raw** lemma of one bare surface — the table's third column, re-measured.

        `lemmatise_surface` cannot answer this: it returns the lemma with the B9(a) table
        already applied, so comparing it to the table's ledger column is circular and a
        stale row passes. That is not hypothetical — the first version of
        `test_INV_PACK_06_every_declared_surface_really_produces_its_raw_lemma` did
        exactly that, and two rows (`días`, `tardes`) carried third-column surfaces the
        model contradicts while the test stayed green.

        `None` when the probe is not one token, or is not a content word, which is how a
        row naming an impossible surface fails rather than silently comparing to nothing.
        The probe shape is `config/g1.LEMMA_NORMALISATION_PROBE`, so this and the table's
        third column cannot drift apart.
        """
        doc = _pipeline(self.model)(LEMMA_NORMALISATION_PROBE.format(surface=surface))
        words = [token for token in doc if not token.is_space]
        if len(words) != 1 or words[0].pos_ in NON_LEXICAL_POS:
            return None
        return unicodedata.normalize("NFC", words[0].lemma_.lower())

    # -- the gate ----------------------------------------------------------

    def self_test(self) -> list[str]:
        """Every disagreement with the frozen corpus, as readable lines. `[]` is a pass.

        Both sides of it. The RAW fingerprints catch the model moving; the normalised
        ones (`ADAPTER_SELFTEST_ES_NORMALISED`) catch the B9(a) table stopping firing,
        which the raw side cannot see — a deleted row leaves every raw fingerprint green
        and puts `Buenos días.` back outside the lesson that teaches both its words.
        """
        failures: list[str] = []
        for sentence, expected in ADAPTER_SELFTEST[self.lang]:
            actual = self._fingerprint_sentence(sentence)
            if actual != expected:
                failures.extend(_diff(sentence, expected, actual))
            wanted = self._normalised_expectation(sentence)
            if wanted is None:
                continue
            normalised = self._fingerprint_sentence(sentence, normalise=True)
            if normalised != wanted:
                failures.extend(_diff(f"{sentence} (normalised)", wanted, normalised))
        return failures

    def _normalised_expectation(self, sentence: str) -> str | None:
        """The frozen post-table fingerprint for `sentence`, or None if it has no row.

        No row means "the table changes nothing here", and that is asserted rather than
        assumed: `test_g1_analyze.py` checks every unlisted sentence normalises to its
        raw fingerprint unchanged, so a new row that fires somewhere nobody looked at
        fails the suite instead of quietly moving a lemma.
        """
        if self.lang != "es":
            return None
        return ADAPTER_SELFTEST_ES_NORMALISED.get(sentence)

    def require_self_test(self) -> None:
        """Run the self-test and raise on any disagreement."""
        failures = self.self_test()
        if not failures:
            return
        raise AdapterSelfTestFailed(
            f"{self.model}-{self.model_version} no longer produces the frozen "
            f"lemmatisation in config/g1.ADAPTER_SELFTEST_ES:\n  "
            + "\n  ".join(failures)
            + "\n\nThis is not cosmetic. The lemma ledger IS this function's partition of "
            "the vocabulary, so a change here re-partitions it and can retro-introduce a "
            "lemma before its introduction unit — a V1 failure invisible to every test "
            "downstream of G2, because all of them agree with the new lemmatiser. "
            "Reinstall the pinned wheel (`uv sync --locked`), or, if the change is "
            "deliberate, update the frozen table and REBUILD EVERY PACK: a pack already "
            "shipped was partitioned by the old one."
        )

    def _fingerprint_sentence(self, sentence: str, *, normalise: bool = False) -> str:
        """`surface/lemma/POS ...` for one sentence; RAW by default.

        Raw is the default because the frozen table records what the model does, and a
        fingerprint that had already been through the B9(a) table could not tell a model
        change from a table change. `normalise=True` is the other frozen side.
        """
        doc = _pipeline(self.model)(sentence)

        def lemma_of(token) -> str:  # noqa: ANN001 — spaCy's Token
            if normalise:
                return ledger_lemma(self.lang, token.lemma_)
            return unicodedata.normalize("NFC", token.lemma_.lower())

        return " ".join(
            f"{token.text}/{lemma_of(token)}/{token.pos_}" for token in doc if not token.is_space
        )


def _single_token(doc, *, lang: str) -> tuple[str, str] | None:  # noqa: ANN001 — Doc
    """`(ledger lemma, UD POS)` for a one-lexical-word document, else None.

    The lemma goes through `ledger_lemma`, so the frequency list and G3's reachability
    gate are partitioned the same way a corpus sentence is. Without that the ledger has
    two partitions again — `buenos` counted under `buen` in the lexicon and under
    `bueno` in every analysed sentence — which is the exact shape of INV-PACK-40.
    """
    words = [token for token in doc if not token.is_space]
    if len(words) != 1:
        return None
    token = words[0]
    if token.pos_ in NON_LEXICAL_POS:
        return None
    return ledger_lemma(lang, token.lemma_), token.pos_


def parse_fingerprint(fingerprint: str) -> list[tuple[str, str, str]]:
    """Take a `surface/lemma/POS ...` fingerprint apart into triples.

    The one parser for the format, so the frozen table in `config/g1.py` is read the same
    way everywhere. A surface may itself be a slash, so the split is from the right with
    a maxsplit of two.
    """
    triples: list[tuple[str, str, str]] = []
    for entry in fingerprint.split(" "):
        surface, lemma, pos = entry.rsplit("/", 2)
        triples.append((surface, lemma, pos))
    return triples


def _diff(sentence: str, expected: str, actual: str) -> list[str]:
    """One line per token that moved; one line if the segmentation itself changed."""
    want = expected.split(" ")
    got = actual.split(" ")
    if len(want) != len(got):
        return [
            f"{sentence!r}: segmentation changed, {len(want)} tokens -> {len(got)}"
            f"\n    frozen: {expected}\n    actual: {actual}"
        ]
    return [
        f"{sentence!r}: {before} -> {after}"
        for before, after in zip(want, got, strict=True)
        if before != after
    ]


def selftest_digest(lang: str) -> str:
    """sha256 over everything frozen about this lemmatiser, for the runlog and manifest.

    One line a reader can compare across two runs. The tables in `config/g1.py` are what
    tell them WHICH token moved; this is what tells them that something did.

    **Three tables and one probe, one digest, on purpose.** The frozen corpus, the
    B9(a) normalisation table and its normalised expectations all partition the ledger,
    and a digest that covered only the first would let a normalisation row be added,
    changed or deleted with the runlog and the manifest still reporting the same
    fingerprint. `LEMMA_NORMALISATION_PROBE` rides along because the table's third
    column is evidence only relative to one probe — change the probe and the same rows
    mean something else.
    """
    lines = [f"{sentence}\t{expected}" for sentence, expected in ADAPTER_SELFTEST[lang]]
    if lang == "es":
        lines.append(f"probe\t{LEMMA_NORMALISATION_PROBE}")
        lines.extend(
            f"{raw}\t{ledger}\t{','.join(surfaces)}"
            for raw, ledger, surfaces in LEMMA_NORMALISATION_ES
        )
        lines.extend(
            f"{sentence}\t{expected}"
            for sentence, expected in sorted(ADAPTER_SELFTEST_ES_NORMALISED.items())
        )
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


@lru_cache(maxsize=4)
def _pipeline(model: str):  # noqa: ANN202 — spaCy's Language type needs the import
    """Load the pinned model once per process, and refuse a different version.

    `spacy.load` takes a bare name because that is its only API; the pin lives in the
    lockfile. So the version is asserted HERE, at the first use, rather than trusted:
    a venv carrying a different build otherwise produces a differently partitioned ledger
    that every downstream test agrees with.
    """
    require_group("nlp", needed_by=f"the {model} morphology adapter")
    import spacy

    try:
        nlp = spacy.load(model, disable=list(SPACY_DISABLED_COMPONENTS))
    except OSError as exc:  # pragma: no cover — needs a venv without the wheel
        raise MissingInput(
            f"{model} is not installed. It is pinned BY WHEEL URL in "
            f"tools/coursekit/pyproject.toml; install it with `uv sync --locked` from "
            f"tools/coursekit. Never `python -m spacy download {model}`: that resolves "
            f"against a live manifest and can hand you a different lemmatiser."
        ) from exc
    installed = nlp.meta.get("version", "")
    if installed != SPACY_MODEL_VERSION:
        raise AdapterSelfTestFailed(
            f"{model} is version {installed!r}, not the pinned {SPACY_MODEL_VERSION!r}. "
            f"A lemmatiser change re-partitions the lemma ledger and can retro-introduce "
            f"a lemma before its introduction unit. Run `uv sync --locked`."
        )
    return nlp


@register_adapter("es")
def build() -> SpacyEsAdapter:
    """The registered Spanish adapter. `ADAPTERS.get("es")` returns this function."""
    return SpacyEsAdapter(
        lang="es",
        name=ADAPTER_BY_LANGUAGE["es"],
        model=SPACY_MODEL_BY_LANGUAGE["es"],
        model_version=SPACY_MODEL_VERSION,
    )


# The frozen digest in `config/g1.py` must describe the frozen table beside it. Checked
# at import rather than in a test, because the two live in different files and a table
# edited without its digest is exactly the silent change this module exists to catch.
if selftest_digest("es") != ADAPTER_SELFTEST_ES_DIGEST:  # pragma: no cover
    raise AdapterSelfTestFailed(
        "config/g1.ADAPTER_SELFTEST_ES_DIGEST does not describe ADAPTER_SELFTEST_ES. "
        "The table was edited without its digest, or the other way round."
    )
