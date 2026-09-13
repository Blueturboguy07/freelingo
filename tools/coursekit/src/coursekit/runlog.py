"""The per-stage provenance log every downstream validator reads.

`coursekit.artifacts` says what crossed a stage boundary. This says what *happened* at
it: which stage ran, with which tool at which version, over which sources, how many rows
went in and out, how many were rejected, and which licences the run touched. One file
per language at the run root, entries keyed by stage, append-only.

It exists because of a property of the phase, not a taste for logging. Stages run in
two waves across eight lanes, and the validators that decide whether a pack may ship
run last. V8 has to know whether a grammar engine existed for this language or whether
it degraded to perplexity alone; V10 and INV-PACK-13 have to know which corpora were
read and under what licence; INV-PACK-15 has to know the codec and bitrate the bake
actually used. None of that is recoverable from the artefact rows, and all of it is a
property of a run. A validator that cannot tell "clean" from "did not run" reports the
same green either way, which is the most expensive lie this pipeline can tell.

Two rules make it load-bearing rather than decorative:

- `require_successful()` is how a stage declares its upstream. It raises rather than
  returning a default, so a lane that runs G7 before G4 finds out at the first line
  instead of producing exercises over an empty ledger.
- An entry whose status is `failed` is still written. A log that only records successes
  cannot distinguish a stage that failed from a stage nobody ran, and those need
  different fixes.
"""

from __future__ import annotations

import json
import os
import platform
import sys
import uuid
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema import ValidationError as _JsonSchemaValidationError

from .artifacts import ARTIFACTS, run_dir
from .config import (
    ARTIFACT_SCHEMA_VERSION,
    BUILD_STAGE_IDS,
    LANGUAGES,
    RUNLOG_FILENAME,
    VALIDATOR_IDS,
)

__all__ = [
    "RUNLOG_SCHEMA",
    "LicenceRow",
    "RunLog",
    "RunLogError",
    "StageEntry",
    "UpstreamStageMissing",
    "read_entries",
    "require_successful",
    "runlog_path",
    "tool_fingerprint",
]


class RunLogError(ValueError):
    """A malformed entry. Never written, never silently skipped on read."""


class UpstreamStageMissing(RuntimeError):
    """A stage asked for an upstream that never ran, or ran and failed."""


#: Everything a stage id may be: the ten build stages, the two tail commands, and every
#: validator. Kept as one set so an entry cannot name a stage that does not exist.
_STAGE_IDS = [*BUILD_STAGE_IDS, "sample", "sign", *VALIDATOR_IDS]

_NONEMPTY = {"type": "string", "minLength": 1}

RUNLOG_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "RunLogEntry",
    "type": "object",
    "additionalProperties": False,
    "required": [
        "schema_version",
        "run_id",
        "lang",
        "stage",
        "status",
        "started_at",
        "finished_at",
        "tool",
        "tool_version",
        "platform",
        "inputs",
        "outputs",
        "counts",
        "licences",
        "notes",
    ],
    "properties": {
        "schema_version": {"const": ARTIFACT_SCHEMA_VERSION},
        "run_id": {"type": "string", "pattern": "^[0-9a-f]{32}$"},
        "lang": {"type": "string", "enum": list(LANGUAGES)},
        "stage": {"type": "string", "enum": _STAGE_IDS},
        "status": {"type": "string", "enum": ["ok", "failed", "skipped"]},
        "started_at": _NONEMPTY,
        "finished_at": _NONEMPTY,
        "tool": _NONEMPTY,
        "tool_version": _NONEMPTY,
        "platform": _NONEMPTY,
        # Source ids from config.SOURCES. What this run actually read.
        "inputs": {"type": "array", "items": _NONEMPTY},
        # Artefact record kinds this run wrote.
        "outputs": {
            "type": "array",
            "items": {"type": "string", "enum": sorted(ARTIFACTS)},
        },
        "counts": {
            "type": "object",
            "additionalProperties": False,
            "required": ["read", "written", "rejected"],
            "properties": {
                "read": {"type": "integer", "minimum": 0},
                "written": {"type": "integer", "minimum": 0},
                "rejected": {"type": "integer", "minimum": 0},
            },
        },
        "licences": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "source_id",
                    "licence",
                    "verdict",
                    "attribution_required",
                    "attribution_owner",
                ],
                "properties": {
                    "source_id": _NONEMPTY,
                    "licence": _NONEMPTY,
                    "verdict": {
                        "type": "string",
                        "enum": ["shippable", "oracle_only", "forbidden"],
                    },
                    "attribution_required": {"type": "boolean"},
                    "attribution_owner": {"type": ["string", "null"], "minLength": 1},
                },
            },
        },
        # Free-form per-stage facts a validator reads. V8 puts
        # {"spellcheck_engine": "none"} here for Japanese; G8 puts the codec and
        # bitrate; G5 puts the model id and the reject rate.
        "notes": {"type": "object"},
    },
}

_VALIDATOR = Draft202012Validator(RUNLOG_SCHEMA)


@dataclass(frozen=True, slots=True)
class LicenceRow:
    """One source's licence, as the run resolved it. V10 and INV-PACK-13 read these."""

    source_id: str
    licence: str
    verdict: str
    attribution_required: bool
    attribution_owner: str | None


