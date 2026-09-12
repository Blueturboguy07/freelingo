"""V10, V11 and V12 — the three pack-level validators, and the join they share.

`scope2/00` §2.4:

    V10  Every sentence carries a resolved license + attribution; pack fails on any
         unknown.                    Catches: Tatoeba's per-sentence licensing.
    V11  Mean sentence difficulty non-decreasing across units.
         Catches: batch-level LLM drift — measured interactively in `01` F23, with no
         reason to be absent from a batch build.
    V12  RTL flag set where required; every character in the pack exists in the shipped
         font.                       Catches: Arabic rendering, CJK glyph coverage.

The other nine live with the stages that produce what they check (V1-V4 with the ledger,
V5-V7 with expansion and the bake, V8 with G6, V9 with selection). These three are here
because all three read the same thing: the set of sentences a learner will actually see,
joined across four artefacts. `shipped_items()` is that join, and it is the only place
the join is written.

**Every one of them fails on an empty input.** A validator that reads nothing reports
zero findings, and zero findings is exactly what a green validator looks like. That is
the failure mode `docs/ci.md` describes for `flows-present` — two device jobs, a green
tick, nothing tested — and the reason INV-PACK-14 exists. So "there were no shipped
items" is a blocking finding here, not a fast pass.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from statistics import fmean
from typing import Any

from ..artifacts import artifact_path, read_records
from ..config.validate import (
    AUTHORED_SENTENCE_LICENCE,
    AUTHORED_SENTENCE_OWNER,
    DIFFICULTY_EPSILON,
    DIFFICULTY_WEIGHT_DECILE,
    DIFFICULTY_WEIGHT_TOKENS,
    MIN_BANDED_TOKEN_COVERAGE,
    MIN_ITEMS_PER_UNIT_FOR_DIFFICULTY,
    REQUIRED_CHARACTERS_BY_LANGUAGE,
    RTL_LANGUAGES,
    RTL_META_ROW_ID,
    SHIPPED_FONT_NAME,
    SHIPPED_FONT_RANGES,
    UNBANDED_TOKEN_DECILE,
    UNRESOLVED_LICENCE_VALUES,
    allowed_licences_for,
)
from . import Finding, ValidatorContext, register_validator

__all__ = [
    "ShippedItem",
    "covered_by_shipped_font",
    "difficulty",
    "shipped_items",
    "word_tokens",
]

#: Unicode word tokens: letters only, no digits, no underscore. The same rule the
#: `es-mini` fixture's frequency list was built with, restated rather than imported so
#: a change on one side shows up as a disagreement rather than as agreement.
_TOKEN_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


class SuiteInputMissing(RuntimeError):
    """An artefact the suite must read does not exist. Never a pass."""


@dataclass(frozen=True, slots=True)
class ShippedItem:
    """One sentence a learner will see, with everything the three validators need.

    `item_id` is the sentence id for a corpus row and the candidate id for an authored
    one. They are the same shape (16 hex) and live in the same id space, which is what
    lets an `exercise.source_sentence_id` resolve to either.
    """

    unit_index: int
    lesson_index: int
    slot_index: int
    item_id: str
    provenance: str
    text: str
    translation: str
    licence: str
    licence_verdict: str
    attribution_required: bool
    attribution_owner: str | None
    token_count: int


def word_tokens(text: str) -> list[str]:
    """Lower-cased letter runs. The difficulty proxy's tokeniser."""
    return [match.group(0).lower() for match in _TOKEN_RE.finditer(text)]


def _read(kind: str, lang: str) -> list[dict[str, Any]]:
    """Read an artefact, or raise `SuiteInputMissing` naming the stage that owes it."""
    path = artifact_path(lang, kind)
    if not path.exists():
        raise SuiteInputMissing(
            f"{kind} is not at {path}. The suite cannot report a pass over an artefact "
            f"that does not exist — run `coursekit build {lang}` first."
        )
    return list(read_records(kind, lang=lang))


def _read_optional(kind: str, lang: str) -> list[dict[str, Any]] | None:
    try:
        return _read(kind, lang)
    except SuiteInputMissing:
        return None


