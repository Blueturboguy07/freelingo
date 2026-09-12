"""The fetcher registry, keyed by source.

A fetcher for one entry in `config.SOURCES`: it streams the corpus, list or model to a local
cache and returns the path.

Registered by SOURCE ID, so `coursekit.inputs` stays the place a source is *resolved*
(does it exist, does it cover this language, may its text ship) and this stays the
place it is *fetched*. Keeping them apart is what lets the licence verdict be checked
before a byte is downloaded, which is what INV-PACK-13 means by "at ingest".

Fetchers stream and cap. The pipeline never downloads the 94 GB NLLB set: G0 pulls
shards with `--max-pairs`, which is far more than the ~250k raw candidates a ledger
needs. A fetcher that quietly falls back to a different corpus on a 404 is the bug
`coursekit.inputs` exists to make impossible — raise instead.

## Registering

    # coursekit/sources/<yours>.py
    from ..sources import register_fetcher

    @register_fetcher("<source>")
    def build(...):
        ...

Discovery imports every module in this package at first lookup, so adding one is the
whole of the wiring. `p2-deps-scaffold` owns this file and nothing else in the package;
the implementations are p2-g0-ingest's.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from .. import Registry

__all__ = ["SOURCES", "register_fetcher"]

SOURCES: Registry[Any] = Registry(__name__, "fetcher")

F = TypeVar("F", bound=Callable[..., Any])


def register_fetcher(key: str) -> Callable[[F], F]:
    """Register a fetcher under `key`. Returns the function unchanged.

    A duplicate key raises rather than overwriting: a fetcher silently shadowing
    another lane's reads as "my code isn't running" for an afternoon.
    """

    def decorate(fn: F) -> F:
        SOURCES.add(key, fn)
        return fn

    return decorate
