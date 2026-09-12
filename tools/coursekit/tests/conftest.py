"""Shared fixtures: the es-mini corpus, an isolated build root, and a clean registry.

Two of these exist to stop a test lying:

- `isolated_build_root` points `COURSEKIT_BUILD_ROOT` at a tmp_path for every test, so
  a runlog test cannot pass because a previous run left an entry behind, and no test
  ever writes into the repository's own `build/`.
- `empty_registry` clears the stage and validator registries. The exit-2 rule is only
  interesting if it can be shown *both* ways — 2 with nothing registered, 0 with
  everything — and a registry that is empty only because P2 has not landed yet proves
  nothing.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path

import pytest

from coursekit.config import BUILD_ROOT_ENV_VAR
from coursekit.stages import STAGES
from coursekit.validators import VALIDATORS

FIXTURES = Path(__file__).parent / "fixtures"
ES_MINI = FIXTURES / "es-mini"

#: The fixture's tokeniser, restated here rather than imported, so the test recomputes
#: `frequency.tsv` instead of agreeing with whatever the generator happened to do.
TOKEN_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def tokens(text: str) -> list[str]:
    return [match.group(0).lower() for match in TOKEN_RE.finditer(text)]


@pytest.fixture(autouse=True)
def isolated_build_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "build"
    monkeypatch.setenv(BUILD_ROOT_ENV_VAR, str(root))
    return root


@pytest.fixture
def empty_registry() -> Iterator[None]:
    """Run with no stages or validators registered, then restore discovery."""
    STAGES.reset_for_tests()
    VALIDATORS.reset_for_tests()
    yield
    STAGES.reset_for_tests()
    VALIDATORS.reset_for_tests()
