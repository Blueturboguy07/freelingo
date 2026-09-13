"""Shared, review-backed rejection of exact source/translation pairs.

Review findings are immutable evidence, not rewrite rules.  G4 and G6 both consult the
same language resource and discard an exact pair so their normal selection machinery
can draw another candidate.  Nearby wording remains eligible.
"""

from __future__ import annotations

import hashlib
import json
import unicodedata
from dataclasses import dataclass
from functools import cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]


@dataclass(frozen=True, slots=True)
class ReviewedPair:
    content_hash: str
    text: str
    translation: str
    root_cause: str
    review: str


def pair_content_hash(text: str, translation: str) -> str:
    """Hash an exact bilingual pair after Unicode normalization only."""
    payload = (
        unicodedata.normalize("NFC", text) + "\x1f" + unicodedata.normalize("NFC", translation)
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@cache
def reviewed_pairs(lang: str) -> dict[str, ReviewedPair]:
    path = REPO_ROOT / "content" / lang / "review" / "rejected-pairs.jsonl"
    if not path.exists():
        return {}
    findings: dict[str, ReviewedPair] = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        raw = json.loads(line)
        finding = ReviewedPair(
            content_hash=str(raw["content_hash"]),
            text=str(raw["text"]),
            translation=str(raw["translation"]),
            root_cause=str(raw["root_cause"]),
            review=str(raw["review"]),
        )
        expected = pair_content_hash(finding.text, finding.translation)
        if finding.content_hash != expected:
            raise ValueError(f"{path}:{line_number}: content_hash does not match pair")
        if finding.content_hash in findings:
            raise ValueError(f"{path}:{line_number}: duplicate content_hash")
        findings[finding.content_hash] = finding
    return findings


def reviewed_pair(lang: str, text: str, translation: str) -> ReviewedPair | None:
    content_hash = pair_content_hash(text, translation)
    finding = reviewed_pairs(lang).get(content_hash)
    if finding is None:
        return None
    # Defend against even the theoretical possibility of a hash collision.
    if (finding.text, finding.translation) != (text, translation):
        return None
    return finding
