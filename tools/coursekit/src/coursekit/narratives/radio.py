"""Exact Radio source preparation. No timings, pack targets, review or audio are invented."""

from __future__ import annotations

import copy
import hashlib
import json
import math
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from typing import Any

from ..artifacts import ArtifactError, sentence_id, validate_record
from ..config.narratives import (
    RADIO_LANGUAGES_IMPLEMENTED,
    RADIO_MAX_MATCH_PAIRS,
    RADIO_MAX_OPTIONS,
    RADIO_MIN_CONTENT_TILES,
    RADIO_MIN_OPTIONS,
    RADIO_PREPARATION_REQUIREMENTS,
    RADIO_SCHEMA_VERSION,
)
from ..ledger import is_lexical_pos
from ..tts.cast import Cast, CastError
from .compiler import NarrativeError


@dataclass(frozen=True)
class RadioPreparation:
    source: dict[str, Any]
    source_hash: str
    author: str
    analyses: dict[str, dict[str, Any]]
    source_text: str
    cast_sha256: str
    texts: dict[str, str]
    requires: tuple[str, ...] = RADIO_PREPARATION_REQUIREMENTS


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise NarrativeError(message)


def _text(value: Any, where: str) -> str:
    _require(
        isinstance(value, str) and bool(value.strip()) and "\0" not in value,
        f"{where}: nonblank text required.",
    )
    try:
        value.encode("utf-8")
    except UnicodeError as exc:
        raise NarrativeError(f"{where}: valid UTF-8 text required.") from exc
    return value


def _closed(
    value: Any, required: set[str], where: str, optional: set[str] | None = None
) -> Mapping[str, Any]:
    _require(
        isinstance(value, Mapping) and required <= value.keys() <= required | (optional or set()),
        f"{where}: missing or unknown fields.",
    )
    return value


def _rows(value: Any, where: str) -> list:
    _require(isinstance(value, list) and bool(value), f"{where}: nonempty array required.")
    return value


def _strings(value: Any, where: str) -> list[str]:
    values = [_text(v, where) for v in _rows(value, where)]
    _require(len(set(values)) == len(values), f"{where}: duplicate values.")
    return values


def _integer(value: Any, where: str) -> int:
    _require(
        type(value) is int and 0 < value <= 2**53 - 1, f"{where}: positive safe integer required."
    )
    return value


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, f"Duplicate Radio JSON key {key!r}.")
        result[key] = value
    return result


def _analysis(analyse, language, text, identifier):
    try:
        record = analyse(language, text)
        validate_record("analysed_sentence", record, where=identifier)
        _require(
            record["lang"] == language and record["sentence_id"] == sentence_id(language, text),
            f"Radio analysis {identifier}: stale language/text identity.",
        )
        previous = 0
        for token in record["tokens"]:
            start, end = token["start"], token["end"]
            _require(
                type(start) is int
                and type(end) is int
                and previous <= start < end <= len(text)
                and not text[previous:start].strip()
                and text[start:end] == token["surface"],
                f"Radio analysis {identifier}: incomplete or stale exact spans.",
            )
            previous = end
        _require(
            not text[previous:].strip(), f"Radio analysis {identifier}: uncovered trailing text."
        )
        lexical = [t for t in record["tokens"] if is_lexical_pos(t["pos"])]
        _require(
            bool(lexical)
            and record["lemmas"] == [t["lemma"] for t in lexical]
            and record["display_tokens"] == [t["surface"] for t in lexical],
            f"Radio analysis {identifier}: lexical/display evidence differs from exact tokens.",
        )
        return copy.deepcopy(record)
    except (ArtifactError, KeyError, TypeError, ValueError) as exc:
        raise NarrativeError(f"Radio analysis {identifier}: {exc}") from exc


