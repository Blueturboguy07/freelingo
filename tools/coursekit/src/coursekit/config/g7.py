"""Constants owned by expand (G7).

Exercise-shape mix per unit, distractor count, the rule core's same-POS / same-band
constraints, and the alignment model. The LLM re-ranks; it never generates a distractor.

Owner: p2-g7-expand

## Why the shape table lives here

`deep/01` §S1-S11 and `deep/00-PRODUCT-MAP` §3.2 (S032-S041) are the two places the
exercise inventory is written down, and both are *copy plus a grading contract*: an
instruction string, a direction, a heart cost, whether the type is punitive. Every one
of those is a constant that a reviewer has to be able to diff against the spec, so the
whole table is here rather than next to the router that reads it.

## The projection onto `EXERCISE_TYPES`, and what it loses

`config/base.py` declares eight coarse artefact types. The product map declares
sixteen shapes. The mapping is many-to-one and it is LOSSY: `word_bank` carries both
directions of S035, `match` carries picture-select, meaning-select and match-pairs,
`listen` carries four listening shapes. The frozen artefact contract
(`coursekit.artifacts.EXERCISE`, `additionalProperties: false`) has no `shape` field,
so the shape is recovered from `(type, instruction line of prompt)` — which is exactly
why `INSTRUCTION` below must stay unique per shape, and why
`tests/test_g7_expand.py` round-trips every draft through `shape_of_record`.

## S043

`Put the events in order` is out of v1 by founder ruling (no grading contract, no
taxonomy home). It has no row here, no coarse type in `EXERCISE_TYPES`, and
`shapes.forbidden_shape_guard` makes asking for it a `ValueError` rather than a
`KeyError` that reads like a typo.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

# ---------------------------------------------------------------------------
# The shape table
# ---------------------------------------------------------------------------

#: Which way a shape runs. `recognition` shapes have no production at all (tap a card,
#: tap a tile); `l1_to_l2` is production into the course language; `l2_to_l1` back into
#: English; `l2_only` is target-language-internal (a cloze, a dictation); `open` is the
#: non-binary response family (S040, S041).
Direction = Literal["recognition", "l1_to_l2", "l2_to_l1", "l2_only", "open"]

#: What the item under an exercise actually is. `INV-PACK-50` is a rule about this
#: column meeting the `quotes_lexeme` column: a grammar concept or a script unit may
#: never be introduced through a prompt that quotes a standalone word (EC-PACK-47 —
#: the bound morpheme 〜枚 in a picture-select prompt).
Focus = Literal["lexeme", "sentence", "grammar_concept", "script_unit"]


@dataclass(frozen=True, slots=True)
class ExerciseShape:
    """One row of `deep/00-PRODUCT-MAP` §3.2, made executable.

    `punitive` is the single most load-bearing field in this file. It decides the heart
    cost, whether a wrong answer breaks the combo, whether the item enters the mistake
    queue at all, and therefore — through INV-PACK-07 — whether the pack is obliged to
    author a second form of the item. The product map marks S040 and S041 `0` with a
    named departure (`[DEPART D-SKIPSPEAK]`: never a heart, never a combo reset,
    excluded from the accuracy denominator, never a mistake row), so non-punitive here
    means all five of those things at once, not just "costs nothing".
    """

    #: Stable id. Appears in findings, runlog notes and test names.
    id: str
    #: The product-map screen this shape renders on.
    screen: str
    #: The coarse `EXERCISE_TYPES` member the artefact records.
    type: str
    #: The instruction string, verbatim from `strings@09-11`. `{hint}` and `{lang}` are
    #: the shipped substitution slots. Curly quotes are deliberate: the adversarial
    #: review A8 measured that every quoting instruction except `Translate "{word}"`
    #: ships typographic quotes, and straight quotes are visibly wrong at 15px/700.
    instruction: str
    direction: Direction
    #: Which item kinds this shape may carry.
    focuses: tuple[Focus, ...]
    #: Does a wrong answer cost a heart, break the combo and queue a mistake?
    punitive: bool
    #: Hearts deducted per wrong *answer*. S033 charges per wrong pair, not per item.
    heart_cost: int
    #: Does the prompt quote a standalone lexeme? INV-PACK-50's left-hand side.
    quotes_lexeme: bool
    #: May this shape carry the purple NEW WORD pill? INV-PACK-50's right-hand side.
    #: Kept a subset of `quotes_lexeme` — see `shapes.py` for why that subset
    #: relation is what lets a record-level validator discharge both halves.
    new_word_eligible: bool
    #: Does rendering need a baked clip? V7 reads this through the artefact's
    #: `audio_ref`.
    needs_audio: bool
    #: Exactly how many distractors the builder must produce. 0 = a typed/open shape.
    distractor_count: int
    #: Does the builder need a word alignment (for tiles, hints, or a gap)?
    needs_alignment: bool
    #: The phase this shape may first be emitted in. `select_the_character` is P7's.
    available_from: str


#: Every shape Freelingo ships, in product-map order. S042 is declared so the eight
#: coarse types are all covered, and gated to P7 with the Japanese characters stage.
SHAPES: Final[tuple[ExerciseShape, ...]] = (
    ExerciseShape(
        id="picture_select",
        screen="S032",
        type="match",
        instruction="Which one of these is “{hint}”?",
        direction="recognition",
        focuses=("lexeme",),
        punitive=True,
        heart_cost=1,
        quotes_lexeme=True,
        new_word_eligible=True,
        needs_audio=False,
        distractor_count=2,
        needs_alignment=False,
        available_from="P2",
    ),
    ExerciseShape(
        id="match_pairs",
        screen="S033",
        type="match",
        instruction="Tap the matching pairs",
        direction="recognition",
        focuses=("lexeme",),
        punitive=True,
        heart_cost=1,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=False,
        distractor_count=0,
        needs_alignment=False,
        available_from="P2",
    ),
    ExerciseShape(
        id="meaning_select",
        screen="S034",
        type="match",
        instruction="Select the meaning for “{hint}”",
        direction="recognition",
        focuses=("lexeme",),
        punitive=True,
        heart_cost=1,
        quotes_lexeme=True,
        new_word_eligible=True,
        needs_audio=False,
        distractor_count=2,
        needs_alignment=False,
        available_from="P2",
    ),
    ExerciseShape(
        id="word_bank_forward",
        screen="S035",
        type="word_bank",
        instruction="Write this in {lang}",
        direction="l1_to_l2",
        focuses=("sentence", "grammar_concept"),
        punitive=True,
        heart_cost=1,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=False,
        distractor_count=3,
        needs_alignment=True,
        available_from="P2",
    ),
    ExerciseShape(
        id="word_bank_reverse",
        screen="S035",
        type="word_bank",
        instruction="Write this in {lang}",
        direction="l2_to_l1",
        focuses=("sentence", "grammar_concept"),
        punitive=True,
        heart_cost=1,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=False,
        distractor_count=3,
        needs_alignment=True,
        available_from="P2",
    ),
    ExerciseShape(
        id="typed_translate_forward",
        screen="S036",
        type="translate",
        instruction="Translate this sentence",
        direction="l1_to_l2",
        focuses=("sentence", "grammar_concept"),
        punitive=True,
        heart_cost=1,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=False,
        distractor_count=0,
        needs_alignment=False,
        available_from="P2",
    ),
    ExerciseShape(
        id="typed_translate_reverse",
        screen="S036",
        type="reverse_translate",
        instruction="Translate this sentence",
        direction="l2_to_l1",
        focuses=("sentence", "grammar_concept"),
        punitive=True,
        heart_cost=1,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=False,
        distractor_count=0,
        needs_alignment=False,
        available_from="P2",
    ),
    ExerciseShape(
        id="complete_the_chat",
        screen="S037",
        type="cloze",
        instruction="Complete the chat",
        direction="recognition",
        focuses=("sentence",),
        punitive=True,
        heart_cost=1,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=True,
        distractor_count=1,
        needs_alignment=False,
        available_from="P2",
    ),
    ExerciseShape(
        id="tap_what_you_hear",
        screen="S038",
        type="listen",
        instruction="Tap what you hear",
        direction="l2_only",
        focuses=("sentence",),
        punitive=True,
        heart_cost=1,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=True,
        distractor_count=3,
        needs_alignment=True,
        available_from="P2",
    ),
    ExerciseShape(
        id="type_what_you_hear",
        screen="S038",
        type="listen",
        instruction="Type what you hear",
        direction="l2_only",
        focuses=("sentence",),
        punitive=True,
        heart_cost=1,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=True,
        distractor_count=0,
        needs_alignment=False,
        available_from="P2",
    ),
    ExerciseShape(
        id="listen_for_the_missing_word",
        screen="S038",
        type="listen",
        instruction="Listen for the missing word",
        direction="l2_only",
        focuses=("sentence", "grammar_concept"),
        punitive=True,
        heart_cost=1,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=True,
        distractor_count=2,
        needs_alignment=False,
        available_from="P2",
    ),
    ExerciseShape(
        id="fill_in_the_blank",
        screen="S039",
        type="cloze",
        instruction="Fill in the blank",
        direction="l2_only",
        focuses=("sentence", "grammar_concept"),
        punitive=True,
        heart_cost=1,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=False,
        distractor_count=2,
        needs_alignment=False,
        available_from="P2",
    ),
    ExerciseShape(
        id="complete_the_translation",
        screen="S039",
        type="cloze",
        instruction="Complete the translation",
        direction="l1_to_l2",
        focuses=("sentence", "grammar_concept"),
        punitive=True,
        heart_cost=1,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=False,
        distractor_count=0,
        needs_alignment=True,
        available_from="P2",
    ),
    ExerciseShape(
        id="type_the_word_ending",
        screen="S039",
        type="cloze",
        instruction="Type the word ending",
        direction="l2_only",
        focuses=("grammar_concept",),
        punitive=True,
        heart_cost=1,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=False,
        distractor_count=0,
        needs_alignment=False,
        available_from="P2",
    ),
    ExerciseShape(
        id="read_and_respond",
        screen="S040",
        type="speak",
        instruction="Read and respond",
        direction="open",
        focuses=("sentence",),
        punitive=False,
        heart_cost=0,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=False,
        distractor_count=0,
        needs_alignment=False,
        available_from="P2",
    ),
    ExerciseShape(
        id="listen_and_respond",
        screen="S040",
        type="listen",
        instruction="Listen and respond",
        direction="open",
        focuses=("sentence",),
        punitive=False,
        heart_cost=0,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=True,
        distractor_count=0,
        needs_alignment=False,
        available_from="P2",
    ),
    ExerciseShape(
        id="speak_this_sentence",
        screen="S041",
        type="speak",
        instruction="Speak this sentence",
        direction="open",
        focuses=("sentence",),
        punitive=False,
        heart_cost=0,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=True,
        distractor_count=0,
        needs_alignment=False,
        available_from="P2",
    ),
    ExerciseShape(
        id="select_the_character",
        screen="S042",
        type="select_character",
        instruction="Select the correct character(s) for “{hint}”",
        direction="recognition",
        focuses=("script_unit",),
        punitive=False,
        heart_cost=0,
        quotes_lexeme=False,
        new_word_eligible=False,
        needs_audio=False,
        distractor_count=2,
        needs_alignment=False,
        available_from="P7",
    ),
)

#: S043. Named so that asking for it fails with a ruling rather than a KeyError, and so
#: `tests/test_g7_expand.py` can assert no code path reaches it.
FORBIDDEN_SHAPE_IDS: Final[tuple[str, ...]] = ("put_the_events_in_order",)

#: The founder ruling, quoted at the point of refusal.
FORBIDDEN_SHAPE_REASON: Final[str] = (
    "S043 'Put the events in order' is out of v1 by founder ruling: no grading "
    "contract, no taxonomy home. It has no coarse type in EXERCISE_TYPES and no "
    "builder. Re-scoping it means adding a row to config/g7.py SHAPES and a type to "
    "config/base.py EXERCISE_TYPES, not reaching around this guard."
)

#: The phase this build is allowed to emit shapes for. A shape whose `available_from`
#: is later is declared, registered and unreachable — which is the honest shape of
#: "Japanese is P7" inside a table that has to cover all eight coarse types.
CURRENT_PHASE: Final[str] = "P2"

#: Phases in order, so `available_from` is comparable without parsing.
PHASE_ORDER: Final[tuple[str, ...]] = ("P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8")

#: The English name of each course language, for the `{lang}` slot. `{lang}` is
#: `{{group:language:language_name}}` upstream and is always the name of the language
#: the learner is writing IN — which is what separates word_bank_forward from
#: word_bank_reverse on the wire, since both carry the same instruction template.
LANGUAGE_NAME: Final[dict[str, str]] = {
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "ja": "Japanese",
}

#: The `{lang}` value for the reverse direction. One constant rather than a literal in
#: the decoder, because the decoder compares against it to recover the direction.
L1_LANGUAGE_NAME: Final[str] = "English"

# ---------------------------------------------------------------------------
# INV-PACK-07 — forms per missable item
# ---------------------------------------------------------------------------

#: EC-MIS-04 / EC-PACK-05: "any item that can be missed has >=2 authored forms". The
#: forms that count are the PUNITIVE ones: EC-MIS-11 rules that a non-punitive replay
#: "can never clear a mistake", so a missable item whose only second form is a Trace or
#: a Speak has no recycle at all and the session cannot resolve.
MIN_FORMS_PER_MISSABLE_ITEM: Final[int] = 2

# ---------------------------------------------------------------------------
# Distractors — the rule core
# ---------------------------------------------------------------------------

#: The rule core's three strategies, in the order it tries them. `wrong_form` first
#: because a wrong inflection of the right lemma is the distractor that teaches
#: something; `same_pos_same_band` is the fallback that keeps V5 satisfiable; there is
#: no third fallback on purpose — running out is an error, not a licence to reach for a
#: different POS.
DISTRACTOR_STRATEGIES: Final[tuple[str, ...]] = ("wrong_form", "same_pos_same_band")

#: Bands the rule core will widen to when the exact band is exhausted, as offsets in
#: `BAND_ORDER`. Empty: no widening. The measured distractor-quality baseline is
#: NDCG@10 ~34/100 (`scope2/00` §2.4 V5 row), so widening the band to fill a slot buys
#: a distractor that is easy for the wrong reason.
DISTRACTOR_BAND_WIDENING: Final[tuple[int, ...]] = ()

#: CEFR bands in order, for comparability.
BAND_ORDER: Final[tuple[str, ...]] = ("A1", "A2", "B1", "B2", "C1", "C2", "unbanded")

#: Seed for the deterministic shuffle. A pack must rebuild byte-identically, so no
#: distractor choice may depend on the clock, the hash seed or dict order.
DISTRACTOR_SEED: Final[int] = 20260911

# ---------------------------------------------------------------------------
# The re-ranker — declared, unimplemented, unreachable
# ---------------------------------------------------------------------------

#: `scope2/00` §2.3 G7: "LLM as re-ranker only". There is no hosted model in this
#: environment and no API key, so the hook is declared and left unreachable rather than
#: faked with a heuristic wearing an LLM's name. `tests/test_distractors.py` asserts
#: there is no call site.
RERANK_ENABLED: Final[bool] = False

RERANK_UNAVAILABLE_REASON: Final[str] = (
    "The distractor re-ranker is an LLM-only stage and no hosted model is reachable "
    "from this environment (no API keys). The rule core ships alone; enabling the hook "
    "means setting RERANK_ENABLED and adding a call site in "
    "exercises/distractors.py::rule_core_distractors, which the tests currently assert "
    "does not exist. A heuristic re-ranker under this name would be a lie in the "
    "manifest."
)

# ---------------------------------------------------------------------------
# Alignment
# ---------------------------------------------------------------------------

#: SimAlign's constructor arguments, from `deep/10` §S7, verbatim.
SIMALIGN_MODEL: Final[str] = "bert"
SIMALIGN_TOKEN_TYPE: Final[str] = "bpe"
SIMALIGN_MATCHING_METHODS: Final[str] = "mai"
#: The key of the matching method whose output G7 consumes. "mai" runs Argmax,
#: Itermax and Match; `itermax` is the one SimAlign's own README recommends for
#: downstream use.
SIMALIGN_METHOD_KEY: Final[str] = "itermax"

#: Every aligner this stage knows. `deterministic` is a REAL declared engine, not a
#: silent fallback: it is recorded on the runlog entry and a caller has to ask for it.
ALIGNMENT_ENGINES: Final[tuple[str, ...]] = ("simalign", "deterministic")

#: The engine a build uses unless `--set align_engine=` says otherwise. simalign, so
#: that an absent `align` group is exit 3 with a remedy (pyproject's rule: "a stage
#: that needs an absent group must fail loudly, never degrade to a worse aligner").
DEFAULT_ALIGNMENT_ENGINE: Final[str] = "simalign"

#: The published mBERT-Argmax F1 per pair (`deep/10` §S7). A pair with no entry has NO
#: PUBLISHED FIGURE — es and ja both. Read by the stage so the runlog says which, and
#: by nothing that decides whether to run: gating on an absent number would silently
#: turn Spanish off.
SIMALIGN_PUBLISHED_F1: Final[dict[str, float]] = {
    "fr": 0.94,
    "de": 0.81,
}

#: What the runlog says about a language with no published figure. `deep/10` edge case
#: 16 and open question 5: eng-spa and eng-jpn need an in-house 200-pair gold sample.
SIMALIGN_UNMEASURED_NOTE: Final[str] = (
    "no eng-{iso3} F1 is published (SimAlign reports eng-fra .94, eng-deu .81, "
    "eng-hin .55); alignment quality for this pair is UNMEASURED and the word-bank "
    "hint feature that depends on it is gated behind a manual gold sample"
)

#: The deterministic aligner's scoring weights. Position agreement dominates because
#: the fallback's only defensible claim is monotonicity; lexical similarity breaks ties
#: between two equally-placed tokens and is worth much less.
FALLBACK_POSITION_WEIGHT: Final[float] = 0.75
FALLBACK_LEXICAL_WEIGHT: Final[float] = 0.25

#: Below this combined score the fallback drops the candidate. It prunes the candidate
#: list; it does not by itself reduce the pair count, because a proportional diagonal
#: always scores 1.0 on position and the greedy always finds it. The thing that DOES
#: let the fallback decline is the length-ratio gate below.
FALLBACK_MIN_SCORE: Final[float] = 0.45

#: The honest limit of a positional aligner. Above this ratio between the two token
#: counts the sentences are not parallel token-for-token, every pair the diagonal would
#: produce is a guess, and the fallback returns NOTHING rather than |min(m,n)| confident
#: wrong pairs — which is the failure `deep/10` edge case 16 is about: a wrong hint is
#: worse than an absent one, because the learner cannot tell them apart and V4 cannot
#: catch it. Measured against the hand-checked gold sample in `tests/test_alignment.py`:
#: the widest real ratio there is 5:3, so 2.0 costs the sample nothing.
FALLBACK_MAX_LENGTH_RATIO: Final[float] = 2.0

#: The honest description of the fallback, copied onto every runlog entry that used it.
FALLBACK_ENGINE_NOTE: Final[str] = (
    "deterministic positional-monotone aligner with a character-bigram tie-break. It "
    "has NO measured F1 against any gold standard and is not a substitute for "
    "SimAlign; it exists so CI, which does not carry torch, runs G7 end to end. A pack "
    "built with it must not ship."
)

# ---------------------------------------------------------------------------
# Word banks
# ---------------------------------------------------------------------------

#: `deep/01` §S4: the bank always holds more tiles than the answer needs.
MIN_EXTRA_WORD_BANK_TILES: Final[int] = 2

#: Cap, so a four-token sentence does not get a twelve-tile bank the learner scans.
MAX_EXTRA_WORD_BANK_TILES: Final[int] = 4

#: Only tokens the scheduler flags new-or-shaky carry the dotted underline (`scope/09`).
#: At build time "new" is what the pack knows: a lemma introduced in this unit.
HINT_ONLY_FOR_NEW_LEMMAS: Final[bool] = True

# ---------------------------------------------------------------------------
# Morphological segmentation — S039 `Type the word ending`
# ---------------------------------------------------------------------------

#: `deep/00-PRODUCT-MAP` §3.2 row S039: "Sub-word morphology drills oblige the pipeline
#: to store a **morphological segmentation per surface form**." Chopping the last two
#: characters off the longest token is not that — it produced `El pan está calien____`
#: with the accepted answer `te`, and `te` is not an ending of `caliente`.
#:
#: The segmentation implemented in `stages/g7_expand.py::ending_split` is two rules, one
#: per word class, and it REFUSES rather than guessing:
#:
#: - a verb whose lemma is a regular infinitive (`-ar`/`-er`/`-ir`) has the stem
#:   `lemma[:-2]`; the ending is whatever the surface adds to that stem. `correr` ->
#:   `corr` + `e`; `estar` -> `est` + `á`. A stem-changing form does not start with the
#:   infinitive stem (`tener` -> `ten`, but the surface is `tiene`) and gets NO split,
#:   because its "ending" is not separable from its stem change and a drill on it would
#:   teach a rule that is false.
#: - any other word class splits at the longest common prefix with its own lemma:
#:   `cuartos`/`cuarto` -> `cuarto` + `s`, `rica`/`rico` -> `ric` + `a`. A surface equal
#:   to its lemma (`caliente`) has no ending and gets no split.
#:
#: A sentence with no segmentable token authors no `type_the_word_ending` at all. That
#: is safe for INV-PACK-07 because the grammar drafts carry `source_sentence_id` and are
#: filed under the sentence item, whose `SENTENCE_FORM_PLAN` row already carries two
#: punitive forms — and the stage notes the skip on the runlog rather than swallowing it.
ENDING_SEGMENTATION_LANGUAGES: Final[tuple[str, ...]] = ("es",)

#: UD tags whose lemma is an infinitive in Spanish.
VERB_POS: Final[tuple[str, ...]] = ("VERB", "AUX")

#: The three regular Spanish infinitive endings. A lemma ending in one of these has a
#: stem of `lemma[:-2]`.
SPANISH_INFINITIVE_ENDINGS: Final[tuple[str, ...]] = ("ar", "er", "ir")

#: A stem shorter than this is not a stem — `t` + `iene` is the shape of a bad split,
#: and a one-letter prompt (`t____`) is unanswerable.
MIN_ENDING_STEM_CHARS: Final[int] = 2

#: An "ending" longer than this is a different word. Spanish inflectional endings are
#: 1-4 characters (`-o`, `-as`, `-mos`, `-áis`); beyond that the split is a guess.
MAX_ENDING_CHARS: Final[int] = 4

#: Which POS classes may be drilled for an ending, best first. The concept rows this
#: stage builds are verb-conjugation concepts, so a verb is preferred over a noun plural
#: when a sentence offers both.
ENDING_POS_PREFERENCE: Final[tuple[str, ...]] = ("VERB", "AUX", "ADJ", "NOUN", "DET")

# ---------------------------------------------------------------------------
# L1-side decoys — the reverse word bank
# ---------------------------------------------------------------------------

#: `word_bank_reverse` (S035, `Write this in English`) renders an ENGLISH tile grid, so
#: its decoy tiles have to be English words. Drawing them from the course-language
#: `banded_lemma` pool shipped `["aprendo", "está", "conocerte"]` into an English bank —
#: and `está` was a word of the Spanish sentence displayed directly above it, which
#: makes the exercise answerable by copying. V5 could not catch either: it can only
#: POS-check against the course-language ledger, and these have no row in it.
#:
#: So the reverse direction draws from an L1 pool built out of the OTHER sentences'
#: English translations, with every course-language lemma removed and every token of the
#: displayed prompt removed. Sibling translations rather than a word list because a decoy
#: has to be a word this course actually uses; a tile from a generic English frequency
#: list is eliminable on register alone.
L1_DECOY_SOURCE: Final[str] = "sibling_translations"

#: A decoy pool smaller than this cannot fill a 3-tile bank without repeating itself, so
#: the stage raises `NotEnoughDistractors` instead — the same refusal the rule core makes.
MIN_L1_DECOY_POOL: Final[int] = 4

# ---------------------------------------------------------------------------
# V6 — register
# ---------------------------------------------------------------------------

#: The register a unit declares, derived from `unit_assignment.register_slot`. A1
#: Spanish teaches tuteo and nothing else, so `binary_t_v` resolves to `tu` for the
#: whole of P2; a unit that teaches ustedeo overrides it with `--set register=usted`.
DEFAULT_REGISTER_BY_SLOT: Final[dict[str, str]] = {
    "n/a": "neutral",
    "binary_t_v": "tu",
    "graded_honorific": "plain",
}

#: Every register value V6 will accept as a declaration.
REGISTERS: Final[tuple[str, ...]] = ("neutral", "tu", "usted", "plain", "polite", "humble")

#: Spanish register markers, lower-cased and unaccented on both sides of the compare.
#: Surface forms only: this is a lexical gate, not a parser. A form in neither set is
#: register-neutral, which is the common case and must stay the cheap one.
#:
#: HIGH PRECISION, LOW RECALL, ON PURPOSE — and the recall was bought back down after a
#: refuter found the table blocking ordinary Spanish. `le`, `les`, `su`, `sus`, `suyo`,
#: `suya`, `suyos`, `suyas` and `consigo` were in the `usted` row and are NOT register
#: markers: they are the ordinary THIRD-PERSON clitic, possessive and reflexive. `A el
#: le gusta su casa.` is third person and carries no register at all, but with those
#: forms listed V6 read it as `usted` and reported a BLOCKING "mixes registers" finding
#: in a tuteo unit — i.e. any A1 pack containing `su casa` or `le gusta` was unshippable
#: for a reason that is not true. They are ambiguous between ustedeo and plain third
#: person and cannot be disambiguated lexically, so deciding them needs a
#: second-person-context test (an `usted` in the same clause, or a 3sg verb with a 2nd
#: person subject) that this gate deliberately does not have.
#:
#: What is left is the set of forms that can ONLY be register: the `usted`/`ustedes`
#: pronouns themselves, and the tuteo forms, every one of which is second-person by
#: morphology. V6 therefore catches the case the invariant is written about — an
#: explicit `usted` sentence inside a `tu` unit — and stays silent where it cannot know.
#: The cost is recorded honestly: an ustedeo sentence that never names the pronoun
#: (`?Como esta?`) passes V6, and no lexical table can catch that one.
ES_REGISTER_MARKERS: Final[dict[str, tuple[str, ...]]] = {
    "tu": (
        "tu",
        "tus",
        "te",
        "ti",
        "tuyo",
        "tuya",
        "tuyos",
        "tuyas",
        "contigo",
        "vosotros",
        "vosotras",
        "os",
    ),
    "usted": (
        "usted",
        "ustedes",
    ),
}

#: The forms that were removed from the `usted` row, kept as a named constant so the
#: regression has a test to point at rather than an absence nobody can assert.
ES_AMBIGUOUS_THIRD_PERSON_FORMS: Final[tuple[str, ...]] = (
    "le",
    "les",
    "su",
    "sus",
    "suyo",
    "suya",
    "suyos",
    "suyas",
    "consigo",
)

#: Languages whose register V6 can actually check here. Japanese script variants and
#: keigo scoping are P7's (`INV-PACK-08`'s other half); listing es alone is what stops
#: V6 reporting a vacuous pass for a language it cannot read.
V6_IMPLEMENTED_LANGUAGES: Final[tuple[str, ...]] = ("es",)

#: What V6 reports for a language outside that list. Blocking, not a warning: a
#: validator that cannot check must not be the reason a pack ships.
V6_UNIMPLEMENTED_MESSAGE: Final[str] = (
    "V6 register checking is implemented for {implemented} only. For {lang} the "
    "accepted-answer set is the entire tolerance budget (EC-GRD-16, review R24) and "
    "its script-variant / honorific half is P7's work, so this run cannot report a "
    "pass. See docs/owned/p2-g7.json."
)

# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------

#: The Python-side property floor, matching the plan's ">=10,000 cases per property"
#: for the TypeScript suite. `tests/test_g7_expand.py` reads it; nothing else may
#: lower it locally.
PROPERTY_RUNS: Final[int] = 10_000

# ---------------------------------------------------------------------------
# The form plan — which shapes an item is expanded into
# ---------------------------------------------------------------------------

#: Sentence items rotate through these rows by `slot_index`, so a lesson is not thirteen
#: renderings of one sentence and a unit still sees every shape. EVERY ROW CARRIES AT
#: LEAST TWO PUNITIVE SHAPES: that is INV-PACK-07 held by construction rather than
#: repaired by the validator, and `tests/test_g7_expand.py` asserts the property over
#: the table instead of over one generated pack.
SENTENCE_FORM_PLAN: Final[tuple[tuple[str, ...], ...]] = (
    ("word_bank_forward", "typed_translate_forward", "speak_this_sentence"),
    ("word_bank_reverse", "typed_translate_reverse", "read_and_respond"),
    ("tap_what_you_hear", "type_what_you_hear", "listen_and_respond"),
    ("fill_in_the_blank", "complete_the_translation", "listen_for_the_missing_word"),
    ("complete_the_chat", "word_bank_forward", "typed_translate_forward"),
)

#: A newly introduced lexeme gets both recognition shapes. `deep/01` §S20: recognition
#: before production, and the observed level-1 shape is picture-selects then a match.
LEXEME_FORM_PLAN: Final[tuple[str, ...]] = ("picture_select", "meaning_select")

#: A grammar concept is drilled, never quoted. Both shapes are punitive and neither is
#: lexeme-quoting, which is INV-PACK-50 and INV-PACK-07 satisfied in one row.
GRAMMAR_FORM_PLAN: Final[tuple[str, ...]] = ("type_the_word_ending", "fill_in_the_blank")

#: `deep/01` §S2 / S033: five rows, two columns.
MATCH_PAIRS_PER_EXERCISE: Final[int] = 5

#: A match is a SECOND form, never a first, and that is now enforced rather than
#: asserted. `validators/exercise.py::item_keys` files a match under ONE KEY PER TAGGED
#: LEMMA (EC-MIS-04: "the left-hand lexeme is the queued mistake"), so a match built over
#: a lemma with no other punitive lexeme form would make that lemma a SINGLE-FORM
#: MISSABLE ITEM and fail INV-PACK-07 — the exact bug the rule reads as preventing.
#: `stages/g7_expand.py` therefore draws match rows only from lemmas that already carry
#: `MIN_FORMS_PER_MISSABLE_ITEM` punitive lexeme-keyed drafts in the same lesson, i.e.
#: from the lemmas that got both `LEXEME_FORM_PLAN` recognition shapes.
MATCH_PAIR_ROWS_MUST_ALREADY_BE_TAUGHT: Final[bool] = True

#: How a match-pairs row is written into the flat `accepted_answers` array, which the
#: frozen contract gives no structure for. One row per accepted answer.
MATCH_PAIR_SEPARATOR: Final[str] = " = "

#: How a cloze marks its gap inside the body.
GAP_MARKER: Final[str] = "____"

#: `deep/01` §S6: the chat's two option lines. One correct, one distractor.
CHAT_TURN_SEPARATOR: Final[str] = "\n"
