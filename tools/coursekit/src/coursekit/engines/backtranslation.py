"""The back-translation consistency check, and an honest account of what produced it.

`scope2/00` §2.3 gives G6 four checks: a KenLM perplexity band, LanguageTool rules, a
**back-translation round trip**, and a register check. A round trip needs a translation
model. There is no API key for any provider in this environment and no local MT model in
the dependency set, so the round trip cannot be run.

The plan's ruling for exactly this situation is that the Opus agent building the lane is
the author. So the check is the agent's own judgement of whether the English a learner
will be shown is what the Spanish actually says, made against a published rubric
(`content/<lang>/gapfill-rubric.md`), written into the authored candidates file at
authoring time, and read back here.

**That is not a model round trip, and this module's entire job is to make sure nobody
can come to believe it is.** The engine id it reports carries the disclaimer verbatim;
the runlog records it; the manifest inherits it; INV-PACK-55 puts the engine fields on
the pack card. A reviewer looking at a Freelingo pack can see that this axis was scored
by an agent against a rubric rather than by a translation model, without reading a line
of source.

When a real round trip becomes available it registers as another engine under this same
interface and the runlog starts naming that one instead — which is the thing INV-PACK-14
is for: the artefact says which engine ran, and swapping one for another is visible.

## Why the score cannot ride on the `candidate` record

`coursekit.artifacts.CANDIDATE` is frozen and `additionalProperties: false`, so a rubric
score is not smuggleable across the G5 boundary — which is the contract working. The
score lives where it was authored, in `content/<lang>/candidates.jsonl` and in every
`content/<lang>/candidates/*.jsonl` shard, and this engine reads it from there, keyed by
the candidate text.

## Why it reads a LIST of files

It read exactly one — `content/<lang>/candidates.jsonl` — until the P2 fix integration.
The sharding that let four authoring lanes write one course moved every authored row into
`content/<lang>/candidates/*.jsonl` and left that single file absent, so the engine probed
a path that no longer existed, reported `backtranslation_engine: none`, and G6 failed the
build with "an engine was requested and could not run". The score file and the file G5
reads are the same file, so the engine now takes the same list G5 takes
(`authored_candidates_paths`) rather than one path that happened to be the only one when
it was written.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config.g6 import (
    BACKTRANSLATION_AUTHORSHIP,
    BACKTRANSLATION_SCORE_RANGE,
    ENGINE_NONE,
)
from ..engines import register_engine

__all__ = ["AgentRubricEngine", "build"]


@dataclass(slots=True)
class AgentRubricEngine:
    """Rubric scores read from the authored candidate files, keyed by candidate text."""

    paths: tuple[Path, ...]
    id: str = "agent_rubric"
    _scores: dict[str, dict[str, Any]] = field(default_factory=dict)
    _rubric_version: str = ""

    @property
    def path(self) -> Path | None:
        """The first file, for a message that has to name somewhere. `None` if empty."""
        return self.paths[0] if self.paths else None

    def probe(self, lang: str) -> dict[str, Any]:
        present = [path for path in self.paths if path.exists()]
        if not present:
            named = ", ".join(str(path) for path in self.paths) or "nowhere"
            return {
                "available": False,
                "backtranslation_engine": ENGINE_NONE,
                "reason": (
                    f"no authored candidates at {named}, so there are no rubric "
                    f"scores to read and no round trip to run instead"
                ),
                "detail": {},
            }

        low, high = BACKTRANSLATION_SCORE_RANGE
        unscored: list[str] = []
        for row in _rows_of(present):
            block = row.get("backtranslation")
            if not isinstance(block, dict) or not isinstance(block.get("score"), int):
                unscored.append(row.get("text", "<no text>"))
                continue
            if not low <= block["score"] <= high:
                unscored.append(row.get("text", "<no text>"))
                continue
            self._scores[row["text"]] = block
            self._rubric_version = block.get("rubric_version", self._rubric_version)
            for alternate in row.get("accepted_alternates", []):
                surface = alternate.get("text") if isinstance(alternate, dict) else None
                alternate_block = (
                    alternate.get("backtranslation") if isinstance(alternate, dict) else None
                )
                if (
                    not isinstance(surface, str)
                    or not isinstance(alternate_block, dict)
                    or not isinstance(alternate_block.get("score"), int)
                    or not low <= alternate_block["score"] <= high
                ):
                    unscored.append(surface or row.get("text", "<no text>"))
                    continue
                self._scores[surface] = alternate_block
                self._rubric_version = alternate_block.get(
                    "rubric_version", self._rubric_version
                )

        if unscored:
            return {
                "available": False,
                "backtranslation_engine": ENGINE_NONE,
                "reason": (
                    f"{len(unscored)} authored candidate(s) carry no rubric score in "
                    f"{low}..{high}; an unscored axis must be reported as absent, never "
                    f"as passed. First: {unscored[0]!r}"
                ),
                "detail": {"unscored": len(unscored)},
            }

        return {
            "available": True,
            "backtranslation_engine": (
                f"{self.id}/v{self._rubric_version or '0'} ({BACKTRANSLATION_AUTHORSHIP})"
            ),
            "reason": "",
            "detail": {
                "files": [str(path) for path in present],
                "rubric": str(present[0].parent / "gapfill-rubric.md"),
                "rubric_version": self._rubric_version,
                "scored": len(self._scores),
                "authorship": BACKTRANSLATION_AUTHORSHIP,
                "lang": lang,
            },
        }

    def score(self, text: str) -> int | None:
        """The rubric score for one candidate, or `None` if it was never scored.

        `None` is a rejection reason upstream, never a default pass: a sentence nobody
        judged is not a sentence that survived judgement.
        """
        block = self._scores.get(text)
        return None if block is None else int(block["score"])

    def judgement(self, text: str) -> dict[str, Any]:
        """The whole recorded judgement — the back-translation and the note with it."""
        return dict(self._scores.get(text, {}))


def _rows_of(paths: Iterable[Path]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for path in paths:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    out.append(json.loads(line))
    return out


@register_engine("agent_rubric")
def build(path: str | Sequence[str] | None = None) -> AgentRubricEngine | None:
    """One path or every path G5 read. A bare string stays accepted, and is one file."""
    if not path:
        return None
    paths = (path,) if isinstance(path, str) else tuple(path)
    if not paths:
        return None
    return AgentRubricEngine(paths=tuple(Path(one) for one in paths))
