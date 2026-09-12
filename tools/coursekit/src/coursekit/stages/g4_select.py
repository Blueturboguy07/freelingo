"""G4 — select. Fill lesson slots from the corpus, and say exactly what it could not fill.

For each lesson slot, pick a corpus sentence whose **lemma set is a subset of
known ∪ this unit's new items** and which **exhibits the unit's grammar concept**, then
emit an explicit gap list for G5 (`scope2/00` §2.3 G4).

Three rules make this stage more than a filter:

- **`corpus.shippable` only.** The verdict is read off the G0 row, which resolved it at
  ingest. Oracle-only text (NLLB, OpenSubtitles, CCMatrix) informs frequency, perplexity
  and alignment and may never fill a slot; a stage that re-derived the verdict from a
  source id could re-derive it differently, and the result would be crawl-derived text
  shipped verbatim in a pack.
- **A gap is written, never skipped.** `sentence_id: null`, `gap: true`. An unfilled slot
  and a slot whose sentence was dropped are different bugs, and a lesson that quietly got
  shorter is the one nobody notices.
- **The yield is measured.** `deep/10` Open Question 1 calls the ledger's admission rate
  "the most load-bearing untested assumption in the content plan" — the framework
  estimates 5-15% of short candidates and nobody had measured it. This stage measures it
  and writes it to the runlog; P2 is where it stops being untested.

### Why the admissibility index looks the way it does

The obvious implementation rescans the corpus for every lesson: 250k sentences × ~180
lessons is 45M subset tests and a stage nobody runs twice. Instead each not-yet-admissible
sentence is parked under **one** lemma it is still waiting on, and introducing a lemma
wakes only the sentences parked under it — the watched-literal trick from SAT solvers.
Total work is proportional to the corpus, not to the corpus times the course.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from ..artifacts import read_records, write_records
from ..config import ARTIFACT_SCHEMA_VERSION
from ..config.g3 import LESSONS_PER_LEVEL, RECYCLE_MIN_OCCURRENCES
from ..config.g4 import (
    CANDIDATE_TOKENS_MAX,
    CANDIDATE_TOKENS_MIN,
    CROSS_UNIT_REPEAT_CEILING,
    FILLED_PROVENANCE,
    GAP_PROVENANCE,
    LEDGER_EXCLUDED_POS,
    MAX_GAP_FRACTION,
    MAX_NEW_LEMMAS_PER_EXERCISE,
    MAX_NEW_LEMMAS_PER_LESSON,
    MAX_USES_PER_SENTENCE_PER_COURSE,
    MAX_USES_PER_SENTENCE_PER_UNIT,
    PREDICTED_YIELD_MAX,
    PREDICTED_YIELD_MIN,
    RECYCLE_SCAN_LIMIT,
    SHIPPABLE_VERDICT,
    SLOTS_PER_LESSON,
    SORT_BY_LENGTH_ASCENDING,
    YIELD_NOTE_KEY,
)
from ..runlog import require_successful
from . import StageContext, StageResult, register_stage
from .g3_solve import GrammarConcept, curriculum_path, load_curriculum

__all__ = [
    "Candidate",
    "SelectReport",
    "SelectResult",
    "build_candidates",
    "select",
]


@dataclass(frozen=True, slots=True)
class Candidate:
    """One shippable, analysed, short-enough sentence, ready for the ledger test."""

    sentence_id: str
    lemmas: frozenset[str]
    tokens: tuple[Mapping[str, Any], ...]
    token_count: int


def build_candidates(
    ingested: Iterable[Mapping[str, Any]],
    analysed: Iterable[Mapping[str, Any]],
) -> tuple[list[Candidate], dict[str, int]]:
    """Join G0's licence row to G1's lemmas and keep what a lesson may use.

    Returns the candidates and a census of what was dropped and why, because "1,200
    candidates" and "1,200 candidates out of 229,000, 96% of them cut for length" are
    different facts and only the second one tells you whether the corpus posture holds.
    """
    census = {
        "ingested": 0,
        "not_shippable": 0,
        "wrong_length": 0,
        "not_analysed": 0,
        "candidates": 0,
    }
    shippable: dict[str, int] = {}
    for row in ingested:
        census["ingested"] += 1
        if row["licence_verdict"] != SHIPPABLE_VERDICT:
            census["not_shippable"] += 1
            continue
        token_count = int(row["token_count"])
        if not CANDIDATE_TOKENS_MIN <= token_count <= CANDIDATE_TOKENS_MAX:
            census["wrong_length"] += 1
            continue
        shippable[str(row["sentence_id"])] = token_count

    candidates: list[Candidate] = []
    seen: set[str] = set()
    for row in analysed:
        sentence_id = str(row["sentence_id"])
        if sentence_id not in shippable or sentence_id in seen:
            continue
        seen.add(sentence_id)
        tokens = tuple(dict(token) for token in row["tokens"])
        not_items = {
            str(token["lemma"]) for token in tokens if str(token["pos"]) in LEDGER_EXCLUDED_POS
        }
        lemmas = frozenset(str(lemma) for lemma in row["lemmas"]) - not_items
        if not lemmas:
            # Nothing but punctuation. Admissible against every ledger and teaches
            # nothing — the one shape that would fill slots while saying nothing.
            census["no_ledger_lemmas"] = census.get("no_ledger_lemmas", 0) + 1
            continue
        candidates.append(
            Candidate(
                sentence_id=sentence_id,
                lemmas=lemmas,
                tokens=tokens,
                token_count=shippable[sentence_id],
            )
        )
    census["not_analysed"] = len(shippable) - len(seen)
    census["candidates"] = len(candidates)
    candidates.sort(
        key=lambda candidate: (candidate.token_count, candidate.sentence_id),
        reverse=not SORT_BY_LENGTH_ASCENDING,
    )
    return candidates, census


class _Admissible:
    """Which candidates the ledger currently admits, maintained incrementally.

    A candidate is admissible when every one of its lemmas has been introduced. Until
    then it is parked under exactly one lemma it is waiting on; introducing that lemma
    wakes it and either admits it or re-parks it under the next one it still lacks.
    """

    def __init__(self, candidates: Sequence[Candidate]) -> None:
        self._candidates = {candidate.sentence_id: candidate for candidate in candidates}
        self._order = {candidate.sentence_id: index for index, candidate in enumerate(candidates)}
        self._parked: dict[str, list[str]] = {}
        self._ready: set[str] = set()
        self.known: set[str] = set()
        for candidate in candidates:
            self._place(candidate.sentence_id)

    def _place(self, sentence_id: str) -> None:
        waiting = self._candidates[sentence_id].lemmas - self.known
        if not waiting:
            self._ready.add(sentence_id)
            return
        self._parked.setdefault(min(waiting), []).append(sentence_id)

    def introduce(self, lemmas: Iterable[str]) -> None:
        pending = list(lemmas)
        while pending:
            lemma = pending.pop()
            if lemma in self.known:
                continue
            self.known.add(lemma)
            for sentence_id in self._parked.pop(lemma, []):
                self._place(sentence_id)

    def ready(self) -> list[Candidate]:
        """Admissible candidates, in the deterministic corpus order."""
        return [
            self._candidates[sentence_id]
            for sentence_id in sorted(self._ready, key=lambda sid: self._order[sid])
        ]


@dataclass(slots=True)
class SelectReport:
    """The numbers Open Question 1 asked for, plus what the run actually produced."""

    census: dict[str, int] = field(default_factory=dict)
    slots: int = 0
    filled: int = 0
    gaps: int = 0
    admissible: int = 0
    exhibiting: int = 0
    selected_distinct: int = 0
    cross_unit_repeats: int = 0
    ledger_yield: float = 0.0
    exhibiting_yield: float = 0.0
    selection_yield: float = 0.0
    within_prediction: bool = False
    per_unit_gaps: dict[str, int] = field(default_factory=dict)

    @property
    def gap_fraction(self) -> float:
        return self.gaps / self.slots if self.slots else 0.0

    @property
    def cross_unit_repeat_fraction(self) -> float:
        return self.cross_unit_repeats / self.filled if self.filled else 0.0

    def as_notes(self) -> dict[str, Any]:
        return {
            "census": dict(self.census),
            "slots": self.slots,
            "filled": self.filled,
            "gaps": self.gaps,
            "gap_fraction": round(self.gap_fraction, 4),
            "per_unit_gaps": dict(self.per_unit_gaps),
            "selected_distinct": self.selected_distinct,
            "cross_unit_repeats": self.cross_unit_repeats,
            "cross_unit_repeat_fraction": round(self.cross_unit_repeat_fraction, 4),
            YIELD_NOTE_KEY: {
                "short_shippable_candidates": self.census.get("candidates", 0),
                "admitted_by_the_ledger": self.admissible,
                "admitted_and_exhibiting_a_concept": self.exhibiting,
                "actually_selected": self.selected_distinct,
                "ledger_yield": round(self.ledger_yield, 4),
                "exhibiting_yield": round(self.exhibiting_yield, 4),
                "selection_yield": round(self.selection_yield, 4),
                "predicted_range": [PREDICTED_YIELD_MIN, PREDICTED_YIELD_MAX],
                "within_prediction": self.within_prediction,
            },
        }


@dataclass(slots=True)
class SelectResult:
    items: list[dict[str, Any]]
    report: SelectReport


def _lessons_of(unit: Mapping[str, Any]) -> int:
    return int(unit["level_count"]) * LESSONS_PER_LEVEL


def _split_new_lemmas(target: Sequence[str], lessons: int) -> list[list[str]]:
    """Deal a unit's new lemmas across its lessons, in authored order.

    Chunked, not round-robin: the author put related words next to each other and a
    lesson that teaches five consecutive ones is a lesson about something.
    """
    if lessons <= 0:
        return []
    per_lesson = min(MAX_NEW_LEMMAS_PER_LESSON, max(1, math.ceil(len(target) / lessons)))
    chunks = [
        list(target[index : index + per_lesson])
        for index in range(0, len(target), per_lesson)
    ]
    while len(chunks) < lessons:
        chunks.append([])
    return chunks


def select(
    units: Sequence[Mapping[str, Any]],
    candidates: Sequence[Candidate],
    concepts: Mapping[str, GrammarConcept],
    census: Mapping[str, int],
) -> SelectResult:
    """Fill every lesson slot of every unit, or mark it a gap for G5."""
    index = _Admissible(candidates)
    exhibits: dict[tuple[str, str], bool] = {}

    def exhibited(candidate: Candidate, concept_id: str) -> bool:
        key = (candidate.sentence_id, concept_id)
        if key not in exhibits:
            exhibits[key] = concepts[concept_id].probe.matches_sentence(candidate.tokens)
        return exhibits[key]

    items: list[dict[str, Any]] = []
    report = SelectReport(census=dict(census))
    #: Lemmas an exercise has actually put in front of the learner. A lemma the ledger
    #: introduced and no exercise ever showed is NOT here — that is a V4 coverage
    #: finding, and a gap slot is where G5 fixes it.
    shown: set[str] = set()
    uses_per_course: dict[str, int] = {}
    #: lemma -> how many more appearances it still owes V3. G3 emitted `recycled_lemmas`
    #: precisely so this stage can select against it; without this the ledger satisfies
    #: V1 and V2 by construction and leaves V3 to luck.
    owed: dict[str, int] = {}
    lesson_index = 0

    for unit in units:
        unit_index = int(unit["unit_index"])
        concept_id = str(unit["grammar_concept"])
        target = [str(lemma) for lemma in unit["target_lemmas"]]
        #: The unit's OWN new items, the only ones that count against V2's per-exercise
        #: budget here. A lemma an earlier unit introduced is known by the time this unit
        #: runs, whether or not an exercise in that unit happened to carry it, and
        #: counting it as new again is what deadlocks a corpus-only selector: at the
        #: start of the course nothing has been shown, every sentence looks like five new
        #: items at once, and the stage gaps all 756 slots while reporting success.
        #: Measured on the es-mini fixture before this changed.
        unit_new = set(target)
        for lemma in unit["recycled_lemmas"]:
            owed.setdefault(str(lemma), 0)
        lessons = _lessons_of(unit)
        uses_in_unit: dict[str, int] = {}

        for chunk in _split_new_lemmas(target, lessons):
            lesson_index += 1
            index.introduce(chunk)
            lesson_new: set[str] = set()
            pool = index.ready()

            for slot_index in range(SLOTS_PER_LESSON):
                report.slots += 1
                pending = [
                    lemma
                    for lemma in target
                    if lemma not in shown and lemma in index.known
                ]
                # Introduce first. A slot that could have taught one of this lesson's own
                # new words and instead practised an old one is how a unit fills every
                # slot and still covers none of its target lexemes — measured on the
                # es-mini pack as a V4 coverage failure in unit 29, with no gap against it.
                choice = _pick(
                    pool,
                    concept_id=concept_id,
                    exhibited=exhibited,
                    unit_new=unit_new,
                    shown=shown,
                    lesson_new=lesson_new,
                    uses_in_unit=uses_in_unit,
                    uses_per_course=uses_per_course,
                    owed=owed,
                    require_new=True,
                )
                if choice is None and len(pending) < SLOTS_PER_LESSON - slot_index:
                    # Enough slots left to teach what is still pending; spend this one on
                    # practice. Otherwise fall through and RESERVE the slot as a gap, so
                    # G5 has somewhere to introduce a word the corpus cannot.
                    choice = _pick(
                        pool,
                        concept_id=concept_id,
                        exhibited=exhibited,
                        unit_new=unit_new,
                        shown=shown,
                        lesson_new=lesson_new,
                        uses_in_unit=uses_in_unit,
                        uses_per_course=uses_per_course,
                        owed=owed,
                        require_new=False,
                    )
                if choice is None:
                    report.gaps += 1
                    key = str(unit_index)
                    report.per_unit_gaps[key] = report.per_unit_gaps.get(key, 0) + 1
                    items.append(
                        _item(
                            unit=unit,
                            lesson_index=lesson_index,
                            slot_index=slot_index,
                            sentence_id=None,
                            new_lemmas=[],
                            known_lemmas=[],
                        )
                    )
                    continue

                new_lemmas = sorted((choice.lemmas & unit_new) - shown)
                known_lemmas = sorted(choice.lemmas - set(new_lemmas))
                shown.update(choice.lemmas)
                lesson_new.update(new_lemmas)
                for lemma in choice.lemmas:
                    if lemma in owed:
                        owed[lemma] = max(0, owed[lemma] - 1)
                    else:
                        # First appearance: from here it owes N RE-appearances (V3).
                        owed[lemma] = RECYCLE_MIN_OCCURRENCES
                uses_in_unit[choice.sentence_id] = uses_in_unit.get(choice.sentence_id, 0) + 1
                previous = uses_per_course.get(choice.sentence_id, 0)
                if previous:
                    report.cross_unit_repeats += 1
                uses_per_course[choice.sentence_id] = previous + 1
                report.filled += 1
                items.append(
                    _item(
                        unit=unit,
                        lesson_index=lesson_index,
                        slot_index=slot_index,
                        sentence_id=choice.sentence_id,
                        new_lemmas=new_lemmas,
                        known_lemmas=known_lemmas,
                    )
                )

        # A unit's own target lemmas are introduced whether or not a sentence carried
        # them: the ledger is the curriculum's, not the corpus's. Without this a lemma
        # G4 could not place would block every later sentence that uses it.
        index.introduce(target)

    _measure_yield(report, index, candidates, units, exhibited, uses_per_course)
    return SelectResult(items=items, report=report)


def _pick(
    pool: Sequence[Candidate],
    *,
    concept_id: str,
    exhibited: Any,
    unit_new: set[str],
    shown: set[str],
    lesson_new: set[str],
    uses_in_unit: Mapping[str, int],
    uses_per_course: Mapping[str, int],
    owed: Mapping[str, int],
    require_new: bool,
) -> Candidate | None:
    """The admissible candidate that pays off the most recycling debt.

    Admissibility is the hard part and is absolute: lemma set inside the window (the
    candidate pool is already filtered to that), at most one of THIS unit\'s new items
    not yet shown, the lesson\'s allowance not exceeded, the unit\'s grammar concept
    exhibited, not already used here. Among the candidates that pass, the one carrying the
    most lemmas that still owe V3 appearances wins — that is what turns G3's
    `recycled_lemmas` from a field into a constraint. Ties go to corpus order (shortest
    first, then sentence id), so the whole stage stays deterministic.
    """
    best: Candidate | None = None
    best_score = -1
    scanned = 0
    for candidate in pool:
        if scanned >= RECYCLE_SCAN_LIMIT and best is not None:
            break
        if uses_in_unit.get(candidate.sentence_id, 0) >= MAX_USES_PER_SENTENCE_PER_UNIT:
            continue
        if uses_per_course.get(candidate.sentence_id, 0) >= MAX_USES_PER_SENTENCE_PER_COURSE:
            continue
        new = (candidate.lemmas & unit_new) - shown
        if len(new) > MAX_NEW_LEMMAS_PER_EXERCISE:
            continue
        if require_new and not new:
            continue
        if len(lesson_new | new) > MAX_NEW_LEMMAS_PER_LESSON:
            continue
        if not exhibited(candidate, concept_id):
            continue
        scanned += 1
        score = sum(1 for lemma in candidate.lemmas if owed.get(lemma, 0) > 0)
        if score > best_score:
            best, best_score = candidate, score
    return best


def _item(
    *,
    unit: Mapping[str, Any],
    lesson_index: int,
    slot_index: int,
    sentence_id: str | None,
    new_lemmas: Sequence[str],
    known_lemmas: Sequence[str],
) -> dict[str, Any]:
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "lang": unit["lang"],
        "unit_index": int(unit["unit_index"]),
        "lesson_index": lesson_index,
        "slot_index": slot_index,
        "sentence_id": sentence_id,
        "provenance": FILLED_PROVENANCE if sentence_id else GAP_PROVENANCE,
        "gap": sentence_id is None,
        "new_lemmas": list(new_lemmas),
        "known_lemmas": list(known_lemmas),
        "grammar_concept": str(unit["grammar_concept"]),
    }


def _measure_yield(
    report: SelectReport,
    index: _Admissible,
    candidates: Sequence[Candidate],
    units: Sequence[Mapping[str, Any]],
    exhibited: Any,
    uses_per_course: Mapping[str, int],
) -> None:
    """Open Question 1, answered with three numbers rather than one.

    `ledger_yield` is the one the framework predicted at 5-15%: of the short, shippable
    candidates, how many does the finished ledger admit at all. `exhibiting_yield` is
    tighter and is the number that actually governs whether a course can be built — a
    sentence inside the vocabulary that demonstrates no unit's grammar concept fills no
    slot. `selection_yield` is how many were used, which is bounded above by the number
    of slots and says nothing about the corpus.
    """
    admissible = index.ready()
    report.admissible = len(admissible)
    concept_ids = {str(unit["grammar_concept"]) for unit in units}
    report.exhibiting = sum(
        1
        for candidate in admissible
        if any(exhibited(candidate, concept_id) for concept_id in concept_ids)
    )
    report.selected_distinct = len(uses_per_course)
    total = len(candidates)
    if total:
        report.ledger_yield = report.admissible / total
        report.exhibiting_yield = report.exhibiting / total
        report.selection_yield = report.selected_distinct / total
    report.within_prediction = PREDICTED_YIELD_MIN <= report.ledger_yield <= PREDICTED_YIELD_MAX


# ---------------------------------------------------------------------------
# The stage
# ---------------------------------------------------------------------------


@register_stage(
    "g4",
    reads=("ingested_sentence", "analysed_sentence", "unit_assignment"),
    writes=("selected_item",),
)
def select_items(ctx: StageContext) -> StageResult:
    """Read g0/g1/g3; write `g4/selected.jsonl` including every gap."""
    require_successful(ctx.lang, ["g0", "g1", "g3"])
    units = list(read_records("unit_assignment", lang=ctx.lang))
    candidates, census = build_candidates(
        read_records("ingested_sentence", lang=ctx.lang),
        read_records("analysed_sentence", lang=ctx.lang),
    )
    curriculum = load_curriculum(ctx.lang)

    result = select(units, candidates, curriculum.concepts, census)
    written = write_records("selected_item", result.items, lang=ctx.lang)

    ctx.entry.record_output("selected_item")
    ctx.entry.read = census["ingested"]
    ctx.entry.written = written
    ctx.entry.rejected = census["not_shippable"] + census["wrong_length"]
    ctx.entry.note(
        curriculum=str(curriculum_path(ctx.lang).name),
        **result.report.as_notes(),
    )

    report = result.report
    if report.gap_fraction > MAX_GAP_FRACTION:
        return StageResult(
            ok=False,
            message=(
                f"{report.gaps}/{report.slots} slots ({report.gap_fraction:.0%}) are gaps, "
                f"over the {MAX_GAP_FRACTION:.0%} ceiling. G5 is an authoring stage with a "
                f"budget, not a way to make a thin corpus look full."
            ),
            detail=report.as_notes(),
        )
    if report.cross_unit_repeat_fraction > CROSS_UNIT_REPEAT_CEILING:
        return StageResult(
            ok=False,
            message=(
                f"{report.cross_unit_repeat_fraction:.1%} of filled slots reuse a sentence "
                f"from an earlier unit, over the {CROSS_UNIT_REPEAT_CEILING:.0%} ceiling (V9)."
            ),
            detail=report.as_notes(),
        )
    return StageResult(
        ok=True,
        message=(
            f"{report.filled} filled, {report.gaps} gaps, ledger yield "
            f"{report.ledger_yield:.1%} of {census['candidates']} short candidates"
        ),
        detail=report.as_notes(),
    )
