"""`coursekit build <lang>` — G0 through G9, in order."""

from __future__ import annotations

from ..config import BUILD_STAGE_IDS
from ._run import run_stages


def build(language: str, only: str | None = None, options: dict[str, str] | None = None) -> None:
    """Run the build stages.

    `only` runs a single stage, which is how a lane iterates on its own G-stage without
    re-running the nine around it. It is still checked against the registry, so
    `--only g4` with G4 unwritten exits 2 exactly like the full build does.
    """
    stage_ids = (only,) if only is not None else BUILD_STAGE_IDS
    run_stages(language, stage_ids, options=options)
