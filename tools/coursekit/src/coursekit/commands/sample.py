"""`coursekit sample <lang>` — draw the paid native-speaker sample."""

from __future__ import annotations

from ..config import SAMPLE_STAGE_ID
from ._run import run_stages


def sample(language: str, options: dict[str, str] | None = None) -> None:
    """Draw a stratified sample; the gate is `config.MAX_DEFECT_RATE`.

    The measured rate is written into the manifest and shown to the learner, so this is
    a stage like any other and its run is recorded in the same provenance log.
    """
    run_stages(language, (SAMPLE_STAGE_ID,), options=options)