@dataclass(slots=True)
class StageEntry:
    """One stage's record of itself. Mutated during the stage, written at the end."""

    lang: str
    stage: str
    run_id: str
    started_at: str
    tool: str
    tool_version: str
    platform: str
    status: str = "ok"
    finished_at: str = ""
    inputs: list[str] = field(default_factory=list)
    outputs: list[str] = field(default_factory=list)
    read: int = 0
    written: int = 0
    rejected: int = 0
    licences: list[LicenceRow] = field(default_factory=list)
    notes: dict[str, Any] = field(default_factory=dict)

    def record_input(self, source_id: str) -> None:
        if source_id not in self.inputs:
            self.inputs.append(source_id)

    def record_output(self, kind: str) -> None:
        if kind not in ARTIFACTS:
            raise RunLogError(
                f"{kind!r} is not an artefact record kind; the contract declares "
                f"{', '.join(sorted(ARTIFACTS))}"
            )
        if kind not in self.outputs:
            self.outputs.append(kind)

    def record_licence(self, row: LicenceRow) -> None:
        if row not in self.licences:
            self.licences.append(row)

    def note(self, **facts: Any) -> None:
        self.notes.update(facts)

    def to_json(self) -> dict[str, Any]:
        return {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "run_id": self.run_id,
            "lang": self.lang,
            "stage": self.stage,
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at or _now(),
            "tool": self.tool,
            "tool_version": self.tool_version,
            "platform": self.platform,
            "inputs": list(self.inputs),
            "outputs": list(self.outputs),
            "counts": {
                "read": self.read,
                "written": self.written,
                "rejected": self.rejected,
            },
            "licences": [asdict(row) for row in self.licences],
            "notes": dict(self.notes),
        }


def _now() -> str:
    # G9 must distinguish a rebuild from validation within the same second.
    return datetime.now(UTC).isoformat(timespec="microseconds")


def tool_fingerprint() -> str:
    """Interpreter and OS, so a snapshot diff caused by a different box is readable."""
    python = f"py{sys.version_info.major}.{sys.version_info.minor}"
    return f"{platform.system()}-{platform.machine()}-{python}"


def runlog_path(lang: str) -> Path:
    """`<build root>/<lang>/runlog.jsonl`."""
    return run_dir(lang) / RUNLOG_FILENAME


class RunLog:
    """Append-only provenance log for one language's run directory."""

    def __init__(self, lang: str, *, run_id: str | None = None) -> None:
        if lang not in LANGUAGES:
            raise ValueError(f"unknown language {lang!r}; expected one of {', '.join(LANGUAGES)}")
        self.lang = lang
        #: One id per `coursekit build`, shared by every stage in it, so a half-finished
        #: run is distinguishable from a mixture of two runs — which is what a lane
        #: re-running one stage over yesterday's output actually produces.
        self.run_id = run_id or os.environ.get("COURSEKIT_RUN_ID") or uuid.uuid4().hex
        self.path = runlog_path(lang)

    @contextmanager
    def stage(
        self,
        stage: str,
        *,
        tool: str,
        tool_version: str,
    ) -> Iterator[StageEntry]:
        """Run a stage and write its entry, whether it succeeded or raised.

        The `except` branch is the reason this is a context manager: a stage that
        crashes must leave `status: "failed"` behind, because a missing entry and a
        failed entry send a reader looking in different places.
        """
        entry = StageEntry(
            lang=self.lang,
            stage=stage,
            run_id=self.run_id,
            started_at=_now(),
            tool=tool,
            tool_version=tool_version,
            platform=tool_fingerprint(),
        )
        try:
            yield entry
        except BaseException:
            entry.status = "failed"
            entry.finished_at = _now()
            self.append(entry)
            raise
        entry.finished_at = _now()
        self.append(entry)

    def append(self, entry: StageEntry) -> None:
        payload = entry.to_json()
        try:
            _VALIDATOR.validate(payload)
        except _JsonSchemaValidationError as exc:
            location = "/".join(str(part) for part in exc.absolute_path) or "<root>"
            raise RunLogError(f"runlog entry for {entry.stage}: {location}: {exc.message}") from exc
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")


def read_entries(lang: str, *, stage: str | None = None) -> list[dict[str, Any]]:
    """Every entry for a language, oldest first, validated. Optionally one stage's.

    An absent log is an empty list, not an error: "nobody has run anything for this
    language" is a legitimate state that `coursekit doctor` needs to report. An
    unreadable or invalid log IS an error — the whole point is that a validator can
    trust what it reads here.
    """
    path = runlog_path(lang)
    if not path.exists():
        return []
    entries: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError as exc:
                raise RunLogError(f"{path.name} line {number}: {exc}") from exc
            try:
                _VALIDATOR.validate(entry)
            except _JsonSchemaValidationError as exc:
                raise RunLogError(f"{path.name} line {number}: {exc.message}") from exc
            if stage is None or entry["stage"] == stage:
                entries.append(entry)
    return entries


def require_successful(lang: str, stages: Sequence[str]) -> dict[str, dict[str, Any]]:
    """Assert every named stage has an `ok` entry; return the latest of each.

    This is how a stage declares its upstream. It raises `UpstreamStageMissing` rather
    than returning what it found, because the alternative — a stage that carries on
    over a partial ledger — produces a pack that passes every row-level validator and
    is missing half its content.
    """
    entries = read_entries(lang)
    latest: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if entry["status"] == "ok":
            latest[entry["stage"]] = entry

    missing = [stage for stage in stages if stage not in latest]
    if missing:
        ran = sorted({entry["stage"] for entry in entries})
        raise UpstreamStageMissing(
            f"{lang}: {', '.join(missing)} has no successful run in {runlog_path(lang)}. "
            f"Stages seen: {', '.join(ran) if ran else '(none)'}. "
            f"Run `coursekit build {lang}` first — nothing downstream may guess at this."
        )
    return {stage: latest[stage] for stage in stages}


def licences_seen(lang: str) -> list[Mapping[str, Any]]:
    """Every distinct licence row across the run. V10's and INV-PACK-13's input."""
    seen: list[Mapping[str, Any]] = []
    for entry in read_entries(lang):
        for row in entry["licences"]:
            if row not in seen:
                seen.append(row)
    return seen
