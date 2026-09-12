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
5. **Draw a decoy from the wrong language, or from the prompt.** The direction decides
   the pool: an English tile grid (`word_bank_reverse`, S035 `Write this in English`)
   takes English tiles from `L1DecoyPool`, because the rule core's POS tags and
   frequency bands are facts about the COURSE language and say nothing about an English
   word. And no decoy, in either direction, may be a token of the sentence rendered
   above the option list. Both of those shipped once — `["aprendo", "está",
   "conocerte"]` under `Write this in English / La sopa está muy rica.` — and V5 cannot
   catch either, because its POS clause can only be evaluated against the
   course-language ledger.

## Where the alignment goes

`exercise` has an `alignment` array and no field for tiles, tile order or hints, so the
pairs ride on the records whose shape declares `needs_alignment` and the player
re-derives the dotted underlines from them with `exercises/wordbank.py::build_hints`.
The stage runs `build_hints` itself at build time and writes the COUNT to the runlog
(`word_bank_hints`), so a pack whose aligner produced no hintable token says so in a
number rather than shipping a feature that renders nothing.

## Why `audio_ref` can be filled before G8 runs

G8 is content-addressed: a clip's id is a hash of what is spoken. So G7 computes the
same id with the same function (`artifacts.sentence_id`) and G8 either finds the clip
or bakes it. The alternative — a second pass over the exercise file after the bake —
would make the exercise artefact mutable, and every id downstream of it with it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from .. import __version__
from ..artifacts import read_records, sentence_id, write_records
from ..config import EXERCISE_TYPES, TOOL_NAME
from ..config.g7 import (
    CHAT_TURN_SEPARATOR,
    DEFAULT_REGISTER_BY_SLOT,
    ENDING_POS_PREFERENCE,
    ENDING_SEGMENTATION_LANGUAGES,
    GAP_MARKER,
    GRAMMAR_FORM_PLAN,
    LEXEME_FORM_PLAN,
    MATCH_PAIR_SEPARATOR,
    MATCH_PAIRS_PER_EXERCISE,
    MAX_ENDING_CHARS,
    MIN_ENDING_STEM_CHARS,
    MIN_FORMS_PER_MISSABLE_ITEM,
    REGISTERS,
    SENTENCE_FORM_PLAN,
    SPANISH_INFINITIVE_ENDINGS,
    VERB_POS,
)
from ..exercises.alignment import alignment_provenance, get_aligner
from ..exercises.distractors import (
    AlternativesIndex,
    DistractorPool,
    L1DecoyPool,
    NotEnoughDistractors,
    rule_core_distractors,
)
from ..exercises.shapes import ExerciseDraft, shape
from ..exercises.wordbank import Hint, build_hints, build_word_bank
from ..ledger import surface_tokens
from ..runlog import require_successful
from ..validators.exercise import check_pack_07, check_pack_50, check_v5
from . import StageContext, StageResult, register_stage

__all__ = ["ExpansionInputs", "ending_split", "expand", "expand_item"]


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
    #: English decoy tiles for the reverse word bank. A separate pool because the rule
    #: core's POS tags and frequency bands describe the COURSE language and mean nothing
    #: about an English tile.
    l1_pool: L1DecoyPool
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
        l1_pool=L1DecoyPool.build(
            [row["translation"] for row in ingested],
            exclude_lemmas=[row["lemma"] for row in banded],
        ),
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


#: The characters a whitespace split leaves glued to a word. G1's `display_tokens` are
#: LEXICAL surfaces — spaCy has already put punctuation in its own token with its own
#: offsets — so a fallback that keeps them produces a different kind of list from the
#: same sentence depending on which stage saw it first.
_EDGE_PUNCTUATION: Final[str] = ".,¿?¡!:;«»\"'()…—-"


