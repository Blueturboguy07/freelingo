"""Finite independently reviewed candidate selection; there is deliberately no repair path."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from typing import Any

from .compiler import NarrativeError


def review_hash(candidate: Mapping[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(candidate, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def select_reviewed(
    candidates: Iterable[dict[str, Any]], reviews: Iterable[Mapping[str, Any]]
) -> tuple[dict[str, Any], list[str]]:
    rows = list(reviews)
    discarded: list[str] = []
    for candidate in candidates:
        digest = review_hash(candidate)
        matches = [row for row in rows if row.get("content_hash") == digest]
        if len(matches) != 1:
            discarded.append(str(candidate["id"]))
            continue
        review = matches[0]
        if (
            review.get("verdict") != "accept"
            or not review.get("reviewer")
            or review["reviewer"] == candidate.get("author")
        ):
            discarded.append(str(candidate["id"]))
            continue
        return candidate, discarded
    raise NarrativeError(f"No independently reviewed candidate survives; discarded {discarded}.")
