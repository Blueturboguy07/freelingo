"""Explicit authoring evidence for standalone meanings; never alignment guesses.

This JSONL resource is original content, not a G0–G9 artifact or a dictionary-wide
claim. An independent review binds the supported senses and their citation forms.
Missing, rejected or pending entries are unavailable; invalid/stale evidence fails.
"""

from __future__ import annotations

import hashlib
import json
import os
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from .artifacts import _repo_root
from .config import LANGUAGES
from .config.g5 import CONTENT_ROOT_DIRNAME, CONTENT_ROOT_ENV_VAR
from .config.lexeme_glosses import (
    GLOSSARY_LEXICAL_POS,
    GLOSSARY_LICENCE,
    GLOSSARY_RELATIVE_PATH,
    GLOSSARY_SCHEMA_VERSION,
)

_TEXT = {"type": "string", "minLength": 1, "pattern": r"\S"}
_AUTHOR_FIELDS = {
    "schema_version": {"const": GLOSSARY_SCHEMA_VERSION},
    "lang": {"enum": list(LANGUAGES)},
    "lemma": _TEXT,
    "pos": {"enum": list(GLOSSARY_LEXICAL_POS)},
    "citation_gloss": _TEXT,
    "valid_alternates": {"type": "array", "items": _TEXT},
    "sense_evidence": _TEXT,
    "author": _TEXT,
    "licence": {"const": GLOSSARY_LICENCE},
}
_REVIEW = {
    "type": "object", "additionalProperties": False,
    "required": ["reviewer", "verdict", "note", "content_hash"],
    "properties": {
        "reviewer": _TEXT, "verdict": {"enum": ["accepted", "rejected"]}, "note": _TEXT,
        "content_hash": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
    },
}
GLOSSARY_ROW_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": [*_AUTHOR_FIELDS, "review"],
    "properties": {**_AUTHOR_FIELDS, "review": {"anyOf": [{"type": "null"}, _REVIEW]}},
}
_VALIDATOR = Draft202012Validator(GLOSSARY_ROW_SCHEMA)


class GlossaryError(ValueError):
    """Malformed, contradictory or stale authored glossary evidence."""


def _normalise(text: str) -> str:
    return unicodedata.normalize("NFC", text).casefold().strip()


def gloss_content_hash(row: Mapping[str, Any]) -> str:
    """SHA256 of all author fields: sorted compact UTF-8 JSON, normalized to NFC.

    Review metadata is excluded. Editing an authored meaning, POS, alternate, evidence
    or attribution requires a fresh independent review even if the key is unchanged.
    """
    payload = json.dumps({key: row[key] for key in _AUTHOR_FIELDS}, ensure_ascii=False,
                         sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(unicodedata.normalize("NFC", payload).encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class ReviewedGloss:
    lang: str
    lemma: str
    pos: str
    citation_gloss: str
    valid_alternates: tuple[str, ...]
    sense_evidence: str
    author: str
    reviewer: str
    content_hash: str

    @property
    def meanings(self) -> frozenset[str]:
        """The reviewed supported sense set, used to exclude ambiguous choices."""
        return frozenset(_normalise(text) for text in (self.citation_gloss, *self.valid_alternates))


def load_glossary(lang: str) -> dict[tuple[str, str, str], ReviewedGloss]:
    """Read only current independently accepted rows from this content root."""
    root = Path(os.environ.get(CONTENT_ROOT_ENV_VAR, _repo_root() / CONTENT_ROOT_DIRNAME))
    path = root / lang / GLOSSARY_RELATIVE_PATH
    if not path.exists():
        return {}
    entries: dict[tuple[str, str, str], ReviewedGloss] = {}
    seen: set[tuple[str, str, str]] = set()
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        where = f"{path}:{line_number}"
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise GlossaryError(f"{where}: invalid glossary JSON: {exc.msg}") from exc
        error = next(_VALIDATOR.iter_errors(row), None)
        if error is not None:
            raise GlossaryError(f"{where}: malformed glossary row: {error.message}")
        if row["lang"] != lang:
            raise GlossaryError(f"{where}: glossary language does not match {lang}")
        if row["lemma"] != _normalise(row["lemma"]):
            raise GlossaryError(f"{where}: lemma must use the canonical NFC lowercase spelling")
        key = (lang, row["lemma"], row["pos"])
        if key in seen:
            raise GlossaryError(f"{where}: duplicate glossary key {key}")
        seen.add(key)
        meanings = [row["citation_gloss"], *row["valid_alternates"]]
        if len({_normalise(value) for value in meanings}) != len(meanings):
            raise GlossaryError(f"{where}: duplicate citation or alternate meaning")
        review = row["review"]
        if review is None:
            continue
        if _normalise(review["reviewer"]) == _normalise(row["author"]):
            raise GlossaryError(f"{where}: glossary review must be independent of its author")
        if review["content_hash"] != gloss_content_hash(row):
            raise GlossaryError(
                f"{where}: review content hash does not match authored glossary row"
            )
        if review["verdict"] != "accepted":
            continue
        entries[key] = ReviewedGloss(
            lang=lang, lemma=row["lemma"], pos=row["pos"], citation_gloss=row["citation_gloss"],
            valid_alternates=tuple(row["valid_alternates"]), sense_evidence=row["sense_evidence"],
            author=row["author"], reviewer=review["reviewer"], content_hash=review["content_hash"],
        )
    return entries



def load_glossary_by_lemma(lang: str) -> dict[str, tuple[ReviewedGloss, ...]]:
    """Group accepted rows without picking a POS for an ambiguous homograph.

    G2 may apply an intended POS only when a group has exactly one accepted row.
    Multiple POS remain explicit; no majority vote or first-row override is implied.
    """
    grouped: dict[str, list[ReviewedGloss]] = {}
    for (_lang, lemma, _pos), entry in load_glossary(lang).items():
        grouped.setdefault(lemma, []).append(entry)
    return {lemma: tuple(sorted(entries, key=lambda entry: entry.pos))
            for lemma, entries in grouped.items()}
