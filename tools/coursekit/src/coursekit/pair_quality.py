"""Shared, review-backed rejection of exact source/translation pairs.

Review findings are immutable evidence, not rewrite rules.  G4 and G6 both consult the
same language resource and discard an exact pair so their normal selection machinery
can draw another candidate.  Nearby wording remains eligible.
"""

from __future__ import annotations

import hashlib
import json
import os
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from types import MappingProxyType

from .artifacts import _repo_root
from .config.g5 import CONTENT_ROOT_DIRNAME, CONTENT_ROOT_ENV_VAR


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


def reviewed_pairs(lang: str) -> Mapping[str, ReviewedPair]:
    root = Path(os.environ.get(CONTENT_ROOT_ENV_VAR, _repo_root() / CONTENT_ROOT_DIRNAME))
    path = (root / lang / "review" / "rejected-pairs.jsonl").resolve()
    try:
        stat = path.stat()
    except FileNotFoundError:
        return {}
    return _read_reviewed_pairs(path, stat.st_mtime_ns, stat.st_size)


@cache
def _read_reviewed_pairs(path: Path, modified_ns: int, size: int) -> Mapping[str, ReviewedPair]:
    """Cache by resource identity/version, never only by the language string."""
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
    return MappingProxyType(findings)


def reviewed_pair(lang: str, text: str, translation: str) -> ReviewedPair | None:
    content_hash = pair_content_hash(text, translation)
    finding = reviewed_pairs(lang).get(content_hash)
    if finding is None:
        return None
    # Defend against even the theoretical possibility of a hash collision.
    if tuple(
        unicodedata.normalize("NFC", value) for value in (finding.text, finding.translation)
    ) != tuple(unicodedata.normalize("NFC", value) for value in (text, translation)):
        return None
    return finding
