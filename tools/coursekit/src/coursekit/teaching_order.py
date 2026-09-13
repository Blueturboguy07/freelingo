"""Deterministic teaching order shared by G9's actual slots and ledger validation.

G7's content IDs identify exercises, not their prerequisites. Preserve G4 slot hints
where possible, while introducing at most one new lemma before exercises combining
those lemmas. Never move an exercise to a different lesson or invent an introduction:
when no admissible next exercise exists, the actual invalid row remains for V2 to block.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from .config.g4 import MAX_NEW_LEMMAS_PER_EXERCISE

OrderHints = tuple[dict[tuple[int, int, str], int], dict[tuple[int, int, str], int]]


def selection_order_hints(
    selected: Iterable[Mapping[str, Any]],
    chosen: Mapping[tuple[int, int, int], Mapping[str, Any]],
) -> OrderHints:
    sources: dict[tuple[int, int, str], int] = {}
    lemmas: dict[tuple[int, int, str], int] = {}
    for row in selected:
        unit, lesson, slot = (int(row[k]) for k in ("unit_index", "lesson_index", "slot_index"))
        candidate = chosen.get((unit, lesson, slot)) if row["gap"] else None
        sid = candidate["candidate_id"] if candidate else row.get("sentence_id")
        if sid:
            key = (unit, lesson, str(sid))
            sources[key] = min(slot, sources.get(key, slot))
        for lemma in row.get("new_lemmas", ()):
            key = (unit, lesson, str(lemma))
            lemmas[key] = min(slot, lemmas.get(key, slot))
    return sources, lemmas


def order_exercises(
    units: Iterable[Mapping[str, Any]],
    exercises: Iterable[Mapping[str, Any]],
    *,
    hints: OrderHints | None = None,
    extra_exposure_lemmas: Mapping[str, Iterable[str]] | None = None,
) -> list[Mapping[str, Any]]:
    exercises = tuple(exercises)
    extras = {key: frozenset(value) for key, value in (extra_exposure_lemmas or {}).items()}
    if set(extras) - {str(row["exercise_id"]) for row in exercises}:
        raise ValueError("exposure evidence names an unknown exercise")

    def visible_lemmas(row):
        return frozenset(str(lemma) for lemma in row["item_tags"]["lemmas"]) | extras.get(
            str(row["exercise_id"]), frozenset()
        )

    introduced: dict[str, int] = {}
    for unit in sorted(units, key=lambda row: int(row["unit_index"])):
        for lemma in unit["target_lemmas"]:
            introduced.setdefault(str(lemma), int(unit["unit_index"]))
    groups: dict[tuple[int, int], list[Mapping[str, Any]]] = {}
    for exercise in exercises:
        key = (int(exercise["unit_index"]), int(exercise["lesson_index"]))
        groups.setdefault(key, []).append(exercise)
    source_slots, lemma_slots = hints or ({}, {})
    seen: set[str] = set()
    ordered: list[Mapping[str, Any]] = []
    for (unit, lesson), rows in sorted(groups.items()):

        def priority(
            row: Mapping[str, Any], unit: int = unit, lesson: int = lesson
        ) -> tuple[float, int, str]:
            tags = visible_lemmas(row)
            source_key = (unit, lesson, str(row.get("source_sentence_id")))
            # A match follows the latest introduction it needs; a single-word form
            # can precede the sentence that reserved the same lemma's first slot.
            fallback = max(
                (lemma_slots.get((unit, lesson, str(lemma)), float("inf")) for lemma in tags),
                default=float("inf"),
            )
            return (source_slots.get(source_key, fallback), len(tags), str(row["exercise_id"]))

        remaining = sorted(rows, key=priority)
        while remaining:
            eligible = next(
                (
                    i
                    for i, row in enumerate(remaining)
                    if len(
                        {
                            str(lemma)
                            for lemma in visible_lemmas(row)
                            if str(lemma) not in seen and introduced.get(str(lemma), unit) == unit
                        }
                    )
                    <= MAX_NEW_LEMMAS_PER_EXERCISE
                ),
                0,
            )
            exercise = remaining.pop(eligible)
            ordered.append(exercise)
            seen.update(visible_lemmas(exercise))
    return ordered
