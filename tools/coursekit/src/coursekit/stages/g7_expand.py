"""G7 — align, expand each selected pair into exercise shapes, generate distractors.

Reads `analysed_sentence` (G1), `banded_lemma` (G2), `unit_assignment` (G3),
`selected_item` (G4) and, for every slot G4 marked a gap, the accepted `candidate`
rows (G5, validated at G6). Writes `exercise`.

## The four things this stage refuses to do

1. **Emit a shape a focus may not wear.** Every draft goes through
   `exercises.shapes.route`, which is INV-PACK-50 by construction: a grammar concept
   or a script unit cannot reach a lexeme-quoting prompt, and cannot wear the NEW WORD
   pill (EC-PACK-47).
2. **Leave a missable item with one form.** `SENTENCE_FORM_PLAN`,
   `LEXEME_FORM_PLAN` and `GRAMMAR_FORM_PLAN` each carry two punitive shapes, and the
   stage re-checks the written set with `check_pack_07` before it writes anything —
   INV-PACK-07 as a build gate, per EC-MIS-04.
3. **Pick an aligner on the learner's behalf.** `DEFAULT_ALIGNMENT_ENGINE` is SimAlign
   and an absent `align` group is exit 3. The deterministic engine is reachable only by
   naming it (`--set align_engine=deterministic`), and whichever ran is written to the
   runlog with its measured-quality status. CI names it; a shipping pack may not.
4. **Pad a distractor slot.** `rule_core_distractors` raises rather than reaching for
   another POS or another band, and the stage turns that into a failed stage rather
   than a quietly shorter option list.

## Why `audio_ref` can be filled before G8 runs

G8 is content-addressed: a clip's id is a hash of what is spoken. So G7 computes the
same id with the same function (`artifacts.sentence_id`) and G8 either finds the clip
or bakes it. The alternative — a second pass over the exercise file after the bake —
would make the exercise artefact mutable, and every id downstream of it with it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .. import __version__
from ..artifacts import read_records, sentence_id, write_records
from ..config import EXERCISE_TYPES, TOOL_NAME
from ..config.g7 import (
    CHAT_TURN_SEPARATOR,
    DEFAULT_REGISTER_BY_SLOT,
    GAP_MARKER,
    GRAMMAR_FORM_PLAN,
    LEXEME_FORM_PLAN,
    MATCH_PAIR_SEPARATOR,
    MATCH_PAIRS_PER_EXERCISE,
    REGISTERS,
    SENTENCE_FORM_PLAN,
)
from ..exercises.alignment import alignment_provenance, get_aligner
from ..exercises.distractors import (
    AlternativesIndex,
    DistractorPool,
    NotEnoughDistractors,
    rule_core_distractors,
)
from ..exercises.shapes import ExerciseDraft, shape
from ..exercises.wordbank import build_word_bank
from ..runlog import require_successful
from ..validators.exercise import check_pack_07, check_pack_50, check_v5
from . import StageContext, StageResult, register_stage

__all__ = ["ExpansionInputs", "expand", "expand_item"]


@dataclass(slots=True)
class ExpansionInputs:
    """Everything G7 needs, loaded once. Keyed for O(1) lookup per item."""

    lang: str
    analysed: dict[str, Mapping[str, Any]]
    units: dict[int, Mapping[str, Any]]
    selected: list[Mapping[str, Any]]
    candidates: dict[tuple[int, int, int], Mapping[str, Any]]
    translations: dict[str, str]
    texts: dict[str, str]
    pool: DistractorPool
    pos_of: dict[str, str]
    band_of: dict[str, str]


def _load(lang: str) -> ExpansionInputs:
    analysed = {row["sentence_id"]: row for row in read_records("analysed_sentence", lang=lang)}
    banded = list(read_records("banded_lemma", lang=lang))
    units = {row["unit_index"]: row for row in read_records("unit_assignment", lang=lang)}
    selected = list(read_records("selected_item", lang=lang))
    ingested = list(read_records("ingested_sentence", lang=lang))

    candidates: dict[tuple[int, int, int], Mapping[str, Any]] = {}
    if any(item["gap"] for item in selected):
        for row in read_records("candidate", lang=lang):
            if row["accepted"]:
                candidates[(row["unit_index"], row["lesson_index"], row["slot_index"])] = row

    return ExpansionInputs(
        lang=lang,
        analysed=analysed,
        units=units,
        selected=selected,
        candidates=candidates,
        translations={row["sentence_id"]: row["translation"] for row in ingested},
        texts={row["sentence_id"]: row["text"] for row in ingested},
        pool=DistractorPool.build(banded, analysed.values()),
        pos_of={row["lemma"]: row["pos"] for row in banded},
        band_of={row["lemma"]: row["band"] for row in banded},
    )


def _resolve_text(inputs: ExpansionInputs, item: Mapping[str, Any]) -> tuple[str, str, str | None]:
    """`(target text, English translation, source_sentence_id or None)` for one slot.

    A gap slot resolves to its accepted G5 candidate and carries `source_sentence_id:
    null`, which is how the pack records "this sentence was authored, not selected" —
    the provenance percentage in the manifest is computed from exactly this.
    """
    if item["gap"]:
        key = (item["unit_index"], item["lesson_index"], item["slot_index"])
        candidate = inputs.candidates.get(key)
        if candidate is None:
            raise KeyError(
                f"selected slot {key} is a gap and no accepted candidate exists for it. "
                "G5 over-generates and G6 rejects; a slot with no survivor is a content "
                "failure, not something G7 may fill."
            )
        return candidate["text"], candidate["translation"], None
    sid = item["sentence_id"]
    if sid not in inputs.texts:
        raise KeyError(f"selected item names sentence {sid} which G0 never ingested")
    return inputs.texts[sid], inputs.translations[sid], sid


def _target_tokens(inputs: ExpansionInputs, sid: str | None, text: str) -> list[str]:
    """G1's `display_tokens` where the sentence was analysed, else a whitespace split.

    An authored candidate has not been through G1, and re-running a lemmatiser here
    would put a second analyser version into the pipeline. The split is recorded as
    such rather than dressed up as analysis.
    """
    if sid is not None and sid in inputs.analysed:
        return list(inputs.analysed[sid]["display_tokens"])
    return text.split()


def _lemmas_for(inputs: ExpansionInputs, sid: str | None, text: str) -> list[str]:
    if sid is not None and sid in inputs.analysed:
        return list(inputs.analysed[sid]["lemmas"])
    return [token.strip(".,¿?¡!").casefold() for token in text.split() if token.strip(".,¿?¡!")]


def _exercise_id(lang: str, unit: int, lesson: int, shape_id: str, body: str) -> str:
    """Content-addressed, so a rebuild that did not change the item keeps its FSRS row."""
    return sentence_id(lang, f"{unit}\x1f{lesson}\x1f{shape_id}\x1f{body}")


def _gapped(tokens: Sequence[str], index: int) -> str:
    return " ".join(GAP_MARKER if position == index else token
                    for position, token in enumerate(tokens))


# ---------------------------------------------------------------------------
# Expansion
# ---------------------------------------------------------------------------


def expand_item(
    inputs: ExpansionInputs,
    item: Mapping[str, Any],
    *,
    alignment: Sequence[tuple[int, int]],
    register: str,
    alternatives: AlternativesIndex,
    glosses: Mapping[str, str],
) -> list[ExerciseDraft]:
    """Every draft for one selected slot: its sentence forms, its new lexemes, its concept.

    The shape list per focus comes from the form plan in `config/g7.py`, rotated by
    `slot_index` so a lesson does not render one sentence thirteen ways. Every row of
    every plan carries two punitive shapes, which is where INV-PACK-07 is actually
    satisfied — the validator that follows is there to catch a plan somebody edits.
    """
    lang = inputs.lang
    text, translation, sid = _resolve_text(inputs, item)
    unit = item["unit_index"]
    lesson = item["lesson_index"]
    concept = item["grammar_concept"]
    target_tokens = _target_tokens(inputs, sid, text)
    source_tokens = translation.split()
    lemmas = _lemmas_for(inputs, sid, text)
    audio = sentence_id(lang, text)

    drafts: list[ExerciseDraft] = []
    plan = SENTENCE_FORM_PLAN[item["slot_index"] % len(SENTENCE_FORM_PLAN)]
    for shape_id in plan:
        drafts.append(
            _sentence_draft(
                inputs,
                shape_id=shape_id,
                unit=unit,
                lesson=lesson,
                text=text,
                translation=translation,
                target_tokens=target_tokens,
                source_tokens=source_tokens,
                lemmas=lemmas,
                concept=concept,
                register=register,
                audio=audio,
                sid=sid,
                alternatives=alternatives,
            )
        )

    for lemma in item["new_lemmas"]:
        drafts.extend(
            _lexeme_drafts(
                inputs,
                lemma=lemma,
                unit=unit,
                lesson=lesson,
                register=register,
                alternatives=alternatives,
                glosses=glosses,
            )
        )

    if item["slot_index"] == 0:
        for shape_id in GRAMMAR_FORM_PLAN:
            drafts.append(
                _grammar_draft(
                    inputs,
                    shape_id=shape_id,
                    unit=unit,
                    lesson=lesson,
                    concept=concept,
                    target_tokens=target_tokens,
                    lemmas=lemmas,
                    register=register,
                    sid=sid,
                    alternatives=alternatives,
                )
            )

    _ = alignment  # hints ride on the word bank; the pairs are written on the record
    return drafts


def _sentence_draft(
    inputs: ExpansionInputs,
    *,
    shape_id: str,
    unit: int,
    lesson: int,
    text: str,
    translation: str,
    target_tokens: Sequence[str],
    source_tokens: Sequence[str],
    lemmas: Sequence[str],
    concept: str,
    register: str,
    audio: str,
    sid: str | None,
    alternatives: AlternativesIndex,
) -> ExerciseDraft:
    chosen = shape(shape_id)
    lang = inputs.lang
    key = f"sentence:{sid}" if sid else f"authored:{unit}:{lesson}:{text}"
    reverse = chosen.direction == "l2_to_l1"
    body = translation if chosen.direction == "l1_to_l2" else text
    accepted: tuple[str, ...] = (text,) if not reverse else (translation,)
    distractors: tuple[str, ...] = ()

    if chosen.id in {"word_bank_forward", "word_bank_reverse", "tap_what_you_hear"}:
        answer_tokens = list(source_tokens if reverse else target_tokens)
        decoys = _decoys(
            inputs,
            lemmas=lemmas,
            count=chosen.distractor_count,
            key=key,
            accepted=answer_tokens,
            alternatives=alternatives,
        )
        bank = build_word_bank(answer_tokens, decoys, key=f"{key}:{chosen.id}")
        distractors = bank.extra_tiles
        body = "" if chosen.id == "tap_what_you_hear" else body
    elif chosen.id in {"fill_in_the_blank", "listen_for_the_missing_word"}:
        gap_index = _gap_index(target_tokens)
        body = _gapped(target_tokens, gap_index)
        accepted = (target_tokens[gap_index],)
        distractors = _decoys(
            inputs,
            lemmas=[target_tokens[gap_index]],
            count=chosen.distractor_count,
            key=key,
            accepted=list(accepted),
            alternatives=alternatives,
        )
        body = "" if chosen.id == "listen_for_the_missing_word" else body
    elif chosen.id == "complete_the_translation":
        gap_index = _gap_index(target_tokens)
        body = translation + "\n" + _gapped(target_tokens, gap_index)
        accepted = (target_tokens[gap_index],)
    elif chosen.id == "complete_the_chat":
        body = translation
        distractors = _chat_distractor(inputs, text=text, key=key, alternatives=alternatives)

    return ExerciseDraft(
        lang=lang,
        exercise_id=_exercise_id(lang, unit, lesson, chosen.id, body or text),
        unit_index=unit,
        lesson_index=lesson,
        shape_id=chosen.id,
        focus="sentence",
        instruction_hint=None,
        body=body,
        accepted_answers=accepted,
        distractors=distractors,
        alignment=(),
        lemmas=tuple(lemmas),
        grammar_concepts=(concept,),
        audio_ref=audio if chosen.needs_audio else None,
        register=register,
        source_sentence_id=sid,
    )


def _gap_index(tokens: Sequence[str]) -> int:
    """Which token becomes the blank: the longest one, ties to the earliest.

    Deterministic and content-free on purpose. Choosing the *new* lemma would make the
    cloze a second introduction of a word the learner has just met, which V2's
    one-new-item-per-exercise rule is written against.
    """
    if not tokens:
        raise ValueError("a cloze needs at least one token")
    return max(range(len(tokens)), key=lambda index: (len(tokens[index]), -index))


def _decoys(
    inputs: ExpansionInputs,
    *,
    lemmas: Sequence[str],
    count: int,
    key: str,
    accepted: Sequence[str],
    alternatives: AlternativesIndex,
) -> tuple[str, ...]:
    """`count` rule-core distractors anchored on the item's most specific lemma."""
    if count == 0:
        return ()
    anchor = max(lemmas, key=len) if lemmas else accepted[0]
    pos = inputs.pos_of.get(anchor, "")
    band = inputs.band_of.get(anchor, "unbanded")
    return rule_core_distractors(
        pool=inputs.pool,
        alternatives=alternatives,
        key=key,
        answer_surface=anchor,
        answer_lemma=anchor,
        pos=pos,
        band=band,
        accepted_answers=accepted,
        count=count,
    )


