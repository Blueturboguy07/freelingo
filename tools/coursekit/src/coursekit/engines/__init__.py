"""The engine registry, keyed by engine id.

A build-time language engine: KenLM for perplexity, LanguageTool for grammar rules,
SimAlign for word alignment. All out-of-process or build-time only — none of them
links into the app, which is what keeps LGPL and GPL tools compatible with an AGPL
codebase and a CC BY-NC-SA pack.

An engine declares what it CANNOT do per language, and V8 records that in the runlog
rather than reporting zero errors as a pass. For Japanese the real degradation is
`spellcheck_engine: none`: LanguageTool ja has 735 XML grammar rules and no spell
checker, which is the inverse of what `deep/10` stated and its adversarial review R1
corrected.

## Registering

    # coursekit/engines/<yours>.py
    from ..engines import register_engine

    @register_engine("<engine id>")
    def build(...):
        ...

Discovery imports every module in this package at first lookup, so adding one is the
whole of the wiring. `p2-deps-scaffold` owns this file and nothing else in the package;
the implementations are p2-g6-validate's.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from .. import Registry

__all__ = ["ENGINES", "register_engine"]

ENGINES: Registry[Any] = Registry(__name__, "engine")

F = TypeVar("F", bound=Callable[..., Any])


def register_engine(key: str) -> Callable[[F], F]:
    """Register a engine under `key`. Returns the function unchanged.

    A duplicate key raises rather than overwriting: a engine silently shadowing
    another lane's reads as "my code isn't running" for an afternoon.
    """

    def decorate(fn: F) -> F:
        ENGINES.add(key, fn)
        return fn

    return decorate
