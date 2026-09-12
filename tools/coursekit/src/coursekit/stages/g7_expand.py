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

## Why `audio_ref` can be filled before G8 runs, AND WHAT THAT COST ONCE

G8 is content-addressed, so G7 can name a clip before it exists: it computes the id
with the same function G8 will, and G8 either finds the clip or bakes it. The
alternative — a second pass over the exercise file after the bake — would make the
exercise artefact mutable, and every id downstream of it with it.

THE FUNCTION HAS TO BE THE SAME ONE, and for as long as this comment claimed it was, it
was not. G7 wrote `sentence_id(lang, text)`; G8 names clips `cast.rebake_key(cast, role,
text)`, which hashes the engine, the engine's pin, the voice spec, the codec, the
bitrate and the target loudness as well as the text, because INV-AUD-08 requires an
engine swap to re-bake the bank. Two different hashes of the same sentence, and nothing
compared them until G9 tried to insert both: measured on the real Spanish course,
2026-09-12, over units 1-3 — G8 baked 284 clips, all 198 exercises carrying an
`audio_ref` pointed at ids that were in no `audio` row, and G9's foreign-key gate said
so with `sqlite3.IntegrityError: FOREIGN KEY constraint failed`. It was invisible for
exactly as long as no run had G7's output and G8's output in the same tree.

So G7 loads the cast and computes the re-bake key. It makes this stage depend on
`content/<lang>/cast.yaml`, which is the honest dependency: a pack that cannot name its
clips cannot carry audio refs, and a missing cast is a `StageResult` naming the file.
The role is `LESSON_ROLE`, because that is the role G8's `plan_utterances` bakes every
exercise line in; a per-character dialogue line would need the role ON THE RECORD, which
the frozen contract has no field for (the request is in
`docs/owned/p2r3-expand-bake-package.json`).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from .. import __version__
from ..artifacts import read_records, sentence_id, write_records
from ..config import EXERCISE_TYPES, TOOL_NAME
from ..config.g7 import (
    CHAT_TURN_SEPARATOR,
    CURRENT_PHASE,
    DEFAULT_REGISTER_BY_SLOT,
    ENDING_POS_PREFERENCE,
    ENDING_SEGMENTATION_LANGUAGES,
    GAP_MARKER,
    GRAMMAR_FORM_PLAN,
    LEXEME_FORM_PLAN,
    LEXEME_MATCH_SHAPE,
    MATCH_PAIR_SEPARATOR,
    MATCH_PAIRS_PER_EXERCISE,
    MAX_ENDING_CHARS,
    MIN_ENDING_STEM_CHARS,
    MIN_FORMS_PER_MISSABLE_ITEM,
    PHASE_ORDER,
    REGISTERS,
    SENTENCE_FORM_PLAN,
    SHAPES,
    SPANISH_INFINITIVE_ENDINGS,
    VERB_POS,
)
from ..config.g8 import LESSON_ROLE
from ..exercises.alignment import alignment_provenance, get_aligner
from ..exercises.distractors import (
    AlternativesIndex,
    DistractorPool,
    L1DecoyPool,
    NotEnoughDistractors,
    normalise,
    rule_core_distractors,
)
from ..exercises.shapes import ExerciseDraft, focus_for_item, shape
from ..exercises.wordbank import Hint, build_hints, build_word_bank
from ..ledger import surface_tokens
from ..runlog import require_successful
from ..tts.cast import Cast, CastError, load_cast, rebake_key
from ..validators.exercise import check_pack_07, check_pack_50, check_v5, pos_sets
from . import StageContext, StageResult, register_stage

__all__ = [
    "ExpansionInputs",
    "MissingAnalysis",
    "ResolvedSlot",
    "StarvedSlot",
    "ending_split",
    "expand",
    "expand_item",
]


class StarvedSlot(LookupError):
    """A gap slot G6 left with no accepted candidate.

    B14: the message was always right and the type was always wrong. Every other stage
    reports a content failure as `StageResult(ok=False, ...)` and the dispatcher exits 4
    with one line; this one raised a bare `KeyError` out of pass 1, which is outside the
    `try` the other failures are caught in, so it printed a Python traceback. A
    `LookupError` rather than a `KeyError` because `KeyError.__str__` wraps the message in
    the repr of its argument, and the message is meant to be read by a person.
    """


class MissingAnalysis(ValueError):
    """An authored candidate G7 must expand whose `analysis` is `null`.

    The coded half of the B16 contract, and the whole reason `candidate.analysis` was
    added to the frozen record. `artifacts.CANDIDATE`'s docstring states the rule: "an
    authored row G7 is asked to expand and whose `analysis` is null stops the stage naming
    the candidate_id, rather than silently falling back to the surface, which is the bug
    this field exists to delete." No schema keyword can say "non-null exactly when G7 will
    read it" (a row rejected on an axis evaluated before the analyser runs legitimately
    carries `null`), so the check lives here.
    """


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
    #: The voice cast, loaded because a clip's id is a hash over the ENGINE and the
    #: voice as well as the text (INV-AUD-08). G7 names clips G8 has not baked yet, so
    #: it has to name them with G8's function or G9's foreign keys fail — which is
    #: exactly what happened, see the module docstring.
    cast: Cast | None = None
    #: `string -> every UD tag the course attests for it`, from the banded ledger and
    #: every token G1 tagged. The V5 gate compares SETS: a `wrong_form` distractor is an
    #: attested surface, and looking a surface up in a lemma table answers a different
    #: question — see `validators/exercise.py::pos_sets`.
    pos_sets: dict[str, set[str]] = field(default_factory=dict)


