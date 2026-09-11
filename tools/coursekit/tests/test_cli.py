"""The CLI contract: every stage exists, none of them pretends to work yet."""

from __future__ import annotations

import pytest
from typer.testing import CliRunner

from coursekit.cli import app
from coursekit.config import (
    AUDIO_BUDGET_MB,
    CEFR_LANGUAGES,
    LANGUAGES,
    LOCALE_BY_LANGUAGE,
    MAX_DEFECT_RATE,
    OPUS_BITRATE_KBPS,
)

runner = CliRunner()

COMMANDS = ["build", "validate", "bake", "pack", "sample", "sign"]


def test_help_lists_every_stage() -> None:
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    for command in COMMANDS:
        assert command in result.output


@pytest.mark.parametrize("command", COMMANDS)
def test_stage_is_not_implemented_yet(command: str) -> None:
    result = runner.invoke(app, [command, "es"])
    assert result.exit_code == 2, result.output


@pytest.mark.parametrize("command", COMMANDS)
def test_unknown_language_is_rejected(command: str) -> None:
    result = runner.invoke(app, [command, "kl"])
    assert result.exit_code == 1, result.output


def test_config_constants_match_the_plan() -> None:
    assert LANGUAGES == ("es", "fr", "de", "ja")
    assert set(LOCALE_BY_LANGUAGE) == set(LANGUAGES)
    assert AUDIO_BUDGET_MB == 120
    assert OPUS_BITRATE_KBPS == 20
    assert MAX_DEFECT_RATE == 0.02
    # CEFR is claimed only where a CEFRLex resource exists (Q8 ruling).
    assert CEFR_LANGUAGES == ("es", "fr")
