"""The validator suite runner: what `coursekit validate <lang>` actually does.

`scope2/00` §2.4 ends with one sentence that decides this module's design:

    V1-V12 must be a **hard CI gate that runs before any human review**, standing in
    for Duolingo's human "select and edit" step on exactly these properties.

A gate stands for something only if it cannot report a pass it did not earn. There are
three ways a validator suite passes without earning it, and this runner refuses all
three by name:

1. **An unregistered validator.** Nobody wrote V9; V9 produces no findings; the suite
   reports 16 of 16 green. This is the same class of lie as `maestro test` over an empty
   directory (`docs/ci.md`, why `flows-present` exists) and the same reasoning as
   INV-PACK-14: a suite is a statement about `config.VALIDATOR_IDS`, never about
   whatever happened to be importable.
2. **A skipped validator.** V8 needs a dependency group CI does not sync; it is
   registered, it did not run, it reported nothing. `skipped` is a BLOCKING outcome
   here, and the missing group is named.
3. **A validator that read nothing.** That one belongs to the validators themselves —
   `validators/pack.py` fails on an empty input rather than passing fast — but the
   runner records each validator's own notes into the report so a reader can see how
   much each one actually looked at.

Every validator still runs even after one produces a blocking finding: the suite runs
before human review, and a reviewer handed "V1 failed" and nothing else waits a whole
build to learn V6 failed too.

The runner is deliberately free of `typer`. It returns a `SuiteResult`; the command layer
prints it and chooses the exit code. That is what lets `tests/test_validate_runner.py`
assert the *outcomes* rather than scraping stdout.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .. import __version__
from ..config import (
    EXIT_FAILED,
    EXIT_MISSING_INPUT,
    EXIT_NOT_REGISTERED,
    EXIT_OK,
    GROUP_INSTALL_COMMAND,
    LANGUAGES,
    TOOL_NAME,
    VALIDATOR_IDS,
    VALIDATOR_TITLES,
)
from ..inputs import group_is_installed
from ..runlog import RunLog
from . import VALIDATORS, Finding, ValidatorContext
from .report import build_report, report_path, write_report

__all__ = [
    "SuiteResult",
    "ValidatorRun",
    "run_suite",
]


@dataclass(frozen=True, slots=True)
class ValidatorRun:
    """One validator's outcome, whether or not it executed."""

    id: str
    title: str
    outcome: str
    findings: tuple[Finding, ...] = ()
    messages: tuple[str, ...] = ()
    notes: dict[str, Any] = field(default_factory=dict)
    duration_ms: int = 0

    def to_record(self) -> dict[str, Any]:
        counted = {"blocking": 0, "warning": 0, "info": 0}
        for finding in self.findings:
            counted[finding.severity] += 1
        messages = [
            f"{finding.subject or '-'}: {finding.message}" for finding in self.findings
        ]
        return {
            "id": self.id,
            "title": self.title,
            "outcome": self.outcome,
            "findings": counted,
            "messages": [*self.messages, *messages],
            "notes": dict(self.notes),
            "duration_ms": self.duration_ms,
        }


