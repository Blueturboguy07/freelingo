"""The shape taxonomy: routing an item into an exercise shape, and back out again.

`config/g7.py` holds the table. This holds the three things done to it:

1. **Routing** — `route` decides whether an item of a given focus may wear a given
   shape. It is where INV-PACK-50 is enforced *by construction*: a `grammar_concept` or
   `script_unit` focus can never reach a lexeme-quoting shape, because the router
   refuses before a draft exists rather than a validator objecting after one does.
2. **Projection** — `ExerciseDraft.to_record()` writes the frozen `exercise` artefact.
   The contract has no `shape` field (`additionalProperties: false`), so the shape has
   to survive the trip inside `type` + the prompt's instruction line.
3. **Recovery** — `shape_of_record` reads it back. Every draft round-trips, and
   `tests/test_g7_expand.py` asserts that over `PROPERTY_RUNS` generated drafts,
   because "recoverable in principle" and "recoverable" are different properties.

## Why the NEW WORD half of INV-PACK-50 is checkable at all

The invariant has two clauses: no grammar-concept or script item in a lexeme-quoting
prompt, and neither ever wears the NEW WORD pill. The artefact contract carries no
pill field, so the second clause looks unverifiable from a record.

It is verifiable, because of a structural fact this module pins:
`{s for s in SHAPES if s.new_word_eligible}` is a subset of
`{s for s in SHAPES if s.quotes_lexeme}`. Every shape that can wear the pill quotes a
lexeme, so a record that passes the first clause cannot fail the second. That subset
relation is asserted by `assert_pill_shapes_quote_lexemes()` and by a test, so the
argument cannot rot silently the day somebody makes `fill_in_the_blank` pill-eligible.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from ..artifacts import validate_record
from ..config import ARTIFACT_SCHEMA_VERSION, EXERCISE_TYPES, LANGUAGES
from ..config.g7 import (
    CURRENT_PHASE,
    FORBIDDEN_SHAPE_IDS,
    FORBIDDEN_SHAPE_REASON,
    L1_LANGUAGE_NAME,
    LANGUAGE_NAME,
    PHASE_ORDER,
    SHAPES,
    ExerciseShape,
    Focus,
)

__all__ = [
    "ExerciseDraft",
    "ForbiddenShape",
    "RoutingError",
    "ShapeNotAvailable",
    "UnknownShape",
    "assert_pill_shapes_quote_lexemes",
    "forbidden_shape_guard",
    "instruction_for",
    "mistake_queue_eligible",
    "missable_shapes",
    "prompt_for",
    "route",
    "shape",
    "shape_ids",
    "shape_of_record",
    "shapes_for_focus",
]


class UnknownShape(KeyError):
    """A shape id nobody declared."""


class ForbiddenShape(ValueError):
    """A shape that is out of scope by ruling. S043 is the only one."""


class ShapeNotAvailable(ValueError):
    """A declared shape whose phase has not arrived. Never a silent skip."""


class RoutingError(ValueError):
    """An item may not wear this shape. INV-PACK-50's refusal."""


_BY_ID: dict[str, ExerciseShape] = {item.id: item for item in SHAPES}

#: `{hint}` / `{lang}` slots become named capture groups so a rendered instruction can
#: be read back. Built once; keyed by (type, shape id).
_INSTRUCTION_PATTERNS: dict[str, re.Pattern[str]] = {}


def _pattern_for(shape_id: str) -> re.Pattern[str]:
    if shape_id not in _INSTRUCTION_PATTERNS:
        template = _BY_ID[shape_id].instruction
        parts: list[str] = []
        cursor = 0
        for match in re.finditer(r"\{(hint|lang)\}", template):
            parts.append(re.escape(template[cursor : match.start()]))
            parts.append(f"(?P<{match.group(1)}>.+)")
            cursor = match.end()
        parts.append(re.escape(template[cursor:]))
        _INSTRUCTION_PATTERNS[shape_id] = re.compile("^" + "".join(parts) + "$")
    return _INSTRUCTION_PATTERNS[shape_id]


