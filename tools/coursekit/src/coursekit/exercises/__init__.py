"""The builder registry, keyed by exercise type.

A builder for one exercise shape in `config.EXERCISE_TYPES`, turning a selected
sentence plus its alignment into an `exercise` artefact record.

Every builder inherits the unit's `target_lexemes` and `grammar_concept` as item
tags — that is D1's tagging contract, and V4 checks the tags against the lemmas
actually present, because D1's stated failure mode is that a wrong tag silently
corrupts the memory model.

`accepted_answers` is a SET with at least one member. In a parity build that set is
the entire tolerance budget: the reference product marks a one-character typo fully
wrong with no grace (review R24), so an omission from the set is an unrecoverable
wrong answer rather than a degraded one. For Japanese it must enumerate
kanji+okurigana, all-kana and taught katakana forms.

S043 "Put the events in order" has no builder and no type: it is out of v1 by
ruling (no grading contract, no taxonomy home).

## Registering

    # coursekit/exercises/<yours>.py
    from ..exercises import register_builder

    @register_builder("<exercise type>")
    def build(...):
        ...

Discovery imports every module in this package at first lookup, so adding one is the
whole of the wiring. `p2-deps-scaffold` owns this file and nothing else in the package;
the implementations are p2-g7-expand's.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from .. import Registry

__all__ = ["EXERCISES", "register_builder"]

EXERCISES: Registry[Any] = Registry(__name__, "builder")

F = TypeVar("F", bound=Callable[..., Any])


def register_builder(key: str) -> Callable[[F], F]:
    """Register a builder under `key`. Returns the function unchanged.

    A duplicate key raises rather than overwriting: a builder silently shadowing
    another lane's reads as "my code isn't running" for an afternoon.
    """

    def decorate(fn: F) -> F:
        EXERCISES.add(key, fn)
        return fn

    return decorate