def _chat_distractor(
    inputs: ExpansionInputs,
    *,
    text: str,
    key: str,
    alternatives: AlternativesIndex,
) -> tuple[str, ...]:
    """S037's one wrong reply line.

    A whole sentence, not a word, so the rule core's lexical machinery does not apply:
    the reply is another accepted answer from elsewhere in the ledger, which is a real
    Spanish sentence and is wrong only in this conversation. `alternatives` keeps it
    from being one of THIS item's accepted lines.
    """
    forbidden = alternatives.forbidden_for(key) | {text.casefold()}
    for other in sorted(alternatives.everywhere):
        if other not in forbidden and len(other.split()) > 1:
            return (other,)
    raise NotEnoughDistractors(
        f"{key}: complete-the-chat needs one wrong reply line and the unit has no "
        "other multi-word accepted answer to draw one from"
    )


def _lexeme_drafts(
    inputs: ExpansionInputs,
    *,
    lemma: str,
    unit: int,
    lesson: int,
    register: str,
    alternatives: AlternativesIndex,
    glosses: Mapping[str, str],
) -> list[ExerciseDraft]:
    """Both recognition forms for a newly introduced lexeme, plus the NEW WORD pill.

    The pill rides on `picture_select` only — the first recognition of the word — and
    `ExerciseDraft` refuses it on any shape that is not `new_word_eligible`.
    """
    lang = inputs.lang
    key = f"lexeme:{lemma}"
    pos = inputs.pos_of.get(lemma, "")
    band = inputs.band_of.get(lemma, "unbanded")
    drafts: list[ExerciseDraft] = []
    for shape_id in LEXEME_FORM_PLAN:
        chosen = shape(shape_id)
        if shape_id == "meaning_select":
            gloss = glosses.get(lemma)
            if gloss is None:
                # No alignment reached this lemma, so there is no gloss to offer and no
                # meaning-select. The whole introduction is then dropped rather than
                # half-authored: a lexeme item with ONE punitive form fails INV-PACK-07,
                # and the word is still taught inside the sentence exercises.
                return []
            accepted = (gloss,)
            options = [
                glosses[other]
                for other in _same_pos_band_lemmas(inputs, lemma, pos, band)
                if other in glosses and glosses[other] != gloss
            ]
            if len(options) < chosen.distractor_count:
                return []
            distractors = tuple(options[: chosen.distractor_count])
        else:
            accepted = (lemma,)
            distractors = rule_core_distractors(
                pool=inputs.pool,
                alternatives=alternatives,
                key=key,
                answer_surface=lemma,
                answer_lemma=lemma,
                pos=pos,
                band=band,
                accepted_answers=list(accepted),
                count=chosen.distractor_count,
            )
        drafts.append(
            ExerciseDraft(
                lang=lang,
                exercise_id=_exercise_id(lang, unit, lesson, shape_id, lemma),
                unit_index=unit,
                lesson_index=lesson,
                shape_id=shape_id,
                focus="lexeme",
                instruction_hint=lemma,
                body=lemma,
                accepted_answers=accepted,
                distractors=distractors,
                lemmas=(lemma,),
                grammar_concepts=(),
                audio_ref=None,
                register=register,
                source_sentence_id=None,
                new_word_pill=shape_id == "picture_select",
            )
        )
    return drafts