def _display_split(text: str) -> list[str]:
    """A whitespace split, stripped to lexical surfaces. G1's shape, without a model.

    THE PUNCTUATION MATTERS AND IT STOPPED A BUILD. An authored candidate has no
    `analysed_sentence` — G5 lemmatises it to filter it and the frozen `candidate`
    record has nowhere to put the result — so G7 falls back to a split here. It used to
    be a bare whitespace split, which makes `Hola,` and `noche.` word-bank tiles, and the
    distractor core is then asked for two same-POS same-band lexemes for a string that
    is in no lexicon: POS empty, band `unbanded`, zero candidates, `NotEnoughDistractors`,
    and the whole stage fails on a sentence that is perfectly good. Measured on this Mac,
    2026-09-12, against the real corpus:

        g7 failed: NotEnoughDistractors: concept:subject_pronouns: needed 2 distractors
        for 'Hola,' (POS , band unbanded) and the rule core found 0.

    The asymmetry was the tell: `_lemmas_for`'s fallback already stripped the same
    characters, so the lemmas were clean and the tiles were not, from one sentence.

    Still not analysis, and deliberately not: no lemmatiser runs here, because a second
    analyser version in the pipeline is the drift INV-PACK-40 is about. This is the same
    whitespace split it always was, with the edges trimmed.
    """
    return [
        stripped for token in surface_tokens(text) if (stripped := token.strip(_EDGE_PUNCTUATION))
    ]


def _target_tokens(inputs: ExpansionInputs, sid: str | None, text: str) -> list[str]:
    """G1's `display_tokens` where the sentence was analysed, else a stripped split."""
    if sid is not None and sid in inputs.analysed:
        return list(inputs.analysed[sid]["display_tokens"])
    return _display_split(text)


def _lemmas_for(inputs: ExpansionInputs, sid: str | None, text: str) -> list[str]:
    if sid is not None and sid in inputs.analysed:
        return list(inputs.analysed[sid]["lemmas"])
    return [token.casefold() for token in _display_split(text)]


