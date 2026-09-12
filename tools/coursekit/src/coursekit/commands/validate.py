"""`coursekit validate <lang>` — V1-V12 plus the Freelingo validators."""

from __future__ import annotations

from ..config import VALIDATOR_IDS
from ._run import run_validators


def validate(language: str, only: str | None = None) -> None:
    """Run the validator suite. Nothing ships without a green run."""
    validator_ids = (only,) if only is not None else VALIDATOR_IDS
    run_validators(language, validator_ids)
