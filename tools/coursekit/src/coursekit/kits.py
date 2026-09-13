"""Explicit P7 input integrity preflight, never a course-quality or release gate."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .config.p7 import (
    KIT_CLAIM_BY_LANGUAGE,
    KIT_FIELDS,
    KIT_HASH_PATTERN,
    KIT_INPUT_FIELDS,
    KIT_LABEL_BY_LANGUAGE,
    KIT_REQUIRED_INPUTS,
    KIT_SCHEMA_VERSION,
)
from .ledger import ledger_declaration


class KitError(ValueError):
    """Missing or contradictory language kit evidence."""


@dataclass(frozen=True)
class KitInput:
    name: str
    path: Path
    sha256: str | None


@dataclass(frozen=True)
class LanguageKit:
    language: str
    title: str
    beta: bool
    root: Path
    inputs: tuple[KitInput, ...]

    @property
    def ledger(self) -> dict[str, Any]:
        return ledger_declaration(self.language)

    @property
    def claim_label(self) -> str:
        """Intended claim only; this property is not proof of a CEFR or pack gate."""
        return KIT_LABEL_BY_LANGUAGE[self.language]


@dataclass(frozen=True)
class KitInputReport:
    missing: tuple[str, ...]
    unpinned: tuple[str, ...]
    stale: tuple[str, ...]
    scope: str = "input_integrity_only"

    @property
    def ready(self) -> bool:
        return not (self.missing or self.unpinned or self.stale)


def _within(root: Path, raw: str) -> Path:
    path = Path(raw)
    if not raw.strip() or path.is_absolute() or ".." in path.parts:
        raise KitError(f"Kit input path must stay inside {root}: {raw!r}")
    resolved = (root / path).resolve()
    if not resolved.is_relative_to(root):
        raise KitError(f"Kit input path resolves outside {root}: {raw!r}")
    return root / path


def load_kit(path: Path) -> LanguageKit:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf8"))
    except (OSError, yaml.YAMLError) as exc:
        raise KitError(f"Cannot read language kit {path}: {exc}") from exc
    if not isinstance(data, dict) or set(data) != KIT_FIELDS:
        raise KitError("Kit has missing or unknown declaration fields.")
    lang = data["language"]
    if not isinstance(lang, str) or lang not in KIT_CLAIM_BY_LANGUAGE:
        raise KitError(f"Unsupported P7 kit language {lang!r}.")
    if type(data["schema_version"]) is not int or data["schema_version"] != KIT_SCHEMA_VERSION:
        raise KitError("Unsupported kit schema version.")
    if type(data["beta"]) is not bool or data["beta"] is not (lang == "ja"):
        raise KitError("Japanese kit must declare beta; other v1 kits do not.")
    if data["claim"] != KIT_CLAIM_BY_LANGUAGE[lang]:
        raise KitError(f"Kit claim does not match the approved resource basis for {lang}.")
    if not isinstance(data["title"], str) or not data["title"].strip():
        raise KitError("Kit title must be nonempty.")
    entries = data["inputs"]
    if not isinstance(entries, dict) or set(entries) != set(KIT_REQUIRED_INPUTS[lang]):
        raise KitError(
            f"Kit {lang} requires exactly these named inputs: {KIT_REQUIRED_INPUTS[lang]}"
        )
    root = path.resolve().parent
    inputs = []
    for name in KIT_REQUIRED_INPUTS[lang]:
        entry = entries[name]
        if not isinstance(entry, dict) or set(entry) != KIT_INPUT_FIELDS:
            raise KitError(f"Kit input {name} needs an exact path and SHA-256 declaration.")
        raw = entry["path"]
        digest = entry["sha256"]
        if not isinstance(raw, str):
            raise KitError(f"Kit input {name} path must be a string.")
        if digest is not None and (
            not isinstance(digest, str) or re.fullmatch(KIT_HASH_PATTERN, digest) is None
        ):
            raise KitError(f"Kit input {name} SHA-256 is malformed.")
        inputs.append(KitInput(name, _within(root, raw), digest))
    return LanguageKit(lang, data["title"], data["beta"], root, tuple(inputs))


def inspect_kit_inputs(kit: LanguageKit) -> KitInputReport:
    missing = []
    unpinned = []
    stale = []
    for entry in kit.inputs:
        # Re-resolve at read time too: a symlink can change after declaration loading.
        if not entry.path.resolve().is_relative_to(kit.root):
            raise KitError(f"Kit input path escaped after loading: {entry.name}")
        if not entry.path.is_file():
            missing.append(entry.name)
        elif entry.sha256 is None:
            unpinned.append(entry.name)
        elif hashlib.sha256(entry.path.read_bytes()).hexdigest() != entry.sha256:
            stale.append(entry.name)
    return KitInputReport(tuple(missing), tuple(unpinned), tuple(stale))


def require_kit_inputs(kit: LanguageKit) -> KitInputReport:
    report = inspect_kit_inputs(kit)
    if not report.ready:
        raise KitError(
            f"Kit inputs unresolved: missing={report.missing}, "
            f"unpinned={report.unpinned}, stale={report.stale}"
        )
    return report