def ending_split(surface: str, lemma: str, pos: str, lang: str) -> tuple[str, str] | None:
    """`(stem, ending)` for one surface form, or `None` when it has no separable ending.

    `deep/00-PRODUCT-MAP` §3.2 row S039 obliges the pipeline to store "a morphological
    segmentation per surface form". The previous implementation chopped the last two
    characters off the longest token in the sentence and shipped
    `El pan está calien____` with the accepted answer `te`; `te` is not an ending of
    `caliente`, and a learner who typed one would be told they were wrong for the same
    reason the pack was.

    Two rules, one per word class, and both refuse rather than guess:

    * A **verb** whose lemma is a regular infinitive has the stem `lemma[:-2]`:
      `correr` -> `corr`, so `corre` is `corr` + `e`, and `estar` -> `est`, so `está` is
      `est` + `á`. A stem-CHANGING form does not begin with that stem — `tener` gives
      `ten`, and the surface is `tiene` — and gets no split at all, because its ending
      cannot be separated from the stem change and a drill on it would teach a rule
      that is false.
    * Anything else splits at the longest common prefix with its own lemma:
      `cuartos`/`cuarto` -> `cuarto` + `s`, `rica`/`rico` -> `ric` + `a`. A surface
      equal to its lemma (`caliente`) has no ending and gets nothing.

    Guarded on both sides: `MIN_ENDING_STEM_CHARS` because `t____` is unanswerable, and
    `MAX_ENDING_CHARS` because a five-character "ending" is a different word.
    """
    if lang not in ENDING_SEGMENTATION_LANGUAGES:
        return None
    if not surface or not lemma:
        return None
    folded_surface = surface.casefold()
    folded_lemma = lemma.casefold()

    if pos in VERB_POS and folded_lemma[-2:] in SPANISH_INFINITIVE_ENDINGS:
        stem = folded_lemma[:-2]
        if not folded_surface.startswith(stem):
            # A stem change (tener -> tiene). Not segmentable by this rule, and this
            # rule is the only one that is true of Spanish verbs.
            return None
        cut = len(stem)
    else:
        cut = 0
        for left, right in zip(folded_surface, folded_lemma, strict=False):
            if left != right:
                break
            cut += 1

    stem_text, ending = surface[:cut], surface[cut:]
    if len(stem_text) < MIN_ENDING_STEM_CHARS:
        return None
    if not 1 <= len(ending) <= MAX_ENDING_CHARS:
        return None
    return stem_text, ending


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

    `alignment` is the pass-1 word alignment for this slot, and it is written ONTO the
    drafts whose shape declares `needs_alignment`. It is the only learner-visible use
    the aligner has that survives the frozen contract: the record has an `alignment`
    array and no field for tiles, tile order or hints, so the player re-derives the
    dotted underlines from these pairs with the rule in `exercises/wordbank.py`.
    """
    lang = inputs.lang
    text, translation, sid = _resolve_text(inputs, item)
    unit = item["unit_index"]
    lesson = item["lesson_index"]
    concept = item["grammar_concept"]
    target_tokens = _target_tokens(inputs, sid, text)
    source_tokens = list(surface_tokens(translation))
    lemmas = _lemmas_for(inputs, sid, text)
    audio = sentence_id(lang, text)
    pairs = tuple(sorted({(int(a), int(b)) for a, b in alignment}))

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
                alignment=pairs,
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
            draft = _grammar_draft(
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
            if draft is not None:
                drafts.append(draft)

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
    alignment: tuple[tuple[int, int], ...] = (),
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
        body = "" if chosen.id == "tap_what_you_hear" else body
        decoys = _decoys(
            inputs,
            lemmas=lemmas,
            count=chosen.distractor_count,
            key=key,
            accepted=answer_tokens,
            alternatives=alternatives,
            # THE DIRECTION DECIDES THE POOL. A bank rendered in English takes English
            # tiles; drawing them from the course-language ledger put `aprendo`,
            # `está` and `conocerte` under the prompt `Write this in English`, and
            # `está` was a word of the Spanish sentence displayed above the bank.
            l1_side=reverse,
            prompt_tokens=list(surface_tokens(body)),
        )
        bank = build_word_bank(answer_tokens, decoys, key=f"{key}:{chosen.id}")
        distractors = bank.extra_tiles
    elif chosen.id in {"fill_in_the_blank", "listen_for_the_missing_word"}:
        gap_index = _gap_index(target_tokens)
        body = _gapped(target_tokens, gap_index)
        accepted = (target_tokens[gap_index],)
        body = "" if chosen.id == "listen_for_the_missing_word" else body
        distractors = _decoys(
            inputs,
            lemmas=[target_tokens[gap_index]],
            count=chosen.distractor_count,
            key=key,
            accepted=list(accepted),
            alternatives=alternatives,
            prompt_tokens=list(surface_tokens(body)),
        )
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
        # The pairs ride on the record for the shapes that need them, and on no other:
        # a `speak_this_sentence` row carrying an alignment would be an unused array in
        # every pack forever.
        alignment=alignment if chosen.needs_alignment else (),
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
    l1_side: bool = False,
    prompt_tokens: Sequence[str] = (),
) -> tuple[str, ...]:
    """`count` distractors for one slot, drawn from the pool the DIRECTION selects.

    `l1_side=True` means the option list is rendered in English (`word_bank_reverse`,
    S035 `Write this in English`), and English tiles come from `inputs.l1_pool`. The
    course-language rule core is not an option there: its POS tags, its bands and its
    attested inflections are all facts about Spanish, so asking it for an English tile
    returns a Spanish word, and V5 cannot catch it because it can only POS-check against
    the course-language ledger.

    `prompt_tokens` are the tokens of the sentence actually displayed above the option
    list. A decoy that appears in the prompt makes the exercise answerable by copying,
    and in the reverse bank it was also the giveaway that the pool was the wrong one.
    """
    if count == 0:
        return ()
    if l1_side:
        return inputs.l1_pool.decoys(
            key=key,
            accepted=accepted,
            prompt_tokens=prompt_tokens,
            alternatives=alternatives,
            count=count,
        )
    anchor = max(lemmas, key=len) if lemmas else accepted[0]
    pos = inputs.pos_of.get(anchor, "")
    band = inputs.band_of.get(anchor, "unbanded")
    forbidden_prompt = [token.strip(".,¿?¡!") for token in prompt_tokens]
    return rule_core_distractors(
        pool=inputs.pool,
        alternatives=alternatives,
        key=key,
        answer_surface=anchor,
        answer_lemma=anchor,
        pos=pos,
        band=band,
        accepted_answers=[*accepted, *(token for token in forbidden_prompt if token)],
        count=count,
    )


def _chat_distractor(
    inputs: ExpansionInputs,
    *,
    text: str,
    key: str,
    alternatives: AlternativesIndex,
) -> tuple[str, ...]:
    """S037's one wrong reply line, IN THE CASE IT WAS AUTHORED IN.

    A whole sentence, not a word, so the rule core's lexical machinery does not apply:
    the reply is another accepted answer from elsewhere in the ledger, which is a real
    Spanish sentence and is wrong only in this conversation. `alternatives` keeps it
    from being one of THIS item's accepted lines.

    `AlternativesIndex.everywhere` holds `normalise()`d keys — casefolded, because that
    is what a comparison index is for — and returning one of those keys shipped
    `el pan está caliente.` onto the screen as rendered copy. `originals` maps the key
    back to the sentence as the ledger wrote it, and this function returns that.
    """
    _ = inputs
    forbidden = alternatives.forbidden_for(key) | {text.casefold()}
    for other in sorted(alternatives.everywhere):
        if other not in forbidden and len(surface_tokens(other)) > 1:
            return (alternatives.original(other),)
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
) -> ExerciseDraft | None:
    """A grammar concept drilled, never quoted. INV-PACK-50's positive case.

    `focus="grammar_concept"` is what makes `route()` refuse picture-select and
    meaning-select for this draft, and what makes the NEW WORD pill impossible on it.

    Returns `None` when the shape cannot be authored honestly. That happens for exactly
    one shape and one reason: `type_the_word_ending` needs a surface form with a
    separable morphological ending (`ending_split`), and a sentence whose every token is
    a stem-changing verb, a citation-form adjective or an unanalysed authored candidate
    has none. Dropping the drill is safe for INV-PACK-07 — a grammar draft carries
    `source_sentence_id`, so `validators.exercise.item_keys` files it under the sentence
    item, whose `SENTENCE_FORM_PLAN` row already carries two punitive forms — and the
    stage records the skip on the runlog rather than swallowing it.
    """
    lang = inputs.lang
    key = f"sentence:{sid}" if sid else f"concept:{concept}"
    if shape_id == "type_the_word_ending":
        segmented = _ending_target(inputs, sid, target_tokens)
        if segmented is None:
            return None
        gap_index, stem, ending = segmented
        body = " ".join(
            f"{stem}{GAP_MARKER}" if position == gap_index else token
            for position, token in enumerate(target_tokens)
        )
        accepted: tuple[str, ...] = (ending,)
        distractors: tuple[str, ...] = ()
    else:
        gap_index = _gap_index(target_tokens)
        body = _gapped(target_tokens, gap_index)
        accepted = (target_tokens[gap_index],)
        distractors = _decoys(
            inputs,
            lemmas=[target_tokens[gap_index]],
            count=shape(shape_id).distractor_count,
            key=key,
            accepted=list(accepted),
            alternatives=alternatives,
            prompt_tokens=list(surface_tokens(body)),
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


def _ending_target(
    inputs: ExpansionInputs, sid: str | None, target_tokens: Sequence[str]
) -> tuple[int, str, str] | None:
    """`(token index, stem, ending)` of the best token to drill, or `None`.

    Needs G1's analysis, because a segmentation is a claim about a lemma and a POS and
    there is no way to make it from a bare surface string. An AUTHORED candidate (a G5
    gap slot) has not been through G1, so it gets no ending drill at all — inventing a
    lemma here would put a second analyser into the pipeline, which is the thing
    `_target_tokens` already refuses to do.

    Preference order is `ENDING_POS_PREFERENCE`: a verb before an adjective before a
    noun plural, because the concept rows this stage builds are verb-conjugation
    concepts. Ties break on the earliest token, so the choice is deterministic.
    """
    if sid is None or sid not in inputs.analysed:
        return None
    tokens = inputs.analysed[sid]["tokens"]
    best: tuple[int, int, str, str] | None = None
    for index, token in enumerate(tokens):
        if index >= len(target_tokens) or token["surface"] != target_tokens[index]:
            # display_tokens and tokens are the same list in G1's contract; if a pack
            # ever disagrees, refuse rather than drill the wrong word.
            continue
        split = ending_split(token["surface"], token["lemma"], token["pos"], inputs.lang)
        if split is None:
            continue
        rank = (
            ENDING_POS_PREFERENCE.index(token["pos"])
            if token["pos"] in ENDING_POS_PREFERENCE
            else len(ENDING_POS_PREFERENCE)
        )
        stem, ending = split
        if best is None or rank < best[0]:
            best = (rank, index, stem, ending)
    if best is None:
        return None
    _rank, index, stem, ending = best
    return index, stem, ending


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

    THAT IS A CONSTRAINT ON THE CALLER, and it is now enforced there rather than assumed
    here. `lemmas` must be lemmas that ALREADY carry `MIN_FORMS_PER_MISSABLE_ITEM`
    punitive lexeme-keyed drafts in this lesson (`_match_eligible_lemmas`). Feeding this
    function every glossed lemma in the lesson — the obvious fix for "S033 never ships" —
    builds a match over words that have no other lexeme form, and `item_keys` then files
    each of them as a SINGLE-FORM MISSABLE ITEM: INV-PACK-07 fails, in the exact way the
    ruling above says it must not.
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


def _match_eligible_lemmas(drafts: Sequence[ExerciseDraft]) -> dict[tuple[int, int], list[str]]:
    """`(unit, lesson) -> lemmas that already carry two punitive lexeme forms.`

    Read off the drafts that exist, not off `selected_item.new_lemmas`: a lemma whose
    `meaning_select` was dropped for want of a gloss has ONE punitive form, and putting
    it in a match would make the match its second — which reads fine until you notice
    the match is also the second form of four other words and none of them can recycle
    a mistake on this one.
    """
    punitive: dict[tuple[int, int], dict[str, set[str]]] = {}
    for draft in drafts:
        if draft.focus != "lexeme" or not draft.missable:
            continue
        bucket = punitive.setdefault((draft.unit_index, draft.lesson_index), {})
        for lemma in draft.lemmas:
            bucket.setdefault(lemma, set()).add(draft.shape_id)
    return {
        lesson: sorted(
            lemma
            for lemma, shapes in lemmas.items()
            if len(shapes) >= MIN_FORMS_PER_MISSABLE_ITEM
        )
        for lesson, lemmas in sorted(punitive.items())
    }


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
        translation = list(surface_tokens(inputs.translations.get(sid, "")))
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
        pairs = aligner.align(list(surface_tokens(translation)), _target_tokens(inputs, sid, text))
        alternatives.add(_alt_key(item, sid, text), [text, translation])
        if sid is not None:
            alignments[sid] = list(pairs)

    glosses = build_glosses(inputs, alignments)
    for lemma, gloss in glosses.items():
        alternatives.add(f"lexeme:{lemma}", [lemma, gloss])

    # Pass 2: expand.
    drafts: list[ExerciseDraft] = []
    hints_written = 0
    hinted_lemmas: set[str] = set()
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
            hints = _hints_for(inputs, item, alignments.get(sid or "", []))
            hints_written += len(hints)
            hinted_lemmas.update(hint.gloss for hint in hints)

        # Pass 3: matches, over the lemmas that are ALREADY taught twice. A match is a
        # second form, never a first: `item_keys` files it under one key per tagged
        # lemma, so a match over an untaught lemma makes that lemma a single-form
        # missable item and INV-PACK-07 fails.
        for (unit, lesson), lemmas in _match_eligible_lemmas(drafts).items():
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
    planned_endings = sum(
        1 for item in inputs.selected if item["slot_index"] == 0
    ) * GRAMMAR_FORM_PLAN.count("type_the_word_ending")
    ctx.entry.note(
        shapes={
            shape_id: sum(1 for draft in drafts if draft.shape_id == shape_id)
            for shape_id in sorted({draft.shape_id for draft in drafts})
        },
        types_emitted=sorted({record["type"] for record in records}),
        types_declared=list(EXERCISE_TYPES),
        register=register,
        # What the alignment actually bought, as two numbers rather than an adjective.
        # `alignment_pairs_written` is how many records carry the pairs the player needs
        # to draw a dotted underline; `word_bank_hints` is how many underlines those
        # pairs will produce under `HINT_ONLY_FOR_NEW_LEMMAS`. A fallback-aligned pack
        # with `word_bank_hints: 0` is a pack whose hint feature does not exist.
        alignment_pairs_written=sum(1 for record in records if record["alignment"]),
        word_bank_hints=hints_written,
        hinted_glosses=sorted(hinted_lemmas),
        # The ending drills that could not be segmented honestly. `deep/00-PRODUCT-MAP`
        # §3.2 S039 wants a morphological segmentation per surface form; a sentence with
        # no separable ending gets NO drill rather than a chopped-off suffix.
        ending_drills_planned=planned_endings,
        ending_drills_written=sum(
            1 for draft in drafts if draft.shape_id == "type_the_word_ending"
        ),
        tool=f"{TOOL_NAME} {__version__}",
    )
    return StageResult(ok=True, message=f"{written} exercises", detail={"written": written})


def _alt_key(item: Mapping[str, Any], sid: str | None, text: str) -> str:
    """The alternatives-index key for one slot. Must match `_sentence_draft`'s."""
    if sid:
        return f"sentence:{sid}"
    return f"authored:{item['unit_index']}:{item['lesson_index']}:{text}"


