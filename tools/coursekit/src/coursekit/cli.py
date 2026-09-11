"""`coursekit` CLI.

Every command is a stub that exits non-zero until its phase implements it, so a half-
built pipeline can never quietly produce a pack. Phases: build/validate/bake/pack/sign
land in P2 (Spanish); sample rides with the reviewer sample at the end of P2.
"""

from __future__ import annotations

from typing import Annotated

import typer

from .config import LANGUAGES

__all__ = ["app", "main"]

app = typer.Typer(
    name="coursekit",
    help="Freelingo content pipeline: build, validate, bake, pack, sample, sign.",
    no_args_is_help=True,
    add_completion=False,
)

LanguageArg = Annotated[str, typer.Argument(help=f"Language code, one of {', '.join(LANGUAGES)}.")]


class NotImplementedYet(typer.Exit):
    """Exit code 2: the command exists, the stage does not."""

    def __init__(self, command: str, phase: str) -> None:
        typer.secho(
            f"coursekit {command}: not implemented yet (lands in {phase}).",
            fg=typer.colors.YELLOW,
            err=True,
        )
        super().__init__(code=2)


def _check_language(language: str) -> None:
    if language not in LANGUAGES:
        typer.secho(
            f"unknown language {language!r}; expected one of {', '.join(LANGUAGES)}",
            fg=typer.colors.RED,
            err=True,
        )
        raise typer.Exit(code=1)


@app.command()
def build(language: LanguageArg) -> None:
    """G0-G9: corpus ledger -> selected items -> exercises -> units."""
    _check_language(language)
    raise NotImplementedYet("build", "P2")


@app.command()
def validate(language: LanguageArg) -> None:
    """V1-V12 plus the Freelingo validators. Nothing ships without a green run."""
    _check_language(language)
    raise NotImplementedYet("validate", "P2")


@app.command()
def bake(language: LanguageArg) -> None:
    """Synthesize and transcode the voice bank, within the per-language audio budget."""
    _check_language(language)
    raise NotImplementedYet("bake", "P2")


@app.command()
def pack(language: LanguageArg) -> None:
    """Assemble the read-only SQLite pack + manifest (content packs are CC BY-NC-SA 4.0)."""
    _check_language(language)
    raise NotImplementedYet("pack", "P2")


@app.command()
def sample(language: LanguageArg) -> None:
    """Draw the paid native-speaker sample; the gate is the configured max defect rate."""
    _check_language(language)
    raise NotImplementedYet("sample", "P2")


@app.command()
def sign(language: LanguageArg) -> None:
    """Sign the manifest with the ed25519 release key (INV-PACK-18)."""
    _check_language(language)
    raise NotImplementedYet("sign", "P2")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