def prepare_radio(
    source: str, *, analyse: Callable[[str, str], dict[str, Any]], cast: Cast
) -> RadioPreparation:
    """Parse the preserved source and analyze every Spanish learner-facing surface.

    English translation strings are retained for independent bilingual review; this
    function does not claim English grammar, meaning, curriculum, or audio approval.
    Target bindings and sentence-boundary times belong to the later explicit plan
    and measured audio stage, not to a guess from a lemma or target duration.
    """
    _text(source, "Radio source")
    try:
        document = json.loads(source, object_pairs_hook=_pairs)
    except (json.JSONDecodeError, TypeError) as exc:
        raise NarrativeError("Radio source is invalid JSON.") from exc
    _closed(
        document,
        {
            "schema_version",
            "id",
            "title",
            "translation",
            "language",
            "unit_index",
            "author",
            "register",
            "show",
            "l1_ratio",
            "target_duration_ms",
            "segments",
            "questions",
        },
        "Radio source",
    )
    _require(
        type(document["schema_version"]) is int
        and document["schema_version"] == RADIO_SCHEMA_VERSION,
        "Radio schema version is unsupported.",
    )
    for key in ("id", "title", "translation", "language", "author", "register"):
        _text(document[key], "Radio " + key)
    language = document["language"]
    _require(
        language in RADIO_LANGUAGES_IMPLEMENTED and cast.language == language,
        "Radio source language/cast preparation is unsupported.",
    )
    _integer(document["unit_index"], "Radio unit")
    _integer(document["target_duration_ms"], "Radio target duration")
    ratio = document["l1_ratio"]
    _require(
        type(ratio) in (int, float) and math.isfinite(ratio) and 0 <= ratio <= 1,
        "Radio language-ratio declaration is invalid.",
    )
    show = _closed(document["show"], {"id", "title", "host_character_id"}, "Radio show")
    for key, value in show.items():
        _text(value, "Radio show " + key)
    try:
        cast.role(show["host_character_id"])
    except CastError as exc:
        raise NarrativeError(f"Radio host: {exc}") from exc
    analyses = {}
    texts = {}

    def add(identifier, text):
        texts[identifier] = _text(text, identifier)
        analyses[identifier] = _analysis(analyse, language, texts[identifier], identifier)

    add("title", document["title"])
    add("show:title", show["title"])
    segment_ids = set()
    for segment in _rows(document["segments"], "Radio segments"):
        _closed(segment, {"id", "character_id", "text", "translation"}, "Radio segment")
        for key, value in segment.items():
            _text(value, "Radio segment " + key)
        _require(segment["id"] not in segment_ids, "Radio segment identity is duplicated.")
        segment_ids.add(segment["id"])
        try:
            cast.role(segment["character_id"])
        except CastError as exc:
            raise NarrativeError(f"Radio segment cast: {exc}") from exc
        add("segment:" + segment["id"], segment["text"])
    # This revision has no per-segment English-language carrier. Never label a mixed
    # episode checked by applying the Spanish analyzer to an English host sentence.
    _require(ratio == 0, "Radio mixed-language source needs an explicit language/analysis carrier.")
    question_ids, anchors = set(), set()
    for question in _rows(document["questions"], "Radio questions"):
        _require(isinstance(question, Mapping), "Radio question must be an object.")
        kind = question.get("kind")
        _require(isinstance(kind, str), "Radio question shape must be text.")
        base = {"id", "kind", "after_segment"}
        extra = {
            "comprehension": {"prompt", "accepted", "distractors", "target_lemmas"},
            "listenSelect": {"count", "correct_lemmas", "tile_lemmas"},
            "matching": {"pairs"},
        }.get(kind)
        _require(extra is not None, "Radio question shape is unsupported.")
        _closed(question, base | extra, "Radio question")
        identifier = _text(question["id"], "Radio question ID")
        _require(identifier not in question_ids, "Radio question identity is duplicated.")
        question_ids.add(identifier)
        anchor = _text(question["after_segment"], "Radio question anchor")
        _require(
            anchor in segment_ids and anchor not in anchors,
            "Radio anchor must name one distinct actual segment boundary.",
        )
        anchors.add(anchor)
        if kind == "comprehension":
            add("question:" + identifier + ":prompt", question["prompt"])
            answers = [
                _text(question["accepted"], "Radio accepted answer"),
                *_strings(question["distractors"], "Radio distractors"),
            ]
            _require(
                RADIO_MIN_OPTIONS <= len(answers) <= RADIO_MAX_OPTIONS
                and len(set(answers)) == len(answers),
                "Radio comprehension options must be distinct and fit the actual renderer.",
            )
            add("question:" + identifier + ":accepted", answers[0])
            for i, answer in enumerate(answers[1:]):
                add(f"question:{identifier}:distractor:{i}", answer)
            _strings(question["target_lemmas"], "Radio comprehension targets")
        elif kind == "listenSelect":
            count = _integer(question["count"], "Radio selection count")
            correct = _strings(question["correct_lemmas"], "Radio correct lexical claims")
            tiles = _strings(question["tile_lemmas"], "Radio tile lexical claims")
            _require(
                len(tiles) >= RADIO_MIN_CONTENT_TILES
                and count == len(correct)
                and set(correct) <= set(tiles),
                "Radio selection count/content claims are inconsistent.",
            )
        else:
            pairs = _rows(question["pairs"], "Radio matching pairs")
            _require(
                len(pairs) <= RADIO_MAX_MATCH_PAIRS,
                "Radio matching source exceeds displayed pair capacity.",
            )
            lemmas, meanings = set(), set()
            for i, pair in enumerate(pairs):
                _closed(pair, {"lemma", "translation"}, "Radio matching pair")
                lemma, meaning = (
                    _text(pair["lemma"], "Radio matching lemma"),
                    _text(pair["translation"], "Radio matching translation"),
                )
                _require(
                    lemma not in lemmas and meaning not in meanings,
                    "Radio matching pairs are ambiguous or duplicated.",
                )
                lemmas.add(lemma)
                meanings.add(meaning)
                add(f"question:{identifier}:pair:{i}", lemma)
    return RadioPreparation(
        copy.deepcopy(document),
        hashlib.sha256(source.encode()).hexdigest(),
        document["author"],
        analyses,
        source,
        hashlib.sha256(
            json.dumps(
                asdict(cast), sort_keys=True, ensure_ascii=False, separators=(",", ":")
            ).encode()
        ).hexdigest(),
        texts,
    )


