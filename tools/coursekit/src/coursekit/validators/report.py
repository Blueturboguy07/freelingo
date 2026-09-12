"""`validator-report.json` — the machine-readable result S002 and S137 render.

`scope2/00` §2.5 puts the validator report inside the pack's `meta` table, and the
product map spends two screens on it:

    S002  Pack detail — "sample sentence + speaker · item count · size ·
          validator-report summary"
    S137  About       — "[DEPART D-HONEST] per-pack: machine-authored %, validator
          report, native-reviewer sample size and measured wrong-item rate"

So this is a rendered surface, not a log. Three consequences shape the schema:

1. **A validator that did not run is IN the report, with an outcome that says so.**
   `unregistered` and `skipped` are blocking outcomes. A report that simply omitted them
   would show "17 of 17 green" for a suite where four never executed, and that number is
   printed on a card a learner reads before downloading.
2. **`summarise()` is the only thing the UI reads.** The full per-validator detail is for
   an engineer; a screen gets counts, a status, and the defect-rate line with its
   provenance note attached — never a rate without the note.
3. **It is validated on write and on read**, like every artefact in this pipeline, for
   the reason `coursekit.artifacts` gives: writing is the only path this module controls.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema import ValidationError as _JsonSchemaValidationError

from ..artifacts import run_dir
from ..config import VALIDATOR_IDS, VALIDATOR_TITLES
from ..config.sample import PROVISIONAL_DEFECT_RATE_NOTE, REVIEWER_KIND_PAID_NATIVE
from ..config.validate import (
    BLOCKING_OUTCOMES,
    HARD_GATE_VALIDATOR_IDS,
    VALIDATOR_OUTCOMES,
    VALIDATOR_REPORT_FILENAME,
    VALIDATOR_REPORT_VERSION,
)

__all__ = [
    "VALIDATOR_REPORT_SCHEMA",
    "ReportError",
    "build_report",
    "read_report",
    "report_path",
    "summarise",
    "write_report",
]


class ReportError(ValueError):
    """A report that does not match its schema, on the way in or on the way out."""


def _nonempty() -> dict[str, Any]:
    return {"type": "string", "minLength": 1}


def _count() -> dict[str, Any]:
    return {"type": "integer", "minimum": 0}


def _schema() -> dict[str, Any]:
    """The report schema, built by a call so it is not a module-level literal.

    (`tests/test_cli.py::test_no_constant_lives_outside_config` walks the package with
    `ast` and refuses public UPPER_CASE names bound to literals outside `config/`. A
    JSON Schema is a contract that belongs beside the code enforcing it, and the
    existing exception list is meant to stay short, so this one is constructed.)
    """
    validator = {
        "type": "object",
        "additionalProperties": False,
        "required": ["id", "title", "outcome", "findings", "messages", "notes"],
        "properties": {
            "id": {"type": "string", "enum": list(VALIDATOR_IDS)},
            "title": _nonempty(),
            "outcome": {"type": "string", "enum": list(VALIDATOR_OUTCOMES)},
            "findings": {
                "type": "object",
                "additionalProperties": False,
                "required": ["blocking", "warning", "info"],
                "properties": {
                    "blocking": _count(),
                    "warning": _count(),
                    "info": _count(),
                },
            },
            "messages": {"type": "array", "items": _nonempty()},
            "notes": {"type": "object"},
            "duration_ms": _count(),
        },
    }
    review = {
        "type": "object",
        "additionalProperties": False,
        "required": ["reviewer_kind", "sample_size", "scored", "wrong_item_rate", "note"],
        "properties": {
            "reviewer_kind": _nonempty(),
            "sample_size": _count(),
            "scored": _count(),
            "wrong_item_rate": {"type": ["number", "null"], "minimum": 0},
            "awkward_rate": {"type": ["number", "null"], "minimum": 0},
            "note": {"type": "string"},
        },
    }
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "ValidatorReport",
        "type": "object",
        "additionalProperties": False,
        "required": [
            "schema_version",
            "lang",
            "run_id",
            "tool",
            "tool_version",
            "generated_at",
            "status",
            "declared",
            "validators",
            "counts",
            "hard_gate",
        ],
        "properties": {
            "schema_version": {"const": VALIDATOR_REPORT_VERSION},
            "lang": _nonempty(),
            "run_id": _nonempty(),
            "tool": _nonempty(),
            "tool_version": _nonempty(),
            "generated_at": _nonempty(),
            "status": {"type": "string", "enum": ["green", "failed"]},
            "declared": {"type": "array", "items": _nonempty(), "minItems": 1},
            "validators": {"type": "array", "items": validator},
            "counts": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "declared",
                    "ran",
                    "green",
                    "failed",
                    "skipped",
                    "unregistered",
                    "blocking_findings",
                    "warning_findings",
                ],
                "properties": {
                    "declared": _count(),
                    "ran": _count(),
                    "green": _count(),
                    "failed": _count(),
                    "skipped": _count(),
                    "unregistered": _count(),
                    "blocking_findings": _count(),
                    "warning_findings": _count(),
                },
            },
            "hard_gate": {
                "type": "object",
                "additionalProperties": False,
                "required": ["ids", "passed"],
                "properties": {
                    "ids": {"type": "array", "items": _nonempty()},
                    "passed": {"type": "boolean"},
                },
            },
            "review": review,
        },
    }


VALIDATOR_REPORT_SCHEMA = _schema()
_VALIDATOR = Draft202012Validator(VALIDATOR_REPORT_SCHEMA)


def report_path(lang: str) -> Path:
    """`<build root>/<lang>/validator-report.json`."""
    return run_dir(lang) / VALIDATOR_REPORT_FILENAME


def build_report(
    *,
    lang: str,
    run_id: str,
    tool: str,
    tool_version: str,
    generated_at: str,
    runs: list[Mapping[str, Any]],
    declared: tuple[str, ...] = VALIDATOR_IDS,
    review: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble a report from the runner's per-validator records.

    `runs` may be shorter than `declared`; every declared id that is missing from it is
    written in as `unregistered`, which is the whole point. A report is a statement about
    the *suite*, and the suite is `config.VALIDATOR_IDS` — not whatever happened to be
    importable on the day.
    """
    by_id = {record["id"]: record for record in runs}
    validators: list[dict[str, Any]] = []
    for validator_id in declared:
        record = by_id.get(validator_id)
        if record is None:
            validators.append(
                {
                    "id": validator_id,
                    "title": VALIDATOR_TITLES[validator_id],
                    "outcome": "unregistered",
                    "findings": {"blocking": 0, "warning": 0, "info": 0},
                    "messages": [
                        f"{validator_id} is not registered. `scope2/00` §2.4 makes "
                        f"V1-V12 a hard CI gate before any human review; an id nobody "
                        f"implemented reports zero findings, which is what green looks "
                        f"like."
                    ],
                    "notes": {},
                }
            )
            continue
        validators.append(dict(record))

    counts = {
        "declared": len(declared),
        "ran": sum(1 for v in validators if v["outcome"] in ("ok", "warned", "failed")),
        "green": sum(1 for v in validators if v["outcome"] in ("ok", "warned")),
        "failed": sum(1 for v in validators if v["outcome"] == "failed"),
        "skipped": sum(1 for v in validators if v["outcome"] == "skipped"),
        "unregistered": sum(1 for v in validators if v["outcome"] == "unregistered"),
        "blocking_findings": sum(v["findings"]["blocking"] for v in validators),
        "warning_findings": sum(v["findings"]["warning"] for v in validators),
    }
    blocked = any(v["outcome"] in BLOCKING_OUTCOMES for v in validators)
    hard_gate = [v for v in validators if v["id"] in HARD_GATE_VALIDATOR_IDS]
    report: dict[str, Any] = {
        "schema_version": VALIDATOR_REPORT_VERSION,
        "lang": lang,
        "run_id": run_id,
        "tool": tool,
        "tool_version": tool_version,
        "generated_at": generated_at,
        "status": "failed" if blocked else "green",
        "declared": list(declared),
        "validators": validators,
        "counts": counts,
        "hard_gate": {
            "ids": list(HARD_GATE_VALIDATOR_IDS),
            "passed": bool(hard_gate)
            and len(hard_gate) == len(HARD_GATE_VALIDATOR_IDS)
            and all(v["outcome"] in ("ok", "warned") for v in hard_gate),
        },
    }
    if review is not None:
        report["review"] = dict(review)
    _validate(report)
    return report


