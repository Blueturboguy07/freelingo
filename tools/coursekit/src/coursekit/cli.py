"""`coursekit` CLI.

Seven verbs, and not one of them knows what a stage does. Every command in
`coursekit.commands` looks its work up in the stage or validator registry
(`coursekit.stages`, `coursekit.validators`), so a lane lands a stage by adding a module
to `coursekit/stages/` and this file does not change. P2 runs as two waves over eight
lanes; a hand-maintained dispatch table here would be eight conflicting edits to one
function.

Exit codes are a contract other lanes and `pack-ci.yml` depend on, named in
`config/base.py`:

    0  ok
    1  usage — unknown language, unknown stage or validator id
    2  the verb exists, the stage or validator behind it is not registered
    3  a required input or dependency group is absent
    4  a registered stage or validator ran and failed

**2 is the one that matters.** A command whose stages are unwritten must never exit 0.
`tests/test_cli.py` proves the rule both ways: with an empty registry every verb exits
2, with a full one `build` exits 0, and pulling one stage back out returns it to 2 — so
the exit-2 path cannot rot into something that is true only because nothing is
registered yet.
"""

from __future__ import annotations

from typing import Annotated

import typer

from .commands import bake as bake_command
from .commands import build as build_command
from .commands import doctor as doctor_command
from .commands import pack as pack_command
from .commands import sample as sample_command
from .commands import sign as sign_command
from .commands import validate as validate_command
from .commands._run import fail
from .config import BUILD_STAGE_IDS, EXIT_USAGE, LANGUAGES, VALIDATOR_IDS

__all__ = ["app", "main"]

app = typer.Typer(
    name="coursekit",
    help="Freelingo content pipeline: build, validate, bake, pack, sample, sign.",
    no_args_is_help=True,
    add_completion=False,
)

LanguageArg = Annotated[str, typer.Argument(help=f"Language code, one of {', '.join(LANGUAGES)}.")]
SetOpt = Annotated[
    list[str] | None,
    typer.Option(
        "--set",
        help="Stage option as key=value. Repeatable. Stages read these from ctx.options.",
    ),
]


def _options(pairs: list[str] | None) -> dict[str, str]:
    out: dict[str, str] = {}
    for pair in pairs or []:
        key, separator, value = pair.partition("=")
        if not separator or not key:
            raise fail(f"--set expects key=value, got {pair!r}", EXIT_USAGE)
        out[key] = value
    return out


@app.command()
def build(
    language: LanguageArg,
    only: Annotated[
        str | None,
        typer.Option("--only", help=f"Run one stage: {', '.join(BUILD_STAGE_IDS)}."),
    ] = None,
    set_: SetOpt = None,
) -> None:
    """G0-G9: corpus ledger -> selected items -> exercises -> units."""
    if only is not None and only not in BUILD_STAGE_IDS:
        raise fail(
            f"unknown stage {only!r}; build runs {', '.join(BUILD_STAGE_IDS)}",
            EXIT_USAGE,
        )
    build_command.build(language, only=only, options=_options(set_))


@app.command()
def validate(
    language: LanguageArg,
    only: Annotated[
        str | None,
        typer.Option("--only", help=f"Run one validator: {', '.join(VALIDATOR_IDS)}."),
    ] = None,
) -> None:
    """V1-V12 plus the Freelingo validators. Nothing ships without a green run."""
    if only is not None and only not in VALIDATOR_IDS:
        raise fail(
            f"unknown validator {only!r}; the suite is {', '.join(VALIDATOR_IDS)}",
            EXIT_USAGE,
        )
    validate_command.validate(language, only=only)


@app.command()
def bake(language: LanguageArg, set_: SetOpt = None) -> None:
    """Synthesize and transcode the voice bank, within the per-language audio budget."""
    bake_command.bake(language, options=_options(set_))


@app.command()
def pack(language: LanguageArg, set_: SetOpt = None) -> None:
    """Assemble the read-only SQLite pack + manifest (content packs are CC BY-NC-SA 4.0)."""
    pack_command.pack(language, options=_options(set_))


@app.command()
def sample(language: LanguageArg, set_: SetOpt = None) -> None:
    """Draw the paid native-speaker sample; the gate is the configured max defect rate."""
    sample_command.sample(language, options=_options(set_))


@app.command()
def sign(language: LanguageArg, set_: SetOpt = None) -> None:
    """Sign the manifest with the ed25519 release key (INV-PACK-18)."""
    sign_command.sign(language, options=_options(set_))


@app.command()
def doctor(
    language: Annotated[
        str | None,
        typer.Argument(help="Report one language instead of all four."),
    ] = None,
) -> None:
    """Report dependency groups, registry coverage and source resolution. Always exits 0."""
    if language is not None and language not in LANGUAGES:
        raise fail(
            f"unknown language {language!r}; expected one of {', '.join(LANGUAGES)}",
            EXIT_USAGE,
        )
    doctor_command.doctor(language)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