def radio_preparation_hash(prepared: RadioPreparation) -> str:
    """Exact source, every analysis, and cast snapshot for subsequent plan/review joins."""
    _require(
        hashlib.sha256(prepared.source_text.encode()).hexdigest() == prepared.source_hash
        and json.loads(prepared.source_text, object_pairs_hook=_pairs) == prepared.source,
        "Radio preparation: source snapshot was changed.",
    )
    source = prepared.source
    expected = {"title": source["title"], "show:title": source["show"]["title"]}
    expected.update({"segment:" + row["id"]: row["text"] for row in source["segments"]})
    for question in source["questions"]:
        qid = question["id"]
        if question["kind"] == "comprehension":
            expected["question:" + qid + ":prompt"] = question["prompt"]
            expected["question:" + qid + ":accepted"] = question["accepted"]
            expected.update(
                {
                    f"question:{qid}:distractor:{i}": text
                    for i, text in enumerate(question["distractors"])
                }
            )
        elif question["kind"] == "matching":
            expected.update(
                {
                    f"question:{qid}:pair:{i}": row["lemma"]
                    for i, row in enumerate(question["pairs"])
                }
            )
    _require(
        prepared.texts == expected and set(prepared.analyses) == set(expected),
        "Radio preparation: exact source surface population differs.",
    )
    for aid, text in expected.items():
        _analysis(
            lambda lang, surface, record=prepared.analyses[aid]: record,
            source["language"],
            text,
            aid,
        )
    return hashlib.sha256(
        json.dumps(
            asdict(prepared), sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()
