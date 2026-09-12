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
from ..sample import ScoreError, derive_review
from ..stages import STAGES, StageContext
from ..validators.runner import run_suite


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
    """Print and exit over `validators.runner.run_suite`.

    The decision logic moved into `coursekit.validators.runner` so that
    `validator-report.json` — the artefact S002's "validator-report summary" and S137's
    provenance block render — is written by the same pass that decides the exit code,
    and so that the suite's rules can be asserted on outcomes rather than by scraping
    stdout. What stays here is presentation and the exit contract.

    The three refusals the runner enforces, restated because they are the point:
    every validator runs even after one produces a blocking finding; an UNREGISTERED
    validator is exit 2 with its id named; and a SKIPPED one (an absent dependency
    group) is exit 3, never a pass.
    """
    check_language(language)

    # The review block rides in the same report, because S002 and S137 render the
    # validator summary and the measured wrong-item rate side by side and a rate with no
    # report beside it is a number with nothing to check it against.
    try:
        review = derive_review(language)
    except ScoreError as exc:
        raise fail(f"{language}: {exc}", EXIT_FAILED) from exc

    result = run_suite(language, tuple(validator_ids), review=review)

    if result.unregistered:
        for line in _unregistered_lines(result.unregistered):
            typer.secho(line, fg=typer.colors.YELLOW, err=True)

    for run in result.runs:
        for message in run.messages:
            typer.secho(f"{run.id}: {message}", fg=typer.colors.RED, err=True)
        for finding in run.findings:
            colour = typer.colors.RED if finding.severity == "blocking" else typer.colors.YELLOW
            subject = f" [{finding.subject}]" if finding.subject else ""
            typer.secho(f"{finding.validator_id}{subject}: {finding.message}", fg=colour, err=True)

    if result.report_file is not None:
        typer.secho(f"validator report: {result.report_file}", fg=typer.colors.BLUE)

    counts = result.report["counts"]
    code = result.exit_code
    if code != EXIT_OK:
        raise fail(
            f"{language}: {counts['green']}/{counts['declared']} validators green, "
            f"{counts['unregistered']} unregistered, {counts['skipped']} skipped, "
            f"{counts['blocking_findings']} blocking finding(s). Nothing ships.",
            code,
        )

    typer.secho(
        f"{language}: {counts['declared']} validators green"
        + (
            f", {counts['warning_findings']} non-blocking finding(s)"
            if counts["warning_findings"]
            else ""
        ),
        fg=typer.colors.GREEN,
    )
    raise typer.Exit(code=EXIT_OK)


def _unregistered_lines(missing: Sequence[str]) -> list[str]:
    """The exit-2 explanation, as lines. Naming them matters as much as the code."""
    lines = [
        f"coursekit: {len(missing)} validator(s) are not registered, so this command "
        f"cannot report a result. A half-built pipeline must never quietly produce a pack."
    ]
    lines.extend(f"  {identifier}: {VALIDATOR_TITLES[identifier]}" for identifier in missing)
    lines.append(
        "Register one by adding a module to coursekit/validators/ with "
        "@register_validator; no dispatcher changes."
    )
    return lines