# ---------------------------------------------------------------------------
# Lookup
# ---------------------------------------------------------------------------


def shape_ids() -> tuple[str, ...]:
    """Every declared shape id, in product-map order."""
    return tuple(item.id for item in SHAPES)


def shape(shape_id: str) -> ExerciseShape:
    """One shape, or a refusal that says which kind of absence this is.

    Three different absences with three different fixes, and collapsing them into one
    `KeyError` is how S043 comes back as a bug report about a typo.
    """
    forbidden_shape_guard(shape_id)
    if shape_id not in _BY_ID:
        raise UnknownShape(
            f"no exercise shape {shape_id!r}; config/g7.py declares "
            f"{', '.join(shape_ids())}"
        )
    return _BY_ID[shape_id]


def forbidden_shape_guard(shape_id: str) -> None:
    """Raise `ForbiddenShape` for a shape that is out of v1 by ruling.

    Called by `shape()` and again at the top of `route()`. Two call sites rather than
    one because the interesting way S043 gets built is not somebody calling `shape()`:
    it is somebody constructing a draft directly and skipping the lookup entirely.
    """
    if shape_id in FORBIDDEN_SHAPE_IDS:
        raise ForbiddenShape(f"{shape_id!r}: {FORBIDDEN_SHAPE_REASON}")


def shapes_for_focus(focus: Focus, *, phase: str = CURRENT_PHASE) -> tuple[ExerciseShape, ...]:
    """Every shape an item of this focus may wear in this phase.

    This is INV-PACK-50 read forwards: the generator asks what it *may* emit rather
    than emitting and being corrected, so a grammar concept is never offered
    picture-select in the first place.
    """
    limit = PHASE_ORDER.index(phase)
    return tuple(
        item
        for item in SHAPES
        if focus in item.focuses
        and PHASE_ORDER.index(item.available_from) <= limit
        and not (item.quotes_lexeme and focus != "lexeme")
    )


def missable_shapes() -> tuple[str, ...]:
    """The shapes whose wrong answer can queue a mistake: exactly the punitive ones.

    Derived from the table, never a second hand-written list. INV-PACK-07's second
    clause — "non-punitive types are excluded from the mistake queue by construction" —
    is a statement about there being no other source for this set.
    """
    return tuple(item.id for item in SHAPES if item.punitive)


def mistake_queue_eligible(shape_id: str) -> bool:
    """May a wrong answer on this shape enter the mistake queue?

    `[DEPART D-SKIPSPEAK]` and EC-MIS-11: a non-punitive replay can never clear a
    mistake, so a non-punitive shape must never create one either.
    """
    return shape(shape_id).punitive


def assert_pill_shapes_quote_lexemes() -> None:
    """The structural fact the record-level INV-PACK-50 check leans on.

    Raises rather than returns, and is called from `route()`, so the relation is
    re-checked on every routing decision in every build — not only when a test runs.
    """
    pill = {item.id for item in SHAPES if item.new_word_eligible}
    quoting = {item.id for item in SHAPES if item.quotes_lexeme}
    if not pill <= quoting:
        raise RoutingError(
            "INV-PACK-50: the NEW WORD-eligible shapes "
            f"({', '.join(sorted(pill))}) must stay a subset of the "
            f"lexeme-quoting shapes ({', '.join(sorted(quoting))}). A record-level "
            "validator can only discharge the pill clause while that holds."
        )


# ---------------------------------------------------------------------------
# Routing — INV-PACK-50 by construction
# ---------------------------------------------------------------------------


