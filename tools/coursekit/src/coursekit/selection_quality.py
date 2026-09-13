"""Pure upstream source repair and final-population checks under unchanged V3/V11.

Repair is an explicit upstream choice over reviewed alternatives supplied by its caller.
G6 only measures the resulting population; it must never call repair to reorder reserves.
Source lemma preservation is not a proof about G7 format counts: prospective actual
exercise expansion must preserve V3 too, or a subsequent full V3 probe must reject it.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from statistics import fmean
from typing import Any, Protocol

from .artifacts import dedup_hash
from .config.g3 import RECYCLE_MIN_OCCURRENCES, RECYCLE_WINDOW_LESSONS
from .config.g4 import MAX_USES_PER_SENTENCE_PER_COURSE, MAX_USES_PER_SENTENCE_PER_UNIT
from .config.validate import DIFFICULTY_EPSILON, MIN_ITEMS_PER_UNIT_FOR_DIFFICULTY
from .validators.pack import difficulty

Slot = tuple[int, int, int]


class SourceLike(Protocol):
    unit_index: int
    lesson_index: int
    slot_index: int
    source_id: str
    text: str
    lemmas: frozenset[str]

    @property
    def slot(self) -> Slot: ...


@dataclass(frozen=True)
class SourceChoice:
    unit_index: int
    lesson_index: int
    slot_index: int
    source_id: str
    text: str
    lemmas: frozenset[str]

    @property
    def slot(self) -> Slot:
        return self.unit_index, self.lesson_index, self.slot_index


@dataclass(frozen=True)
class SelectionRepair[SourceT: SourceLike]:
    choices: tuple[SourceT, ...]
    replacements: tuple[dict[str, Any], ...]
    report: dict[str, Any]


def source_difficulty_report(
    choices: Iterable[SourceLike],
    *,
    expected_slots: Iterable[Slot],
    section_by_unit: Mapping[int, int],
    deciles: dict[str, int],
) -> dict[str, Any]:
    """Measure each actual resolved source once, with the existing V11 implementation.

    Missing/duplicate/unexpected joins, absent sections, empty population and small
    units fail closed. This consumes exact source text, never its exercise siblings.
    """
    rows = tuple(choices)
    expected = Counter(expected_slots)
    actual = Counter(row.slot for row in rows)
    missing = sorted(expected.keys() - actual.keys())
    unexpected = sorted(actual.keys() - expected.keys())
    duplicates = sorted(slot for slot, count in actual.items() if count != 1)
    duplicate_expected = sorted(slot for slot, count in expected.items() if count != 1)
    unit_indices = sorted({slot[0] for slot in expected} | {row.unit_index for row in rows})
    missing_sections = [unit for unit in unit_indices if unit not in section_by_unit]
    complete = bool(rows and expected) and not (
        missing or unexpected or duplicates or duplicate_expected or missing_sections
    )
    scores: dict[int, list[float]] = {}
    for row in rows:
        # V11's single metric consumes only .text. SelectedSource and SourceChoice
        # both provide it; no tokenization/decile formula is copied into the producer.
        scores.setdefault(row.unit_index, []).append(difficulty(row, deciles)[0])
    means = {unit: fmean(values) for unit, values in scores.items()}
    small = [
        unit
        for unit in unit_indices
        if len(scores.get(unit, ())) < MIN_ITEMS_PER_UNIT_FOR_DIFFICULTY
    ]
    crossed = []
    within = []
    for previous, following in zip(sorted(means), sorted(means)[1:], strict=False):
        before, after = means[previous], means[following]
        if before - after <= DIFFICULTY_EPSILON:
            continue
        if previous not in section_by_unit or following not in section_by_unit:
            continue
        row = {
            "from_unit": previous,
            "to_unit": following,
            "from_section": section_by_unit[previous],
            "to_section": section_by_unit[following],
            "before": before,
            "after": after,
            "mean_deficit": before - after,
            "required_total_gain": (before - after) * len(scores[following]),
        }
        (crossed if row["from_section"] != row["to_section"] else within).append(row)
    return {
        "complete": complete,
        "blocking": not complete or bool(small or crossed),
        "expected_count": len(expected),
        "source_count": len(rows),
        "missing_slots": [list(slot) for slot in missing],
        "unexpected_slots": [list(slot) for slot in unexpected],
        "duplicate_slots": [list(slot) for slot in duplicates],
        "duplicate_expected_slots": [list(slot) for slot in duplicate_expected],
        "missing_sections": missing_sections,
        "too_small_units": small,
        "counts": {str(unit): len(scores[unit]) for unit in sorted(scores)},
        "means": {str(unit): means[unit] for unit in sorted(means)},
        "cross_section_deficits": crossed,
        "within_section_falls": within,
    }


def _reuse_safe(old: SourceLike, new: SourceLike, rows: Sequence[SourceLike]) -> bool:
    """Never increase existing source/text duplicates, within a unit or the course."""
    for key in (lambda row: row.source_id, lambda row: dedup_hash(row.text)):
        for population, maximum in (
            (rows, MAX_USES_PER_SENTENCE_PER_COURSE),
            (
                [row for row in rows if row.unit_index == old.unit_index],
                MAX_USES_PER_SENTENCE_PER_UNIT,
            ),
        ):
            counts = Counter(key(row) for row in population)
            proposed = counts[key(new)] - int(key(old) == key(new)) + 1
            if proposed > max(maximum, counts[key(new)]):
                return False
    return True


def repair_source_selection[SourceT: SourceLike](
    choices: Iterable[SourceT],
    replacements_by_slot: Mapping[Slot, Sequence[SourceT]],
    *,
    expected_slots: Iterable[Slot],
    section_by_unit: Mapping[int, int],
    deciles: dict[str, int],
    admissible: Callable[[SourceT, SourceT, tuple[SourceT, ...]], bool],
) -> SelectionRepair[SourceT]:
    """Choose explicit upstream repairs; report any deficit the reviewed pool cannot fill.

    Only section-entry sources can change. Slot order is deterministic; alternatives
    keep the caller's reviewed quality order rather than sorting by length or proxy.
    Each replacement strictly raises its slot's existing V11 score, preserves every
    old source lemma and reuse bounds, and requires the caller's affirmative source
    checks (ledger, targets, register, grammar, and prospective actual V3 expansion).
    This is a bounded greedy repair, not a claim to find every feasible assignment.
    """
    rows = tuple(sorted(choices, key=lambda row: row.slot))
    args = {
        "expected_slots": tuple(expected_slots),
        "section_by_unit": section_by_unit,
        "deciles": deciles,
    }
    report = source_difficulty_report(rows, **args)
    history: list[dict[str, Any]] = []
    if not report["complete"] or report["too_small_units"]:
        return SelectionRepair(rows, (), report)
    while report["cross_section_deficits"]:
        changed = False
        for deficit in report["cross_section_deficits"]:
            proposals = [
                (preference, index, old, new)
                for index, old in enumerate(rows)
                if old.unit_index == deficit["to_unit"]
                for preference, new in enumerate(replacements_by_slot.get(old.slot, ()))
            ]
            # Offer first-preference eligible repairs across all entry slots before
            # descending one slot's quality list. Never sort alternatives by proxy.
            for _preference, index, old, new in sorted(proposals, key=lambda p: (p[0], p[2].slot)):
                if (
                    new.slot != old.slot
                    or new.source_id == old.source_id
                    or not old.lemmas <= new.lemmas
                ):
                    continue
                before, after = difficulty(old, deciles)[0], difficulty(new, deciles)[0]
                if after - before <= DIFFICULTY_EPSILON or not _reuse_safe(old, new, rows):
                    continue
                if not admissible(old, new, rows):
                    continue
                rows = rows[:index] + (new,) + rows[index + 1 :]
                history.append(
                    {
                        "slot": list(old.slot),
                        "from_source_id": old.source_id,
                        "to_source_id": new.source_id,
                        "before": before,
                        "after": after,
                    }
                )
                report = source_difficulty_report(rows, **args)
                changed = True
                break
            if changed:
                break
        if not changed:
            break
    return SelectionRepair(rows, tuple(history), report)


def recurrence_deficits(
    appearances: Iterable[tuple[int, frozenset[str]]], *, last_lesson: int
) -> list[dict[str, Any]]:
    """Plan using actual ordered G7 exercise appearances, never source/format estimates.

    N, K, inclusive deadline and the final-course end effect are identical to V3.
    Missing promised targets are a separate coverage defect; never invent appearances.
    """
    by_lemma: dict[str, list[int]] = {}
    previous = 0
    for lesson, lemmas in appearances:
        if type(lesson) is not int or lesson < previous or lesson < 1:
            raise ValueError("recurrence appearances must be in actual lesson order")
        if lesson > last_lesson:
            raise ValueError("recurrence appearance extends beyond the actual last lesson")
        previous = lesson
        for lemma in set(lemmas):
            by_lemma.setdefault(lemma, []).append(lesson)
    result = []
    for lemma, lessons in sorted(by_lemma.items()):
        introduced = lessons[0]
        end = introduced + RECYCLE_WINDOW_LESSONS
        recycled = sum(lesson <= end for lesson in lessons[1:])
        if recycled < RECYCLE_MIN_OCCURRENCES:
            result.append(
                {
                    "lemma": lemma,
                    "introduced_at": introduced,
                    "window_end": end,
                    "recycled": recycled,
                    "deficit": RECYCLE_MIN_OCCURRENCES - recycled,
                    "severity": "info" if end > last_lesson else "blocking",
                }
            )
    return result
