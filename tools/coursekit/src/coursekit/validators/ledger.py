"""V1-V4 and V9 — the ledger validators, and therefore INV-PACK-06.

`INV-PACK-06` is one claim: **V1-V4 pass at 100% on the built pack.** Everything in this
module is an assertion about the ledger G3 and G4 produce, which is why it is owned by the
lane that produces it rather than by a validator lane that would have to guess at it.

| Id | The property                                                              |
| -- | ------------------------------------------------------------------------- |
| V1 | No lemma appears before its introduction unit — lemma-level, never surface |
| V2 | At most one new lemma-or-inflection per exercise; K new lemmas per lesson  |
| V3 | Every introduced lemma re-appears at least N times within K lessons       |
| V4 | Tag soundness and coverage: tags are present; target lexemes appear       |
| V9 | No duplicate sentence within a unit; cross-unit repeats under the ceiling  |

### Lemma-level, never surface token

V1's parenthesis is the whole rule. A surface-token ledger passes on Spanish by accident
and breaks silently on every inflected and agglutinative language: `hablo` and `hablas`
are one lemma and two surfaces, and a ledger that counts surfaces has already taught a
word it thinks it has not. So these checks read `analysed_sentence.lemmas`, and fall back
to `item_tags.lemmas` only for an exercise with no corpus sentence behind it (a
G5-authored item before G6 has analysed it).

INV-PACK-06's second clause — "Japanese runs the ledger on Mode-A segmentation" — is
ENFORCED by `_check_segmentation` rather than assumed. Under SudachiPy Mode C a compound
is one token, so V1 and V2 pass *vacuously* while several unseen morphemes reach the
learner (EC-PACK-07). A ledger on the wrong mode is blocking, with no gap-aware softening:
it is not an unfinished pack, it is a pack whose validation means nothing.

### Why some findings are warnings before G5 has run

A unit whose corpus could not fill every slot carries **gap** rows: `sentence_id: null`,
`gap: true`, waiting for G5. Until G5 fills them, "this target lexeme appears in no
exercise" and "this lemma is under-recycled" are statements about an unfinished pack, and
reporting them as blocking would mean the suite can only ever be green after the last
stage. So a shortfall in a unit that still has gap slots is a **warning naming the gap
count**, and the same shortfall in a unit with no gaps left — a finished pack — is
**blocking**. Nothing is suppressed either way: the finding is always printed.

The one thing that is a warning for a different reason is V2's inflection half. See
`config/g4.py::MAX_NEW_INFLECTIONS_PER_EXERCISE`: the frozen `exercise` record carries no
morphology, so the check reaches only corpus-sourced items, and a blocking rule that
silently does not apply to half the pack is worse than a warning that says what it saw.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from ..artifacts import read_records
from ..config.g3 import RECYCLE_MIN_OCCURRENCES, RECYCLE_WINDOW_LESSONS
from ..config.g4 import (
    CROSS_UNIT_REPEAT_CEILING,
    LEDGER_EXCLUDED_POS,
    LEDGER_SPLIT_MODE,
    MAX_NEW_INFLECTIONS_PER_EXERCISE,
    MAX_NEW_LEMMAS_PER_EXERCISE,
    MAX_NEW_LEMMAS_PER_LESSON,
    MAX_USES_PER_SENTENCE_PER_UNIT,
)
from ..runlog import require_successful
from . import Finding, ValidatorContext, register_validator

__all__ = [
    "LEDGER_CHECKS",
    "Ledger",
    "build_ledger",
    "check_v1",
    "check_v2",
    "check_v3",
    "check_v4",
    "check_v9",
    "load_ledger",
    "run_ledger_checks",
]


# ---------------------------------------------------------------------------
# The ledger, assembled from what the stages wrote
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Ledger:
    """Everything V1-V4 and V9 read, joined once so five validators agree on the facts."""

    lang: str
    units: tuple[Mapping[str, Any], ...]
    exercises: tuple[Mapping[str, Any], ...]
    #: lemma -> the unit before which it may never appear. G3's decision.
    introduction_unit: dict[str, int]
    #: unit index -> what that unit promised to teach.
    target_lemmas: dict[int, tuple[str, ...]]
    #: unit index -> the unit's grammar concept.
    concept_of: dict[int, str]
    #: unit index -> slots G4 could not fill and handed to G5.
    gaps: dict[int, int]
    #: sentence id -> the lemmas actually in it (G1's answer, not the tags').
    lemmas_of: dict[str, frozenset[str]]
    #: sentence id -> (lemma, morph) pairs, for V2's inflection half.
    forms_of: dict[str, frozenset[tuple[str, str]]] = field(default_factory=dict)
    #: The segmentation modes the analysed rows were produced with (EC-PACK-07). A set
    #: rather than one value: a ledger assembled from two runs of different adapters is
    #: exactly the mixture V2 must refuse, and a single field would hide it.
    split_modes: frozenset[str | None] = frozenset()

    def content_lemmas(self, exercise: Mapping[str, Any]) -> frozenset[str]:
        """What is really in an exercise.

        G1's lemma set when the exercise came from a corpus sentence; the D1 tags when it
        did not. V4 is the check that those two agree wherever both exist, so V1 reading
        the tags for an unanalysed item is not circular — it is the only statement of
        content that exists for it yet, and it is named as such.
        """
        sentence_id = exercise.get("source_sentence_id")
        if sentence_id and sentence_id in self.lemmas_of:
            return self.lemmas_of[str(sentence_id)]
        return frozenset(str(lemma) for lemma in exercise["item_tags"]["lemmas"])

    def content_forms(self, exercise: Mapping[str, Any]) -> frozenset[tuple[str, str]] | None:
        sentence_id = exercise.get("source_sentence_id")
        if sentence_id and sentence_id in self.forms_of:
            return self.forms_of[str(sentence_id)]
        return None

    def last_lesson(self) -> int:
        return max((int(ex["lesson_index"]) for ex in self.exercises), default=0)

    def in_course_order(self) -> list[Mapping[str, Any]]:
        return sorted(
            self.exercises,
            key=lambda ex: (int(ex["unit_index"]), int(ex["lesson_index"]), str(ex["exercise_id"])),
        )


def build_ledger(
    lang: str,
    units: Iterable[Mapping[str, Any]],
    exercises: Iterable[Mapping[str, Any]],
    *,
    analysed: Iterable[Mapping[str, Any]] = (),
    selected: Iterable[Mapping[str, Any]] = (),
) -> Ledger:
    """Join G3's units, G4's gap list, G1's analyses and G7's exercises into one view."""
    unit_rows = tuple(sorted(units, key=lambda unit: int(unit["unit_index"])))
    introduction_unit: dict[str, int] = {}
    target_lemmas: dict[int, tuple[str, ...]] = {}
    concept_of: dict[int, str] = {}
    for unit in unit_rows:
        index = int(unit["unit_index"])
        lemmas = tuple(str(lemma) for lemma in unit["target_lemmas"])
        target_lemmas[index] = lemmas
        concept_of[index] = str(unit["grammar_concept"])
        for lemma in lemmas:
            introduction_unit.setdefault(lemma, index)

    gaps: dict[int, int] = {index: 0 for index in target_lemmas}
    for item in selected:
        if item["gap"]:
            index = int(item["unit_index"])
            gaps[index] = gaps.get(index, 0) + 1

    lemmas_of: dict[str, frozenset[str]] = {}
    forms_of: dict[str, frozenset[tuple[str, str]]] = {}
    split_modes: set[str | None] = set()
    for row in analysed:
        sentence_id = str(row["sentence_id"])
        mode = row.get("adapter", {}).get("split_mode")
        split_modes.add(str(mode) if mode is not None else None)
        # Punctuation is not a ledger item. Counting it makes every sentence carry a
        # lemma no curriculum introduces, which reads as a V1 failure on every row.
        items = [
            token for token in row["tokens"] if str(token["pos"]) not in LEDGER_EXCLUDED_POS
        ]
        not_items = {
            str(token["lemma"])
            for token in row["tokens"]
            if str(token["pos"]) in LEDGER_EXCLUDED_POS
        }
        lemmas_of[sentence_id] = frozenset(str(lemma) for lemma in row["lemmas"]) - not_items
        forms_of[sentence_id] = frozenset(
            (str(token["lemma"]), str(token.get("morph", ""))) for token in items
        )

    return Ledger(
        lang=lang,
        units=unit_rows,
        exercises=tuple(exercises),
        introduction_unit=introduction_unit,
        target_lemmas=target_lemmas,
        concept_of=concept_of,
        gaps=gaps,
        lemmas_of=lemmas_of,
        forms_of=forms_of,
        split_modes=frozenset(split_modes),
    )


def load_ledger(lang: str) -> Ledger:
    """Read the ledger out of a run directory. Raises if a stage it needs never ran."""
    require_successful(lang, ["g3", "g4", "g7"])
    return build_ledger(
        lang,
        read_records("unit_assignment", lang=lang),
        read_records("exercise", lang=lang),
        analysed=read_records("analysed_sentence", lang=lang),
        selected=read_records("selected_item", lang=lang),
    )


def _severity(ledger: Ledger, unit_index: int) -> tuple[str, str]:
    """Blocking on a finished unit; a warning while G5 still owes it slots."""
    outstanding = ledger.gaps.get(unit_index, 0)
    if outstanding:
        return "warning", f" ({outstanding} gap slot(s) still with G5)"
    return "blocking", ""


# ---------------------------------------------------------------------------
# V1 — nothing before its unit
# ---------------------------------------------------------------------------


def check_v1(ledger: Ledger) -> list[Finding]:
    """No lemma appears in any exercise before its introduction unit."""
    findings: list[Finding] = []
    for exercise in ledger.in_course_order():
        unit_index = int(exercise["unit_index"])
        for lemma in sorted(ledger.content_lemmas(exercise)):
            introduced = ledger.introduction_unit.get(lemma)
            if introduced is None:
                findings.append(
                    Finding(
                        validator_id="V1",
                        severity="blocking",
                        message=(
                            f"{lemma!r} appears in unit {unit_index} and is introduced by no "
                            f"unit at all — it is never taught, only used."
                        ),
                        subject=str(exercise["exercise_id"]),
                        detail={"lemma": lemma, "unit_index": unit_index},
                    )
                )
            elif introduced > unit_index:
                findings.append(
                    Finding(
                        validator_id="V1",
                        severity="blocking",
                        message=(
                            f"{lemma!r} appears in unit {unit_index} but is not introduced "
                            f"until unit {introduced}."
                        ),
                        subject=str(exercise["exercise_id"]),
                        detail={
                            "lemma": lemma,
                            "unit_index": unit_index,
                            "introduction_unit": introduced,
                        },
                    )
                )
    return findings


# ---------------------------------------------------------------------------
# V2 — the new-item rate
# ---------------------------------------------------------------------------


def _check_segmentation(ledger: Ledger) -> list[Finding]:
    """EC-PACK-07: the ledger must be built on the segmentation its language requires.

    This is the second clause of INV-PACK-06 — "Japanese runs the ledger on Mode-A
    segmentation" — and it is a *precondition* of V2 rather than an extra rule. Under
    SudachiPy Mode C, `外国人観光客` is one token, so V2 counts one new item and passes
    while three unseen morphemes go in front of the learner. The failure leaves no trace
    in any count: every number V2 prints is smaller and every one of them is green.

    So the mode is checked positively, per language, and a violation is BLOCKING with no
    gap-aware softening: a pack built on the wrong segmentation is not an unfinished pack,
    it is a pack whose validation means nothing. A language with no entry in
    `LEDGER_SPLIT_MODE` has no modes and is expected to carry `split_mode: null`.
    """
    required = LEDGER_SPLIT_MODE.get(ledger.lang)
    if not ledger.split_modes:
        return []  # nothing analysed; V4 and the stage gates own the empty-pack case
    wrong = sorted(
        str(mode) for mode in ledger.split_modes if (mode or None) != required
    )
    if not wrong:
        return []
    return [
        Finding(
            validator_id="V2",
            severity="blocking",
            message=(
                f"the {ledger.lang} ledger was built on segmentation "
                f"{', '.join(wrong)} but requires "
                f"{required or 'none (this adapter has no modes)'} (EC-PACK-07). "
                f"On the wrong mode a compound counts as one new item while several "
                f"morphemes are introduced, so V1 and V2 pass VACUOUSLY."
            ),
            subject=ledger.lang,
            detail={"required": required, "found": wrong},
        )
    ]


def check_v2(ledger: Ledger) -> list[Finding]:
    """At most one new lemma-or-inflection per exercise; at most K new lemmas per lesson.

    **New** means: this exercise is the first one in course order to carry the lemma, AND
    the lemma's introduction unit is this exercise's own unit. The second clause is what
    keeps the rule about the learner rather than about the corpus. A lemma an earlier unit
    introduced is known by the time this unit runs — the ledger says so — whether or not
    some exercise in that unit happened to carry it; if none did, that is a V4 coverage
    finding with a gap slot against it, not five simultaneous new items here. Without the
    clause the rule is unsatisfiable from a corpus at all: at the start of a course nothing
    has been carried yet, every sentence looks like five new items at once, and the only
    ledger that passes is the empty one.

    It also refuses to run at all on the wrong segmentation — see `_check_segmentation`.
    """
    findings: list[Finding] = _check_segmentation(ledger)
    seen_lemmas: set[str] = set()
    seen_forms: set[tuple[str, str]] = set()
    per_lesson: dict[tuple[int, int], set[str]] = {}

    for exercise in ledger.in_course_order():
        unit_index = int(exercise["unit_index"])
        key = (unit_index, int(exercise["lesson_index"]))
        lemmas = ledger.content_lemmas(exercise)
        first_here = lemmas - seen_lemmas
        new_lemmas = {
            lemma
            for lemma in first_here
            if ledger.introduction_unit.get(lemma, unit_index) == unit_index
        }
        if len(new_lemmas) > MAX_NEW_LEMMAS_PER_EXERCISE:
            findings.append(
                Finding(
                    validator_id="V2",
                    severity="blocking",
                    message=(
                        f"{len(new_lemmas)} new lemmas in one exercise "
                        f"({', '.join(sorted(new_lemmas))}); the budget is "
                        f"{MAX_NEW_LEMMAS_PER_EXERCISE}."
                    ),
                    subject=str(exercise["exercise_id"]),
                    detail={"new_lemmas": sorted(new_lemmas)},
                )
            )

        forms = ledger.content_forms(exercise)
        if forms is not None:
            new_forms = {
                form for form in forms if form not in seen_forms and form[0] in seen_lemmas
            }
            if len(new_forms) > MAX_NEW_INFLECTIONS_PER_EXERCISE:
                findings.append(
                    Finding(
                        validator_id="V2",
                        severity="warning",
                        message=(
                            f"{len(new_forms)} new inflections of already-known lemmas in one "
                            f"exercise ({', '.join(sorted(lemma for lemma, _ in new_forms))}); "
                            f"the budget is {MAX_NEW_INFLECTIONS_PER_EXERCISE}. Not blocking: "
                            f"the exercise record carries no morphology, so this reaches only "
                            f"corpus-sourced items."
                        ),
                        subject=str(exercise["exercise_id"]),
                    )
                )
            seen_forms |= forms

        seen_lemmas |= first_here
        per_lesson.setdefault(key, set()).update(new_lemmas)

    for (unit_index, lesson_index), new in sorted(per_lesson.items()):
        if len(new) > MAX_NEW_LEMMAS_PER_LESSON:
            findings.append(
                Finding(
                    validator_id="V2",
                    severity="blocking",
                    message=(
                        f"lesson {lesson_index} of unit {unit_index} introduces {len(new)} new "
                        f"lemmas; the published budget is {MAX_NEW_LEMMAS_PER_LESSON}."
                    ),
                    subject=f"unit {unit_index} lesson {lesson_index}",
                    detail={"new_lemmas": sorted(new)},
                )
            )
    return findings


# ---------------------------------------------------------------------------
# V3 — recycling
# ---------------------------------------------------------------------------


def check_v3(ledger: Ledger) -> list[Finding]:
    """Every introduced lemma re-appears at least N times within K lessons.

    This is the property a shuffled deck cannot have (`01` F14). Two exemptions, both
    named in the finding rather than silent: a lemma introduced too near the end of the
    course has no K-lesson window to be recycled in, which is an end effect and reported
    as `info`; and a unit that still owes G5 gap slots gets a warning instead of a block.
    """
    findings: list[Finding] = []
    appearances: dict[str, list[int]] = {}
    for exercise in ledger.in_course_order():
        lesson_index = int(exercise["lesson_index"])
        for lemma in ledger.content_lemmas(exercise):
            appearances.setdefault(lemma, []).append(lesson_index)

    last = ledger.last_lesson()
    for lemma, lessons in sorted(appearances.items()):
        introduced_at = lessons[0]
        window_end = introduced_at + RECYCLE_WINDOW_LESSONS
        recycled = sum(1 for lesson in lessons[1:] if lesson <= window_end)
        if recycled >= RECYCLE_MIN_OCCURRENCES:
            continue
        unit_index = ledger.introduction_unit.get(lemma, 0)
        if window_end > last:
            findings.append(
                Finding(
                    validator_id="V3",
                    severity="info",
                    message=(
                        f"{lemma!r} is introduced in lesson {introduced_at} and the course ends "
                        f"at lesson {last}, so its {RECYCLE_WINDOW_LESSONS}-lesson recycling "
                        f"window does not exist yet. End effect, not a defect."
                    ),
                    subject=lemma,
                )
            )
            continue
        severity, note = _severity(ledger, unit_index)
        findings.append(
            Finding(
                validator_id="V3",
                severity=severity,  # type: ignore[arg-type]
                message=(
                    f"{lemma!r} re-appears {recycled} time(s) within "
                    f"{RECYCLE_WINDOW_LESSONS} lessons of its introduction (lesson "
                    f"{introduced_at}); V3 needs {RECYCLE_MIN_OCCURRENCES}{note}."
                ),
                subject=lemma,
                detail={"unit_index": unit_index, "recycled": recycled},
            )
        )
    return findings


# ---------------------------------------------------------------------------
# V4 — tag soundness and coverage
# ---------------------------------------------------------------------------


def check_v4(ledger: Ledger) -> list[Finding]:
    """Every D1 tag is really in the exercise, and every unit teaches what it promised.

    D1's stated cost is "a wrong tag silently corrupts the memory model": FSRS schedules
    an item by its tags, so an exercise tagged with a lemma it does not contain trains a
    review the learner never saw and a lemma with no exercise is never scheduled at all.
    Both halves are here because either one alone reads as green.
    """
    findings: list[Finding] = []
    covered: dict[int, set[str]] = {}

    for exercise in ledger.in_course_order():
        unit_index = int(exercise["unit_index"])
        tags = {str(lemma) for lemma in exercise["item_tags"]["lemmas"]}
        sentence_id = exercise.get("source_sentence_id")
        if sentence_id and sentence_id in ledger.lemmas_of:
            present = ledger.lemmas_of[str(sentence_id)]
            unsound = tags - present
            if unsound:
                findings.append(
                    Finding(
                        validator_id="V4",
                        severity="blocking",
                        message=(
                            f"tagged with {', '.join(sorted(unsound))}, which the exercise does "
                            f"not contain."
                        ),
                        subject=str(exercise["exercise_id"]),
                        detail={"unsound": sorted(unsound)},
                    )
                )
        elif sentence_id:
            findings.append(
                Finding(
                    validator_id="V4",
                    severity="blocking",
                    message=(
                        f"names source sentence {sentence_id!r}, which no analysed record "
                        f"describes. A dangling source is an untaggable exercise."
                    ),
                    subject=str(exercise["exercise_id"]),
                )
            )

        concepts = {str(concept) for concept in exercise["item_tags"]["grammar_concepts"]}
        stray = concepts - {ledger.concept_of.get(unit_index, "")}
        if stray:
            findings.append(
                Finding(
                    validator_id="V4",
                    severity="blocking",
                    message=(
                        f"tagged with grammar concept(s) {', '.join(sorted(stray))}, which unit "
                        f"{unit_index} does not teach."
                    ),
                    subject=str(exercise["exercise_id"]),
                )
            )
        covered.setdefault(unit_index, set()).update(ledger.content_lemmas(exercise))

    for unit_index, promised in sorted(ledger.target_lemmas.items()):
        missing = [lemma for lemma in promised if lemma not in covered.get(unit_index, set())]
        if not missing:
            continue
        severity, note = _severity(ledger, unit_index)
        findings.append(
            Finding(
                validator_id="V4",
                severity=severity,  # type: ignore[arg-type]
                message=(
                    f"unit {unit_index} promises {len(promised)} target lexeme(s) and "
                    f"{len(missing)} of them appear in no exercise: "
                    f"{', '.join(missing[:12])}{'…' if len(missing) > 12 else ''}{note}."
                ),
                subject=f"unit {unit_index}",
                detail={"missing": missing},
            )
        )
    return findings


# ---------------------------------------------------------------------------
# V9 — repetition
# ---------------------------------------------------------------------------


def check_v9(ledger: Ledger) -> list[Finding]:
    """No duplicate sentence within a unit; cross-unit repeats under the ceiling."""
    findings: list[Finding] = []
    per_unit: dict[int, dict[str, int]] = {}
    first_unit: dict[str, int] = {}
    repeats = 0
    sourced = 0

    for exercise in ledger.in_course_order():
        sentence_id = exercise.get("source_sentence_id")
        if not sentence_id:
            continue
        sentence_id = str(sentence_id)
        sourced += 1
        unit_index = int(exercise["unit_index"])
        counts = per_unit.setdefault(unit_index, {})
        counts[sentence_id] = counts.get(sentence_id, 0) + 1
        if counts[sentence_id] > MAX_USES_PER_SENTENCE_PER_UNIT:
            findings.append(
                Finding(
                    validator_id="V9",
                    severity="blocking",
                    message=(
                        f"sentence {sentence_id} is used {counts[sentence_id]} times inside unit "
                        f"{unit_index}; the limit is {MAX_USES_PER_SENTENCE_PER_UNIT}."
                    ),
                    subject=str(exercise["exercise_id"]),
                )
            )
        if sentence_id in first_unit and first_unit[sentence_id] != unit_index:
            repeats += 1
        first_unit.setdefault(sentence_id, unit_index)

    fraction = repeats / sourced if sourced else 0.0
    if fraction > CROSS_UNIT_REPEAT_CEILING:
        findings.append(
            Finding(
                validator_id="V9",
                severity="blocking",
                message=(
                    f"{fraction:.1%} of corpus-sourced exercises reuse a sentence from an "
                    f"earlier unit ({repeats}/{sourced}); the ceiling is "
                    f"{CROSS_UNIT_REPEAT_CEILING:.0%}."
                ),
                subject=f"{ledger.lang} course",
                detail={"repeats": repeats, "sourced": sourced},
            )
        )
    return findings


#: The five checks this module owns, by validator id. Used by the registered validators
#: below and by the INV-PACK-06 test, so the test cannot drift from what CI runs.
LEDGER_CHECKS = {
    "V1": check_v1,
    "V2": check_v2,
    "V3": check_v3,
    "V4": check_v4,
    "V9": check_v9,
}


def run_ledger_checks(ledger: Ledger, ids: Sequence[str] | None = None) -> list[Finding]:
    """Run several checks over one ledger. The shape INV-PACK-06's test asserts on."""
    findings: list[Finding] = []
    for validator_id in ids or sorted(LEDGER_CHECKS):
        findings.extend(LEDGER_CHECKS[validator_id](ledger))
    return findings


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def _registered(validator_id: str):
    def run(ctx: ValidatorContext) -> list[Finding]:
        ledger = load_ledger(ctx.lang)
        findings = LEDGER_CHECKS[validator_id](ledger)
        ctx.entry.note(
            units=len(ledger.units),
            exercises=len(ledger.exercises),
            lemmas_in_ledger=len(ledger.introduction_unit),
            gap_slots=sum(ledger.gaps.values()),
            blocking=sum(1 for finding in findings if finding.severity == "blocking"),
        )
        return findings

    run.__name__ = f"check_{validator_id.lower()}_registered"
    return run


register_validator("V1")(_registered("V1"))
register_validator("V2")(_registered("V2"))
register_validator("V3")(_registered("V3"))
register_validator("V4")(_registered("V4"))
register_validator("V9")(_registered("V9"))