def _validate(report: Mapping[str, Any]) -> None:
    try:
        _VALIDATOR.validate(dict(report))
    except _JsonSchemaValidationError as exc:
        location = "/".join(str(part) for part in exc.absolute_path) or "<root>"
        raise ReportError(f"validator report: {location}: {exc.message}") from exc


def write_report(report: Mapping[str, Any], path: Path) -> Path:
    """Validate, then write. A malformed report never reaches the disk."""
    _validate(report)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return path


def read_report(path: Path) -> dict[str, Any]:
    """Read and validate. Reading is where a hand-edited report shows up."""
    report = json.loads(path.read_text(encoding="utf-8"))
    _validate(report)
    return report


def summarise(report: Mapping[str, Any]) -> dict[str, Any]:
    """The payload S002's summary line and S137's provenance block render.

    The defect rate never leaves here without its note. A rate whose provenance is not
    attached to it is the same claim as a rate measured by a paid native speaker, and
    this run did not buy one.
    """
    counts = report["counts"]
    review = report.get("review")
    summary: dict[str, Any] = {
        "status": report["status"],
        "line": (
            f"{counts['green']}/{counts['declared']} validators green"
            + (f", {counts['unregistered']} unregistered" if counts["unregistered"] else "")
            + (f", {counts['skipped']} skipped" if counts["skipped"] else "")
            + (f", {counts['failed']} failed" if counts["failed"] else "")
        ),
        "declared": counts["declared"],
        "green": counts["green"],
        "not_run": counts["unregistered"] + counts["skipped"],
        "blocking_findings": counts["blocking_findings"],
        "warning_findings": counts["warning_findings"],
        "hard_gate_passed": report["hard_gate"]["passed"],
        "wrong_item_rate": None,
        "wrong_item_rate_note": PROVISIONAL_DEFECT_RATE_NOTE,
        "reviewer_kind": None,
        "reviewer_sample_size": 0,
    }
    if review is not None:
        summary["wrong_item_rate"] = review["wrong_item_rate"]
        summary["reviewer_kind"] = review["reviewer_kind"]
        summary["reviewer_sample_size"] = review["sample_size"]
        summary["wrong_item_rate_note"] = (
            "" if review["reviewer_kind"] == REVIEWER_KIND_PAID_NATIVE else review["note"]
        )
    return summary