def _same_pos_band_lemmas(
    inputs: ExpansionInputs, lemma: str, pos: str, band: str
) -> list[str]:
    return [other for other in inputs.pool.by_pos_band.get((pos, band), []) if other != lemma]


def _grammar_draft(
    inputs: ExpansionInputs,
    *,
    shape_id: str,
    unit: int,
    lesson: int,
    concept: str,
    target_tokens: Sequence[str],
    lemmas: Sequence[str],
    register: str,
    sid: str | None,
    alternatives: AlternativesIndex,
) -> ExerciseDraft:
    """A grammar concept drilled, never quoted. INV-PACK-50's positive case.

    `focus="grammar_concept"` is what makes `route()` refuse picture-select and
    meaning-select for this draft, and what makes the NEW WORD pill impossible on it.
    """
    lang = inputs.lang
    key = f"sentence:{sid}" if sid else f"concept:{concept}"
    gap_index = _gap_index(target_tokens)
    if shape_id == "type_the_word_ending":
        surface = target_tokens[gap_index]
        stem, ending = surface[: max(len(surface) - 2, 1)], surface[max(len(surface) - 2, 1) :]
        body = " ".join(
            f"{stem}{GAP_MARKER}" if position == gap_index else token
            for position, token in enumerate(target_tokens)
        )
        accepted: tuple[str, ...] = (ending,)
        distractors: tuple[str, ...] = ()
    else:
        body = _gapped(target_tokens, gap_index)
        accepted = (target_tokens[gap_index],)
        distractors = _decoys(
            inputs,
            lemmas=[target_tokens[gap_index]],
            count=shape(shape_id).distractor_count,
            key=key,
            accepted=list(accepted),
            alternatives=alternatives,
        )
    return ExerciseDraft(
        lang=lang,
        exercise_id=_exercise_id(lang, unit, lesson, shape_id, f"{concept}\x1f{body}"),
        unit_index=unit,
        lesson_index=lesson,
        shape_id=shape_id,
        focus="grammar_concept",
        instruction_hint=None,
        body=body,
        accepted_answers=accepted,
        distractors=distractors,
        lemmas=tuple(lemmas),
        grammar_concepts=(concept,),
        audio_ref=None,
        register=register,
        source_sentence_id=sid,
    )


