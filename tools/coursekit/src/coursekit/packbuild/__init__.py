"""The writer registry, keyed by table.

A writer for one table in `config.PACK_TABLES`, turning `pack_row` artefact records
into rows of the read-only SQLite pack.

Registered by TABLE NAME. The column shapes belong to `packages/schema`, which owns
the pack DB and its migrations; duplicating them here would give the project two
sources of truth that drift, so the `pack_row` payload is deliberately open and this
is where it meets the real schema.

The pack is read-only and lives outside the backed-up directory, so it never counts
against Android Auto Backup's 25 MB cap or bloats the iCloud blob. The manifest it
ships beside carries the validator report, the measured defect rate, the licence and
attribution table, and the audio codec/bitrate/bytes INV-PACK-15 asserts against the
120 MB budget — for all three pipelines, lessons and stories and radio.

## Registering

    # coursekit/packbuild/<yours>.py
    from ..packbuild import register_writer

    @register_writer("<table>")
    def build(...):
        ...

Discovery imports every module in this package at first lookup, so adding one is the
whole of the wiring. `p2-deps-scaffold` owns this file and nothing else in the package;
the implementations are p2-g9-package's.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from .. import Registry

__all__ = ["PACKBUILD", "register_writer"]

PACKBUILD: Registry[Any] = Registry(__name__, "writer")

F = TypeVar("F", bound=Callable[..., Any])


def register_writer(key: str) -> Callable[[F], F]:
    """Register a writer under `key`. Returns the function unchanged.

    A duplicate key raises rather than overwriting: a writer silently shadowing
    another lane's reads as "my code isn't running" for an afternoon.
    """

    def decorate(fn: F) -> F:
        PACKBUILD.add(key, fn)
        return fn

    return decorate