def shipped_items(lang: str) -> tuple[ShippedItem, ...]:
    """Join G0, G4 and G5 into the set of sentences that will be in the pack.

    A `selected_item` is the authority on *what ships and where*: it carries the unit,
    the lesson and the slot. Its `sentence_id` points into G0 for a corpus row; a `gap`
    slot carries `sentence_id: null` and is filled by the G5 candidate at the same
    (unit, lesson, slot) coordinate.

    Raises `SuiteInputMissing` if `selected_item` or `ingested_sentence` is absent.
    """
    selected = _read("selected_item", lang)
    ingested = {record["sentence_id"]: record for record in _read("ingested_sentence", lang)}
    candidates = _read_optional("candidate", lang) or []
    by_slot = {
        (record["unit_index"], record["lesson_index"], record["slot_index"]): record
        for record in candidates
        if record["accepted"]
    }

    items: list[ShippedItem] = []
    for row in selected:
        coordinate = (row["unit_index"], row["lesson_index"], row["slot_index"])
        if row["provenance"] == "corpus" and row["sentence_id"] is not None:
            sentence = ingested.get(row["sentence_id"])
            if sentence is None:
                # A dangling reference is V10's business: no row means no licence.
                items.append(
                    ShippedItem(
                        unit_index=row["unit_index"],
                        lesson_index=row["lesson_index"],
                        slot_index=row["slot_index"],
                        item_id=row["sentence_id"],
                        provenance="corpus",
                        text="",
                        translation="",
                        licence="",
                        licence_verdict="",
                        attribution_required=True,
                        attribution_owner=None,
                        token_count=0,
                    )
                )
                continue
            items.append(
                ShippedItem(
                    unit_index=row["unit_index"],
                    lesson_index=row["lesson_index"],
                    slot_index=row["slot_index"],
                    item_id=sentence["sentence_id"],
                    provenance="corpus",
                    text=sentence["text"],
                    translation=sentence["translation"],
                    licence=sentence["licence"],
                    licence_verdict=sentence["licence_verdict"],
                    attribution_required=sentence["attribution_required"],
                    attribution_owner=sentence["attribution_owner"],
                    token_count=sentence["token_count"],
                )
            )
            continue

        candidate = by_slot.get(coordinate)
        if candidate is None:
            items.append(
                ShippedItem(
                    unit_index=row["unit_index"],
                    lesson_index=row["lesson_index"],
                    slot_index=row["slot_index"],
                    item_id="",
                    provenance="llm",
                    text="",
                    translation="",
                    licence="",
                    licence_verdict="",
                    attribution_required=True,
                    attribution_owner=None,
                    token_count=0,
                )
            )
            continue
        items.append(
            ShippedItem(
                unit_index=row["unit_index"],
                lesson_index=row["lesson_index"],
                slot_index=row["slot_index"],
                item_id=candidate["candidate_id"],
                provenance="llm",
                text=candidate["text"],
                translation=candidate["translation"],
                licence=AUTHORED_SENTENCE_LICENCE,
                licence_verdict="shippable",
                attribution_required=True,
                attribution_owner=AUTHORED_SENTENCE_OWNER,
                token_count=len(word_tokens(candidate["text"])),
            )
        )
    return tuple(items)


def _deciles(lang: str) -> dict[str, int]:
    return {row["lemma"].lower(): row["decile"] for row in _read("banded_lemma", lang)}


def difficulty(item: ShippedItem, deciles: dict[str, int]) -> tuple[float, int, int]:
    """The declared proxy, plus how many of its tokens were actually banded.

    `tokens * w_tokens + mean_decile * w_decile`. An unbanded token counts as the rarest
    decile: dropping it would make a unit full of unknown vocabulary score EASIER than
    one built from the ledger, which is exactly the drift V11 is looking for.
    """
    tokens = word_tokens(item.text)
    if not tokens:
        return (0.0, 0, 0)
    banded = [deciles[token] for token in tokens if token in deciles]
    scored = [deciles.get(token, UNBANDED_TOKEN_DECILE) for token in tokens]
    value = len(tokens) * DIFFICULTY_WEIGHT_TOKENS + fmean(scored) * DIFFICULTY_WEIGHT_DECILE
    return (value, len(banded), len(tokens))


def covered_by_shipped_font(character: str) -> bool:
    """Is this codepoint inside the declared coverage of the bundled font?"""
    point = ord(character)
    return any(first <= point <= last for first, last in SHIPPED_FONT_RANGES)