def build_match_pairs(
    inputs: ExpansionInputs,
    *,
    unit: int,
    lesson: int,
    lemmas: Sequence[str],
    glosses: Mapping[str, str],
    register: str,
) -> ExerciseDraft | None:
    """S033. Five rows, or nothing — a four-row match is a different exercise.

    Tagged with all five lemmas, because `validators.exercise.item_keys` files it as a
    form of EACH of them: "the left-hand lexeme is the queued mistake" (S033), so a
    match is five items' second form and never one item's only form.
    """
    glossed = [lemma for lemma in lemmas if lemma in glosses]
    if len(glossed) < MATCH_PAIRS_PER_EXERCISE:
        return None
    rows = sorted(glossed)[:MATCH_PAIRS_PER_EXERCISE]
    accepted = tuple(f"{lemma}{MATCH_PAIR_SEPARATOR}{glosses[lemma]}" for lemma in rows)
    return ExerciseDraft(
        lang=inputs.lang,
        exercise_id=_exercise_id(inputs.lang, unit, lesson, "match_pairs", "|".join(rows)),
        unit_index=unit,
        lesson_index=lesson,
        shape_id="match_pairs",
        focus="lexeme",
        instruction_hint=None,
        body=CHAT_TURN_SEPARATOR.join(rows),
        accepted_answers=accepted,
        distractors=(),
        lemmas=tuple(rows),
        grammar_concepts=(),
        audio_ref=None,
        register=register,
        source_sentence_id=None,
    )