def _hints_for(
    inputs: ExpansionInputs,
    item: Mapping[str, Any],
    alignment: Sequence[tuple[int, int]],
) -> tuple[Hint, ...]:
    """The dotted underlines this slot's word banks will be able to render.

    `build_hints` is the rule — only tokens the alignment actually covers, and under
    `HINT_ONLY_FOR_NEW_LEMMAS` only tokens whose lemma is new in this lesson. The frozen
    `exercise` contract has no field for a hint list (a request to add one is in
    `docs/owned/p2-g7.json` beside the `shape` request), so what ships is the
    `alignment` array the hints are DERIVED from, and the player applies the same rule.
    Running it here is what makes that claim checkable: the count goes on the runlog, so
    a pack whose aligner produced no hintable token says so in a number instead of
    shipping a feature that silently renders nothing.
    """
    text, translation, sid = _resolve_text(inputs, item)
    if sid is None or sid not in inputs.analysed:
        return ()
    source_tokens = list(surface_tokens(translation))
    target_tokens = _target_tokens(inputs, sid, text)
    tokens = inputs.analysed[sid]["tokens"]
    lemma_of_source: list[str] = []
    by_source: dict[int, list[int]] = {}
    for source_index, target_index in alignment:
        by_source.setdefault(source_index, []).append(target_index)
    for index in range(len(source_tokens)):
        targets = [t for t in by_source.get(index, []) if 0 <= t < len(tokens)]
        lemma_of_source.append(tokens[targets[0]]["lemma"] if targets else "")
    pairs = [
        (source, target)
        for source, target in alignment
        if 0 <= source < len(source_tokens) and 0 <= target < len(target_tokens)
    ]
    return build_hints(
        source_tokens,
        target_tokens,
        pairs,
        new_lemmas=item["new_lemmas"],
        lemma_of_source_index=lemma_of_source,
    )
