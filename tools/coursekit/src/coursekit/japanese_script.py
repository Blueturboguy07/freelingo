"""Exact paired Mode-A/Mode-C build evidence for Japanese.

Offsets are Python Unicode codepoint indices, as in G1. This module proves structural
joins only. Analyzer readings and the whole-sentence kana pronunciation remain
unreviewed until independent linguistic and actual speech evidence is recorded.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

import regex

from .artifacts import ArtifactError, sentence_id, validate_record
from .config.japanese_script import (
    KANA_ALLOWED_PATTERN,
    KANA_REQUIRED_PATTERN,
    MODE_A_READING_FIELDS,
    MODE_C_FIELDS,
    READING_REVIEW_STATUS,
    SCRIPT_FIELDS,
    SCRIPT_SCHEMA_VERSION,
)
from .ledger import is_lexical_pos, normalized_form


class ScriptAnalysisError(ValueError):
    """The script row cannot prove the exact bound source and segmentation."""


@dataclass(frozen=True, slots=True)
class ScriptProjection:
    mode_a_to_mode_c: tuple[int, ...]
    reading_review_status: str = READING_REVIEW_STATUS


def analysis_digest(analysed: Mapping[str, Any]) -> str:
    """Hash every G1 field, including the analyzer and dictionary-linked readings."""
    try:
        payload = json.dumps(
            dict(analysed),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ScriptAnalysisError("analysis is not canonical JSON") from exc
    return hashlib.sha256(payload).hexdigest()


def _nonblank(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ScriptAnalysisError(f"{label} must be a nonblank string")
    return value


def _closed(row: Any, fields: frozenset[str], label: str) -> Mapping[str, Any]:
    if not isinstance(row, Mapping) or set(row) != fields:
        raise ScriptAnalysisError(f"{label} has missing or unknown fields")
    return row


def _span(row: Mapping[str, Any], text: str, label: str) -> tuple[int, int]:
    start, end = row.get("start"), row.get("end")
    if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(text):
        raise ScriptAnalysisError(f"{label} has invalid codepoint offsets")
    if row.get("surface") != text[start:end]:
        raise ScriptAnalysisError(f"{label} surface differs from the exact source span")
    return start, end


def _partition(rows: Sequence[Mapping[str, Any]], text: str, label: str) -> None:
    previous = 0
    for index, row in enumerate(rows):
        start, end = _span(row, text, f"{label}[{index}]")
        if start < previous or text[previous:start].strip():
            raise ScriptAnalysisError(f"{label} overlaps or omits source text")
        previous = end
    if text[previous:].strip():
        raise ScriptAnalysisError(f"{label} omits the end of the source text")


def _rows(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list) or not value:
        raise ScriptAnalysisError(f"{label} must be a nonempty array")
    return value


def validate_script_analysis(
    script: Mapping[str, Any],
    analysed: Mapping[str, Any],
    *,
    text: str,
) -> ScriptProjection:
    """Reject stale/partial evidence; return the total stored-token projection.

    Surface readings deliberately need not equal dictionary-linked lemma readings.
    A pronunciation candidate cannot mark itself linguistically reviewed here.
    """
    _closed(script, SCRIPT_FIELDS, "script analysis")
    _nonblank(text, "source text")
    try:
        validate_record("analysed_sentence", analysed)
    except (ArtifactError, TypeError, AttributeError) as exc:
        raise ScriptAnalysisError(f"invalid bound G1 analysis: {exc}") from exc
    if analysed["lang"] != "ja" or script["lang"] != "ja":
        raise ScriptAnalysisError("script evidence is only valid for Japanese")
    if (
        type(script["schema_version"]) is not int
        or script["schema_version"] != SCRIPT_SCHEMA_VERSION
    ):
        raise ScriptAnalysisError("unsupported script schema version")
    if script["reading_review_status"] != READING_REVIEW_STATUS:
        raise ScriptAnalysisError("analysis cannot self-declare linguistic review")
    if (
        script["text"] != text
        or script["text_sha256"] != hashlib.sha256(text.encode("utf-8")).hexdigest()
    ):
        raise ScriptAnalysisError("script text/hash differs from the source")
    if script["sentence_id"] != analysed["sentence_id"] or analysed["sentence_id"] != sentence_id(
        "ja", text
    ):
        raise ScriptAnalysisError("script sentence identity differs from the exact source")
    if script["adapter"] != analysed["adapter"]:
        raise ScriptAnalysisError("script adapter differs from the G1 adapter")
    if script["analysis_sha256"] != analysis_digest(analysed):
        raise ScriptAnalysisError("script analysis digest is stale")
    reading = script["tts_reading"]
    if (
        not isinstance(reading, str)
        or not regex.fullmatch(KANA_ALLOWED_PATTERN, reading)
        or not regex.search(KANA_REQUIRED_PATTERN, reading)
    ):
        raise ScriptAnalysisError("tts_reading must contain kana, not display kanji or digits")

    tokens = _rows(analysed["tokens"], "Mode A tokens")
    _partition(tokens, text, "Mode A tokens")
    for token in tokens:
        if is_lexical_pos(token["pos"]):
            expected = normalized_form("ja", token["normalized_form"])
            if token["lemma"] != expected:
                raise ScriptAnalysisError("Mode A lemma differs from shared normalized_form")

    lexical_lemmas = [token["lemma"] for token in tokens if is_lexical_pos(token["pos"])]
    if analysed["lemmas"] != lexical_lemmas:
        raise ScriptAnalysisError("G1 lemma sequence differs from its exact Mode A tokens")

    mode_c = _rows(script["mode_c_tokens"], "Mode C tokens")
    for index, row in enumerate(mode_c):
        _closed(row, MODE_C_FIELDS, f"Mode C[{index}]")
        _nonblank(row["reading"], f"Mode C[{index}] reading")
    _partition(mode_c, text, "Mode C tokens")
    surface_readings = _rows(script["mode_a_surface_readings"], "Mode A surface readings")
    if len(surface_readings) != len(tokens):
        raise ScriptAnalysisError("surface readings do not cover every Mode A token")
    for index, (token, row) in enumerate(zip(tokens, surface_readings, strict=True)):
        _closed(row, MODE_A_READING_FIELDS, f"Mode A reading[{index}]")
        if type(row["token_index"]) is not int or row["token_index"] != index:
            raise ScriptAnalysisError("surface reading token indices differ from Mode A order")
        if any(row[field] != token[field] for field in ("surface", "start", "end")):
            raise ScriptAnalysisError("surface reading span differs from its Mode A token")
        _span(row, text, f"Mode A reading[{index}]")
        _nonblank(row["reading"], f"Mode A reading[{index}] reading")

    projection = []
    lexical_display = set()
    for token in tokens:
        containing = [
            index
            for index, row in enumerate(mode_c)
            if row["start"] <= token["start"] < token["end"] <= row["end"]
        ]
        if len(containing) != 1:
            raise ScriptAnalysisError("each Mode A span must project onto exactly one Mode C token")
        projection.append(containing[0])
        if is_lexical_pos(token["pos"]):
            lexical_display.add(containing[0])
    display = [row["surface"] for index, row in enumerate(mode_c) if index in lexical_display]
    if not display or analysed["display_tokens"] != display:
        raise ScriptAnalysisError("G1 display tokens differ from the lexical Mode C projection")
    return ScriptProjection(tuple(projection))


def build_script_analysis(
    analysed: Mapping[str, Any],
    *,
    text: str,
    mode_c_tokens: Sequence[Mapping[str, Any]],
    mode_a_surface_readings: Sequence[Mapping[str, Any]],
    tts_reading: str,
) -> dict[str, Any]:
    """Build an unreviewed row from supplied analyzer output; never infer readings."""
    if not isinstance(analysed, Mapping):
        raise ScriptAnalysisError("bound G1 analysis must be an object")
    _nonblank(text, "source text")
    script = {
        "schema_version": SCRIPT_SCHEMA_VERSION,
        "lang": "ja",
        "sentence_id": analysed.get("sentence_id"),
        "text": text,
        "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "adapter": deepcopy(analysed.get("adapter")),
        "analysis_sha256": analysis_digest(analysed),
        "mode_c_tokens": deepcopy(list(mode_c_tokens)),
        "mode_a_surface_readings": deepcopy(list(mode_a_surface_readings)),
        "tts_reading": tts_reading,
        "reading_review_status": READING_REVIEW_STATUS,
    }
    validate_script_analysis(script, analysed, text=text)
    return script
