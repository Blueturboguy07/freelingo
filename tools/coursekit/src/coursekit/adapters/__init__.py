"""The adapter registry, keyed by language.

A morphology adapter for one language: segment, lemmatise, emit a UD morph feature
bundle per token. Registered by LANGUAGE CODE.

This is `scope2/00` §2.1 input 2, one of the four whose fallback column reads
"**None.** Hard gate". The ledger is lemma-level, never surface-token, or inflected
and agglutinative languages break silently and CJK without segmentation makes a whole
sentence one unknown token — at which point the i+1 mechanism no-ops and every
validator downstream still passes.

es/fr/de are spaCy 3.8, pinned BY WHEEL URL: `spacy download` resolves against a live
manifest, and a lemmatiser change re-partitions the ledger and can retro-introduce a
lemma before its unit. ja is SudachiPy, Mode A for the ledger and Mode C for display
and audio, both stored.

## Registering

    # coursekit/adapters/<yours>.py
    from ..adapters import register_adapter

    @register_adapter("<language>")
    def build(...):
        ...

Discovery imports every module in this package at first lookup, so adding one is the
whole of the wiring. `p2-deps-scaffold` owns this file and nothing else in the package;
the implementations are p2-g1-analyze's.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from .. import Registry

__all__ = ["ADAPTERS", "register_adapter"]

ADAPTERS: Registry[Any] = Registry(__name__, "adapter")

F = TypeVar("F", bound=Callable[..., Any])


def register_adapter(key: str) -> Callable[[F], F]:
    """Register a adapter under `key`. Returns the function unchanged.

    A duplicate key raises rather than overwriting: a adapter silently shadowing
    another lane's reads as "my code isn't running" for an afternoon.
    """

    def decorate(fn: F) -> F:
        ADAPTERS.add(key, fn)
        return fn

    return decorate
