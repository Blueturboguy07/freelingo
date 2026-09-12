"""`coursekit bake <lang>` — G8 on its own."""

from __future__ import annotations

from ..config import BAKE_STAGE_ID
from ._run import run_stages


def bake(language: str, options: dict[str, str] | None = None) -> None:
    """Synthesise the voice cast and transcode, within the per-language audio budget.

    Needs the `tts` dependency group, which CI does not sync. The dispatcher checks
    that before the stage body and exits 3 with the install command, because a bake
    that degrades to a system voice ships audio that is neither content-addressed nor
    reproducible.
    """
    run_stages(language, (BAKE_STAGE_ID,), options=options)
