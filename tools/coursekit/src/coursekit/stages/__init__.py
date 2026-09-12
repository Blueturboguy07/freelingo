"""The stage registry: G0-G9 plus `sample` and `sign`.

A lane implements a stage by dropping a module in this package:

    # coursekit/stages/ingest.py
    from ..stages import StageContext, StageResult, register_stage

    @register_stage("g0", reads=(), writes=("ingested_sentence",))
    def ingest(ctx: StageContext) -> StageResult:
        ...

and nothing in `cli.py` or `commands/` changes. That is the point: P2 runs as two waves
over eight lanes, and a registry is what lets eight people add to the same CLI without
eight conflicting edits to one dispatch table.

The dispatcher never invents a stage. `STAGES.missing(BUILD_STAGE_IDS)` is what
`coursekit build` checks first, and an unregistered stage exits 2 — never 0. A pipeline
that reports success for work nobody wrote is the single most expensive thing this tool
could do, because the thing downstream of it is a pack a learner installs.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import Registry
from ..artifacts import stage_dir
from ..config import STAGE_TITLES
from ..runlog import RunLog, StageEntry

__all__ = [
    "STAGES",
    "Stage",
    "StageContext",
    "StageResult",
    "register_stage",
]


@dataclass(slots=True)
class StageContext:
    """Everything a stage is handed. Nothing a stage reaches around this for.

    `entry` is the live runlog record: a stage calls `ctx.entry.record_input(...)`,
    `record_licence(...)` and `note(...)` as it goes, and the context manager in
    `coursekit.runlog` writes it whether the stage returns or raises.
    """

    lang: str
    runlog: RunLog
    entry: StageEntry
    #: Extra flags a lane's stage understands, from `--set key=value` on the CLI.
    options: dict[str, str] = field(default_factory=dict)

    @property
    def dir(self) -> Path:
        """This stage's directory under the run root."""
        return stage_dir(self.lang, self.entry.stage)


@dataclass(frozen=True, slots=True)
class StageResult:
    """What a stage reports back. `ok=False` exits 4 and names the stage."""

    ok: bool = True
    message: str = ""
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Stage:
    """One registered stage."""

    id: str
    title: str
    run: Callable[[StageContext], StageResult]
    #: Artefact record kinds this stage reads. The CLI does not enforce these; the
    #: stage does, through `runlog.require_successful`. They are declared so
    #: `coursekit doctor` can print the graph without importing every stage's body.
    reads: tuple[str, ...]
    writes: tuple[str, ...]
    #: An optional dependency group the stage cannot run without. The dispatcher
    #: checks it before the stage body, so a missing group is exit 3 with a remedy
    #: rather than an ImportError halfway through a 250k-row stream.
    requires_group: str | None


STAGES: Registry[Stage] = Registry(__name__, "stage")


def register_stage(
    stage_id: str,
    *,
    reads: tuple[str, ...] = (),
    writes: tuple[str, ...] = (),
    requires_group: str | None = None,
    title: str | None = None,
) -> Callable[[Callable[[StageContext], StageResult]], Callable[[StageContext], StageResult]]:
    """Register a stage implementation. Returns the function unchanged.

    `stage_id` must be one the ledger in `config/base.py` already names. A lane cannot
    invent a stage id here, because `coursekit build` runs `BUILD_STAGE_IDS` and a stage
    outside that list would be registered, importable, and never run — which looks
    exactly like a bug in the stage.
    """
    if stage_id not in STAGE_TITLES:
        raise ValueError(
            f"{stage_id!r} is not a stage in the ledger; config/base.py names "
            f"{', '.join(STAGE_TITLES)}"
        )

    def decorate(
        fn: Callable[[StageContext], StageResult],
    ) -> Callable[[StageContext], StageResult]:
        STAGES.add(
            stage_id,
            Stage(
                id=stage_id,
                title=title or STAGE_TITLES[stage_id],
                run=fn,
                reads=reads,
                writes=writes,
                requires_group=requires_group,
            ),
        )
        return fn

    return decorate