def route(shape_id: str, focus: Focus, *, phase: str = CURRENT_PHASE) -> ExerciseShape:
    """Refuse or return. The one door every draft goes through.

    EC-PACK-47, verbatim: "grammar-concept and `script_unit` items introduce through
    the tips interstitial, never picture-select and never a lexeme-quoting prompt, and
    never wear the NEW WORD pill. Otherwise every counter and particle produces a
    malformed prompt."
    """
    forbidden_shape_guard(shape_id)
    assert_pill_shapes_quote_lexemes()
    chosen = shape(shape_id)

    if PHASE_ORDER.index(chosen.available_from) > PHASE_ORDER.index(phase):
        raise ShapeNotAvailable(
            f"{shape_id!r} is available from {chosen.available_from}; this build is "
            f"{phase}. It is declared so the shape table covers every coarse type, "
            "and unreachable until its phase lands."
        )

    if chosen.quotes_lexeme and focus != "lexeme":
        raise RoutingError(
            f"INV-PACK-50: {shape_id!r} ({chosen.screen}) quotes a standalone lexeme "
            f"and a {focus!r} item may never be routed into it (EC-PACK-47). Introduce "
            "it through the tips interstitial or a non-quoting shape: "
            f"{', '.join(item.id for item in shapes_for_focus(focus, phase=phase))}."
        )

    if focus not in chosen.focuses:
        raise RoutingError(
            f"{shape_id!r} carries {', '.join(chosen.focuses)} items, not {focus!r}."
        )

    return chosen


# ---------------------------------------------------------------------------
# Rendering the instruction
# ---------------------------------------------------------------------------


def instruction_for(shape_id: str, *, lang: str, hint: str | None = None) -> str:
    """The rendered instruction line. Curly quotes; `{lang}` is the *answer* language.

    `{lang}` naming the language the learner writes IN is what separates
    `word_bank_forward` from `word_bank_reverse` on the wire: both carry
    `Write this in {lang}`, and only the substituted value differs.
    """
    chosen = shape(shape_id)
    template = chosen.instruction
    if "{lang}" in template:
        if lang not in LANGUAGES:
            raise ValueError(f"unknown language {lang!r}")
        answer_language = (
            L1_LANGUAGE_NAME if chosen.direction == "l2_to_l1" else LANGUAGE_NAME[lang]
        )
        template = template.replace("{lang}", answer_language)
    if "{hint}" in template:
        if not hint:
            raise ValueError(
                f"{shape_id!r} quotes a lexeme and needs a hint; none was given"
            )
        if "\n" in hint:
            raise ValueError("a hint may not contain a newline; it would split the prompt")
        template = template.replace("{hint}", hint)
    return template


def prompt_for(shape_id: str, *, lang: str, body: str, hint: str | None = None) -> str:
    """`<instruction>\\n<body>`. The whole of the prompt encoding.

    One newline, one instruction line. `body` is whatever the shape renders under it —
    the source sentence, the chat lines, the gapped target — and may contain newlines
    of its own, because only the FIRST is structural.
    """
    return instruction_for(shape_id, lang=lang, hint=hint) + "\n" + body


def shape_of_record(record: dict[str, Any]) -> ExerciseShape:
    """Recover the shape from a written `exercise` record.

    The frozen contract has no `shape` field, so this is the only way back. It matches
    on `(type, instruction template)` and then, for the two `word_bank` shapes that
    share a template, on the substituted `{lang}`.
    """
    instruction = record["prompt"].split("\n", 1)[0]
    candidates = [item for item in SHAPES if item.type == record["type"]]
    for candidate in candidates:
        match = _pattern_for(candidate.id).match(instruction)
        if match is None:
            continue
        if "lang" in (match.groupdict() or {}):
            reverse = match.group("lang") == L1_LANGUAGE_NAME
            if reverse != (candidate.direction == "l2_to_l1"):
                continue
        return candidate
    raise UnknownShape(
        f"no shape of type {record['type']!r} renders the instruction "
        f"{instruction!r}. Either the prompt was built without prompt_for(), or a "
        "shape's instruction template changed without its consumers."
    )