@dataclass(frozen=True, slots=True)
class SuiteResult:
    """What the suite concluded, and the report it wrote."""

    lang: str
    runs: tuple[ValidatorRun, ...]
    report: dict[str, Any]
    report_file: Path | None
    unregistered: tuple[str, ...]
    skipped: tuple[str, ...]

    @property
    def findings(self) -> tuple[Finding, ...]:
        return tuple(finding for run in self.runs for finding in run.findings)

    @property
    def blocking(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.severity == "blocking")

    @property
    def ok(self) -> bool:
        return self.report["status"] == "green"

    @property
    def exit_code(self) -> int:
        """The scaffold's exit contract, in priority order.

        2 before 3 before 4: "nobody wrote it" is a different problem from "it could not
        run here", which is a different problem from "it ran and the pack is wrong", and
        a run with all three needs the first fix first.
        """
        if self.unregistered:
            return EXIT_NOT_REGISTERED
        if self.skipped:
            return EXIT_MISSING_INPUT
        # `failed` rather than `self.blocking`: a validator that RAISED has outcome
        # `failed` and no findings at all, and "no findings" is exactly what a green
        # validator returns. Deciding on findings alone made a crashing validator exit 0.
        if any(run.outcome == "failed" for run in self.runs):
            return EXIT_FAILED
        return EXIT_OK


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def run_suite(
    lang: str,
    validator_ids: Sequence[str] = VALIDATOR_IDS,
    *,
    options: dict[str, str] | None = None,
    write: bool = True,
    review: dict[str, Any] | None = None,
) -> SuiteResult:
    """Run every declared validator, then write `validator-report.json`.

    `validator_ids` defaults to the whole ledger. Passing a single id (`--only V10`) is
    an engineer iterating; the report it writes says `declared: ["V10"]` so it can never
    be mistaken for a suite run.
    """
    if lang not in LANGUAGES:
        raise ValueError(f"unknown language {lang!r}; expected one of {', '.join(LANGUAGES)}")

    declared = tuple(validator_ids)
    runlog = RunLog(lang)
    runs: list[ValidatorRun] = []
    unregistered: list[str] = []
    skipped: list[str] = []

    for validator_id in declared:
        validator = VALIDATORS.get(validator_id)
        title = VALIDATOR_TITLES[validator_id]

        if validator is None:
            unregistered.append(validator_id)
            # Not appended to `runs`: `build_report` writes the `unregistered` row, so
            # the "a declared id with no record is unregistered" rule lives in exactly
            # one place and cannot disagree with itself.
            continue

        if validator.requires_group is not None and not group_is_installed(
            validator.requires_group
        ):
            skipped.append(validator_id)
            install = GROUP_INSTALL_COMMAND.format(group=validator.requires_group)
            message = (
                f"{validator_id} needs the {validator.requires_group!r} dependency group "
                f"and it is not installed ({install}). A validator that cannot run must "
                f"not report a pass, so this is blocking, not a warning."
            )
            with runlog.stage(validator_id, tool=TOOL_NAME, tool_version=__version__) as entry:
                entry.status = "skipped"
                entry.note(skipped_reason="missing_group", group=validator.requires_group)
            runs.append(
                ValidatorRun(
                    id=validator_id,
                    title=title,
                    outcome="skipped",
                    messages=(message,),
                    notes={"group": validator.requires_group},
                )
            )
            continue

        started = time.monotonic()
        found: list[Finding] = []
        crash: str | None = None
        with runlog.stage(validator_id, tool=TOOL_NAME, tool_version=__version__) as entry:
            context = ValidatorContext(lang=lang, entry=entry, options=dict(options or {}))
            try:
                found = list(validator.run(context))
            except Exception as exc:  # noqa: BLE001 — one broken validator, not one dead suite
                crash = f"{type(exc).__name__}: {exc}"
                entry.status = "failed"
            entry.note(findings=len(found))
            if crash is None and any(f.severity == "blocking" for f in found):
                entry.status = "failed"
            notes = dict(entry.notes)
        duration_ms = int((time.monotonic() - started) * 1000)

        if crash is not None:
            runs.append(
                ValidatorRun(
                    id=validator_id,
                    title=title,
                    outcome="failed",
                    messages=(
                        f"{validator_id} raised and is therefore a failure, not a pass: "
                        f"{crash}",
                    ),
                    notes=notes,
                    duration_ms=duration_ms,
                )
            )
            continue

        blocking = any(f.severity == "blocking" for f in found)
        warning = any(f.severity == "warning" for f in found)
        outcome = "failed" if blocking else ("warned" if warning else "ok")
        runs.append(
            ValidatorRun(
                id=validator_id,
                title=title,
                outcome=outcome,
                findings=tuple(found),
                notes=notes,
                duration_ms=duration_ms,
            )
        )

    report = build_report(
        lang=lang,
        run_id=runlog.run_id,
        tool=TOOL_NAME,
        tool_version=__version__,
        generated_at=_now(),
        runs=[run.to_record() for run in runs],
        declared=declared,
        review=review,
    )
    report_file = write_report(report, report_path(lang)) if write else None

    return SuiteResult(
        lang=lang,
        runs=tuple(runs),
        report=report,
        report_file=report_file,
        unregistered=tuple(unregistered),
        skipped=tuple(skipped),
    )
