"""Pinned Sudachi Mode A/C adapter with paired G1 persistence.

G1 consumes analyse_with_script so required script evidence cannot be discarded.
spaCy's installed Japanese POS mapping is used directly, including its contextual
bigram rules; no trained Japanese spaCy model or guessed fallback POS is introduced.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from ..adapters import register_adapter
from ..artifacts import sentence_id as source_id
from ..config import ARTIFACT_SCHEMA_VERSION
from ..config.japanese_adapter import JAPANESE_SELFTEST, JAPANESE_SELFTEST_DIGEST, SPACY_POS_VERSION
from ..config.p7 import SUDACHI_DICTIONARY_NAME, SUDACHI_DICTIONARY_VERSION, SUDACHI_VERSION
from ..inputs import MissingInput
from ..japanese_script import ScriptAnalysisError, build_script_analysis
from ..ledger import is_lexical_pos, normalized_form
from .spacy_es import AdapterSelfTestFailed
from .sudachi_identity import LemmaIdentityError, resolve_lemma_identity


@dataclass(frozen=True, slots=True)
class JapaneseAnalysis:
    analysed: dict[str, Any]
    script: dict[str, Any]


def pair_digest(pair: JapaneseAnalysis) -> str:
    payload = json.dumps(
        {"analysed": pair.analysed, "script": pair.script},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def selftest_corpus_digest(rows: Sequence[tuple[str, str]]) -> str:
    payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _installed_versions() -> dict[str, str]:
    try:
        return {name: version(name) for name in ("sudachipy", "sudachidict-core", "spacy")}
    except PackageNotFoundError as exc:
        raise MissingInput(f"Japanese morphology dependency is missing: {exc}") from exc


def _check_versions() -> None:
    expected = {
        "sudachipy": SUDACHI_VERSION,
        "sudachidict-core": SUDACHI_DICTIONARY_VERSION,
        "spacy": SPACY_POS_VERSION,
    }
    actual = _installed_versions()
    for name, pin in expected.items():
        if actual.get(name) != pin:
            raise MissingInput(
                f"{name} must be {pin}, found {actual.get(name)!r}; revalidate Japanese analysis"
            )


@lru_cache(maxsize=1)
def _runtime():
    from sudachipy import dictionary

    lexicon = dictionary.Dictionary(dict=SUDACHI_DICTIONARY_NAME)
    return lexicon, lexicon.create(mode="A")


def _ud_pos(native: Sequence[Sequence[str]], surfaces: Sequence[str]) -> list[str]:
    """The exact installed spaCy Japanese POS conversion, preserving next-token rules."""
    from spacy.lang.ja import resolve_pos
    from spacy.parts_of_speech import NAMES

    if len(native) != len(surfaces) or any(len(parts) != 6 for parts in native):
        raise MissingInput("Japanese POS output is malformed")
    tags = ["-".join(part for part in parts[:4] if part != "*") for parts in native]
    result = []
    next_pos = None
    for index, (surface, tag) in enumerate(zip(surfaces, tags, strict=True)):
        try:
            if next_pos is not None:
                pos, next_pos = next_pos, None
            else:
                pos, next_pos = resolve_pos(
                    surface, tag, tags[index + 1] if index + 1 < len(tags) else None
                )
            result.append(NAMES[pos])
        except KeyError as exc:
            raise MissingInput(
                f"Japanese POS mapping does not support {tag!r}; no fallback POS"
            ) from exc
    return result


@lru_cache(maxsize=1)
def _morph_vocab():
    from spacy.vocab import Vocab

    return Vocab()


def _morph(native: Sequence[str]) -> str:
    from spacy.tokens import MorphAnalysis

    inflection = ";".join(part for part in native[4:] if part != "*")
    return str(MorphAnalysis(_morph_vocab(), {"Inflection": inflection} if inflection else {}))


class SudachiJaAdapter:
    lang = "ja"
    name = "sudachipy"

    def fingerprint(self) -> dict[str, Any]:
        _check_versions()
        return {
            "name": self.name,
            "version": SUDACHI_VERSION,
            "model": f"sudachidict_core-{SUDACHI_DICTIONARY_VERSION}+spacy-pos-{SPACY_POS_VERSION}",
            "split_mode": "A",
        }

    def analyse_with_script(self, *, sentence_id: str, text: str) -> JapaneseAnalysis:
        """Produce both exact outputs; all analyzer pronunciation remains unreviewed."""
        fingerprint = self.fingerprint()
        if not isinstance(text, str) or not text.strip():
            raise MissingInput("Japanese source text contains no lexical material")
        lexicon, tokenizer = _runtime()
        morphemes = list(tokenizer.tokenize(text, mode="A"))
        native = [m.part_of_speech() for m in morphemes]
        tags = _ud_pos(native, [m.surface() for m in morphemes])
        tokens = []
        surface_readings = []
        try:
            for morpheme, parts, pos in zip(morphemes, native, tags, strict=True):
                if morpheme.surface().isspace():
                    continue
                token = {
                    "surface": morpheme.surface(),
                    "lemma": normalized_form("ja", morpheme.normalized_form()),
                    "pos": pos,
                    "morph": _morph(parts),
                    "start": morpheme.begin(),
                    "end": morpheme.end(),
                }
                if is_lexical_pos(pos):
                    identity = resolve_lemma_identity(morpheme, lexicon)
                    token.update(
                        lemma=identity.lemma,
                        normalized_form=identity.normalized_form,
                        reading=identity.reading,
                    )
                surface_readings.append(
                    {
                        "token_index": len(tokens),
                        "surface": token["surface"],
                        "start": token["start"],
                        "end": token["end"],
                        "reading": morpheme.reading_form(),
                    }
                )
                tokens.append(token)
        except LemmaIdentityError as exc:
            raise MissingInput(
                f"Japanese source {sentence_id} cannot preserve lexical identity: {exc}"
            ) from exc
        lexical = [token for token in tokens if is_lexical_pos(token["pos"])]
        if not lexical:
            raise MissingInput("Japanese source contains no lexical Mode A token")
        mode_c = [
            {
                "surface": m.surface(),
                "start": m.begin(),
                "end": m.end(),
                "reading": m.reading_form(),
            }
            for m in tokenizer.tokenize(text, mode="C")
            if not m.surface().isspace()
        ]
        display = [
            row["surface"]
            for row in mode_c
            if any(row["start"] <= t["start"] < t["end"] <= row["end"] for t in lexical)
        ]
        analysed = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "lang": self.lang,
            "sentence_id": sentence_id,
            "adapter": fingerprint,
            "tokens": tokens,
            "lemmas": [token["lemma"] for token in lexical],
            "display_tokens": display,
        }
        # Preserve whitespace gaps, but never insert display text as a reading fallback.
        cursor = 0
        spoken = []
        for row in mode_c:
            spoken.extend((text[cursor : row["start"]], row["reading"]))
            cursor = row["end"]
        spoken.append(text[cursor:])
        try:
            script = build_script_analysis(
                analysed,
                text=text,
                mode_c_tokens=mode_c,
                mode_a_surface_readings=surface_readings,
                tts_reading="".join(spoken),
            )
        except ScriptAnalysisError as exc:
            raise MissingInput(
                f"Japanese source {sentence_id} has invalid paired script evidence: {exc}"
            ) from exc
        return JapaneseAnalysis(analysed, script)

    def self_test(self) -> list[str]:
        if not JAPANESE_SELFTEST:
            raise MissingInput("Japanese adapter has no measured nonempty self-test corpus")
        if selftest_corpus_digest(JAPANESE_SELFTEST) != JAPANESE_SELFTEST_DIGEST:
            raise AdapterSelfTestFailed(
                "Japanese self-test corpus digest differs from its frozen declaration"
            )
        failures = []
        for text, expected in JAPANESE_SELFTEST:
            actual = pair_digest(
                self.analyse_with_script(sentence_id=source_id("ja", text), text=text)
            )
            if actual != expected:
                failures.append(
                    f"{text!r}: paired analysis digest {actual} differs from {expected}"
                )
        return failures

    def require_self_test(self) -> None:
        failures = self.self_test()
        if failures:
            raise AdapterSelfTestFailed(
                "Japanese paired adapter self-test drift:\n" + "\n".join(failures)
            )


@register_adapter("ja")
def build() -> SudachiJaAdapter:
    """G1 must consume the paired API; no unpaired analysis method is provided."""
    return SudachiJaAdapter()
