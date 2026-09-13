"""Audio freshness and combined budget; synthesis uses the existing cast and codec."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..config import AUDIO_BUDGET_MB
from .compiler import NarrativeError

PIPELINES = frozenset({"lesson", "story", "radio"})


def audio_is_fresh(proof: Mapping[str, Any], *, text: str, voice_version: str) -> bool:
    return (
        proof.get("text") == text
        and proof.get("voice_version") == voice_version
        and bool(proof.get("asset"))
    )


def assert_audio_budget(
    pipeline_bytes: Mapping[str, int], *, budget_bytes: int = AUDIO_BUDGET_MB * 1_000_000
) -> int:
    if set(pipeline_bytes) != PIPELINES:
        raise NarrativeError("Audio budget requires all three pipeline byte totals.")
    if any(type(value) is not int or value < 0 for value in pipeline_bytes.values()):
        raise NarrativeError("Audio byte counts must be nonnegative measured integers.")
    total = sum(pipeline_bytes.values())
    if total > budget_bytes:
        raise NarrativeError(f"Audio budget exceeded: {total} > {budget_bytes}.")
    return total
