"""Exercise-level validators: V5, V6, and the two G7 invariant gates.

| id | What | Owner |
|---|---|---|
| **V5** | a distractor is never an accepted answer, always shares POS, and is | this lane |
|        | never a valid alternative translation |  |
| **V6** | every accepted answer sits in the unit's declared register | this lane |
|        | (`INV-PACK-08`, the Spanish half) |  |
| **INV-PACK-07** | every missable item carries >=2 authored punitive forms, | this lane |
|        | and non-punitive shapes are excluded from the mistake queue | (no validator id) |
|        | by construction |  |
| **INV-PACK-50** | no grammar-concept or script item in a lexeme-quoting | this lane |
|        | prompt; neither ever wears the NEW WORD pill | (no validator id) |

`config/base.py::VALIDATOR_IDS` has no id for the last two, and that file belongs to
another lane, so they are exposed as functions here and run as a **stage gate** inside
G7 (`stages/g7_expand.py` refuses to write an artefact that fails them) as well as from
the tests that carry their ids. A pack that fails either never reaches `validate`. The
request for `F6`/`F7` ids is in `docs/owned/p2-g7.json`.

## What V6 does NOT do

`INV-PACK-08` has two halves. The Spanish half — every accepted answer inside the unit's
declared register — is implemented here. The Japanese half — every script variant
(kanji+okurigana, all-kana, katakana, and every alternate-okurigana headword of the same
JMdict entry, per EC-GRD-16) enumerated as a set — is **P7's**, with the characters
stage and JmdictFurigana. It is not half-implemented here: V6 returns a *blocking*
finding for any language outside `V6_IMPLEMENTED_LANGUAGES`, because for Japanese "the
enumerated set IS the entire tolerance budget" (review R24) and a validator that cannot
check must not be the reason a pack ships.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from ..artifacts import read_records
from ..config.g7 import (
    ES_REGISTER_MARKERS,
    MIN_FORMS_PER_MISSABLE_ITEM,
    REGISTERS,
    V6_IMPLEMENTED_LANGUAGES,
    V6_UNIMPLEMENTED_MESSAGE,
)
from ..exercises.shapes import shape_of_record
from ..ledger import surface_tokens
from . import Finding, ValidatorContext, register_validator

__all__ = [
    "check_pack_07",
    "check_pack_50",
    "check_v5",
    "check_v6",
    "item_key",
    "item_keys",
    "register_of",
]


def _fold(text: str) -> str:
    """Case-folded, accent-stripped. Used only for register-marker matching."""
    decomposed = unicodedata.normalize("NFD", text.casefold())
    return "".join(char for char in decomposed if not unicodedata.combining(char))


#: Everything that can sit against a word and is not part of it. Category-based rather
#: than a hand-listed set: the previous version replaced `¿` and `?` and nothing else, so
#: a sentence ENDING in the marker (`¿Cómo está usted.`) had its marker read as `usted.`
#: and matched nothing — V6 silently missed every out-of-register answer that put the
#: pronoun last, which in Spanish is where it usually goes.
def _words(text: str) -> list[str]:
    stripped = "".join(
        " " if unicodedata.category(char).startswith(("P", "S")) else char
        for char in _fold(text)
    )
    return list(surface_tokens(stripped))


def item_keys(record: Mapping[str, Any]) -> tuple[str, ...]:
    """Which items this exercise is a form OF. Usually one; for a match, five.

    A sentence exercise carries `source_sentence_id` and is one item. Anything else is
    a lexical or conceptual drill and is a form of EVERY tag it carries — which is the
    whole of EC-MIS-04's hard case: "the left-hand lexeme is the queued mistake"
    (S033), so a five-pair match is five items' second form, not one item's only form.
    Collapsing a match into a single key would make it look like a single-form missable
    item and fail INV-PACK-07 for the wrong reason.

    Decidable from the frozen record alone, which matters: INV-PACK-07 has to hold for
    a pack somebody hands you, not only for the run that built it.
    """
    sentence_id = record.get("source_sentence_id")
    if sentence_id:
        return (f"sentence:{sentence_id}",)
    tags = record["item_tags"]
    concepts = sorted(tags["grammar_concepts"])
    if concepts:
        # No source sentence and a declared concept: the item IS the concept. The
        # frozen contract requires `lemmas` to be non-empty even here (they are the
        # lemmas the drill recycles), so the concept has to win or a grammar drill
        # would be filed under whichever word it happened to borrow.
        return tuple(f"concept:{concept}" for concept in concepts)
    return tuple(f"lexeme:{lemma}" for lemma in sorted(tags["lemmas"]))


def item_key(record: Mapping[str, Any]) -> str:
    """The first of `item_keys`. For the single-item shapes, the only one."""
    return item_keys(record)[0]


# ---------------------------------------------------------------------------
# INV-PACK-07
# ---------------------------------------------------------------------------


def check_pack_07(records: Iterable[Mapping[str, Any]]) -> list[Finding]:
    """Every item that can be missed carries >=2 authored *punitive* forms.

    EC-MIS-04 and EC-PACK-05. The forms that count are the punitive ones because
    EC-MIS-11 rules that "a non-punitive Trace replay can never clear a mistake": an
    item whose only second form is a Speak has no recycle, and the session cannot end
    with a mistake outstanding.

    The second clause — non-punitive types are excluded from the mistake queue *by
    construction* — is not checked here because there is nothing to check: eligibility
    is `shapes.mistake_queue_eligible`, which reads `ExerciseShape.punitive` off the one
    table. `tests/test_validators_exercise.py` asserts there is no second source.
    """
    punitive_shapes: dict[str, set[str]] = {}
    all_shapes: dict[str, set[str]] = {}
    subjects: dict[str, str] = {}

    for record in records:
        found = shape_of_record(dict(record))
        for key in item_keys(record):
            all_shapes.setdefault(key, set()).add(found.id)
            subjects.setdefault(key, record["exercise_id"])
            if found.punitive:
                punitive_shapes.setdefault(key, set()).add(found.id)

    findings: list[Finding] = []
    for key, shapes in sorted(punitive_shapes.items()):
        if len(shapes) >= MIN_FORMS_PER_MISSABLE_ITEM:
            continue
        non_punitive = sorted(all_shapes[key] - shapes)
        findings.append(
            Finding(
                validator_id="INV-PACK-07",
                severity="blocking",
                message=(
                    f"item {key} can be missed ({', '.join(sorted(shapes))}) and has "
                    f"{len(shapes)} authored punitive form(s); "
                    f"{MIN_FORMS_PER_MISSABLE_ITEM} are required so the mistake has a "
                    "recycle to schedule (EC-MIS-04). Non-punitive forms present: "
                    f"{', '.join(non_punitive) or 'none'} — none of them can clear a "
                    "mistake (EC-MIS-11)."
                ),
                subject=subjects[key],
                detail={"item": key, "punitive_forms": sorted(shapes)},
            )
        )
    return findings


# ---------------------------------------------------------------------------
# INV-PACK-50
# ---------------------------------------------------------------------------


def check_pack_50(records: Iterable[Mapping[str, Any]]) -> list[Finding]:
    """No grammar concept or script unit inside a lexeme-quoting prompt.

    EC-PACK-47: "the generator introduces the bound morpheme 〜枚 through picture-select,
    whose prompt quotes a standalone word". The record-level signal is exact — the
    quoted string is in the prompt and the concept is in `item_tags.grammar_concepts` —
    so the check does not need the draft.

    The pill clause comes free: `shapes.assert_pill_shapes_quote_lexemes` pins the
    NEW WORD-eligible shapes as a subset of the lexeme-quoting ones, so a record
    that passes this check cannot be a grammar concept wearing the pill.
    """
    findings: list[Finding] = []
    for record in records:
        found = shape_of_record(dict(record))
        if not found.quotes_lexeme:
            continue
        instruction = record["prompt"].split("\n", 1)[0]
        quoted = _quoted_span(instruction)
        tags = record["item_tags"]
        concepts = {concept for concept in tags["grammar_concepts"]}
        if quoted is not None and quoted in concepts:
            findings.append(
                Finding(
                    validator_id="INV-PACK-50",
                    severity="blocking",
                    message=(
                        f"{found.screen} {found.id!r} quotes {quoted!r}, which this "
                        "item declares as a grammar concept. A grammar concept or a "
                        "script unit is introduced through the tips interstitial, "
                        "never a lexeme-quoting prompt and never with the NEW WORD "
                        "pill (EC-PACK-47)."
                    ),
                    subject=record["exercise_id"],
                    detail={"quoted": quoted, "grammar_concepts": sorted(concepts)},
                )
            )
            continue
        if quoted is not None and quoted not in set(tags["lemmas"]):
            findings.append(
                Finding(
                    validator_id="INV-PACK-50",
                    severity="blocking",
                    message=(
                        f"{found.screen} {found.id!r} quotes {quoted!r}, which is not "
                        "in this item's lemma tags. A lexeme-quoting prompt must quote "
                        "a taught lexeme; anything else is a malformed prompt."
                    ),
                    subject=record["exercise_id"],
                    detail={"quoted": quoted, "lemmas": sorted(tags["lemmas"])},
                )
            )
    return findings


def _quoted_span(instruction: str) -> str | None:
    """The text between the shipped curly quotes, if any.

    Curly, not straight: review A8 measured that every quoting instruction except
    `Translate "{word}"` ships typographic quotes, and `config/g7.py` renders them.
    """
    start = instruction.find("“")
    end = instruction.rfind("”")
    if start == -1 or end <= start:
        return None
    return instruction[start + 1 : end]


# ---------------------------------------------------------------------------
# V5
# ---------------------------------------------------------------------------


def check_v5(
    records: Iterable[Mapping[str, Any]],
    *,
    pos_of: Mapping[str, str],
) -> list[Finding]:
    """A distractor is never an accepted answer, always shares POS, never an alternative.

    `pos_of` maps a surface or lemma to its UD tag (G1/G2's output). A distractor whose
    POS is unknown is a **finding**, not a pass: V5's whole content is the POS
    agreement, and "we could not tell" reported as green is the vacuous pass this
    project keeps writing gates against.

    The third clause — not a valid alternative translation — is decided over the whole
    record set: a distractor on exercise A that is an accepted answer of exercise B
    over the same item is a string the learner can tap and be marked wrong for being
    right.
    """
    records = [dict(record) for record in records]
    accepted_by_item: dict[str, set[str]] = {}
    for record in records:
        for key in item_keys(record):
            bucket = accepted_by_item.setdefault(key, set())
            bucket.update(_normalise(answer) for answer in record["accepted_answers"])

    findings: list[Finding] = []
    unchecked = 0
    for record in records:
        keys = item_keys(record)
        siblings: set[str] = set()
        for key in keys:
            siblings |= accepted_by_item[key]
        own = {_normalise(answer) for answer in record["accepted_answers"]}
        answer_pos = _dominant_pos(record["accepted_answers"], pos_of)
        for distractor in record["distractors"]:
            folded = _normalise(distractor)
            if folded in own:
                findings.append(
                    _v5(record, distractor, "is one of this exercise's accepted answers")
                )
                continue
            if folded in siblings:
                findings.append(
                    _v5(
                        record,
                        distractor,
                        "is an accepted answer of another exercise over the same item, "
                        "so it is a valid alternative translation",
                    )
                )
                continue
            distractor_pos = pos_of.get(distractor) or pos_of.get(_normalise(distractor))
            if answer_pos is None or distractor_pos is None:
                # Not a pass. The POS clause is about option lists in ONE language and
                # `pos_of` is the course language's ledger, so an English-gloss option
                # (S034) has no entry in it and never will. Recorded and counted rather
                # than asserted either way: the POS guarantee for these is upheld
                # upstream, where `rule_core_distractors` only ever returns a candidate
                # whose POS equals the answer lemma's.
                unchecked += 1
                continue
            if distractor_pos != answer_pos:
                findings.append(
                    _v5(
                        record,
                        distractor,
                        f"is {distractor_pos} and the answer is {answer_pos}; a "
                        "distractor of a different POS is eliminable without knowing "
                        "the word",
                    )
                )
    if unchecked:
        findings.append(
            Finding(
                validator_id="V5",
                severity="info",
                message=(
                    f"{unchecked} distractor(s) could not be POS-checked against the "
                    "course-language ledger (option lists rendered in English). Their "
                    "POS agreement is held by construction in "
                    "exercises/distractors.py::rule_core_distractors, not by this "
                    "validator."
                ),
                subject=f"{len(records)} exercises",
                detail={"unchecked_distractors": unchecked},
            )
        )
    return findings


def _v5(record: Mapping[str, Any], distractor: str, why: str) -> Finding:
    return Finding(
        validator_id="V5",
        severity="blocking",
        message=f"distractor {distractor!r} {why}",
        subject=record["exercise_id"],
        detail={"distractor": distractor},
    )


def _normalise(text: str) -> str:
    return unicodedata.normalize("NFC", text).casefold().strip()


def _dominant_pos(answers: Sequence[str], pos_of: Mapping[str, str]) -> str | None:
    """The POS of a single-word answer. `None` for a sentence — V5's POS clause is
    about option lists (picture select, meaning select, missing word), and asserting a
    POS for `Yo como pan` would be a category error."""
    for answer in answers:
        if len(surface_tokens(answer)) != 1:
            return None
        found = pos_of.get(answer) or pos_of.get(_normalise(answer))
        if found is not None:
            return found
    return None


# ---------------------------------------------------------------------------
# V6 — INV-PACK-08
# ---------------------------------------------------------------------------


def register_of(text: str, lang: str) -> set[str]:
    """Which registers this string carries markers for. Empty = register-neutral.

    Lexical, not syntactic: a marker list rather than a parser, because the thing V6
    has to catch is a `usted` sentence in a `tú` unit.

    HIGH PRECISION, NOT HIGH RECALL, and the difference is the whole reason this
    function is safe to block a pack with. The `usted` row used to carry `le`, `les`,
    `su` and `sus` — the ordinary third-person clitic and possessive, which carry no
    register at all — so `A él le gusta su casa.` was reported as `usted`, and any A1
    Spanish pack containing `su casa` or `le gusta` inside a tuteo unit was blocked by a
    finding that was not true. Those forms are ambiguous between ustedeo and plain third
    person and cannot be separated lexically, so they are gone
    (`ES_AMBIGUOUS_THIRD_PERSON_FORMS` keeps the list for the regression test). What is
    left is only what can ONLY be register. The cost is stated rather than hidden: an
    ustedeo sentence that never names the pronoun (`¿Cómo está?`) passes V6, and no
    lexical table can catch that one.
    """
    if lang != "es":
        raise ValueError(f"register_of has no marker table for {lang!r}")
    present = set(_words(text))
    return {
        register
        for register, markers in ES_REGISTER_MARKERS.items()
        if present & {_fold(marker) for marker in markers}
    }


def check_v6(
    records: Iterable[Mapping[str, Any]],
    *,
    lang: str,
) -> list[Finding]:
    """Every accepted answer sits in the unit's declared register.

    For a language with no marker table this returns one blocking finding naming the
    gap, and no per-record findings at all — a run that reports zero problems because
    it could not look must not be mistakable for a clean one.
    """
    if lang not in V6_IMPLEMENTED_LANGUAGES:
        return [
            Finding(
                validator_id="V6",
                severity="blocking",
                message=V6_UNIMPLEMENTED_MESSAGE.format(
                    implemented=", ".join(V6_IMPLEMENTED_LANGUAGES), lang=lang
                ),
                subject=lang,
                detail={"implemented_for": list(V6_IMPLEMENTED_LANGUAGES)},
            )
        ]

    findings: list[Finding] = []
    for record in records:
        declared = record["register"]
        if declared not in REGISTERS:
            findings.append(
                Finding(
                    validator_id="V6",
                    severity="blocking",
                    message=(
                        f"register {declared!r} is not one config/g7.py declares "
                        f"({', '.join(REGISTERS)})"
                    ),
                    subject=record["exercise_id"],
                )
            )
            continue
        for answer in record["accepted_answers"]:
            carried = register_of(answer, lang)
            if not carried or declared in carried:
                if len(carried) > 1:
                    findings.append(
                        Finding(
                            validator_id="V6",
                            severity="blocking",
                            message=(
                                f"accepted answer {answer!r} mixes registers "
                                f"({', '.join(sorted(carried))}) in a {declared!r} unit"
                            ),
                            subject=record["exercise_id"],
                            detail={"answer": answer},
                        )
                    )
                continue
            findings.append(
                Finding(
                    validator_id="V6",
                    severity="blocking",
                    message=(
                        f"accepted answer {answer!r} is "
                        f"{', '.join(sorted(carried))} register and the unit declares "
                        f"{declared!r}. The accepted set is the entire tolerance "
                        "budget (review R24), so an out-of-register member is a wrong "
                        "answer the learner cannot recover from."
                    ),
                    subject=record["exercise_id"],
                    detail={"answer": answer, "carried": sorted(carried)},
                )
            )
    return findings


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def _exercise_records(lang: str) -> list[dict[str, Any]]:
    return list(read_records("exercise", lang=lang))


@register_validator("V5")
def v5_distractors(ctx: ValidatorContext) -> list[Finding]:
    """V5 over the written pack. POS comes from G2's banded lemmas."""
    records = _exercise_records(ctx.lang)
    pos_of = {row["lemma"]: row["pos"] for row in read_records("banded_lemma", lang=ctx.lang)}
    ctx.entry.note(v5_exercises=len(records), v5_pos_entries=len(pos_of))
    return check_v5(records, pos_of=pos_of)


@register_validator("V6")
def v6_register(ctx: ValidatorContext) -> list[Finding]:
    """V6 over the written pack, and an explicit refusal for a language it cannot read."""
    records = _exercise_records(ctx.lang)
    ctx.entry.note(
        v6_exercises=len(records),
        v6_implemented_for=list(V6_IMPLEMENTED_LANGUAGES),
        v6_script_variants_checked=False,
    )
    return check_v6(records, lang=ctx.lang)
