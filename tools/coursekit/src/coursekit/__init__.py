"""Freelingo content pipeline.

Stages G0-G9 and validators V1-V12 live here. Nothing in this package ships to the
app: it produces a signed content pack (read-only SQLite + content-addressed Opus
audio + a manifest carrying the validator report, defect rate and licences).

The package root carries exactly one thing beyond the version: `Registry`, the
primitive every sub-package's registry is built on (`stages`, `validators`, `sources`,
`adapters`, `engines`, `tts`, `exercises`, `packbuild`). It lives here because six
near-identical hand-written registries is how six subtly different ones happen.

The point of a registry is the phase shape: P2 runs as two waves and eight lanes, and a
lane in wave 2 cannot consume another lane's live output. So a lane adds a module to
`coursekit/stages/` carrying `@register_stage(...)` and the CLI picks it up without a
single line changing in `cli.py` or `commands/`. Discovery walks the sub-package at
first use; nothing is imported eagerly, so a half-written module in one lane does not
break another lane's tests at import time.
"""

from __future__ import annotations

import importlib
import pkgutil
from collections.abc import Iterator

__version__ = "0.1.0"


class AlreadyRegistered(RuntimeError):
    """Two modules claimed the same id.

    Raised rather than overwritten: the alternative is a stage silently shadowing
    another lane's stage, which reads as "my code isn't running" for an afternoon.
    """


class Registry[T]:
    """A name-keyed registry that discovers its own entries.

    `package` is the dotted name of the sub-package whose modules carry the
    registrations. `discover()` imports every module in it exactly once; `get()`,
    `ids()` and `__contains__` call it first, so a caller never has to remember to.
    """

    def __init__(self, package: str, what: str) -> None:
        self._package = package
        self._what = what
        self._entries: dict[str, T] = {}
        self._discovered = False

    # -- registration ------------------------------------------------------

    def add(self, key: str, value: T) -> None:
        if key in self._entries:
            raise AlreadyRegistered(
                f"{self._what} {key!r} is registered twice; the second registration is in "
                f"{getattr(value, '__module__', '<unknown module>')}"
            )
        self._entries[key] = value

    # -- discovery ---------------------------------------------------------

    def discover(self) -> None:
        """Import every module in the registry's package, once."""
        if self._discovered:
            return
        # Set first: a submodule that imports the registry back must not re-enter here.
        self._discovered = True
        package = importlib.import_module(self._package)
        for module in pkgutil.iter_modules(package.__path__):
            if module.name.startswith("_"):
                continue
            importlib.import_module(f"{self._package}.{module.name}")

    def reset_for_tests(self) -> None:
        """Forget everything, including that discovery ran.

        Tests need an empty registry to prove the "unregistered exits 2, never 0" rule
        is not vacuous, and need a populated one to prove the success path is reachable.
        Named for what it is so nobody reaches for it in production code.
        """
        self._entries.clear()
        self._discovered = False

    # -- lookup ------------------------------------------------------------

    def get(self, key: str) -> T | None:
        self.discover()
        return self._entries.get(key)

    def ids(self) -> tuple[str, ...]:
        self.discover()
        return tuple(self._entries)

    def missing(self, required: tuple[str, ...]) -> tuple[str, ...]:
        """Which of `required` nobody registered. The CLI's exit-2 decision."""
        self.discover()
        return tuple(key for key in required if key not in self._entries)

    def __contains__(self, key: object) -> bool:
        self.discover()
        return key in self._entries

    def __iter__(self) -> Iterator[tuple[str, T]]:
        self.discover()
        return iter(self._entries.items())

    def __len__(self) -> int:
        self.discover()
        return len(self._entries)
