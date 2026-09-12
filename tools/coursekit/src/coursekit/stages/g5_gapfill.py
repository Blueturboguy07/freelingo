"""G5 — gap-fill. The only stage in the pipeline that authors text.

G4 emits a gap list: lesson slots no corpus sentence can fill inside the unit's
vocabulary window. This stage fills them from candidates authored ahead of time into
`content/<lang>/candidates.jsonl`, and it fills them by **generate-and-reject**, which
is `deep/10` §S5's G5-A.

## Generate-and-reject, and why there is no repair path

Closed-vocabulary constrained decoding does not exist against a hosted API: Outlines'
OpenAI backend is JSON-schema-only, and its Anthropic page documents no structured-output
types at all (softened by review R18 to "documents nothing", not "documented absence").
So the vocabulary constraint cannot be enforced *during* generation and has to be
enforced *after* it. Over-generate about twenty per slot, run every one through the
filters, keep what survives.

**INV-PACK-10: a candidate that fails an axis is discarded and resampled, never
patched.** The invariant's gate is "no repair path exists in the generator", and the
reason it is phrased as a property of the code rather than of the output is that a repair
path is invisible in the output — a patched sentence looks exactly like a sentence that
passed. Two things hold it here:

- `tests/test_g5_gapfill.py` parses this module and fails on a repair-shaped identifier
  or a string-mutating call, with `tests/falsifiers/INV-PACK-10.json` beside it so the
  scanner cannot pass by scanning nothing.
- The emitted texts are a subset of the authored texts, asserted over generated inputs.
  Every `text` this stage writes is the object it read; nothing constructs one.

Resampling is the loop itself: candidates are evaluated in file order and the slot is
filled by the first survivor, so a rejection costs the next candidate and nothing else.
A slot whose twenty candidates all fail is a **failed stage**, named, not a slot filled
by the least-bad option.

## Every candidate re-enters through the corpus path

`scope2/00` §2.3 requires that "every output re-enters at G6 identically to corpus
sentences". Identically means the same lemmatiser, the same length window and the same
ledger:

- lemmas come from the **G1 adapter registry**, the same analyser that produced
  `analysed_sentence` for every corpus row. If no adapter is registered for the language
  this stage fails loudly rather than whitespace-splitting — a whitespace "lemma" makes
  V1 pass vacuously, and for Japanese it makes a whole sentence one unknown token.
- the length window is G0's 3-12 token A1 filter, from the shared config, not a second
  looser number for authored text.
- the ledger is the one G4 emitted on the row, not the one the author had in mind, which
  is what the `stale_ledger` axis is for: authoring happens offline, and a candidates
  file written against last week's curriculum must fail rather than fill.

## There is no model here

No API key for any provider exists in this environment, so the plan's ruling applies: the
Opus agent is the author. `author` on every row is that agent, `provenance` is `llm`, and
the manifest's machine-authored percentage is therefore a real count of real rows.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..adapters import ADAPTERS
from ..artifacts import dedup_hash, read_records, write_records
from ..config.g5 import (
    AUTHORED_CANDIDATES_FILENAME,
    AUTHORED_PROVENANCE,
    CONTENT_ROOT_DIRNAME,
    CONTENT_ROOT_ENV_VAR,
    MAX_NEW_LEMMAS_PER_ITEM,
    MAX_TOKENS,
    MIN_CANDIDATES_PER_SLOT,
    MIN_TOKENS,
    OVERGENERATION_TARGET,
    REJECT_AXES,
)
from ..inputs import MissingInput
from ..runlog import require_successful
from . import StageContext, StageResult, register_stage

__all__ = ["Slot", "authored_candidates_path", "content_root", "gapfill"]


@dataclass(frozen=True, slots=True)
class Slot:
    """A lesson slot, as G4 and the authored file both name it."""

    unit_index: int
    lesson_index: int
    slot_index: int

    @classmethod
    def of(cls, row: dict[str, Any]) -> Slot:
        return cls(
            unit_index=int(row["unit_index"]),
            lesson_index=int(row["lesson_index"]),
            slot_index=int(row["slot_index"]),
        )

    def __str__(self) -> str:
        return f"u{self.unit_index}/l{self.lesson_index}/s{self.slot_index}"


# ---------------------------------------------------------------------------
# Where the authored file lives
# ---------------------------------------------------------------------------


def content_root() -> Path:
    """`<repo>/content`, or `$COURSEKIT_CONTENT_ROOT`.

    Authored content is repository content, not build output: it is reviewed, it is
    licensed CC BY-NC-SA with the rest of the pack, and it survives `rm -rf build`.
    """
    override = os.environ.get(CONTENT_ROOT_ENV_VAR)
    if override:
        return Path(override)
    # `tools/coursekit/src/coursekit/stages/g5_gapfill.py` -> five parents is
    # `tools/coursekit`, six is the repository root. Same walk as
    # `artifacts._repo_root`, one directory deeper.
    return Path(__file__).resolve().parents[5] / CONTENT_ROOT_DIRNAME


def authored_candidates_path(lang: str) -> Path:
    return content_root() / lang / AUTHORED_CANDIDATES_FILENAME


# ---------------------------------------------------------------------------
# The authored row
# ---------------------------------------------------------------------------

#: Private, so `test_no_constant_lives_outside_config` leaves it alone, and local
#: because it is a contract with a file this lane also writes — unlike
#: `coursekit.artifacts`, nothing downstream reads this shape.
_AUTHORED_REQUIRED = (
    "slot",
    "allowed_lemmas",
    "new_lemmas",
    "text",
    "translation",
    "author",
    "generated_at",
    "provenance",
    "backtranslation",
)


def _read_authored(path: Path, lang: str) -> list[dict[str, Any]]:
    if not path.exists():
        raise MissingInput(
            f"no authored gap-fill candidates for {lang!r} at {path}. G5 is the only "
            f"authoring stage and it authors nothing at run time: with no API key in "
            f"this environment the candidates are written ahead of the build (plan "
            f"ruling), and a build that cannot find them must stop rather than leave "
            f"the gap list unfilled."
        )
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            if not line or line.isspace():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise MissingInput(f"{path.name} line {number}: {exc}") from exc
            missing = [key for key in _AUTHORED_REQUIRED if key not in row]
            if missing:
                raise MissingInput(
                    f"{path.name} line {number}: authored candidate is missing {', '.join(missing)}"
                )
            if row["provenance"] != AUTHORED_PROVENANCE:
                raise MissingInput(
                    f"{path.name} line {number}: provenance is {row['provenance']!r}; G5 "
                    f"emits {AUTHORED_PROVENANCE!r} and nothing else, because the "
                    f"manifest's machine-authored percentage is counted off this field"
                )
            rows.append(row)
    return rows


def _candidate_id(lang: str, slot: Slot, text: str) -> str:
    """Content-addressed over language, slot and text.

    The slot is in the digest because the same sentence may legitimately be authored
    for two slots, and two rows sharing an id would make the reject rate unreadable.
    """
    payload = f"{lang}\x1f{slot.unit_index}\x1f{slot.lesson_index}\x1f{slot.slot_index}\x1f{text}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# The filter axes
# ---------------------------------------------------------------------------


def _lemmas(analyser: Any, text: str) -> tuple[list[str], int]:
    """Lemmas and token count from the G1 adapter. Never a whitespace split."""
    analysis = analyser.analyse(text)
    lemmas = list(analysis["lemmas"])
    tokens = analysis.get("tokens")
    return lemmas, len(tokens) if tokens is not None else len(lemmas)


def _axis(
    authored: dict[str, Any],
    gap: dict[str, Any],
    analyser: Any,
    seen_in_unit: set[str],
) -> str | None:
    """The first axis this candidate fails, or `None`.

    Evaluated in `REJECT_AXES` order and short-circuited: `stale_ledger` has to come
    first, because every axis below it would otherwise be measured against a vocabulary
    the build no longer has and would pass for the wrong reason.
    """
    allowed = set(gap["known_lemmas"]) | set(gap["new_lemmas"])
    if set(authored["allowed_lemmas"]) != allowed:
        return "stale_ledger"
    if set(authored["new_lemmas"]) != set(gap["new_lemmas"]):
        # Same window, different idea of which lemmas are the NEW ones. The author
        # wrote to a budget of one new lemma per item against a different set, so the
        # budget axis below would be measured against the wrong thing.
        return "stale_ledger"

    lemmas, token_count = _lemmas(analyser, authored["text"])

    unknown = [lemma for lemma in lemmas if lemma not in allowed]
    if unknown:
        return "out_of_vocabulary"

    introduced = {lemma for lemma in lemmas if lemma in set(gap["new_lemmas"])}
    if len(introduced) > MAX_NEW_LEMMAS_PER_ITEM:
        return "new_lemma_budget"

    if not MIN_TOKENS <= token_count <= MAX_TOKENS:
        return "length"

    if dedup_hash(authored["text"]) in seen_in_unit:
        return "duplicate"

    return None


# ---------------------------------------------------------------------------
# The stage
# ---------------------------------------------------------------------------


def _gaps(lang: str) -> Iterator[dict[str, Any]]:
    for row in read_records("selected_item", lang=lang):
        if row["gap"]:
            yield row


@register_stage("g5", reads=("selected_item",), writes=("candidate",))
def gapfill(ctx: StageContext) -> StageResult:
    """Fill G4's gap list by generate-and-reject. Writes every candidate, kept or not."""
    require_successful(ctx.lang, ("g4",))

    analyser_factory = ADAPTERS.get(ctx.lang)
    if analyser_factory is None:
        raise MissingInput(
            f"no morphology adapter is registered for {ctx.lang!r}, so a candidate "
            f"cannot be lemmatised the way a corpus sentence was. There is no "
            f"whitespace fallback by design: whitespace 'lemmas' make V1 pass vacuously "
            f"and, for ja, make a whole sentence one unknown token. Register one in "
            f"coursekit/adapters/ (G1's lane)."
        )
    analyser = analyser_factory()

    path = authored_candidates_path(ctx.lang)
    authored = _read_authored(path, ctx.lang)
    ctx.entry.record_input(str(path))

    by_slot: dict[Slot, list[dict[str, Any]]] = {}
    for row in authored:
        by_slot.setdefault(Slot.of(row["slot"]), []).append(row)

    gaps = list(_gaps(ctx.lang))
    records: list[dict[str, Any]] = []
    rejected_by_axis = dict.fromkeys(REJECT_AXES, 0)
    seen_by_unit: dict[int, set[str]] = {}
    filled: list[str] = []
    unfilled: list[str] = []
    thin: list[str] = []

    for gap in gaps:
        slot = Slot.of(gap)
        pool = by_slot.get(slot, [])
        if len(pool) < MIN_CANDIDATES_PER_SLOT:
            thin.append(f"{slot} ({len(pool)})")
            continue

        seen = seen_by_unit.setdefault(int(gap["unit_index"]), set())
        slot_filled = False
        for row in pool:
            axis = _axis(row, gap, analyser, seen)
            accepted = axis is None
            if accepted:
                seen.add(dedup_hash(row["text"]))
                if not slot_filled:
                    slot_filled = True
                    filled.append(str(slot))
            else:
                rejected_by_axis[axis] += 1
            records.append(
                {
                    "schema_version": 1,
                    "lang": ctx.lang,
                    "candidate_id": _candidate_id(ctx.lang, slot, row["text"]),
                    "unit_index": slot.unit_index,
                    "lesson_index": slot.lesson_index,
                    "slot_index": slot.slot_index,
                    "text": row["text"],
                    "translation": row["translation"],
                    "author": row["author"],
                    "generated_at": row["generated_at"],
                    "accepted": accepted,
                    "reject_reason": None if accepted else axis,
                    "provenance": AUTHORED_PROVENANCE,
                }
            )
        if not slot_filled:
            unfilled.append(str(slot))

    written = write_records("candidate", records, lang=ctx.lang)
    ctx.entry.record_output("candidate")
    ctx.entry.read = len(authored)
    ctx.entry.written = written
    ctx.entry.rejected = sum(rejected_by_axis.values())

    orphans = sorted(str(slot) for slot in by_slot if slot not in {Slot.of(gap) for gap in gaps})
    ctx.entry.note(
        author=sorted({row["author"] for row in authored}),
        authoring_file=str(path),
        overgeneration_target=OVERGENERATION_TARGET,
        gap_slots=len(gaps),
        filled_slots=len(filled),
        unfilled_slots=unfilled,
        thin_slots=thin,
        orphan_authored_slots=orphans,
        rejected_by_axis=rejected_by_axis,
        reject_rate=round(sum(rejected_by_axis.values()) / written, 4) if written else 0.0,
        # INV-PACK-10, stated in the artefact as well as enforced by the test. Phrased
        # as the positive property rather than as the absence of a repair path, because
        # the scanner in tests/test_g5_gapfill.py fails this module on a repair-shaped
        # IDENTIFIER — and a note key that had to be exempted from the gate would be the
        # first hole in it.
        discard_and_resample=True,
        emitted_text_is_authored_verbatim=True,
    )

    if thin:
        return StageResult(
            ok=False,
            message=(
                f"{len(thin)} slot(s) authored below the over-generation floor of "
                f"{MIN_CANDIDATES_PER_SLOT}: {', '.join(thin)}. Generate-and-reject has "
                f"nothing to resample from, and the alternative is patching."
            ),
        )
    if unfilled:
        return StageResult(
            ok=False,
            message=(
                f"{len(unfilled)} slot(s) exhausted every candidate: "
                f"{', '.join(unfilled)}. Widen the ledger window or author more; a slot "
                f"is never filled by the least-bad rejected candidate."
            ),
        )
    return StageResult(
        ok=True,
        message=f"{len(filled)}/{len(gaps)} slots filled from {written} candidates",
        detail={"rejected_by_axis": rejected_by_axis},
    )