def _audio_id(inputs: ExpansionInputs, text: str) -> str:
    """The clip id G8 will bake this line under. G8's function, not a second one.

    Falls back to `sentence_id` ONLY when there is no cast, which `expand` refuses
    before it gets here — the fallback exists so a caller holding a hand-built
    `ExpansionInputs` (the unit tests) does not have to carry a cast file.
    """
    if inputs.cast is None:
        return sentence_id(inputs.lang, text)
    return rebake_key(inputs.cast, LESSON_ROLE, text)


def _load(lang: str) -> ExpansionInputs:
    analysed = {row["sentence_id"]: row for row in read_records("analysed_sentence", lang=lang)}
    banded = list(read_records("banded_lemma", lang=lang))
    units = {row["unit_index"]: row for row in read_records("unit_assignment", lang=lang)}
    selected = list(read_records("selected_item", lang=lang))
    ingested = list(read_records("ingested_sentence", lang=lang))

    # FIRST accepted row per slot, and `setdefault` is the whole of that — it used to be
    # `candidates[key] = row`, which is LAST-wins.
    #
    # G5 does not accept one row per slot. It measures every authored row against the
    # five reject axes and marks each `accepted` independently; `slot_filled` only
    # records that the slot HAS a fill, and the fill is the FIRST accepted row in shard
    # order (`stages/g5_gapfill.py`, `if not slot_filled`). So a slot whose window admits
    # two authored texts emits two accepted rows, G5's runlog names the first, and
    # last-wins here made the learner meet the second. Nothing in either stage said so.
    #
    # Measured at the P2 round-3 integration, on `u1/l1/s0`: B9(a)'s lemma-normalisation
    # table brought three more of that shard's twenty rows into the five-lemma window, so
    # G5 accepted four (`Hola.`, `Buenas noches.`, `¡Buenas tardes!`,
    # `Buenos días, buenas tardes.`), reported `Hola.` as the fill, and G7 expanded
    # `Buenos días, buenas tardes.` — a word list where the course teaches `hola`. The
    # other eight slots have one accepted row each only because G5's `duplicate` axis
    # rejects those same three texts once the unit has seen them, which is luck about
    # ordering rather than a property.
    #
    # First-wins makes the two stages name the same sentence by construction. It needs no
    # new field on the frozen CANDIDATE contract (the deps lane owns that), and it holds
    # for whatever G5 accepts, because `write_records`/`read_records` preserve the order
    # G5 appended in.
    candidates: dict[tuple[int, int, int], Mapping[str, Any]] = {}
    if any(item["gap"] for item in selected):
        for row in read_records("candidate", lang=lang):
            if row["accepted"]:
                candidates.setdefault(
                    (row["unit_index"], row["lesson_index"], row["slot_index"]), row
                )

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
        pos_sets=pos_sets(banded, analysed.values()),
        cast=load_cast(lang),
    )


@dataclass(frozen=True, slots=True)
class ResolvedSlot:
    """One selected slot, resolved: its text, its translation, and its ANALYSIS.

    The analysis is the point. A corpus slot gets G1's `analysed_sentence` row; an
    authored slot gets the `analysis` G5 wrote onto its `candidate` record (B16, option
    2), which is the same four fields in the same shape from the same pinned adapter. So
    every reader below — the word-bank tiles, the cloze lemma, the ending segmentation —
    treats a corpus row and an authored row identically instead of having a second,
    worse code path for authored text. That second path is where B15 and B16 both lived:
    a bare whitespace split made `Hola,` a tile, and a casefolded surface made `tardes`
    the lemma handed to the distractor core, which has no row for it.
    """

    text: str
    translation: str
    #: `None` for an authored slot. It is also what the pack records as
    #: `source_sentence_id`, which is how the manifest's provenance split is computed.
    sid: str | None
    #: G1's row or G5's `candidate.analysis`, in G1's shape. `None` only for a corpus
    #: sentence G1 never analysed.
    analysis: Mapping[str, Any] | None
    #: The authored row this slot came from, for the message an error has to name.
    candidate_id: str | None


def _resolve(inputs: ExpansionInputs, item: Mapping[str, Any]) -> ResolvedSlot:
    """Resolve one slot, or fail by name. Never returns a slot G7 has to guess about.

    Two named failures, and both used to be something worse:

    * a **starved** gap slot raised a bare `KeyError` out of a pass the stage does not
      catch, so it printed a traceback where every other stage prints a line (B14);
    * an authored row with **no analysis** silently fell back to the surface at the gap
      index, and the surface of an inflected form is in no lexicon (B16).
    """
    if item["gap"]:
        key = (item["unit_index"], item["lesson_index"], item["slot_index"])
        candidate = inputs.candidates.get(key)
        if candidate is None:
            raise StarvedSlot(
                f"selected slot {key} is a gap and no accepted candidate exists for it. "
                "G5 over-generates and G6 rejects; a slot with no survivor is a content "
                "failure, not something G7 may fill."
            )
        analysis = candidate.get("analysis")
        if analysis is None:
            raise MissingAnalysis(
                f"candidate {candidate['candidate_id']} (slot {key}, "
                f"{candidate['text']!r}) carries analysis: null and G7 is being asked to "
                "expand it. G5 writes its own adapter pass onto every row it analysed; a "
                "null there means this row was rejected before the analyser ran, so it "
                "cannot be an accepted candidate. G7 will not fall back to the surface: "
                "that fallback handed 'tardes' to the distractor core where 'tarde' "
                "belongs, and it is the bug candidate.analysis exists to delete (B16)."
            )
        return ResolvedSlot(
            text=candidate["text"],
            translation=candidate["translation"],
            sid=None,
            analysis=analysis,
            candidate_id=str(candidate["candidate_id"]),
        )
    sid = item["sentence_id"]
    if sid not in inputs.texts:
        raise StarvedSlot(f"selected item names sentence {sid} which G0 never ingested")
    return ResolvedSlot(
        text=inputs.texts[sid],
        translation=inputs.translations[sid],
        sid=sid,
        analysis=inputs.analysed.get(sid),
        candidate_id=None,
    )


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