def _nothing_to_check(validator_id: str, what: str) -> Finding:
    return Finding(
        validator_id=validator_id,
        severity="blocking",
        message=(
            f"{validator_id} had no {what} to check. A validator that reads nothing "
            f"reports zero findings, which is what a green validator looks like — so an "
            f"empty input fails here rather than passing fast."
        ),
        subject="<empty>",
    )


def _input_missing(validator_id: str, exc: SuiteInputMissing) -> Finding:
    return Finding(
        validator_id=validator_id,
        severity="blocking",
        message=str(exc),
        subject="<missing-artefact>",
    )


# ---------------------------------------------------------------------------
# V10 — licence and attribution
# ---------------------------------------------------------------------------


@register_validator("V10")
def every_sentence_carries_a_resolved_licence(ctx: ValidatorContext) -> list[Finding]:
    """No shipped sentence may have an unknown licence or a missing attribution owner.

    Three distinct failures, kept distinct because they have three different fixes:

    * an **unresolved** licence (`NOASSERTION`, `UNKNOWN`, empty) — G0 read a source
      with no verdict, which INV-PACK-13 is supposed to have refused at ingest;
    * a licence that resolved to something **off the allow-list for its provenance** —
      a real string, and the wrong one, which is how a CC BY-NC-ND corpus reaches a pack;
    * a licence that resolved fine and an **attribution owner that is missing** — the
      row ships, the credits screen S152 has nothing to render, and INV-PACK-17 fails at
      the surface rather than here.

    The allow-list is **per provenance** (`allowed_licences_for`). A single merged set
    containing both the ingest list and `AUTHORED_SENTENCE_LICENCE` reads as stricter
    than it is: `AUTHORED_SENTENCE_LICENCE` is the pack licence `CC-BY-NC-SA-4.0`, so a
    merged set silently accepts an NC *corpus* row, and INV-PACK-13's "NC and ND sources
    are excluded at ingest, not at package time" is then enforced nowhere.
    """
    try:
        items = shipped_items(ctx.lang)
    except SuiteInputMissing as exc:
        return [_input_missing("V10", exc)]

    if not items:
        return [_nothing_to_check("V10", "shipped sentence")]

    findings: list[Finding] = []
    resolved = 0
    attributed = 0
    for item in items:
        subject = f"u{item.unit_index}/l{item.lesson_index}/s{item.slot_index}:{item.item_id}"
        if item.licence in UNRESOLVED_LICENCE_VALUES:
            findings.append(
                Finding(
                    validator_id="V10",
                    severity="blocking",
                    message=(
                        f"licence is unresolved ({item.licence!r}). A sentence with no "
                        f"resolved licence must never have reached an artefact: "
                        f"INV-PACK-13 refuses at ingest, not at package time."
                    ),
                    subject=subject,
                    detail={"provenance": item.provenance},
                )
            )
            continue
        resolved += 1
        allowed = allowed_licences_for(item.provenance)
        if item.licence not in allowed:
            findings.append(
                Finding(
                    validator_id="V10",
                    severity="blocking",
                    message=(
                        f"licence {item.licence!r} is not on the allow-list for "
                        f"provenance {item.provenance!r} ({', '.join(sorted(allowed))}). "
                        f"{AUTHORED_SENTENCE_LICENCE!r} is the licence this repository "
                        f"puts on its OWN text; a third party's sentence may never "
                        f"arrive carrying it (INV-PACK-13: NC and ND sources are "
                        f"excluded at ingest, not at package time)."
                    ),
                    subject=subject,
                    detail={"provenance": item.provenance},
                )
            )
        if item.licence_verdict != "shippable":
            findings.append(
                Finding(
                    validator_id="V10",
                    severity="blocking",
                    message=(
                        f"verdict is {item.licence_verdict!r}: this text may inform "
                        f"statistics and may never be shipped verbatim."
                    ),
                    subject=subject,
                )
            )
        if item.attribution_required and not item.attribution_owner:
            findings.append(
                Finding(
                    validator_id="V10",
                    severity="blocking",
                    message=(
                        "attribution is required and no owner is recorded; S152 would "
                        "have nothing to credit (INV-PACK-17)."
                    ),
                    subject=subject,
                )
            )
        elif item.attribution_required:
            attributed += 1

    ctx.entry.note(
        shipped_items=len(items),
        licences_resolved=resolved,
        attribution_rows=attributed,
        distinct_licences=sorted({item.licence for item in items if item.licence}),
    )
    return findings