# ---------------------------------------------------------------------------
# Glosses
# ---------------------------------------------------------------------------


def build_glosses(
    inputs: ExpansionInputs,
    alignments: Mapping[str, Sequence[tuple[int, int]]],
) -> dict[str, str]:
    """`lemma -> English gloss`, taken from the alignment and nothing else.

    This is the one place the word alignment becomes learner-visible content rather
    than a hint, so its quality note travels with it on the runlog. A lemma with no
    alignment gets NO gloss and its meaning-select is simply not authored — the item
    still has `picture_select` plus whatever match it lands in, so INV-PACK-07 holds
    without inventing a translation.
    """
    votes: dict[str, dict[str, int]] = {}
    for sid, pairs in alignments.items():
        row = inputs.analysed.get(sid)
        if row is None:
            continue
        translation = inputs.translations.get(sid, "").split()
        tokens = row["tokens"]
        for source_index, target_index in pairs:
            if not (0 <= source_index < len(translation) and 0 <= target_index < len(tokens)):
                continue
            lemma = tokens[target_index]["lemma"]
            gloss = translation[source_index].strip(".,!?¿¡").casefold()
            if not gloss:
                continue
            votes.setdefault(lemma, {})[gloss] = votes.setdefault(lemma, {}).get(gloss, 0) + 1
    return {
        lemma: max(sorted(counts), key=lambda gloss: (counts[gloss], gloss))
        for lemma, counts in votes.items()
    }


