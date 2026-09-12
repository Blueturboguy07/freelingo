"""The shared dispatch body: registry lookup, exit codes, runlog wiring."""

from __future__ import annotations

from collections.abc import Sequence

import typer

from .. import __version__
from ..config import (
    EXIT_FAILED,
    EXIT_MISSING_INPUT,
    EXIT_NOT_REGISTERED,
    EXIT_OK,
    EXIT_USAGE,
    GROUP_INSTALL_COMMAND,
    LANGUAGES,
    STAGE_TITLES,
    TOOL_NAME,
    VALIDATOR_TITLES,
)
from ..inputs import (
    ForbiddenSource,
    MissingDependencyGroup,
    MissingInput,
    group_is_installed,
)
from ..runlog import RunLog, UpstreamStageMissing
from ..stages import STAGES, StageContext
from ..validators import VALIDATORS, Finding, ValidatorContext


def fail(message: str, code: int) -> typer.Exit:
    """Print to stderr in red and return the Exit the caller raises."""
    typer.secho(message, fg=typer.colors.RED, err=True)
    return typer.Exit(code=code)


def check_language(language: str) -> None:
    if language not in LANGUAGES:
        raise fail(
            f"unknown language {language!r}; expected one of {', '.join(LANGUAGES)}",
            EXIT_USAGE,
        )


def _report_unregistered(kind: str, missing: Sequence[str], titles: dict[str, str]) -> typer.Exit:
    """Exit 2, naming every missing id and what it was supposed to do.

    Naming them matters as much as the exit code. "not implemented yet" tells a lane
    nothing; a list of the seven stages nobody has written tells them exactly what the
    phase still owes.
    """
    typer.secho(
        f"coursekit: {len(missing)} {kind}(s) are not registered, so this command cannot "
        f"report a result. A half-built pipeline must never quietly produce a pack.",
        fg=typer.colors.YELLOW,
        err=True,
    )
    for identifier in missing:
        typer.secho(f"  {identifier}: {titles[identifier]}", fg=typer.colors.YELLOW, err=True)
    typer.secho(
        "Register one by adding a module to coursekit/stages/ or coursekit/validators/ "
        "with @register_stage / @register_validator; no dispatcher changes.",
        fg=typer.colors.YELLOW,
        err=True,
    )
    return typer.Exit(code=EXIT_NOT_REGISTERED)


def run_stages(
    language: str,
    stage_ids: Sequence[str],
    *,
    options: dict[str, str] | None = None,
) -> None:
    """Run the named stages in order. Raises the right `typer.Exit` on any failure."""
    check_language(language)

    missing = STAGES.missing(tuple(stage_ids))
    if missing:
        raise _report_unregistered("stage", missing, STAGE_TITLES)

    runlog = RunLog(language)
    for stage_id in stage_ids:
        stage = STAGES.get(stage_id)
        assert stage is not None  # `missing` above proved this

        if stage.requires_group is not None and not group_is_installed(stage.requires_group):
            raise fail(
                f"{stage_id} needs the {stage.requires_group!r} dependency group, which is "
                f"not installed. Install it with "
                f"`{GROUP_INSTALL_COMMAND.format(group=stage.requires_group)}` from "
                f"tools/coursekit. There is no fallback by design — see docs/pipeline.md.",
                EXIT_MISSING_INPUT,
            )

        typer.secho(f"{stage_id}  {stage.title}", fg=typer.colors.BLUE)
        try:
            with runlog.stage(stage_id, tool=TOOL_NAME, tool_version=__version__) as entry:
                context = StageContext(
                    lang=language,
                    runlog=runlog,
                    entry=entry,
                    options=dict(options or {}),
                )
                result = stage.run(context)
                if not result.ok:
                    entry.status = "failed"
        except (MissingInput, MissingDependencyGroup) as exc:
            raise fail(f"{stage_id}: {exc}", EXIT_MISSING_INPUT) from exc
        except (ForbiddenSource, UpstreamStageMissing) as exc:
            raise fail(f"{stage_id}: {exc}", EXIT_FAILED) from exc

        if not result.ok:
            raise fail(f"{stage_id} failed: {result.message}", EXIT_FAILED)

    typer.secho(f"{language}: {len(stage_ids)} stage(s) ok", fg=typer.colors.GREEN)
    raise typer.Exit(code=EXIT_OK)


def run_validators(language: str, validator_ids: Sequence[str]) -> None:
    """Run every named validator, collect findings, then decide.

    Every validator runs even after one produces findings. `scope2/00` §2.4 puts this
    suite before any human review, and a reviewer who is handed "V1 failed" and nothing
    else has to wait a whole build to learn V6 failed too.
    """
    check_language(language)

    missing = VALIDATORS.missing(tuple(validator_ids))
    if missing:
        raise _report_unregistered("validator", missing, VALIDATOR_TITLES)

    runlog = RunLog(language)
    findings: list[Finding] = []
    for validator_id in validator_ids:
        validator = VALIDATORS.get(validator_id)
        assert validator is not None

        if validator.requires_group is not None and not group_is_installed(
            validator.requires_group
        ):
            raise fail(
                f"{validator_id} needs the {validator.requires_group!r} dependency group, "
                f"which is not installed. "
                f"`{GROUP_INSTALL_COMMAND.format(group=validator.requires_group)}`. "
                f"A validator that cannot run must not report a pass.",
                EXIT_MISSING_INPUT,
            )

        with runlog.stage(validator_id, tool=TOOL_NAME, tool_version=__version__) as entry:
            found = validator.run(ValidatorContext(lang=language, entry=entry))
            entry.note(findings=len(found))
            if any(finding.severity == "blocking" for finding in found):
                entry.status = "failed"
        findings.extend(found)

    blocking = [finding for finding in findings if finding.severity == "blocking"]
    for finding in findings:
        colour = typer.colors.RED if finding.severity == "blocking" else typer.colors.YELLOW
        subject = f" [{finding.subject}]" if finding.subject else ""
        typer.secho(f"{finding.validator_id}{subject}: {finding.message}", fg=colour, err=True)

    if blocking:
        raise fail(
            f"{language}: {len(blocking)} blocking finding(s) across "
            f"{len(validator_ids)} validators. Nothing ships.",
            EXIT_FAILED,
        )

    typer.secho(
        f"{language}: {len(validator_ids)} validators green"
        + (f", {len(findings)} non-blocking finding(s)" if findings else ""),
        fg=typer.colors.GREEN,
    )
    raise typer.Exit(code=EXIT_OK)