# ---------------------------------------------------------------------------
# V11 — difficulty drift across units
# ---------------------------------------------------------------------------


@register_validator("V11")
def mean_difficulty_is_non_decreasing(ctx: ValidatorContext) -> list[Finding]:
    """Unit n+1 is never, on average, easier than unit n.

    This is the batch-level check on authored content. `01` F23 measured the drift
    interactively — a generator asked for "the same again, harder" wanders — and a batch
    build has no reason to be immune. A per-sentence check cannot see it: every
    individual candidate can be inside the ledger and the batch can still be flatter than
    the curriculum it was written for.
    """
    try:
        items = shipped_items(ctx.lang)
        deciles = _deciles(ctx.lang)
    except SuiteInputMissing as exc:
        return [_input_missing("V11", exc)]

    if not items:
        return [_nothing_to_check("V11", "shipped sentence")]

    by_unit: dict[int, list[ShippedItem]] = {}
    for item in items:
        by_unit.setdefault(item.unit_index, []).append(item)

    findings: list[Finding] = []
    means: dict[int, float] = {}
    banded_tokens = 0
    total_tokens = 0
    for unit_index in sorted(by_unit):
        unit_items = by_unit[unit_index]
        scores: list[float] = []
        for item in unit_items:
            value, banded, total = difficulty(item, deciles)
            scores.append(value)
            banded_tokens += banded
            total_tokens += total
        if len(unit_items) < MIN_ITEMS_PER_UNIT_FOR_DIFFICULTY:
            findings.append(
                Finding(
                    validator_id="V11",
                    severity="blocking",
                    message=(
                        f"unit {unit_index} has {len(unit_items)} item(s); a mean over "
                        f"fewer than {MIN_ITEMS_PER_UNIT_FOR_DIFFICULTY} is noise, and "
                        f"comparing noise to noise is not a check."
                    ),
                    subject=f"u{unit_index}",
                )
            )
        means[unit_index] = fmean(scores) if scores else 0.0

    ordered = sorted(means)
    for previous, following in zip(ordered, ordered[1:], strict=False):
        drop = means[previous] - means[following]
        if drop > DIFFICULTY_EPSILON:
            findings.append(
                Finding(
                    validator_id="V11",
                    severity="blocking",
                    message=(
                        f"mean difficulty falls from {means[previous]:.3f} in unit "
                        f"{previous} to {means[following]:.3f} in unit {following} "
                        f"(-{drop:.3f}). The curriculum goes forwards; the content went "
                        f"backwards."
                    ),
                    subject=f"u{previous}->u{following}",
                    detail={"before": means[previous], "after": means[following]},
                )
            )

    coverage = (banded_tokens / total_tokens) if total_tokens else 0.0
    if coverage < MIN_BANDED_TOKEN_COVERAGE:
        findings.append(
            Finding(
                validator_id="V11",
                severity="warning",
                message=(
                    f"only {coverage:.1%} of shipped tokens matched a row in the banded "
                    f"table, so the difficulty proxy is mostly sentence length. The "
                    f"table is keyed by lemma and this reads surface tokens; below "
                    f"{MIN_BANDED_TOKEN_COVERAGE:.0%} the number in the report is a "
                    f"length signal, not a vocabulary one."
                ),
                subject="<coverage>",
                detail={"banded_token_coverage": coverage},
            )
        )

    ctx.entry.note(
        units=len(means),
        mean_difficulty={str(unit): round(value, 4) for unit, value in means.items()},
        banded_token_coverage=round(coverage, 4),
    )
    return findings


# ---------------------------------------------------------------------------
# V12 — script direction and font coverage
# ---------------------------------------------------------------------------


def _renderable_strings(lang: str, items: Iterable[ShippedItem]) -> Iterator[tuple[str, str]]:
    """Every string a learner can see, with the subject that identifies it."""
    for item in items:
        subject = f"u{item.unit_index}/l{item.lesson_index}/s{item.slot_index}:{item.item_id}"
        if item.text:
            yield (f"{subject}#text", item.text)
        if item.translation:
            yield (f"{subject}#translation", item.translation)
    exercises = _read_optional("exercise", lang)
    for exercise in exercises or []:
        subject = exercise["exercise_id"]
        yield (f"{subject}#prompt", exercise["prompt"])
        for index, answer in enumerate(exercise["accepted_answers"]):
            yield (f"{subject}#answer{index}", answer)
        for index, distractor in enumerate(exercise["distractors"]):
            yield (f"{subject}#distractor{index}", distractor)


