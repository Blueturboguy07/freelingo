"""One curriculum-derived register policy for selection, expansion and V6."""

from collections.abc import Mapping
from typing import Any

from .config.registers import (
    DEFAULT_REGISTER_BY_LANGUAGE,
    REGISTER_BY_CONCEPT,
    REGISTER_SLOT_BY_LANGUAGE,
)


class RegisterPolicyError(ValueError):
    """A unit cannot establish an approved, single answer register."""


def unit_register(lang: str, unit: Mapping[str, Any]) -> str:
    """Resolve existing UnitAssignment fields without reading exercise labels/answers.

    `register_slot` names a language's register system, not the selected style. The
    explicit grammar concept selects the founder-approved formal unit; every other
    Spanish unit inherits tuteo. There is no mixed-register or answer-based override.
    """
    if lang not in DEFAULT_REGISTER_BY_LANGUAGE:
        raise RegisterPolicyError(f"no approved unit-register policy for {lang!r}")
    if unit.get("lang", lang) != lang:
        raise RegisterPolicyError(f"unit language does not match register policy {lang!r}")
    concept = unit.get("grammar_concept")
    if not isinstance(concept, str) or not concept.strip():
        raise RegisterPolicyError("unit-register policy needs a nonempty grammar_concept")
    slot = unit.get("register_slot")
    expected_slot = REGISTER_SLOT_BY_LANGUAGE[lang]
    if slot not in {"n/a", expected_slot}:
        raise RegisterPolicyError(f"{lang} unit has unsupported register_slot {slot!r}")
    special = REGISTER_BY_CONCEPT[lang].get(concept)
    if special is not None:
        if slot != expected_slot:
            raise RegisterPolicyError(f"{concept} must declare register_slot {expected_slot!r}")
        return special
    return DEFAULT_REGISTER_BY_LANGUAGE[lang]
