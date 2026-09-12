"""The validator registry: V1-V12 plus the Freelingo validators F1-F5.

Same shape as `coursekit.stages`, for the same reason. A lane drops a module here:

    # coursekit/validators/v1_ledger.py
    from ..validators import Finding, ValidatorContext, register_validator

    @register_validator("V1")
    def no_lemma_before_its_unit(ctx: ValidatorContext) -> list[Finding]:
        ...

`coursekit validate` runs every id in `config.VALIDATOR_IDS` and refuses to print a
pass while one of them is unregistered — exit 2. `scope2/00` §2.4 is explicit that
V1-V12 are "a hard CI gate that runs before any human review", standing in for
Duolingo's human select-and-edit step; a gate with a hole in it reports the same green
as a gate without one.

A validator returns findings rather than raising, so one run reports everything wrong
with a pack instead of the first thing. `severity` decides which findings block.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from .. import Registry
from ..config import VALIDATOR_TITLES
from ..runlog import StageEntry

__all__ = [
    "VALIDATORS",
    "Finding",
    "Severity",
    "Validator",
    "ValidatorContext",
    "register_validator",
]

Severity = Literal["blocking", "warning", "info"]


@dataclass(frozen=True, slots=True)
class Finding:
    """One thing wrong. `blocking` fails the pack; nothing else does."""

    validator_id: str
    severity: Severity
    message: str
    #: Whatever identifies the offending row: a sentence id, an exercise id, a unit.
    subject: str = ""
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ValidatorContext:
    """What a validator is handed.

    `entry` is the validator's own runlog record. A validator that DEGRADES writes the
    degradation there — V8 for Japanese records `spellcheck_engine: none`, because
    LanguageTool Japanese has 735 grammar rules and no spell checker (the adversarial
    review's R1 reversed the stated fact) — so a later reader can tell a clean run from
    a run that could not check.
    """

    lang: str
    entry: StageEntry
    options: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Validator:
    """One registered validator."""

    id: str
    title: str
    run: Callable[[ValidatorContext], list[Finding]]
    requires_group: str | None


VALIDATORS: Registry[Validator] = Registry(__name__, "validator")


def register_validator(
    validator_id: str,
    *,
    requires_group: str | None = None,
    title: str | None = None,
) -> Callable[
    [Callable[[ValidatorContext], list[Finding]]],
    Callable[[ValidatorContext], list[Finding]],
]:
    """Register a validator. `validator_id` must be one `config/base.py` names."""
    if validator_id not in VALIDATOR_TITLES:
        raise ValueError(
            f"{validator_id!r} is not a validator in the ledger; config/base.py names "
            f"{', '.join(VALIDATOR_TITLES)}"
        )

    def decorate(
        fn: Callable[[ValidatorContext], list[Finding]],
    ) -> Callable[[ValidatorContext], list[Finding]]:
        VALIDATORS.add(
            validator_id,
            Validator(
                id=validator_id,
                title=title or VALIDATOR_TITLES[validator_id],
                run=fn,
                requires_group=requires_group,
            ),
        )
        return fn

    return decorate
