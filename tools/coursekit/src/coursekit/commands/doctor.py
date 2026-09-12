"""`coursekit doctor [lang]` — what is installed, what is registered, what resolves.

A read-only report, and the first thing to run when a stage fails for a reason that
looks environmental. It exists because the three ways this pipeline goes wrong quietly
all look the same from a stack trace: a dependency group CI does not carry, a stage
nobody has registered yet, and a source that does not cover the language being built.

`doctor` always exits 0. It reports; it does not gate. The gates are `build` and
`validate`, and a diagnostic that can fail is a diagnostic people stop running.
"""

from __future__ import annotations

import typer

from ..config import (
    BUILD_STAGE_IDS,
    CI_SYNCED_GROUPS,
    DEPENDENCY_GROUPS,
    LANGUAGES,
    SOURCES,
    VALIDATOR_IDS,
)
from ..inputs import group_is_installed
from ..runlog import read_entries
from ..stages import STAGES
from ..validators import VALIDATORS


def doctor(language: str | None = None) -> None:
    languages = (language,) if language else LANGUAGES

    typer.secho("dependency groups", bold=True)
    for group, what in DEPENDENCY_GROUPS.items():
        installed = group_is_installed(group)
        in_ci = group in CI_SYNCED_GROUPS
        mark = "yes" if installed else "NO "
        colour = typer.colors.GREEN if installed else typer.colors.YELLOW
        ci_note = "synced by CI" if in_ci else "NOT synced by CI (uv sync --group " + group + ")"
        typer.secho(f"  {group:<6} installed={mark}  {ci_note}  — {what}", fg=colour)

    typer.secho("\nregistry", bold=True)
    stage_missing = STAGES.missing(BUILD_STAGE_IDS)
    validator_missing = VALIDATORS.missing(VALIDATOR_IDS)
    typer.secho(
        f"  stages     {len(BUILD_STAGE_IDS) - len(stage_missing)}/{len(BUILD_STAGE_IDS)} "
        f"registered" + (f"  missing: {', '.join(stage_missing)}" if stage_missing else ""),
        fg=typer.colors.GREEN if not stage_missing else typer.colors.YELLOW,
    )
    typer.secho(
        f"  validators {len(VALIDATOR_IDS) - len(validator_missing)}/{len(VALIDATOR_IDS)} "
        f"registered" + (f"  missing: {', '.join(validator_missing)}" if validator_missing else ""),
        fg=typer.colors.GREEN if not validator_missing else typer.colors.YELLOW,
    )

    for lang in languages:
        typer.secho(f"\n{lang}", bold=True)
        covering = [source for source in SOURCES.values() if lang in source.languages]
        for source in sorted(covering, key=lambda s: (s.kind, s.id)):
            colour = {
                "shippable": typer.colors.GREEN,
                "oracle_only": typer.colors.YELLOW,
                "forbidden": typer.colors.RED,
            }[source.verdict]
            group_note = ""
            if source.requires_group and not group_is_installed(source.requires_group):
                group_note = f"  [needs group {source.requires_group}]"
            typer.secho(
                f"  {source.kind:<13} {source.id:<22} {source.verdict:<11} "
                f"{source.licence}{group_note}",
                fg=colour,
            )
        entries = read_entries(lang)
        ran = sorted({entry["stage"] for entry in entries if entry["status"] == "ok"})
        typer.secho(f"  runlog: {', '.join(ran) if ran else '(nothing has run)'}")