# ---------------------------------------------------------------------------
# The draft, and its projection onto the frozen record
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ExerciseDraft:
    """What G7 builds before it is flattened onto the artefact contract.

    Everything the contract cannot carry lives here and is asserted here: the shape,
    the focus, the NEW WORD pill, whether the item is missable. `to_record()` drops
    those fields, which is exactly why the draft-level gates in
    `validators/exercise.py` run over drafts as well as over records.
    """

    lang: str
    exercise_id: str
    unit_index: int
    lesson_index: int
    shape_id: str
    focus: Focus
    instruction_hint: str | None
    body: str
    accepted_answers: tuple[str, ...]
    distractors: tuple[str, ...] = ()
    alignment: tuple[tuple[int, int], ...] = ()
    lemmas: tuple[str, ...] = ()
    grammar_concepts: tuple[str, ...] = ()
    audio_ref: str | None = None
    register: str = "neutral"
    source_sentence_id: str | None = None
    new_word_pill: bool = False
    _shape: ExerciseShape = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        chosen = route(self.shape_id, self.focus)
        object.__setattr__(self, "_shape", chosen)
        if self.new_word_pill and not chosen.new_word_eligible:
            raise RoutingError(
                f"INV-PACK-50: {self.shape_id!r} may not wear the NEW WORD pill "
                f"({chosen.screen} is not an introduction shape)."
            )
        if self.new_word_pill and self.focus != "lexeme":
            raise RoutingError(
                f"INV-PACK-50: a {self.focus!r} item never wears the NEW WORD pill "
                "(EC-PACK-47)."
            )
        if not self.accepted_answers:
            raise ValueError(
                f"{self.exercise_id}: accepted_answers is the entire tolerance budget "
                "(review R24) and may not be empty"
            )
        if not self.lemmas:
            raise ValueError(
                f"{self.exercise_id}: item_tags.lemmas is D1's join and V4 checks it "
                "against the lemmas actually present; it may not be empty"
            )
        if chosen.needs_audio and self.audio_ref is None:
            raise ValueError(
                f"{self.exercise_id}: {self.shape_id!r} renders audio and has no "
                "audio_ref; V7 would find this after the bake, which is late"
            )
        if len(self.distractors) != chosen.distractor_count:
            raise ValueError(
                f"{self.exercise_id}: {self.shape_id!r} takes exactly "
                f"{chosen.distractor_count} distractors, got {len(self.distractors)}"
            )

    @property
    def shape(self) -> ExerciseShape:
        return self._shape

    @property
    def missable(self) -> bool:
        """Can a wrong answer here queue a mistake? INV-PACK-07's left-hand side."""
        return self._shape.punitive

    @property
    def prompt(self) -> str:
        return prompt_for(
            self.shape_id, lang=self.lang, body=self.body, hint=self.instruction_hint
        )

    def to_record(self) -> dict[str, Any]:
        """The `exercise` artefact row, validated against the frozen schema."""
        if self._shape.type not in EXERCISE_TYPES:
            raise ValueError(
                f"{self.shape_id!r} projects onto type {self._shape.type!r}, which "
                f"config/base.py does not declare"
            )
        record: dict[str, Any] = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "lang": self.lang,
            "exercise_id": self.exercise_id,
            "unit_index": self.unit_index,
            "lesson_index": self.lesson_index,
            "type": self._shape.type,
            "prompt": self.prompt,
            "accepted_answers": list(self.accepted_answers),
            "distractors": list(self.distractors),
            "alignment": [list(pair) for pair in self.alignment],
            "item_tags": {
                "lemmas": list(self.lemmas),
                "grammar_concepts": list(self.grammar_concepts),
            },
            "audio_ref": self.audio_ref,
            "register": self.register,
            "source_sentence_id": self.source_sentence_id,
        }
        validate_record("exercise", record, where=f"draft {self.exercise_id}")
        return record
