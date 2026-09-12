"""The Spanish morphology adapter: spaCy 3.8 + `es_core_news_md` 3.8.0.

Segment, lemmatise, and emit a UD POS tag plus a morph-feature bundle per token, on both
sides of the pair. `scope2/00` §2.1 lists this as one of the four inputs whose fallback
column reads "**None.** Hard gate", and `inputs.require_group("nlp")` is where that gate
is enforced.

## The self-test corpus, and what it is actually for

`self_test()` runs `config/g1.ADAPTER_SELFTEST_ES` — twelve original A1 sentences — and
fails if one token's lemma or UD tag has moved. `stages/g1_analyze` calls it before it
analyses a single corpus row.

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
    "parse_fingerprint",
    "selftest_digest",
]


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
                    "lemma": unicodedata.normalize("NFC", token.lemma_.lower()),
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
        return _single_token(_pipeline(self.model)(surface))

    def lemmatise_surfaces(
        self, surfaces: Sequence[str]
    ) -> list[tuple[str, str] | None]:
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
            _single_token(doc)
            for doc in pipeline.pipe(ordered, batch_size=SPACY_BATCH_SIZE)
        ]

    # -- the gate ----------------------------------------------------------

    def self_test(self) -> list[str]:
        """Every disagreement with the frozen corpus, as readable lines. `[]` is a pass."""
        failures: list[str] = []
        for sentence, expected in ADAPTER_SELFTEST[self.lang]:
            actual = self._fingerprint_sentence(sentence)
            if actual == expected:
                continue
            failures.extend(_diff(sentence, expected, actual))
        return failures

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

    def _fingerprint_sentence(self, sentence: str) -> str:
        doc = _pipeline(self.model)(sentence)
        return " ".join(
            f"{token.text}/{unicodedata.normalize('NFC', token.lemma_.lower())}/{token.pos_}"
            for token in doc
            if not token.is_space
        )


def _single_token(doc) -> tuple[str, str] | None:  # noqa: ANN001 — spaCy's Doc
    """`(lemma, UD POS)` for a document that is exactly one lexical word, else None."""
    words = [token for token in doc if not token.is_space]
    if len(words) != 1:
        return None
    token = words[0]
    if token.pos_ in NON_LEXICAL_POS:
        return None
    return unicodedata.normalize("NFC", token.lemma_.lower()), token.pos_


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
    """sha256 over the frozen corpus, for the runlog and the manifest.

    One line a reader can compare across two runs. The table in `config/g1.py` is what
    tells them WHICH token moved; this is what tells them that something did.
    """
    payload = "\n".join(
        f"{sentence}\t{expected}" for sentence, expected in ADAPTER_SELFTEST[lang]
    )
    return hashlib.sha256(payload.encode()).hexdigest()


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