def _target_tokens(slot: ResolvedSlot) -> list[str]:
    """The analysis's `display_tokens`, whoever analysed it. Else a stripped split.

    The fallback is now reachable for ONE case only: a corpus sentence G0 ingested and G1
    never analysed. An authored slot cannot reach it — `_resolve` refuses a `null`
    analysis by name — which is what makes the tiles and the lemmas below the same list
    for authored and corpus text alike.
    """
    if slot.analysis is not None:
        return list(slot.analysis["display_tokens"])
    return _display_split(slot.text)


def _lemmas_for(slot: ResolvedSlot) -> list[str]:
    """The analysis's `lemmas`, index-aligned with `_target_tokens`.

    THE CASEFOLDED SURFACE IS GONE, and it is what B16 was about. This used to return
    `[token.casefold() for token in _display_split(text)]` for every authored slot, so
    `_anchor_lemma` handed the distractor core `tardes` (a surface) where `tarde` (a
    lemma) belongs: `pos_of`/`band_of` are keyed by lemma because `banded_lemma` is, the
    lookup missed, POS came out empty and the band `unbanded`, and the rule core found
    zero candidates and stopped the stage. Every authored item whose gap lands on an
    inflected or capitalised form was exposed, which over 490 authored slots is most of
    them.
    """
    if slot.analysis is not None:
        return list(slot.analysis["lemmas"])
    return [token.casefold() for token in _display_split(slot.text)]


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


def _exercise_id(
    lang: str, unit: int, lesson: int, shape_id: str, body: str, *answers: str
) -> str:
    """Content-addressed, so a rebuild that did not change the item keeps its FSRS row.

    THE ANSWER IS PART OF THE CONTENT, and leaving it out was a collision. The id was
    `(unit, lesson, shape, body)`, and for a `l1_to_l2` shape the body is the ENGLISH
    prompt — so two different Spanish sentences with one English translation in the same
    lesson produced ONE id with two different accepted answers. Measured on the real
    course, 2026-09-12: `Dos más dos es cuatro.` and `Dos más dos son cuatro.` are both
    slots of unit 2 lesson 12 and both render `Write this in Spanish / Two plus two makes
    four.`, and G9 refused the pack with `UNIQUE constraint failed: exercise.exercise_id`.
    Downstream of that constraint it is worse than a refused build: one id means one FSRS
    row for two items, so answering one would schedule the other.

    The accepted answer is exactly what `packbuild.itemid.item_id` already hashes as
    `preferredSurface`, so this makes the artefact id as discriminating as the pack id it
    becomes. Every exercise id in the course moves, which is free at P2 (no pack has
    shipped) and is why INV-PACK-02's additive-only clause is scoped to a major version.
    """
    parts = "\x1f".join((str(unit), str(lesson), shape_id, body, *answers))
    return sentence_id(lang, parts)


def _gapped(slot: ResolvedSlot, tokens: Sequence[str], index: int) -> str:
    """The sentence with one blank, CUT OUT OF THE ORIGINAL TEXT where possible.

    Two things depend on the original text rather than on a space-joined token list,
    and the second one is a defect this replaced:

    * what the learner reads. `display_tokens` are LEXICAL tokens — spaCy puts
      punctuation in its own token — so joining them renders `¿Dónde está la ____` with
      no question marks and no full stop, which is not Spanish.
    * what the clip is. `listen_for_the_missing_word` is "audio plus a sentence with one
      gap" (`deep/01` §S038), so the audio is the WHOLE sentence and the only place G8
      can recover it from is this body with the blank filled back in. If the body is a
      detokenised approximation, the recovered string is not the sentence G7 named a
      clip for, the clip ids differ, and G9's foreign keys reject the pack.

    So the gap is the token's own span, taken from the analysis offsets — which is what
    `CandidateAnalysis` says they are carried for — and the span is verified against the
    surface before it is trusted. A slot with no analysis, or offsets that do not line
    up, falls back to the join it always was.
    """
    analysis = slot.analysis
    if analysis is not None and index < len(analysis["tokens"]):
        token = analysis["tokens"][index]
        start, end = int(token["start"]), int(token["end"])
        if slot.text[start:end] == token["surface"]:
            return f"{slot.text[:start]}{GAP_MARKER}{slot.text[end:]}"
    return " ".join(GAP_MARKER if position == index else token
                    for position, token in enumerate(tokens))


# ---------------------------------------------------------------------------
# Expansion
# ---------------------------------------------------------------------------


