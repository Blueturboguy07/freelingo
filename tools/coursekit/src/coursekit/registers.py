"""One curriculum-derived register policy for selection, expansion and V6."""

import unicodedata
from collections.abc import Mapping
from typing import Any

from .config.g1 import NON_LEXICAL_POS
from .config.g7 import ES_REGISTER_MARKERS
from .config.registers import (
    DEFAULT_REGISTER_BY_LANGUAGE,
    REGISTER_BY_CONCEPT,
    REGISTER_SLOT_BY_LANGUAGE,
)
from .ledger import surface_tokens


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


def _register_words(text: str) -> set[str]:
    decomposed = unicodedata.normalize("NFD", text.casefold())
    folded = "".join(char for char in decomposed if not unicodedata.combining(char))
    stripped = "".join(
        " " if unicodedata.category(char).startswith(("P", "S")) else char for char in folded
    )
    return set(surface_tokens(stripped))


def _sentence_tokens(text: str, analysis: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """Reject stale/misaligned evidence instead of borrowing a different sentence's POS."""
    tokens = analysis.get("tokens") if isinstance(analysis, Mapping) else None
    if not isinstance(tokens, (list, tuple)) or not tokens:
        raise RegisterPolicyError("sentence register analysis needs nonempty tokens")
    previous = 0
    lexical = False
    for token in tokens:
        if not isinstance(token, Mapping) or any(
            not isinstance(token.get(field), str) for field in ("surface", "lemma", "pos", "morph")
        ):
            raise RegisterPolicyError("sentence register analysis has malformed token fields")
        start, end = token.get("start"), token.get("end")
        if (
            type(start) is not int
            or type(end) is not int
            or not previous <= start < end <= len(text)
            or text[previous:start].strip()
            or text[start:end] != token["surface"]
        ):
            raise RegisterPolicyError("sentence register analysis does not match the exact text")
        previous = end
        lexical |= token["pos"] not in NON_LEXICAL_POS
    if text[previous:].strip() or not lexical:
        raise RegisterPolicyError(
            "sentence register analysis is incomplete or has no lexical token"
        )
    return list(tokens)


def register_of(
    text: str,
    lang: str,
    *,
    analysis: Mapping[str, Any] | None = None,
) -> set[str]:
    """Lexical markers plus possible tuteo from finite VERB/AUX Person=2 evidence.

    A finite second-person analysis can be ambiguous with another grammatical reading;
    adding `tu` conservatively causes rejection/resampling in an usted unit. It is not
    a claim that the parser enumerates all readings. Pronoun Person=2 is deliberately
    ignored: usted/ustedes refer to the addressee but take third-person agreement.
    Morphology never supplies an `usted` declaration or establishes formal proof.
    """
    if lang != "es":
        raise RegisterPolicyError(f"register_of has no marker table for {lang!r}")
    words = _register_words(text)
    carried = {
        register
        for register, markers in ES_REGISTER_MARKERS.items()
        if any(words & _register_words(marker) for marker in markers)
    }
    if analysis is not None:
        for token in _sentence_tokens(text, analysis):
            morph = dict(part.split("=", 1) for part in token["morph"].split("|") if "=" in part)
            if (
                token["pos"] in {"VERB", "AUX"}
                and morph.get("VerbForm") == "Fin"
                and morph.get("Person") == "2"
            ):
                carried.add("tu")
    return carried


def sentence_register_matches(
    lang: str,
    unit: Mapping[str, Any],
    text: str,
    analysis: Mapping[str, Any] | None,
) -> bool:
    """Upstream rejection guard: absent/bad analysis abstains, never proves formality."""
    expected = unit_register(lang, unit)
    if analysis is None:
        return False
    try:
        carried = register_of(text, lang, analysis=analysis)
    except RegisterPolicyError:
        return False
    return not carried or carried == {expected}
