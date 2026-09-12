"""`coursekit pack <lang>` — G9 on its own."""

from __future__ import annotations

from ..config import PACK_STAGE_ID
from ._run import run_stages


def pack(language: str, options: dict[str, str] | None = None) -> None:
    """Assemble the read-only SQLite pack + manifest (packs are CC BY-NC-SA 4.0)."""
    run_stages(language, (PACK_STAGE_ID,), options=options)