def expand_item(
    inputs: ExpansionInputs,
    item: Mapping[str, Any],
    *,
    slot: ResolvedSlot,
    alignment: Sequence[tuple[int, int]],
    register: str,
    alternatives: AlternativesIndex,
) -> list[ExerciseDraft]:
    """Every SENTENCE and GRAMMAR draft for one selected slot. Nothing lexeme-focused.

    The shape list comes from `SENTENCE_FORM_PLAN`, rotated by `slot_index` so a lesson
    does not render one sentence thirteen ways. Every row of that plan carries two
    punitive shapes, which is where INV-PACK-07 is satisfied for a sentence item — the
    validator that follows is there to catch a plan somebody edits.

    **A word or a fixed phrase is not a sentence item and gets nothing here.** Ruling
    B9(b) makes lesson 1 words and fixed phrases, and `focus_for_item` is what keeps them
    out of the sentence shapes: a one-token `word_bank_forward` is a bank whose answer is
    one tile among four and a one-token `fill_in_the_blank` blanks the only word on
    screen. Both are well-formed records, so nothing downstream can catch them. Their
    lemmas are introduced by `_lexeme_pass` instead, which is S032/S033/S034's job.

    `alignment` is the pass-1 word alignment for this slot, and it is written ONTO the
    drafts whose shape declares `needs_alignment`. It is the only learner-visible use
    the aligner has that survives the frozen contract: the record has an `alignment`
    array and no field for tiles, tile order or hints, so the player re-derives the
    dotted underlines from these pairs with the rule in `exercises/wordbank.py`.
    """
    text, translation = slot.text, slot.translation
    unit = item["unit_index"]
    lesson = item["lesson_index"]
    concept = item["grammar_concept"]
    target_tokens = _target_tokens(slot)
    source_tokens = list(surface_tokens(translation))
    lemmas = _lemmas_for(slot)
    audio = _audio_id(inputs, text)
    pairs = tuple(sorted({(int(a), int(b)) for a, b in alignment}))

    if focus_for_item(len(target_tokens)) != "sentence":
        return []

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
                slot=slot,
                alternatives=alternatives,
                alignment=pairs,
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
                slot=slot,
                target_tokens=target_tokens,
                lemmas=lemmas,
                register=register,
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
    slot: ResolvedSlot,
    alternatives: AlternativesIndex,
    alignment: tuple[tuple[int, int], ...] = (),
) -> ExerciseDraft:
    chosen = shape(shape_id)
    lang = inputs.lang
    sid = slot.sid
    key = f"sentence:{sid}" if sid else f"authored:{unit}:{lesson}:{text}"
    # What `item_keys` will file the record under. For a corpus sentence that is `key`;
    # for an authored one it is the concept, which is why the two are separate names.
    item_key = f"sentence:{sid}" if sid else f"concept:{concept}"
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
            item_key=item_key,
        )
        bank = build_word_bank(answer_tokens, decoys, key=f"{key}:{chosen.id}")
        distractors = bank.extra_tiles
    elif chosen.id in {"fill_in_the_blank", "listen_for_the_missing_word"}:
        gap_index = _gap_index(target_tokens)
        # The gapped sentence stays ON THE RECORD for both shapes. It used to be blanked
        # for `listen_for_the_missing_word`, which contradicts the product map — S038 is
        # "audio plus a sentence with one gap" (`deep/01` §S038) — and left G8 with no
        # way to recover the sentence its clip is of.
        body = _gapped(slot, target_tokens, gap_index)
        accepted = (target_tokens[gap_index],)
        if chosen.needs_audio:
            # S038's clip is the whole sentence, and G8 recovers it from THIS BODY with
            # the blank filled back in (`SPOKEN_TEXT_SOURCE`). So the id is computed over
            # the same string rather than over `text`: where the analysis offsets let
            # `_gapped` cut the span out of the sentence the two are identical, and where
            # they do not — a fixture, a ledger with synthetic offsets — they must still
            # agree, because a clip id that disagrees is a dangling foreign key in the
            # pack and a listening exercise that resolves to no file.
            audio = _audio_id(inputs, body.replace(GAP_MARKER, accepted[0]))
        distractors = _decoys(
            inputs,
            lemmas=[_anchor_lemma(lemmas, gap_index, target_tokens[gap_index])],
            count=chosen.distractor_count,
            key=key,
            accepted=list(accepted),
            alternatives=alternatives,
            prompt_tokens=list(surface_tokens(body)),
            item_key=item_key,
        )
    elif chosen.id == "complete_the_translation":
        gap_index = _gap_index(target_tokens)
        body = translation + "\n" + _gapped(slot, target_tokens, gap_index)
        accepted = (target_tokens[gap_index],)
    elif chosen.id == "complete_the_chat":
        body = translation
        distractors = _chat_distractor(inputs, text=text, key=key, alternatives=alternatives)

    return ExerciseDraft(
        lang=lang,
        exercise_id=_exercise_id(lang, unit, lesson, chosen.id, body or text, *accepted),
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


def _anchor_lemma(lemmas: Sequence[str], index: int, surface: str) -> str:
    """The LEMMA of the gapped token, for the distractor core. Not its surface.

    `_decoys` uses its `lemmas` argument as both `answer_lemma` and the key into
    `pos_of` / `band_of`, and both of those are keyed by LEMMA because `banded_lemma` is.
    Both call sites used to hand it `target_tokens[gap_index]`, which is a SURFACE, and it
    only ever worked because a lowercase mid-sentence Spanish surface is often its own
    lemma. It is not for a capitalised first word, and it is never one for an authored
    candidate, which has no analysis at all:

        g7 failed: NotEnoughDistractors: concept:subject_pronouns: needed 2 distractors
        for 'Hola' (POS , band unbanded) and the rule core found 0.

    `Hola` is in no lexicon; `hola` is a banded lemma. Measured on this Mac, 2026-09-12,
    on the first run G7 ever made over authored content.

    The two lists are index-aligned by construction — `display_tokens` and `lemmas` are
    both the LEXICAL tokens of the same analysis, in order, and the authored fallback
    derives both from `_display_split` — so this is a lookup, not a guess. Out of range or
    empty falls back to the surface, which is the old behaviour and is still better than
    raising.
    """
    if 0 <= index < len(lemmas) and lemmas[index]:
        return lemmas[index]
    return surface


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
    item_key: str | None = None,
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
    # ONE ORACLE, and this line is the last place the two disagreed. `pos_of` keeps one
    # row per lemma, and V5 checks the tags attested for the ANSWER — so when the
    # anchor's remembered tag is not one of the answer's, every candidate drawn for it
    # is a finding by construction. Measured on the real course: four records whose
    # anchor lemma is tagged PROPN (`henderson` and `stein` are PROPN lemmas in band A1
    # of a course whose ledger declares no proper nouns at all) while the answer surface
    # is attested only as NOUN. The answer's tag wins, and only when the pool has a
    # bucket for it — never a silent widening of the band.
    # ONLY where the gate will have an answer POS to compare, which is the single-token
    # case: `_answer_tags` returns nothing for a sentence, and this call's `accepted` is
    # the TOKEN LIST for a word bank — reading `accepted[0]` there picked up `El` and
    # asked the pool for a DET.
    answer_tags: set[str] = set()
    if len(accepted) == 1:
        answer_tags = inputs.pos_sets.get(normalise(accepted[0]), set())
    if answer_tags and pos not in answer_tags:
        for attested in sorted(answer_tags):
            if (attested, band) in inputs.pool.by_pos_band:
                pos = attested
                break
    forbidden_prompt = [token.strip(".,¿?¡!") for token in prompt_tokens]
    # `item_key` is the key `validators.exercise.item_keys` will file this record under,
    # and it is NOT always this call's `key`. An AUTHORED sentence has no
    # `source_sentence_id`, so `item_keys` files it under its grammar concept and every
    # authored sentence in that concept is one item — while the rule core's own
    # exclusion set is per-slot. The gap is not theoretical: over the real Spanish course
    # V5 reported `distractor 'hermanos' is an accepted answer of another exercise over
    # the same item` twice. Excluding the item's whole accepted set here is what makes
    # the generator and the validator agree by construction rather than by luck.
    forbidden_item = sorted(alternatives.forbidden_for(item_key)) if item_key else []
    return rule_core_distractors(
        pool=inputs.pool,
        alternatives=alternatives,
        key=key,
        answer_surface=anchor,
        answer_lemma=anchor,
        pos=pos,
        band=band,
        accepted_answers=[
            *accepted,
            *(token for token in forbidden_prompt if token),
            *forbidden_item,
        ],
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
    """Every lexeme-focus recognition form for one newly introduced lexeme.

    `LEXEME_FORM_PLAN` is one shape now — `meaning_select` — because S032 needs an
    illustration nothing in this repository can supply and is gated to P3 (see the
    SHAPES comment in `config/g7.py`). The second punitive form every lexeme item needs
    for INV-PACK-07 is its `match_pairs` row, and `_lexeme_pass` is what guarantees one
    exists before this function is ever called.

    The NEW WORD pill rides on the FIRST shape of the plan — the first recognition of
    the word, which used to be picture-select and is now meaning-select — and
    `ExerciseDraft` refuses it on any shape that is not `new_word_eligible`.

    Returns `[]` when the item cannot be authored: no gloss, or not enough sibling
    glosses to fill the option list. The word is then still taught inside the sentence
    exercises, which is what already happened to an unglossed lemma. A HALF-authored
    introduction is the thing that must not happen: one punitive form fails INV-PACK-07.
    """
    lang = inputs.lang
    drafts: list[ExerciseDraft] = []
    for shape_id in LEXEME_FORM_PLAN:
        chosen = shape(shape_id)
        gloss = glosses.get(lemma)
        options = _meaning_options(inputs, lemma, glosses, count=chosen.distractor_count)
        if gloss is None or options is None:
            return []
        drafts.append(
            ExerciseDraft(
                lang=lang,
                exercise_id=_exercise_id(lang, unit, lesson, shape_id, lemma, gloss),
                unit_index=unit,
                lesson_index=lesson,
                shape_id=shape_id,
                focus="lexeme",
                instruction_hint=lemma,
                body=lemma,
                accepted_answers=(gloss,),
                distractors=options,
                lemmas=(lemma,),
                grammar_concepts=(),
                audio_ref=None,
                register=register,
                source_sentence_id=None,
                new_word_pill=shape_id == LEXEME_FORM_PLAN[0],
            )
        )
    return drafts


def _meaning_options(
    inputs: ExpansionInputs,
    lemma: str,
    glosses: Mapping[str, str],
    *,
    count: int,
) -> tuple[str, ...] | None:
    """S034's wrong meanings: glosses of same-POS same-band siblings. `None` = too few.

    One function for both the eligibility test and the draft, so "this lexeme can be
    introduced" and "this is its option list" can never disagree — `_lexeme_pass` asks
    this before it commits to introducing a lemma, and `_lexeme_drafts` asks it again to
    build the record.
    """
    gloss = glosses.get(lemma)
    if gloss is None:
        return None
    pos = inputs.pos_of.get(lemma, "")
    band = inputs.band_of.get(lemma, "unbanded")
    options = [
        glosses[other]
        for other in _same_pos_band_lemmas(inputs, lemma, pos, band)
        if other in glosses and glosses[other] != gloss
    ]
    if len(options) < count:
        return None
    return tuple(options[:count])


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
    slot: ResolvedSlot,
    target_tokens: Sequence[str],
    lemmas: Sequence[str],
    register: str,
    alternatives: AlternativesIndex,
) -> ExerciseDraft | None:
    """A grammar concept drilled, never quoted. INV-PACK-50's positive case.

    `focus="grammar_concept"` is what makes `route()` refuse picture-select and
    meaning-select for this draft, and what makes the NEW WORD pill impossible on it.

    Returns `None` when the shape cannot be authored honestly. That happens for exactly
    one shape and one reason: `type_the_word_ending` needs a surface form with a
    separable morphological ending (`ending_split`), and a sentence whose every token is
    a stem-changing verb or a citation-form adjective has none. An AUTHORED sentence is
    no longer in that list — it carries G5's analysis now, so its endings segment like
    any other. Dropping the drill is safe for INV-PACK-07 — a grammar draft carries
    `source_sentence_id`, so `validators.exercise.item_keys` files it under the sentence
    item, whose `SENTENCE_FORM_PLAN` row already carries two punitive forms — and the
    stage records the skip on the runlog rather than swallowing it.
    """
    lang = inputs.lang
    sid = slot.sid
    key = f"sentence:{sid}" if sid else f"concept:{concept}"
    if shape_id == "type_the_word_ending":
        segmented = _ending_target(slot, target_tokens, lang)
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
        body = _gapped(slot, target_tokens, gap_index)
        accepted = (target_tokens[gap_index],)
        distractors = _decoys(
            inputs,
            lemmas=[_anchor_lemma(lemmas, gap_index, target_tokens[gap_index])],
            count=shape(shape_id).distractor_count,
            key=key,
            accepted=list(accepted),
            alternatives=alternatives,
            prompt_tokens=list(surface_tokens(body)),
            item_key=key,
        )
    return ExerciseDraft(
        lang=lang,
        exercise_id=_exercise_id(
            lang, unit, lesson, shape_id, f"{concept}\x1f{body}", *accepted
        ),
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
    slot: ResolvedSlot, target_tokens: Sequence[str], lang: str
) -> tuple[int, str, str] | None:
    """`(token index, stem, ending)` of the best token to drill, or `None`.

    Needs an analysis, because a segmentation is a claim about a lemma and a POS and
    there is no way to make one from a bare surface string. It no longer needs a CORPUS
    analysis: an authored slot carries G5's pass in the same shape from the same pinned
    adapter (B16), so an authored sentence gets its ending drills like any other. A
    sentence with no analysis at all — a corpus row G1 never saw — still gets none, and
    inventing a lemma here would put a second analyser into the pipeline, which is the
    thing `_display_split` refuses to do.

    Preference order is `ENDING_POS_PREFERENCE`: a verb before an adjective before a
    noun plural, because the concept rows this stage builds are verb-conjugation
    concepts. Ties break on the earliest token, so the choice is deterministic.
    """
    if slot.analysis is None:
        return None
    tokens = slot.analysis["tokens"]
    best: tuple[int, int, str, str] | None = None
    for index, token in enumerate(tokens):
        if index >= len(target_tokens) or token["surface"] != target_tokens[index]:
            # display_tokens and tokens are the same list in G1's contract; if a pack
            # ever disagrees, refuse rather than drill the wrong word.
            continue
        split = ending_split(token["surface"], token["lemma"], token["pos"], lang)
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

    THAT IS A CONSTRAINT ON THE CALLER, and `_lexeme_pass` is where it is enforced:
    every row of every match is a lemma that pass is also introducing with its
    `LEXEME_FORM_PLAN` drill, so the match is that lemma's SECOND punitive form and
    never its only one. Feeding this function every glossed lemma in the lesson — the
    obvious fix for "S033 never ships" — builds a match over words that have no other
    lexeme form, and `item_keys` then files each of them as a SINGLE-FORM MISSABLE ITEM:
    INV-PACK-07 fails, in the exact way the ruling above says it must not.
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


def _lexeme_pass(
    inputs: ExpansionInputs,
    *,
    glosses: Mapping[str, str],
    register: str,
    alternatives: AlternativesIndex,
) -> tuple[list[ExerciseDraft], dict[str, int]]:
    """Introduce the lexemes that can carry BOTH punitive forms, and build the matches.

    This is where INV-PACK-07 is held for every lexeme item, by construction rather than
    by a validator's mercy. `validators.exercise.item_keys` files a lexeme drill and a
    match under `lexeme:<lemma>`, so a lexeme item's punitive forms are exactly its
    `meaning_select` plus the matches it appears in. Two rules make that always two or
    more:

    1. **A lemma is introduced only if it is also matchable.** Eligibility is one gloss
       for the lemma and `distractor_count` sibling glosses for the option list
       (`_meaning_options`, the same function that builds the record). An ineligible
       lemma gets NO lexeme item and is taught inside the sentence exercises — the
       pre-existing behaviour for an unglossed lemma.
    2. **Every eligible lemma lands in a match.** Matches are cut from the unit's
       eligible lemmas in course order, five to a match (`MATCH_PAIRS_PER_EXERCISE`),
       and the last cut is the unit's LAST FIVE rather than a short tail — so a unit
       ending with two leftover lemmas re-uses three already-matched ones and the two
       still get their second form. A unit with fewer than five eligible lemmas can
       build no match at all, so it introduces no lexeme items; the count is on the
       runlog rather than silent.

    `MATCH_LEMMA_SCOPE` is the unit and not the lesson, which is both what `deep/01` §S20
    describes and what makes rule 2 reachable: a real lesson introduces one to three
    lemmas, so a lesson-scoped five-row match shipped in exactly one place in this
    repository (the fixture) and nowhere in a real course.

    A match is filed in the lesson of its LAST row, so it never tests a word the learner
    has not reached yet.
    """
    # The construction this whole function rests on, re-checked on every build rather
    # than argued in a comment: the plan plus the match shape really are two punitive
    # lexeme forms. `assert_pill_shapes_quote_lexemes` is the same idea one file over.
    forms = (*LEXEME_FORM_PLAN, LEXEME_MATCH_SHAPE)
    punitive_forms = {shape_id for shape_id in forms if shape(shape_id).punitive}
    if len(punitive_forms) < MIN_FORMS_PER_MISSABLE_ITEM:
        raise ValueError(
            f"INV-PACK-07: a lexeme item's authored forms are {forms} and only "
            f"{sorted(punitive_forms)} of them are punitive; "
            f"{MIN_FORMS_PER_MISSABLE_ITEM} are required (EC-MIS-04). Editing "
            "LEXEME_FORM_PLAN or LEXEME_MATCH_SHAPE without editing this pass is how a "
            "single-form missable item gets built."
        )

    new_by_lesson: dict[tuple[int, int], list[str]] = {}
    for item in inputs.selected:
        bucket = new_by_lesson.setdefault((item["unit_index"], item["lesson_index"]), [])
        for lemma in item["new_lemmas"]:
            if lemma not in bucket:
                bucket.append(lemma)

    counts = {
        "lexemes_introduced": 0,
        "lexemes_without_gloss_or_options": 0,
        "lexemes_in_a_unit_too_small_to_match": 0,
        "matches": 0,
    }

    # One entry per eligible lemma, in course order: (unit, lesson, lemma).
    options_needed = shape(LEXEME_FORM_PLAN[0]).distractor_count
    eligible: dict[int, list[tuple[int, int, str]]] = {}
    for (unit, lesson), lemmas in sorted(new_by_lesson.items()):
        for lemma in lemmas:
            if _meaning_options(inputs, lemma, glosses, count=options_needed) is None:
                counts["lexemes_without_gloss_or_options"] += 1
                continue
            bucket = eligible.setdefault(unit, [])
            if any(lemma == seen for _u, _l, seen in bucket):
                continue
            bucket.append((unit, lesson, lemma))

    drafts: list[ExerciseDraft] = []
    for unit, entries in sorted(eligible.items()):
        if len(entries) < MATCH_PAIRS_PER_EXERCISE:
            # No match is possible, so no lemma here can reach two punitive forms.
            counts["lexemes_in_a_unit_too_small_to_match"] += len(entries)
            continue
        for _unit, lesson, lemma in entries:
            introduction = _lexeme_drafts(
                inputs,
                lemma=lemma,
                unit=unit,
                lesson=lesson,
                register=register,
                alternatives=alternatives,
                glosses=glosses,
            )
            if not introduction:  # pragma: no cover - eligibility already decided this
                counts["lexemes_without_gloss_or_options"] += 1
                continue
            drafts.extend(introduction)
            counts["lexemes_introduced"] += 1
        for lesson, rows in _match_cuts(entries):
            match = build_match_pairs(
                inputs,
                unit=unit,
                lesson=lesson,
                lemmas=rows,
                glosses=glosses,
                register=register,
            )
            if match is not None:
                drafts.append(match)
                counts["matches"] += 1
    return drafts, counts


def _match_cuts(
    entries: Sequence[tuple[int, int, str]],
) -> list[tuple[int, list[str]]]:
    """`(lesson, five lemmas)` per match, covering every entry at least once.

    Full cuts of five in course order, then — if anything is left over — one final cut of
    the LAST five entries, which picks the leftovers up and re-uses however many earlier
    lemmas it needs to make five. Re-use is harmless: an already-matched lemma gains a
    third punitive form. A short final cut is not harmless, and neither is dropping the
    tail: either leaves a lemma with one form and fails INV-PACK-07.
    """
    cuts: list[tuple[int, list[str]]] = []
    size = MATCH_PAIRS_PER_EXERCISE
    full = len(entries) // size
    for index in range(full):
        chunk = list(entries[index * size : (index + 1) * size])
        cuts.append((chunk[-1][1], [lemma for _u, _l, lemma in chunk]))
    if len(entries) % size:
        chunk = list(entries[-size:])
        cuts.append((chunk[-1][1], [lemma for _u, _l, lemma in chunk]))
    return cuts


# ---------------------------------------------------------------------------
# Glosses
# ---------------------------------------------------------------------------


def build_glosses(
    inputs: ExpansionInputs,
    aligned: Sequence[tuple[ResolvedSlot, Sequence[tuple[int, int]]]],
) -> dict[str, str]:
    """`lemma -> English gloss`, taken from the alignment and nothing else.

    This is the one place the word alignment becomes learner-visible content rather
    than a hint, so its quality note travels with it on the runlog. A lemma with no
    alignment gets NO gloss, so it gets no `meaning_select` and no match row — and
    `_lexeme_pass` then does not introduce it as a lexeme item at all, rather than
    introducing it with one punitive form. The word is still taught inside the sentence
    exercises; nothing invents a translation.

    IT READS AUTHORED SLOTS TOO, and that is new. It used to be keyed by
    `sentence_id`, so an authored slot — which has none — could never contribute a
    gloss, and unit 1 of a course whose first lesson is entirely authored words and
    fixed phrases (ruling B9(b)) therefore had no glosses, no `meaning_select`, no
    match and no lexeme items: the lesson that exists to teach five words taught none of
    them by name. An authored slot now carries G5's analysis (B16) and its own
    translation, which is all this function ever needed.
    """
    votes: dict[str, dict[str, int]] = {}
    for slot, pairs in aligned:
        if slot.analysis is None:
            continue
        translation = list(surface_tokens(slot.translation))
        tokens = slot.analysis["tokens"]
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
    try:
        inputs = _load(lang)
    except CastError as exc:
        # G7 names the clips G8 will bake, and a clip's id hashes the engine and the
        # voice (INV-AUD-08), so this stage cannot write an `audio_ref` without the
        # cast. Reported as a stage failure naming the file rather than as a traceback,
        # and never by falling back to a different hash — that fallback is what made
        # every audio_ref in the pack a dangling foreign key.
        return StageResult(ok=False, message=f"the voice cast is unusable: {exc}")
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

    # EVERY PASS IS INSIDE THE TRY, and pass 1 not being is what B14 was. A starved gap
    # slot is resolved in pass 1, it raised there, and pass 1 used to sit outside this
    # block — so the one content failure that is most likely on a real course printed a
    # Python traceback where every other stage prints one line and exits 4.
    drafts: list[ExerciseDraft] = []
    hints_written = 0
    hinted_lemmas: set[str] = set()
    lexeme_counts: dict[str, int] = {}
    phrase_slots = 0
    try:
        # Pass 1: resolve and align every selected slot, so the glosses and the
        # alternatives index are complete before any distractor is drawn. A distractor
        # chosen against a half-built index is a valid alternative nobody noticed.
        resolved: list[tuple[Mapping[str, Any], ResolvedSlot, list[tuple[int, int]]]] = []
        alternatives = AlternativesIndex()
        for item in inputs.selected:
            slot = _resolve(inputs, item)
            tokens = _target_tokens(slot)
            pairs = aligner.align(list(surface_tokens(slot.translation)), tokens)
            # The sentence, its translation, AND the token a cloze over it will accept.
            # The gap index is content-free (`_gap_index`), so it is knowable here, before
            # any distractor is drawn — which is the only order that works: a distractor
            # is chosen against this index, so anything missing from it can be chosen.
            accepted_here = [slot.text, slot.translation]
            if tokens:
                accepted_here.append(tokens[_gap_index(tokens)])
            alternatives.add(_alt_key(item, slot), accepted_here)
            # And again under the key `item_keys` will file the records under, which for
            # an authored slot is the CONCEPT and not the slot. See `_decoys`.
            alternatives.add(_item_key(item, slot), accepted_here)
            resolved.append((item, slot, list(pairs)))

        glosses = build_glosses(inputs, [(slot, pairs) for _item, slot, pairs in resolved])
        for lemma, gloss in glosses.items():
            alternatives.add(f"lexeme:{lemma}", [lemma, gloss])

        # Pass 2: the sentence and grammar drafts. A word or a fixed phrase produces
        # none — it is a lexeme-focus item and pass 3 is where it is taught.
        for item, slot, pairs in resolved:
            item_drafts = expand_item(
                inputs,
                item,
                slot=slot,
                alignment=pairs,
                register=register,
                alternatives=alternatives,
            )
            if not item_drafts:
                phrase_slots += 1
            drafts.extend(item_drafts)
            hints = _hints_for(inputs, item, slot, pairs)
            hints_written += len(hints)
            hinted_lemmas.update(hint.gloss for hint in hints)

        # Pass 3: the lexeme items and their matches, together, because neither may
        # exist without the other (INV-PACK-07 — see `_lexeme_pass`).
        lexeme_drafts, lexeme_counts = _lexeme_pass(
            inputs,
            glosses=glosses,
            register=register,
            alternatives=alternatives,
        )
        drafts.extend(lexeme_drafts)
    except (StarvedSlot, MissingAnalysis) as exc:
        # B14 and B16: a named content failure, reported verbatim with no exception type
        # in front of it. The dispatcher exits 4 and prints this line.
        return StageResult(ok=False, message=str(exc))
    except (NotEnoughDistractors, KeyError, ValueError) as exc:
        return StageResult(ok=False, message=f"{type(exc).__name__}: {exc}")

    records = [draft.to_record() for draft in drafts]

    # The gates, before the write. A pack that fails one never exists on disk.
    blocking = [
        finding
        for finding in (
            *check_pack_07(records),
            *check_pack_50(records),
            *check_v5(records, pos_of=inputs.pos_of, attested_pos=inputs.pos_sets),
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
        # Ruling B9(b)'s counters. `phrase_slots` is how many selected slots are a word
        # or a fixed phrase and therefore produced NO sentence draft; the four
        # `lexemes_*` numbers say what happened to every new lemma: introduced with both
        # punitive forms, or refused for want of a gloss / an option list / a unit big
        # enough to cut a match from. A lesson of phrases whose lemmas are all refused
        # is a lesson with no exercises, which is a content failure that must be visible
        # as a number rather than as an empty screen at P3.
        phrase_slots=phrase_slots,
        **lexeme_counts,
        # S032 is declared, punitive, lexeme-focused — and gated to P3 because it needs
        # an illustration that does not exist (config/g7.py::SHAPES). Recorded on every
        # run so a reader of the log does not have to know the table to know that a
        # shape the product map lists is not in this pack.
        shapes_not_available_in_phase=sorted(
            item.id
            for item in SHAPES
            if PHASE_ORDER.index(item.available_from) > PHASE_ORDER.index(CURRENT_PHASE)
        ),
        tool=f"{TOOL_NAME} {__version__}",
    )
    return StageResult(ok=True, message=f"{written} exercises", detail={"written": written})


def _alt_key(item: Mapping[str, Any], slot: ResolvedSlot) -> str:
    """The alternatives-index key for one slot. Must match `_sentence_draft`'s."""
    if slot.sid:
        return f"sentence:{slot.sid}"
    return f"authored:{item['unit_index']}:{item['lesson_index']}:{slot.text}"


def _item_key(item: Mapping[str, Any], slot: ResolvedSlot) -> str:
    """The key `validators.exercise.item_keys` will file this slot's records under.

    One function, because the generator and the validator disagreeing about what an
    ITEM is was a measured defect: an authored slot has no `source_sentence_id`, so
    `item_keys` files it under its grammar concept, and a per-slot exclusion set let a
    distractor be a sibling authored sentence's accepted answer.
    """
    if slot.sid:
        return f"sentence:{slot.sid}"
    return f"concept:{item['grammar_concept']}"


def _hints_for(
    inputs: ExpansionInputs,
    item: Mapping[str, Any],
    slot: ResolvedSlot,
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
    if slot.analysis is None:
        return ()
    source_tokens = list(surface_tokens(slot.translation))
    target_tokens = _target_tokens(slot)
    tokens = slot.analysis["tokens"]
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