@register_validator("V12")
def direction_and_font_coverage(ctx: ValidatorContext) -> list[Finding]:
    """The pack declares the right direction, and nothing in it is unrenderable.

    The font half is the PACK half of INV-PACK-54: no string in the pack carries a
    character outside the declared coverage of the bundled face. The other half — that
    the `.ttf` actually shipped in `apps/mobile` still carries those ranges after
    subsetting — is P3's, because the subset lives with the app and nothing here can see
    it. Splitting it that way is deliberate: a validator that asserted a file it cannot
    read would be worse than one that says which half it checked.

    The direction half fails on an ABSENT flag as well as a wrong one. `rtl` missing from
    the pack's meta rows is not `false`, it is nobody having decided, and the first pack
    that needs `true` would ship without it.
    """
    try:
        items = shipped_items(ctx.lang)
    except SuiteInputMissing as exc:
        return [_input_missing("V12", exc)]

    if not items:
        return [_nothing_to_check("V12", "shipped sentence")]

    findings: list[Finding] = []

    # -- the font ranges themselves must cover what this language needs --------
    required = REQUIRED_CHARACTERS_BY_LANGUAGE.get(ctx.lang, "")
    for character in required:
        if not covered_by_shipped_font(character):
            findings.append(
                Finding(
                    validator_id="V12",
                    severity="blocking",
                    message=(
                        f"{SHIPPED_FONT_NAME}'s declared ranges do not cover {character!r} "
                        f"(U+{ord(character):04X}), which {ctx.lang} needs. The ranges "
                        f"were narrowed without narrowing the language."
                    ),
                    subject="<declared-ranges>",
                )
            )

    # -- every renderable string ----------------------------------------------
    uncovered: dict[str, list[str]] = {}
    strings = 0
    characters = 0
    for subject, text in _renderable_strings(ctx.lang, items):
        strings += 1
        characters += len(text)
        for character in text:
            if not covered_by_shipped_font(character):
                uncovered.setdefault(character, []).append(subject)
    for character, subjects in sorted(uncovered.items()):
        findings.append(
            Finding(
                validator_id="V12",
                severity="blocking",
                message=(
                    f"{character!r} (U+{ord(character):04X}) is outside "
                    f"{SHIPPED_FONT_NAME}'s declared coverage and appears in "
                    f"{len(subjects)} string(s), first {subjects[0]}."
                ),
                subject=subjects[0],
                detail={"codepoint": f"U+{ord(character):04X}", "occurrences": len(subjects)},
            )
        )

    # -- the direction flag ----------------------------------------------------
    expected_rtl = ctx.lang in RTL_LANGUAGES
    pack_rows = _read_optional("pack_row", ctx.lang)
    if pack_rows is None:
        findings.append(
            Finding(
                validator_id="V12",
                severity="blocking",
                message=(
                    "the pack declares no meta rows at all, so its direction flag cannot "
                    "be checked. `coursekit validate` runs after `coursekit build`; G9 "
                    "has not run."
                ),
                subject=f"meta/{RTL_META_ROW_ID}",
            )
        )
    else:
        declared = [
            row
            for row in pack_rows
            if row["table"] == "meta" and row["row_id"] == RTL_META_ROW_ID
        ]
        if not declared:
            findings.append(
                Finding(
                    validator_id="V12",
                    severity="blocking",
                    message=(
                        f"no meta row {RTL_META_ROW_ID!r}. An absent direction flag is "
                        f"not 'false', it is nobody having decided — and the first pack "
                        f"that needs true would ship without it."
                    ),
                    subject=f"meta/{RTL_META_ROW_ID}",
                )
            )
        else:
            value = declared[0]["payload"].get("value")
            if value is not expected_rtl:
                findings.append(
                    Finding(
                        validator_id="V12",
                        severity="blocking",
                        message=(
                            f"the pack declares rtl={value!r}; {ctx.lang} requires "
                            f"rtl={expected_rtl!r}."
                        ),
                        subject=f"meta/{RTL_META_ROW_ID}",
                    )
                )

    ctx.entry.note(
        font=SHIPPED_FONT_NAME,
        renderable_strings=strings,
        characters_checked=characters,
        rtl_expected=expected_rtl,
        bundled_font_subset_checked=False,
    )
    return findings