# ---------------------------------------------------------------------------
# The stage
# ---------------------------------------------------------------------------


@register_stage(
    "g7",
    reads=(
        "ingested_sentence",
        "analysed_sentence",
        "banded_lemma",
        "unit_assignment",
        "selected_item",
        "candidate",
    ),
    writes=("exercise",),
)
def expand(ctx: StageContext) -> StageResult:
    """Align, expand, generate distractors, gate, write."""
    lang = ctx.lang
    require_successful(lang, ["g1", "g2", "g3", "g4"])
    inputs = _load(lang)
    if any(item["gap"] for item in inputs.selected):
        require_successful(lang, ["g5", "g6"])

    engine_id = ctx.options.get("align_engine")
    aligner = get_aligner(engine_id)
    provenance = alignment_provenance(aligner.id, lang)
    ctx.entry.note(**provenance)
    if aligner.id == "simalign":
        # Only a registered source id goes in `inputs`; the fallback is an in-tree
        # algorithm with no source row, and inventing one would put a name in the
        # provenance log that `config.SOURCES` cannot resolve.
        ctx.entry.record_input("simalign")

    register = ctx.options.get("register")
    if register is None:
        slots = {row["register_slot"] for row in inputs.units.values()}
        register = DEFAULT_REGISTER_BY_SLOT[sorted(slots)[0]] if slots else "neutral"
    if register not in REGISTERS:
        return StageResult(
            ok=False,
            message=f"register {register!r} is not one of {', '.join(REGISTERS)}",
        )

    # Pass 1: align every selected sentence, so glosses and the alternatives index are
    # complete before any distractor is drawn. A distractor chosen against a half-built
    # index is a valid alternative nobody noticed.
    alignments: dict[str, list[tuple[int, int]]] = {}
    alternatives = AlternativesIndex()
    for item in inputs.selected:
        text, translation, sid = _resolve_text(inputs, item)
        pairs = aligner.align(translation.split(), _target_tokens(inputs, sid, text))
        alternatives.add(_alt_key(item, sid, text), [text, translation])
        if sid is not None:
            alignments[sid] = list(pairs)

    glosses = build_glosses(inputs, alignments)
    for lemma, gloss in glosses.items():
        alternatives.add(f"lexeme:{lemma}", [lemma, gloss])

    # Pass 2: expand.
    drafts: list[ExerciseDraft] = []
    try:
        for item in inputs.selected:
            _text, _translation, sid = _resolve_text(inputs, item)
            drafts.extend(
                expand_item(
                    inputs,
                    item,
                    alignment=alignments.get(sid or "", []),
                    register=register,
                    alternatives=alternatives,
                    glosses=glosses,
                )
            )
        for (unit, lesson), lemmas in _lemmas_by_lesson(inputs).items():
            match = build_match_pairs(
                inputs,
                unit=unit,
                lesson=lesson,
                lemmas=lemmas,
                glosses=glosses,
                register=register,
            )
            if match is not None:
                drafts.append(match)
    except (NotEnoughDistractors, KeyError, ValueError) as exc:
        return StageResult(ok=False, message=f"{type(exc).__name__}: {exc}")

    records = [draft.to_record() for draft in drafts]

    # The gates, before the write. A pack that fails one never exists on disk.
    blocking = [
        finding
        for finding in (
            *check_pack_07(records),
            *check_pack_50(records),
            *check_v5(records, pos_of=inputs.pos_of),
        )
        if finding.severity == "blocking"
    ]
    if blocking:
        ctx.entry.note(gate_failures=[finding.message for finding in blocking[:20]])
        return StageResult(
            ok=False,
            message=(
                f"{len(blocking)} blocking finding(s) from the G7 gates "
                f"(INV-PACK-07, INV-PACK-50, V5); first: {blocking[0].message}"
            ),
            detail={"blocking": len(blocking)},
        )

    written = write_records("exercise", records, lang=lang)
    ctx.entry.record_output("exercise")
    ctx.entry.read = len(inputs.selected)
    ctx.entry.written = written
    ctx.entry.note(
        shapes={
            shape_id: sum(1 for draft in drafts if draft.shape_id == shape_id)
            for shape_id in sorted({draft.shape_id for draft in drafts})
        },
        types_emitted=sorted({record["type"] for record in records}),
        types_declared=list(EXERCISE_TYPES),
        register=register,
        tool=f"{TOOL_NAME} {__version__}",
    )
    return StageResult(ok=True, message=f"{written} exercises", detail={"written": written})


def _alt_key(item: Mapping[str, Any], sid: str | None, text: str) -> str:
    """The alternatives-index key for one slot. Must match `_sentence_draft`'s."""
    if sid:
        return f"sentence:{sid}"
    return f"authored:{item['unit_index']}:{item['lesson_index']}:{text}"


def _lemmas_by_lesson(inputs: ExpansionInputs) -> dict[tuple[int, int], list[str]]:
    by_lesson: dict[tuple[int, int], list[str]] = {}
    for item in inputs.selected:
        key = (item["unit_index"], item["lesson_index"])
        bucket = by_lesson.setdefault(key, [])
        for lemma in item["new_lemmas"]:
            if lemma not in bucket:
                bucket.append(lemma)
    return by_lesson
