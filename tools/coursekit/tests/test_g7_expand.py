"""G7: the shape table, the router, the projection round-trip, and one real run.

Four layers, and each catches something the others cannot:

1. **The table** — every row of `SHAPES` against `deep/00-PRODUCT-MAP` §3.2 and
   `deep/01` §S1-S11. Copy, heart cost and punitiveness are data, and data drifts.
2. **The router** — INV-PACK-50 as a refusal over every (shape, focus) pair, not a
   sampled one.
3. **The projection** — `ExerciseDraft -> exercise record -> shape` over
   `PROPERTY_RUNS` drafts. The frozen contract has no `shape` field, so a shape that
   cannot be read back is a shape the player cannot render.
4. **One end-to-end stage run** over a fixture-derived ledger, with the gates armed.

S043 gets its own section, because "out of v1" has to be a property of the code and not
of nobody having got round to it yet.
"""

from __future__ import annotations

import ast
import json
import random
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from coursekit.artifacts import read_records, sentence_id, write_records
from coursekit.cli import app
from coursekit.config import EXERCISE_TYPES, EXIT_FAILED, EXIT_MISSING_INPUT, EXIT_OK
from coursekit.config.g7 import (
    FORBIDDEN_SHAPE_IDS,
    GAP_MARKER,
    GRAMMAR_FORM_PLAN,
    LEXEME_FOCUS_MAX_DISPLAY_TOKENS,
    LEXEME_FORM_PLAN,
    LEXEME_MATCH_SHAPE,
    MATCH_PAIR_SEPARATOR,
    MATCH_PAIRS_PER_EXERCISE,
    MIN_ENDING_STEM_CHARS,
    MIN_FORMS_PER_MISSABLE_ITEM,
    PHASE_ORDER,
    PROPERTY_RUNS,
    SENTENCE_FORM_PLAN,
    SHAPES,
)
from coursekit.exercises.shapes import (
    ExerciseDraft,
    ForbiddenShape,
    RoutingError,
    ShapeNotAvailable,
    UnknownShape,
    instruction_for,
    prompt_for,
    route,
    shape,
    shape_ids,
    shape_of_record,
    shapes_for_focus,
)
from coursekit.exercises.wordbank import build_hints, build_word_bank, tile_count_is_sane
from coursekit.inputs import group_is_installed
from coursekit.runlog import RunLog, read_entries
from coursekit.stages import STAGES
from coursekit.stages.g7_expand import (
    MissingAnalysis,
    ResolvedSlot,
    StarvedSlot,
    _display_split,
    _target_tokens,
    ending_split,
)


@pytest.fixture(autouse=True)
def g7_is_registered() -> None:
    """Re-register the stage after another module's `empty_registry` fixture cleared it.

    `Registry.reset_for_tests()` clears the entries AND the discovered flag, but
    rediscovery calls `importlib.import_module` on modules that are already in
    `sys.modules`, so the `@register_stage` decorator never runs a second time. Any test
    that uses `tests/conftest.py::empty_registry` therefore unregisters every real stage
    for the remainder of the session, and the CLI then exits 2 here — "not registered"
    for a stage that plainly is. Reloading the module restores it.

    This belongs in `coursekit/__init__.py` or `tests/conftest.py`, neither of which is
    this lane's file; the request is recorded in `docs/owned/p2-g7.json`.
    """
    if "g7" not in STAGES.ids():
        import importlib

        import coursekit.stages.g7_expand as module

        importlib.reload(module)

FIXTURES = Path(__file__).parent / "fixtures" / "es-mini"
PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "src" / "coursekit"
runner = CliRunner()

FOCUSES = ("lexeme", "sentence", "grammar_concept", "script_unit")

#: The adapter stamp G1 writes on an `analysed_sentence` and G5 writes on a
#: `candidate.analysis`. ONE shape, which is the whole of B16 option 2: G7 reads the
#: analysis and never has to know which stage produced it.
_ADAPTER: dict[str, Any] = {
    "name": "es_core_news_md",
    "version": "3.8.0",
    "model": "es_core_news_md",
    "split_mode": None,
}


def _analysis(tokens: list[tuple[str, str, str]]) -> dict[str, Any]:
    """A G1-shaped analysis from `(surface, lemma, pos)` triples."""
    cursor = 0
    rows = []
    for surface, lemma, pos in tokens:
        rows.append(
            {
                "surface": surface,
                "lemma": lemma,
                "pos": pos,
                "morph": f"{pos}:{surface}",
                "start": cursor,
                "end": cursor + len(surface),
            }
        )
        cursor += len(surface) + 1
    return {
        "analyser": _ADAPTER,
        "tokens": rows,
        "lemmas": [lemma for _surface, lemma, _pos in tokens],
        "display_tokens": [surface for surface, _lemma, _pos in tokens],
    }


def _slot(
    text: str,
    translation: str,
    *,
    analysis: dict[str, Any] | None = None,
    sid: str | None = None,
    candidate_id: str | None = None,
) -> ResolvedSlot:
    return ResolvedSlot(
        text=text,
        translation=translation,
        sid=sid,
        analysis=analysis,
        candidate_id=candidate_id,
    )


# ---------------------------------------------------------------------------
# 1. The table
# ---------------------------------------------------------------------------


def test_every_coarse_type_has_at_least_one_shape() -> None:
    """A declared `EXERCISE_TYPES` member with no shape is a type nothing can emit."""
    assert {item.type for item in SHAPES} == set(EXERCISE_TYPES)


def test_the_product_maps_exercise_screens_are_all_covered() -> None:
    """S032-S041 are this task's screens; S042 is declared and gated to P7."""
    covered = {item.screen for item in SHAPES}
    assert {f"S{index:03d}" for index in range(32, 42)} <= covered
    assert "S042" in covered


def test_the_table_declares_which_option_lists_are_rendered_in_english() -> None:
    """`options_in_l1` is a declaration, and it used to be an inference that broke.

    Two consumers read it: the decoy pool (an English bank takes English tiles) and
    V5's POS clause (which compares course-language UD tags and must not be applied to
    an English tile). Both used to work it out from a failed lookup — the tile had no
    row in the Spanish ledger — and that stopped being true when V5's oracle grew to
    include attested SURFACES: a Spanish corpus contains the odd English token, spaCy
    tags it PROPN, and 84 tiles like `the`, `not` and `hello` were suddenly
    POS-comparable against Spanish answers. Measured on the real course, 2026-09-12.
    """
    assert {item.id for item in SHAPES if item.options_in_l1} == {
        "match_pairs",
        "meaning_select",
        "typed_translate_reverse",
        "word_bank_reverse",
    }
    for item in SHAPES:
        # Every reverse-direction shape answers in English, so every one of them is one.
        if item.direction == "l2_to_l1":
            assert item.options_in_l1, item.id
        # And an English option list is never drawn from the course-language rule core:
        # the two shapes that have distractors AND English options are the two the
        # `L1DecoyPool` / gloss paths in `stages/g7_expand.py` handle.
        if item.options_in_l1 and item.distractor_count:
            assert item.id in {"meaning_select", "word_bank_reverse"}, item.id


def test_instructions_are_unique_per_type_and_direction() -> None:
    """The shape survives the projection only while this holds.

    `word_bank_forward` and `word_bank_reverse` deliberately share a template; the
    substituted `{lang}` separates them, so the uniqueness key includes the direction.
    """
    keys = [(item.type, item.instruction, item.direction) for item in SHAPES]
    assert len(set(keys)) == len(keys)


def test_quoting_instructions_use_curly_quotes() -> None:
    """Review A8: every quoting instruction but `Translate "{word}"` ships typographic
    quotes, and straight quotes are visibly wrong at 15px/700."""
    for item in SHAPES:
        if '"' in item.instruction:
            pytest.fail(f"{item.id} ships a straight quote: {item.instruction!r}")
        if item.quotes_lexeme:
            assert "“" in item.instruction and "”" in item.instruction


def test_the_non_punitive_shapes_are_exactly_the_product_maps_zero_cost_rows() -> None:
    """S040 Read/Listen-and-respond and S041 Speak cost 0; S042 tracing costs 0.

    `[DEPART D-SKIPSPEAK]`: never a heart, never a combo reset, excluded from the
    accuracy denominator, never a mistake row.
    """
    non_punitive = {item.id for item in SHAPES if not item.punitive}
    assert non_punitive == {
        "read_and_respond",
        "listen_and_respond",
        "speak_this_sentence",
        "select_the_character",
    }
    for item in SHAPES:
        assert item.heart_cost == (1 if item.punitive else 0)


def test_every_audio_shape_is_in_the_listening_or_speaking_families() -> None:
    for item in SHAPES:
        if item.needs_audio:
            assert item.screen in {"S037", "S038", "S040", "S041"}, item.id


def test_word_bank_decoy_counts_sit_inside_the_measured_band() -> None:
    """`deep/01` §S4: always more tiles than needed, and never a scanning exercise."""
    for item in SHAPES:
        if item.type == "word_bank":
            assert tile_count_is_sane(item.distractor_count), item.id


def test_every_form_plan_row_carries_two_punitive_shapes() -> None:
    """[INV-PACK-07] the invariant held by the plan, not repaired by the validator.

    This is the test that matters for the invariant: the generator cannot emit a
    single-form missable item because no row of any plan has fewer than two punitive
    shapes in it.
    """
    plans: list[tuple[str, tuple[str, ...]]] = [
        *((f"SENTENCE_FORM_PLAN[{index}]", row) for index, row in enumerate(SENTENCE_FORM_PLAN)),
        # A LEXEME item's authored forms are the plan PLUS its match row, and that is a
        # pairing, not a plan row: S032 is gated to P3 (no illustration exists), so the
        # plan alone is one punitive shape and `_lexeme_pass` is what makes the second
        # one obligatory — it introduces a lemma only when a match can be cut over it.
        # Read from the two constants rather than spelled here, so editing either one
        # fails this test instead of quietly halving the forms.
        ("LEXEME_FORM_PLAN + LEXEME_MATCH_SHAPE", (*LEXEME_FORM_PLAN, LEXEME_MATCH_SHAPE)),
        ("GRAMMAR_FORM_PLAN", GRAMMAR_FORM_PLAN),
    ]
    for name, row in plans:
        punitive = {shape_id for shape_id in row if shape(shape_id).punitive}
        assert len(punitive) >= MIN_FORMS_PER_MISSABLE_ITEM, (name, row)


def test_every_form_plan_shape_accepts_the_focus_it_is_planned_for() -> None:
    for row in SENTENCE_FORM_PLAN:
        for shape_id in row:
            assert route(shape_id, "sentence").id == shape_id
    for shape_id in (*LEXEME_FORM_PLAN, LEXEME_MATCH_SHAPE):
        assert route(shape_id, "lexeme").id == shape_id
    for shape_id in GRAMMAR_FORM_PLAN:
        assert route(shape_id, "grammar_concept").id == shape_id


# ---------------------------------------------------------------------------
# 2. The router — INV-PACK-50
# ---------------------------------------------------------------------------


def test_INV_PACK_50_no_non_lexeme_focus_reaches_a_quoting_shape() -> None:
    """[INV-PACK-50] over every (shape, focus) pair, not a sample.

    EC-PACK-47: a grammar concept or a script unit introduced through a prompt that
    quotes a standalone word produces a malformed prompt for every counter and particle
    in the language.
    """
    for item in SHAPES:
        for focus in FOCUSES:
            if not item.quotes_lexeme or focus == "lexeme":
                continue
            with pytest.raises(RoutingError, match="INV-PACK-50"):
                route(item.id, focus, phase="P7")


def test_INV_PACK_50_shapes_for_focus_never_offers_a_quoting_shape_to_a_concept() -> None:
    """[INV-PACK-50] read forwards: the generator is never offered the bad option."""
    for focus in ("sentence", "grammar_concept", "script_unit"):
        for item in shapes_for_focus(focus, phase="P7"):
            assert not item.quotes_lexeme, (focus, item.id)


def test_INV_PACK_50_a_grammar_concept_cannot_wear_the_new_word_pill() -> None:
    """[INV-PACK-50] the pill clause, enforced in the draft constructor."""
    with pytest.raises(RoutingError, match="INV-PACK-50"):
        ExerciseDraft(
            lang="es",
            exercise_id="0" * 16,
            unit_index=1,
            lesson_index=1,
            shape_id="fill_in_the_blank",
            focus="grammar_concept",
            instruction_hint=None,
            body="La casa es ____",
            accepted_answers=("blanca",),
            distractors=("negra", "grande"),
            lemmas=("casa",),
            grammar_concepts=("adjective agreement",),
            register="tu",
            new_word_pill=True,
        )


def test_INV_PACK_50_only_a_lexeme_focus_can_wear_the_pill() -> None:
    """[INV-PACK-50] a pill-eligible shape carries the pill for a lexeme item.

    The shape used to be `picture_select`, the first recognition of a new word. S032 is
    gated to P3 for want of an illustration (config/g7.py::SHAPES), so the first
    recognition — and therefore the pill — is `meaning_select`, which the table already
    marks `new_word_eligible`. The subset relation the record-level check leans on is
    unchanged: every pill-eligible shape still quotes a lexeme.
    """
    draft = ExerciseDraft(
        lang="es",
        exercise_id="0" * 16,
        unit_index=1,
        lesson_index=1,
        shape_id="meaning_select",
        focus="lexeme",
        instruction_hint="perro",
        body="perro",
        accepted_answers=("dog",),
        distractors=("cat", "horse"),
        lemmas=("perro",),
        register="tu",
        new_word_pill=True,
    )
    assert draft.new_word_pill and draft.missable


def test_S032_is_declared_and_unreachable_in_this_phase_by_name() -> None:
    """Picture select is in the table, out of the phase, and refused with a reason.

    A shape nobody emits because the code quietly stopped calling it is indistinguishable
    from a shape nobody has written yet. `route()` raising `ShapeNotAvailable` is what
    makes the absence a decision: S032's cards are "illustration + target label"
    (`deep/01` §S1) and the prompt quotes the target word, so with no illustration the
    only thing on the cards is the word the prompt already gave away. Nothing can supply
    that art — `art/README.md`'s v1 inventory names S034's avatars and no per-lexeme
    illustration, and the frozen `exercise` contract has no field to reference one, so
    every pack row would carry `illustration_ref` NULL.
    """
    assert shape("picture_select").available_from == "P3"
    with pytest.raises(ShapeNotAvailable, match="P3"):
        route("picture_select", "lexeme", phase="P2")
    # Still reachable the moment the art track's phase arrives, unchanged in every
    # other respect: punitive, lexeme-focused, pill-eligible, two distractors.
    later = route("picture_select", "lexeme", phase="P3")
    assert (later.punitive, later.new_word_eligible, later.distractor_count) == (True, True, 2)
    # And the lexeme shapes that CAN ship in this phase are the two the item plan uses.
    assert {item.id for item in shapes_for_focus("lexeme", phase="P2")} == {
        "meaning_select",
        "match_pairs",
    }


def test_a_shape_from_a_later_phase_is_refused_not_silently_skipped() -> None:
    with pytest.raises(ShapeNotAvailable, match="P7"):
        route("select_the_character", "script_unit", phase="P2")
    assert route("select_the_character", "script_unit", phase="P7").id == "select_the_character"
    assert PHASE_ORDER.index("P2") < PHASE_ORDER.index("P7")


def test_an_unknown_shape_is_refused() -> None:
    with pytest.raises(UnknownShape):
        shape("tap_the_thing")


# ---------------------------------------------------------------------------
# S043 — out of v1 by ruling
# ---------------------------------------------------------------------------


def test_S043_has_no_shape_no_type_and_no_builder() -> None:
    """The founder ruling, made unreachable rather than merely unwritten."""
    assert "put_the_events_in_order" not in shape_ids()
    for item in SHAPES:
        assert "order" not in item.instruction.casefold(), item.id
    assert "order" not in " ".join(EXERCISE_TYPES)


def test_S043_asking_for_it_names_the_ruling() -> None:
    for shape_id in FORBIDDEN_SHAPE_IDS:
        with pytest.raises(ForbiddenShape, match="founder ruling"):
            shape(shape_id)
        with pytest.raises(ForbiddenShape, match="founder ruling"):
            route(shape_id, "sentence")


S043_INSTRUCTION = "Put the events in order"


def _renderable_literals(path: Path) -> list[str]:
    """Every string literal in a module that is NOT a docstring.

    A plain grep is the wrong gate here: three modules quote S043's name while stating
    the ruling that removes it, and a gate that fails on its own rationale gets deleted.
    What must never exist is a literal that could be RENDERED as an instruction.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docstrings = {
        id(node.body[0].value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef)
        and node.body
        and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
        and isinstance(node.body[0].value.value, str)
    }
    return [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docstrings
    ]


def test_S043_the_instruction_string_is_never_a_renderable_literal() -> None:
    """The interesting way S043 ships is as a hard-coded prompt that never goes through
    the shape table at all."""
    offenders = [
        (path.relative_to(PACKAGE_ROOT), literal)
        for path in sorted(PACKAGE_ROOT.rglob("*.py"))
        for literal in _renderable_literals(path)
        if literal.startswith(S043_INSTRUCTION)
    ]
    assert offenders == [], offenders


def test_the_literal_walk_would_catch_a_planted_prompt(tmp_path: Path) -> None:
    """The falsifier: without it the test above passes on an empty walk."""
    planted = tmp_path / "planted.py"
    planted.write_text(
        '"""A docstring mentioning Put the events in order."""\n'
        'PROMPT = "Put the events in order"\n',
        encoding="utf-8",
    )
    literals = _renderable_literals(planted)
    assert [text for text in literals if text.startswith(S043_INSTRUCTION)] == [
        S043_INSTRUCTION
    ]


# ---------------------------------------------------------------------------
# 3. The projection round-trip
# ---------------------------------------------------------------------------


def _draft_for(item: Any, rng: random.Random, lang: str) -> ExerciseDraft:
    hint = f"w{rng.randrange(1000)}" if item.quotes_lexeme else None
    body = f"body {rng.randrange(10_000)}"
    if rng.random() < 0.3:
        body += "\nsecond line"
    return ExerciseDraft(
        lang=lang,
        exercise_id=f"{rng.randrange(16**16):016x}",
        unit_index=rng.randint(1, 8),
        lesson_index=rng.randint(1, 6),
        shape_id=item.id,
        focus=rng.choice([f for f in item.focuses]),
        instruction_hint=hint,
        body=body,
        accepted_answers=(f"answer {rng.randrange(1000)}",),
        distractors=tuple(f"d{index}" for index in range(item.distractor_count)),
        lemmas=("casa",),
        grammar_concepts=("greetings",) if rng.random() < 0.5 else (),
        audio_ref=f"{rng.randrange(16**16):016x}" if item.needs_audio else None,
        register="tu",
        source_sentence_id=f"{rng.randrange(16**16):016x}" if rng.random() < 0.5 else None,
    )


def test_every_draft_round_trips_through_the_frozen_record() -> None:
    """[INV-PACK-50 support] the shape is recoverable from `(type, instruction)`.

    `PROPERTY_RUNS` drafts, every shape, both languages that differ in the `{lang}`
    slot. Without this the projection is "recoverable in principle" — and the player,
    the mistake queue and both record-level gates all read the shape back.
    """
    rng = random.Random(20260912)
    available = [item for item in SHAPES if item.available_from == "P2"]
    for _run in range(PROPERTY_RUNS):
        item = rng.choice(available)
        lang = rng.choice(["es", "fr", "de", "ja"])
        draft = _draft_for(item, rng, lang)
        record = draft.to_record()
        assert shape_of_record(record).id == item.id, (item.id, record["prompt"])


def test_the_two_word_bank_directions_survive_the_same_template() -> None:
    """The one genuinely ambiguous pair, pinned by the substituted language name."""
    forward = instruction_for("word_bank_forward", lang="es")
    reverse = instruction_for("word_bank_reverse", lang="es")
    assert forward == "Write this in Spanish"
    assert reverse == "Write this in English"


def test_a_quoting_shape_needs_a_hint() -> None:
    with pytest.raises(ValueError, match="hint"):
        instruction_for("picture_select", lang="es")


def test_a_hint_may_not_contain_a_newline() -> None:
    """The first newline is structural; a hint carrying one would eat the body."""
    with pytest.raises(ValueError, match="newline"):
        prompt_for("picture_select", lang="es", body="x", hint="a\nb")


# ---------------------------------------------------------------------------
# Word banks
# ---------------------------------------------------------------------------


def test_a_word_bank_reconstructs_its_answer_exactly() -> None:
    bank = build_word_bank(["La", "casa", "es", "blanca"], ["negra", "perro"], key="k")
    assert bank.answer == ("La", "casa", "es", "blanca")
    assert set(bank.extra_tiles) == {"negra", "perro"}
    assert len(bank.tiles) == 6


def test_a_repeated_answer_token_gets_its_own_tile() -> None:
    """Otherwise removing one `la` from the strip restores a tile still in use."""
    bank = build_word_bank(["la", "casa", "de", "la", "madre"], ["el", "perro"], key="k")
    assert bank.answer == ("la", "casa", "de", "la", "madre")
    assert len(set(bank.answer_indices)) == 5


def test_a_word_bank_is_deterministic() -> None:
    first = build_word_bank(["a", "b", "c"], ["x", "y"], key="same")
    second = build_word_bank(["a", "b", "c"], ["x", "y"], key="same")
    assert first == second
    assert build_word_bank(["a", "b", "c"], ["x", "y"], key="other") != first


def test_a_bank_with_no_decoys_is_refused() -> None:
    with pytest.raises(ValueError, match="more tiles than needed"):
        build_word_bank(["a", "b"], [], key="k")


def test_hints_are_only_emitted_where_the_alignment_reaches() -> None:
    """An unaligned source token gets no gloss rather than a positional guess."""
    hints = build_hints(
        ["The", "bread", "is", "warm"],
        ["El", "pan", "está", "caliente"],
        [(1, 1), (3, 3)],
        new_lemmas=["pan", "caliente"],
        lemma_of_source_index=["el", "pan", "estar", "caliente"],
    )
    assert [hint.source_index for hint in hints] == [1, 3]
    assert [hint.gloss for hint in hints] == ["pan", "caliente"]


def test_hints_skip_a_lemma_the_learner_already_knows() -> None:
    hints = build_hints(
        ["The", "bread"],
        ["El", "pan"],
        [(0, 0), (1, 1)],
        new_lemmas=["pan"],
        lemma_of_source_index=["el", "pan"],
    )
    assert [hint.surface for hint in hints] == ["bread"]


def test_a_multi_token_gloss_joins_in_target_order() -> None:
    """The measured case: `con leche`."""
    hints = build_hints(
        ["with", "milk"],
        ["con", "leche"],
        [(0, 1), (0, 0)],
        new_lemmas=["con"],
        lemma_of_source_index=["con", "con"],
    )
    assert hints[0].gloss == "con leche"


# ---------------------------------------------------------------------------
# 4. One real run
# ---------------------------------------------------------------------------

LANG = "es"
UNIT = {
    "schema_version": 1,
    "lang": LANG,
    "section_index": 1,
    "section_cefr": "A1",
    "unit_index": 1,
    "unit_title": "Order food",
    "function": "order in a cafe",
    "grammar_concept": "present tense -er verbs",
    "register_slot": "binary_t_v",
    "target_lemmas": ["perro", "casa", "libro", "mesa", "coche", "parque"],
    "recycled_lemmas": [],
    "level_count": 3,
}

SENTENCES: list[tuple[str, str, list[tuple[str, str, str]]]] = [
    (
        "El pan está caliente.",
        "The bread is warm.",
        [("El", "el", "DET"), ("pan", "pan", "NOUN"), ("está", "estar", "AUX"),
         ("caliente", "caliente", "ADJ")],
    ),
    (
        "La sopa está muy rica.",
        "The soup is very tasty.",
        [("La", "el", "DET"), ("sopa", "sopa", "NOUN"), ("está", "estar", "AUX"),
         ("muy", "muy", "ADV"), ("rica", "rico", "ADJ")],
    ),
    (
        "Mi casa tiene tres cuartos.",
        "My house has three rooms.",
        [("Mi", "mi", "DET"), ("casa", "casa", "NOUN"), ("tiene", "tener", "VERB"),
         ("tres", "tres", "NUM"), ("cuartos", "cuarto", "NOUN")],
    ),
    (
        "El perro corre en el parque.",
        "The dog runs in the park.",
        [("El", "el", "DET"), ("perro", "perro", "NOUN"), ("corre", "correr", "VERB"),
         ("en", "en", "ADP"), ("el", "el", "DET"), ("parque", "parque", "NOUN")],
    ),
    (
        "El libro está sobre la mesa.",
        "The book is on the table.",
        [("El", "el", "DET"), ("libro", "libro", "NOUN"), ("está", "estar", "AUX"),
         ("sobre", "sobre", "ADP"), ("la", "el", "DET"), ("mesa", "mesa", "NOUN")],
    ),
]


#: Which lemmas each slot INTRODUCES. Seven, not one, and every one of them a NOUN in
#: band A1 — because a match (S033) is only authored over lemmas that already carry two
#: punitive lexeme forms, and `meaning_select` is only authored when the lemma has a
#: gloss AND two same-POS same-band glossed neighbours to fill its option list. One new
#: lemma in the lesson is why the previous fixture could never emit a match: the shape
#: needs five eligible rows and there was one.
NEW_LEMMAS_BY_SLOT: list[list[str]] = [
    ["pan"],
    [],
    ["casa", "cuarto"],
    ["perro", "parque"],
    ["libro", "mesa"],
]


def _banded() -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in (FIXTURES / "banded.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _write_ledger(lang: str = LANG) -> None:
    """Write G0-G4's artefacts and their runlog entries into the isolated build root."""
    ingested = []
    analysed = []
    selected = []
    for slot, (text, translation, tokens) in enumerate(SENTENCES):
        sid = sentence_id(lang, text)
        ingested.append(
            {
                "schema_version": 1,
                "sentence_id": sid,
                "lang": lang,
                "l1": "en",
                "text": text,
                "translation": translation,
                "source_id": "freelingo-fixture",
                "corpus": "g7-test",
                "corpus_version": "2026-09-12",
                "licence": "CC0-1.0",
                "licence_verdict": "shippable",
                "attribution_required": False,
                "attribution_owner": None,
                "token_count": len(tokens),
                "dedup_hash": f"{abs(hash(text)) % (16**32):032x}",
            }
        )
        analysed.append(
            {
                "schema_version": 1,
                "sentence_id": sid,
                "lang": lang,
                "adapter": {
                    "name": "es_core_news_md",
                    "version": "3.8.0",
                    "model": "es_core_news_md",
                    "split_mode": None,
                },
                "tokens": [
                    {
                        "surface": surface,
                        "lemma": lemma,
                        "pos": pos,
                        "morph": f"{pos}:{surface}",
                        "start": 0,
                        "end": len(surface),
                    }
                    for surface, lemma, pos in tokens
                ],
                "lemmas": [lemma for _surface, lemma, _pos in tokens],
                "display_tokens": [surface for surface, _lemma, _pos in tokens],
            }
        )
        selected.append(
            {
                "schema_version": 1,
                "lang": lang,
                "unit_index": 1,
                "lesson_index": 1,
                "slot_index": slot,
                "sentence_id": sid,
                "provenance": "corpus",
                "gap": False,
                "new_lemmas": NEW_LEMMAS_BY_SLOT[slot],
                "known_lemmas": [lemma for _s, lemma, _p in tokens],
                "grammar_concept": "present tense -er verbs",
            }
        )

    write_records("ingested_sentence", ingested, lang=lang)
    write_records("analysed_sentence", analysed, lang=lang)
    write_records("banded_lemma", _banded(), lang=lang)
    write_records("unit_assignment", [UNIT], lang=lang)
    write_records("selected_item", selected, lang=lang)

    runlog = RunLog(lang)
    for stage_id in ("g0", "g1", "g2", "g3", "g4"):
        with runlog.stage(stage_id, tool="coursekit", tool_version="test") as entry:
            entry.written = 1


def test_the_stage_runs_end_to_end_with_the_declared_fallback_aligner() -> None:
    _write_ledger()
    result = runner.invoke(
        app, ["build", LANG, "--only", "g7", "--set", "align_engine=deterministic"]
    )
    assert result.exit_code == EXIT_OK, result.output

    records = list(read_records("exercise", lang=LANG))
    assert records, "G7 wrote no exercises"
    shapes = {shape_of_record(record).id for record in records}
    # Every family the brief names, from one five-sentence lesson. The recognition row
    # was missing from this assertion while the report claimed all three shipped, and
    # `match_pairs` in fact did not: a shape named in a report and absent from the
    # assertion set is a shape nobody is checking.
    # The recognition row is `meaning_select` + `match_pairs`. `picture_select` is NOT
    # here and its absence is asserted below by the set equality: S032 is gated to P3
    # because its cards are an illustration nothing in this repository can produce
    # (see `test_S032_is_declared_and_unreachable_in_this_phase_by_name`).
    assert {"meaning_select", "match_pairs"} <= shapes
    assert "picture_select" not in shapes
    assert {"word_bank_forward", "word_bank_reverse"} <= shapes
    assert {"typed_translate_forward", "typed_translate_reverse"} <= shapes
    assert {"tap_what_you_hear", "type_what_you_hear", "listen_for_the_missing_word"} <= shapes
    assert {"fill_in_the_blank", "complete_the_translation", "type_the_word_ending"} <= shapes
    assert {"complete_the_chat", "read_and_respond", "listen_and_respond"} <= shapes
    assert "speak_this_sentence" in shapes

    # …and, because "every shape this phase ships" is the actual claim, assert it as a
    # SET EQUALITY against the table rather than as a list somebody keeps in step by hand.
    p2 = PHASE_ORDER.index("P2")
    assert shapes == {
        item.id for item in SHAPES if PHASE_ORDER.index(item.available_from) <= p2
    }


def test_the_run_records_which_aligner_actually_ran() -> None:
    """[INV-PACK-50 neighbours] never a silent substitution.

    The frozen `exercise` record has no engine field, so the runlog is the only place a
    later reader can tell a SimAlign pack from a fallback pack. It says `unmeasured`
    and it says the pack must not ship.
    """
    _write_ledger()
    runner.invoke(app, ["build", LANG, "--only", "g7", "--set", "align_engine=deterministic"])
    entry = read_entries(LANG, stage="g7")[-1]
    assert entry["status"] == "ok"
    assert entry["notes"]["alignment_engine"] == "deterministic"
    assert entry["notes"]["alignment_quality"] == "unmeasured"
    assert "must not ship" in entry["notes"]["alignment_note"]
    assert "simalign" not in entry["inputs"]


@pytest.mark.skipif(group_is_installed("align"), reason="the `align` group IS installed here")
def test_the_default_aligner_refuses_when_the_align_group_is_absent() -> None:
    """`pyproject.toml`'s rule: loud, never a degraded run. Exit 3, with the remedy."""
    _write_ledger()
    result = runner.invoke(app, ["build", LANG, "--only", "g7"])
    assert result.exit_code == EXIT_MISSING_INPUT, result.output
    assert "uv sync --group align" in result.output


def test_INV_PACK_07_the_written_pack_has_two_forms_for_every_missable_item() -> None:
    """[INV-PACK-07] the gate the stage runs on itself, re-run over what it wrote."""
    from coursekit.validators.exercise import check_pack_07

    _write_ledger()
    runner.invoke(app, ["build", LANG, "--only", "g7", "--set", "align_engine=deterministic"])
    records = list(read_records("exercise", lang=LANG))
    assert [f for f in check_pack_07(records) if f.severity == "blocking"] == []


def test_INV_PACK_50_the_written_pack_routes_no_concept_into_a_quoting_prompt() -> None:
    """[INV-PACK-50] the same, for the routing gate."""
    from coursekit.validators.exercise import check_pack_50

    _write_ledger()
    runner.invoke(app, ["build", LANG, "--only", "g7", "--set", "align_engine=deterministic"])
    records = list(read_records("exercise", lang=LANG))
    assert [f for f in check_pack_50(records) if f.severity == "blocking"] == []


def test_INV_PACK_08_the_written_packs_answers_are_all_in_the_declared_register() -> None:
    """[INV-PACK-08] V6 over what G7 actually wrote, not over a hand-built record."""
    from coursekit.validators.exercise import check_v6

    _write_ledger()
    runner.invoke(app, ["build", LANG, "--only", "g7", "--set", "align_engine=deterministic"])
    records = list(read_records("exercise", lang=LANG))
    assert {record["register"] for record in records} == {"tu"}
    assert [f for f in check_v6(records, lang=LANG) if f.severity == "blocking"] == []


# ---------------------------------------------------------------------------
# 4b. The gap slots: B14, B16, and ruling B9(b)
# ---------------------------------------------------------------------------


def _write_gap_ledger(gaps: list[dict[str, Any]]) -> None:
    """The fixture ledger plus extra GAP slots, each with its G5 candidate row.

    `gaps` entries are `{slot_index, text, translation, analysis, new_lemmas, candidate}`;
    a `candidate` of `False` writes the gap slot and NO candidate row, which is the
    starved slot of B14. The g5/g6 runlog entries are written because `expand` requires
    them the moment any selected item is a gap.
    """
    _write_ledger()
    selected = [dict(record) for record in read_records("selected_item", lang=LANG)]
    candidates: list[dict[str, Any]] = []
    for gap in gaps:
        selected.append(
            {
                "schema_version": 1,
                "lang": LANG,
                "unit_index": 1,
                "lesson_index": 1,
                "slot_index": gap["slot_index"],
                "sentence_id": None,
                "provenance": "llm",
                "gap": True,
                "new_lemmas": gap.get("new_lemmas", []),
                "known_lemmas": ["el", "pan", "estar", "caliente"],
                "grammar_concept": "present tense -er verbs",
            }
        )
        if gap.get("candidate", True):
            candidates.append(
                {
                    "schema_version": 1,
                    "lang": LANG,
                    "candidate_id": sentence_id(LANG, gap["text"]),
                    "unit_index": 1,
                    "lesson_index": 1,
                    "slot_index": gap["slot_index"],
                    "text": gap["text"],
                    "translation": gap["translation"],
                    "author": "test",
                    "generated_at": "2026-09-12",
                    "accepted": True,
                    "reject_reason": None,
                    "provenance": "llm",
                    "analysis": gap.get("analysis"),
                }
            )
    write_records("selected_item", selected, lang=LANG)
    write_records("candidate", candidates, lang=LANG)
    runlog = RunLog(LANG)
    for stage_id in ("g5", "g6"):
        with runlog.stage(stage_id, tool="coursekit", tool_version="test") as entry:
            entry.written = len(candidates)


def _build() -> Any:
    return runner.invoke(
        app, ["build", LANG, "--only", "g7", "--set", "align_engine=deterministic"]
    )


#: An authored sentence whose gap lands on an INFLECTED surface, which is the whole of
#: B16: `libros` is in no lexicon, `libro` is a banded A1 noun in the fixture ledger.
_AUTHORED = {
    "slot_index": 8,  # 8 % 5 == 3 -> the fill_in_the_blank row of SENTENCE_FORM_PLAN
    "text": "Los libros están sobre las mesas.",
    "translation": "The books are on the tables.",
    "new_lemmas": [],
    "analysis": _analysis(
        [
            ("Los", "el", "DET"),
            ("libros", "libro", "NOUN"),
            ("están", "estar", "AUX"),
            ("sobre", "sobre", "ADP"),
            ("las", "el", "DET"),
            ("mesas", "mesa", "NOUN"),
        ]
    ),
}


def test_B14_a_starved_gap_slot_is_a_stage_result_not_a_traceback() -> None:
    """B14, and the message is the blockers file's, verbatim.

    Measured before the fix: `KeyError: 'selected slot (1, 1, 8) is a gap and no
    accepted candidate exists for it. …'` — raised out of pass 1, which is the one pass
    that was outside the stage's `try`, so the dispatcher printed a Python traceback
    where every other content failure prints one line and exits 4. Founder ruling B14:
    `StageResult(ok=False)`, message verbatim.
    """
    # The type is part of the fix: `KeyError.__str__` renders the repr of its argument,
    # so a KeyError carrying a sentence prints it wrapped in quotes.
    assert issubclass(StarvedSlot, LookupError) and not issubclass(StarvedSlot, KeyError)

    _write_gap_ledger([{**_AUTHORED, "candidate": False}])
    result = _build()
    assert result.exit_code == EXIT_FAILED, result.output
    assert "Traceback" not in result.output, result.output
    assert "KeyError" not in result.output, result.output
    assert (
        "is a gap and no accepted candidate exists for it. G5 over-generates and G6 "
        "rejects; a slot with no survivor is a content failure, not something G7 may "
        "fill."
    ) in result.output.replace("\n", " ")


def test_B16_an_authored_candidate_with_no_analysis_stops_the_stage_by_name() -> None:
    """B16's coded rule: the field is nullable, so the refusal has to be in the stage.

    `artifacts.CANDIDATE` cannot express "non-null exactly when G7 will read it" — a row
    rejected before the analyser ran legitimately carries `null` — so an authored row
    that REACHES expansion with `analysis: null` stops the stage naming its
    `candidate_id`. The alternative is the bug the field was added to delete: fall back
    to the casefolded surface and hand `libros` to a distractor core keyed by lemma.
    """
    assert issubclass(MissingAnalysis, ValueError)

    _write_gap_ledger([{**_AUTHORED, "analysis": None}])
    result = _build()
    assert result.exit_code == EXIT_FAILED, result.output
    assert "Traceback" not in result.output, result.output
    assert sentence_id(LANG, _AUTHORED["text"]) in result.output
    assert "analysis: null" in result.output
    assert "B16" in result.output


def test_B16_the_gap_distractors_come_from_the_analysis_lemma_not_the_surface() -> None:
    """The read side of B16, on a real stage run over an authored candidate.

    `Los libros están sobre las mesas.` gaps on `libros` (the longest token, ties to the
    earliest). `libros` is a surface and is in no lexicon; `libro` is its lemma and a
    banded A1 noun. Before the fix the rule core was asked for two same-POS same-band
    lexemes for `libros`, found POS empty and band `unbanded`, and stopped the stage —
    the measured failure was `needed 3 distractors for 'tardes' (POS , band unbanded)`.
    """
    _write_gap_ledger([_AUTHORED])
    result = _build()
    assert result.exit_code == EXIT_OK, result.output

    records = [dict(record) for record in read_records("exercise", lang=LANG)]
    clozes = [
        record
        for record in _of_shape(records, "fill_in_the_blank")
        if record["source_sentence_id"] is None
    ]
    assert len(clozes) == 1, [record["prompt"] for record in clozes]
    cloze = clozes[0]
    assert cloze["accepted_answers"] == ["libros"]
    assert GAP_MARKER in cloze["prompt"]
    assert len(cloze["distractors"]) == shape("fill_in_the_blank").distractor_count
    # Same POS as the ANSWER'S LEMMA, which is the guarantee the surface could not give.
    pos_of = {row["lemma"]: row["pos"] for row in _banded()}
    assert pos_of["libro"] == "NOUN"
    assert all(pos_of.get(option) == "NOUN" for option in cloze["distractors"]), (
        cloze["distractors"]
    )
    # And the item's lemma tags are the ANALYSIS's lemmas, not casefolded surfaces.
    assert "libro" in cloze["item_tags"]["lemmas"]
    assert "libros" not in cloze["item_tags"]["lemmas"]


def test_INV_PACK_07_a_word_or_fixed_phrase_is_a_lexeme_item_not_a_sentence_one() -> None:
    """[INV-PACK-07] ruling B9(b), end to end: a two-token slot ships no sentence shape.

    Lesson 1 is words and fixed phrases. Every sentence shape degenerates on one or two
    display tokens — a word bank whose answer is one tile among four, a cloze that
    blanks the only word on screen — and every one of them degenerates into a VALID
    record, so nothing downstream can catch it. `focus_for_item` keeps them out, the
    lemma is taught by the lexeme pass instead, and INV-PACK-07 still holds over the
    whole written pack.
    """
    from coursekit.validators.exercise import check_pack_07, item_keys

    _write_gap_ledger(
        [
            {
                "slot_index": 5,
                "text": "La mesa.",
                "translation": "The table.",
                "new_lemmas": [],
                "analysis": _analysis([("La", "el", "DET"), ("mesa", "mesa", "NOUN")]),
            }
        ]
    )
    result = _build()
    assert result.exit_code == EXIT_OK, result.output

    records = [dict(record) for record in read_records("exercise", lang=LANG)]
    # Nothing renders the phrase as a sentence: no prompt quotes it, in either direction.
    for record in records:
        assert "La mesa." not in record["prompt"], record["prompt"]
        assert "The table." not in record["prompt"], record["prompt"]
    # It is counted rather than silently dropped.
    entry = read_entries(LANG, stage="g7")[-1]
    assert entry["notes"]["phrase_slots"] == 1
    # And `mesa` is still taught, as a lexeme item with two punitive forms.
    punitive: dict[str, set[str]] = {}
    for record in records:
        found = shape_of_record(record)
        if not found.punitive:
            continue
        for key in item_keys(record):
            punitive.setdefault(key, set()).add(found.id)
    assert punitive["lexeme:mesa"] >= {LEXEME_FORM_PLAN[0], LEXEME_MATCH_SHAPE}
    assert [f for f in check_pack_07(records) if f.severity == "blocking"] == []


def test_a_word_or_fixed_phrase_never_reaches_a_sentence_shape_by_construction() -> None:
    """The same rule as a unit, over the boundary rather than over one example."""
    from coursekit.exercises.shapes import focus_for_item

    assert LEXEME_FOCUS_MAX_DISPLAY_TOKENS == 2
    for count in range(1, LEXEME_FOCUS_MAX_DISPLAY_TOKENS + 1):
        assert focus_for_item(count) == "lexeme"
        for item in shapes_for_focus(focus_for_item(count)):
            assert item.focuses == ("lexeme",), item.id
    assert focus_for_item(LEXEME_FOCUS_MAX_DISPLAY_TOKENS + 1) == "sentence"
    with pytest.raises(RoutingError):
        focus_for_item(0)


def test_INV_PACK_51_no_two_tiles_in_one_item_share_a_rendered_label() -> None:
    """[INV-PACK-51] over the written pack: options, match rows, word-bank tiles.

    The ledger half of this id is `test_ledger_unit.py`'s; this is the EXERCISE half —
    "no two tiles in one item share a rendered label" — checked on what G7 actually
    wrote rather than on a hand-built record. Two identical labels in one option list is
    an item with two right answers or two wrong ones, and the learner cannot tell which
    tap was counted.
    """
    records = _built_records()
    for record in records:
        found = shape_of_record(record)
        if found.id == "match_pairs":
            rows = [row.partition(MATCH_PAIR_SEPARATOR) for row in record["accepted_answers"]]
            assert len({left for left, _sep, _right in rows}) == len(rows), record["prompt"]
            assert len({right for _left, _sep, right in rows}) == len(rows), record["prompt"]
            continue
        if not record["distractors"]:
            continue
        tiles = [*record["accepted_answers"], *record["distractors"]]
        if found.id in {"word_bank_forward", "word_bank_reverse", "tap_what_you_hear"}:
            # A word bank legitimately repeats a TOKEN of the answer (`el … el`), and the
            # measured S035 mechanic gives each repeat its own tile. What may not repeat
            # is a DECOY against the answer or against another decoy.
            tiles = record["distractors"]
        assert len(set(tiles)) == len(tiles), (found.id, tiles)


def test_the_stage_is_byte_identical_across_two_runs() -> None:
    """A rebuild that changed nothing must change nothing: the FSRS item ids, the
    content-addressed audio and the player's saved tile indices all ride on it."""
    _write_ledger()
    args = ["build", LANG, "--only", "g7", "--set", "align_engine=deterministic"]
    runner.invoke(app, args)
    first = [json.dumps(record, sort_keys=True) for record in read_records("exercise", lang=LANG)]
    runner.invoke(app, args)
    second = [json.dumps(record, sort_keys=True) for record in read_records("exercise", lang=LANG)]
    assert first == second


def test_the_stage_refuses_to_run_before_its_upstream() -> None:
    """`require_successful` raises rather than expanding over an empty ledger."""
    result = runner.invoke(
        app, ["build", LANG, "--only", "g7", "--set", "align_engine=deterministic"]
    )
    assert result.exit_code == EXIT_FAILED, result.output
    assert "has no successful run" in result.output


# ---------------------------------------------------------------------------
# 5. The defects a refuter found in the first attempt, each with its own test
# ---------------------------------------------------------------------------


def _built_records() -> list[dict[str, Any]]:
    """One real stage run over the fixture ledger, with the fallback aligner named."""
    _write_ledger()
    result = runner.invoke(
        app, ["build", LANG, "--only", "g7", "--set", "align_engine=deterministic"]
    )
    assert result.exit_code == EXIT_OK, result.output
    return [dict(record) for record in read_records("exercise", lang=LANG)]


def _of_shape(records: list[dict[str, Any]], shape_id: str) -> list[dict[str, Any]]:
    return [record for record in records if shape_of_record(record).id == shape_id]


def test_S033_match_pairs_is_emitted_by_a_real_run_with_five_rows() -> None:
    """S033 ships, and it ships five rows tagged with five lemmas.

    It did not before: `build_match_pairs` was fed only `selected_item.new_lemmas`, one
    lemma per lesson in the fixture, and returned `None` below five. The shape had zero
    references in this file, so nothing noticed.
    """
    records = _built_records()
    matches = _of_shape(records, "match_pairs")
    # TWO matches over seven eligible lemmas: one cut of five, then a final cut of the
    # unit's LAST five, which picks up the two leftovers by re-using three lemmas that
    # are already matched. A short final cut would leave those two with one punitive
    # form each and fail INV-PACK-07, which is why the cut is five or nothing.
    assert len(matches) == 2, [record["prompt"] for record in matches]
    assert all(len(m["accepted_answers"]) == MATCH_PAIRS_PER_EXERCISE for m in matches)
    for match in matches:
        assert len(match["item_tags"]["lemmas"]) == MATCH_PAIRS_PER_EXERCISE
        for row in match["accepted_answers"]:
            lemma, _separator, gloss = row.partition(MATCH_PAIR_SEPARATOR)
            assert lemma in match["item_tags"]["lemmas"]
            assert gloss and gloss != lemma
        assert match["prompt"].startswith("Tap the matching pairs\n")
    # Every introduced lexeme is in at least one match: that is the second punitive form
    # INV-PACK-07 needs, and the pass will not introduce a lemma it cannot match.
    matched = {lemma for match in matches for lemma in match["item_tags"]["lemmas"]}
    introduced = {
        record["item_tags"]["lemmas"][0]
        for record in _of_shape(records, LEXEME_FORM_PLAN[0])
    }
    assert introduced and introduced <= matched, introduced - matched


def test_INV_PACK_07_a_match_is_only_built_over_lemmas_already_taught_twice() -> None:
    """[INV-PACK-07] a match is a SECOND form, never a first.

    `item_keys` files a match under one key per tagged lemma, so a match over a lemma
    with no other punitive lexeme form makes that lemma a single-form missable item. The
    obvious fix for "S033 never ships" — feed it every glossed lemma in the lesson — is
    exactly that bug, so the eligibility is computed from the drafts that exist.
    """
    from coursekit.validators.exercise import check_pack_07, item_keys

    records = _built_records()
    match = _of_shape(records, "match_pairs")[0]
    punitive_by_key: dict[str, set[str]] = {}
    for record in records:
        found = shape_of_record(record)
        if not found.punitive:
            continue
        for key in item_keys(record):
            punitive_by_key.setdefault(key, set()).add(found.id)
    for match in _of_shape(records, "match_pairs"):
        for lemma in match["item_tags"]["lemmas"]:
            others = punitive_by_key[f"lexeme:{lemma}"] - {"match_pairs"}
            # AT LEAST ONE, not two, and the number is load-bearing rather than relaxed:
            # a lexeme item's punitive forms are its `LEXEME_FORM_PLAN` drill plus the
            # match, so the match is the SECOND form and `others` is the first. It was
            # two while `picture_select` also shipped; S032 is gated to P3 for want of an
            # illustration, and a match over a lemma with ZERO other punitive forms is
            # still the bug this test is about.
            assert len(others) >= 1, (lemma, others)
            assert len(others) + 1 >= MIN_FORMS_PER_MISSABLE_ITEM, (lemma, others)
    assert [f for f in check_pack_07(records) if f.severity == "blocking"] == []


def test_build_match_pairs_returns_none_below_five_glossed_rows() -> None:
    """Four rows is a different exercise, so the builder declines rather than shrinks."""
    from coursekit.exercises.distractors import DistractorPool, L1DecoyPool
    from coursekit.stages.g7_expand import ExpansionInputs, build_match_pairs

    inputs = ExpansionInputs(
        lang=LANG,
        analysed={},
        units={},
        selected=[],
        candidates={},
        translations={},
        texts={},
        pool=DistractorPool(),
        l1_pool=L1DecoyPool(),
        pos_of={},
        band_of={},
    )
    glosses = {"casa": "house", "libro": "book", "mesa": "table", "pan": "bread"}
    assert (
        build_match_pairs(
            inputs, unit=1, lesson=1, lemmas=sorted(glosses), glosses=glosses, register="tu"
        )
        is None
    )
    glosses["perro"] = "dog"
    built = build_match_pairs(
        inputs, unit=1, lesson=1, lemmas=sorted(glosses), glosses=glosses, register="tu"
    )
    assert built is not None
    assert built.shape_id == "match_pairs"
    assert len(built.accepted_answers) == MATCH_PAIRS_PER_EXERCISE
    # An unglossed lemma is never a row: a blank right-hand column is not a match.
    assert build_match_pairs(
        inputs, unit=1, lesson=1, lemmas=[*sorted(glosses), "sinGloss"],
        glosses=glosses, register="tu",
    ) is not None


def test_the_reverse_word_bank_ships_english_tiles_not_course_language_ones() -> None:
    """S035 `Write this in English`: the decoys are English and none is in the prompt.

    Real output before this fix, from a real run: prompt `Write this in English / La
    sopa está muy rica.`, accepted `The soup is very tasty.`, distractors `["aprendo",
    "está", "conocerte"]` — Spanish tiles in an English bank, one of them a word of the
    sentence displayed directly above it. V5 cannot catch either: its POS clause can
    only be evaluated against the course-language ledger, and these have no row in it.
    """
    records = _built_records()
    course_lemmas = {row["lemma"] for row in _banded()}
    reverse = _of_shape(records, "word_bank_reverse")
    assert reverse
    for record in reverse:
        prompt_body = record["prompt"].split("\n", 1)[1]
        prompt_tokens = {token.strip(".,¿?¡!").casefold() for token in prompt_body.split()}
        answer_tokens = {
            token.strip(".,¿?¡!").casefold()
            for answer in record["accepted_answers"]
            for token in answer.split()
        }
        assert record["distractors"]
        for decoy in record["distractors"]:
            folded = decoy.casefold()
            assert folded not in prompt_tokens, (decoy, prompt_body)
            assert folded not in answer_tokens, decoy
            assert folded not in course_lemmas, (
                f"{decoy!r} is a course-language lemma in an English word bank"
            )


def test_the_forward_word_bank_never_draws_a_decoy_from_its_own_prompt() -> None:
    """The same exclusion in the other direction, so the rule is about prompts, not about
    which pool happened to be wrong."""
    records = _built_records()
    for shape_id in ("word_bank_forward", "tap_what_you_hear"):
        for record in _of_shape(records, shape_id):
            body = record["prompt"].split("\n", 1)[1]
            tokens = {token.strip(".,¿?¡!").casefold() for token in body.split()}
            for decoy in record["distractors"]:
                assert decoy.casefold() not in tokens, (shape_id, decoy, body)


def test_the_complete_the_chat_distractor_is_a_verbatim_ledger_sentence() -> None:
    """S037's wrong reply line is rendered copy and must keep its authored casing.

    It shipped as `el pan está caliente.` — `_chat_distractor` returned the key from
    `AlternativesIndex.everywhere`, which stores `normalise()`d (casefolded) strings, and
    wrote it straight onto the record.
    """
    records = _built_records()
    chats = _of_shape(records, "complete_the_chat")
    assert chats
    ledger = {text for text, _translation, _tokens in SENTENCES}
    for record in chats:
        assert len(record["distractors"]) == 1
        wrong = record["distractors"][0]
        assert wrong in ledger, wrong
        assert wrong not in record["accepted_answers"]
        assert wrong[0].isupper(), f"{wrong!r} was casefolded on the way onto the record"


@pytest.mark.parametrize(
    ("surface", "lemma", "pos", "expected"),
    [
        # Regular verbs: the stem is the infinitive minus its two-letter ending.
        ("está", "estar", "AUX", ("est", "á")),
        ("corre", "correr", "VERB", ("corr", "e")),
        ("como", "comer", "VERB", ("com", "o")),
        ("viven", "vivir", "VERB", ("viv", "en")),
        # A stem change is not segmentable by that rule, so it gets nothing at all.
        ("tiene", "tener", "VERB", None),
        ("quiero", "querer", "VERB", None),
        # Everything else splits at the longest common prefix with its own lemma.
        ("cuartos", "cuarto", "NOUN", ("cuarto", "s")),
        ("rica", "rico", "ADJ", ("ric", "a")),
        # A citation form has no ending.
        ("caliente", "caliente", "ADJ", None),
        ("pan", "pan", "NOUN", None),
        # Guards: a one-letter stem is unanswerable, a five-letter "ending" is a word.
        ("es", "ser", "AUX", None),
    ],
)
def test_ending_split_is_a_morphological_segmentation_not_a_character_chop(
    surface: str, lemma: str, pos: str, expected: tuple[str, str] | None
) -> None:
    """`deep/00-PRODUCT-MAP` §3.2 S039 obliges a segmentation per surface form.

    The previous implementation took the last two characters of the longest token, which
    shipped `El pan está calien____` with the accepted answer `te`.
    """
    assert ending_split(surface, lemma, pos, "es") == expected
    if expected is not None:
        assert "".join(expected) == surface


def test_ending_split_has_no_table_for_a_language_it_was_not_written_for() -> None:
    """Refuses rather than applying Spanish morphology to German. P7's problem."""
    assert ending_split("gegangen", "gehen", "VERB", "de") is None


def test_S039_the_written_ending_drill_reassembles_into_a_real_surface_form() -> None:
    """The drill's stem + its accepted ending is a token of the sentence it came from."""
    records = _built_records()
    endings = _of_shape(records, "type_the_word_ending")
    assert endings
    for record in endings:
        body = record["prompt"].split("\n", 1)[1]
        gapped = [token for token in body.split() if token.endswith(GAP_MARKER)]
        assert len(gapped) == 1, body
        stem = gapped[0][: -len(GAP_MARKER)]
        ending = record["accepted_answers"][0]
        surface = stem + ending
        source = next(
            text
            for text, _t, _k in SENTENCES
            if sentence_id(LANG, text) == record["source_sentence_id"]
        )
        assert surface in source.replace(".", "").split(), (surface, source)
        assert len(stem) >= MIN_ENDING_STEM_CHARS


def test_a_sentence_with_no_separable_ending_authors_no_ending_drill() -> None:
    """Dropped, never faked — and safe, because a grammar draft is filed under its
    sentence item, whose form-plan row already carries two punitive shapes."""
    from coursekit.stages.g7_expand import _ending_target

    analysis = {
        "analyser": _ADAPTER,
        "tokens": [
            {"surface": "El", "lemma": "el", "pos": "DET", "morph": "", "start": 0, "end": 2},
            {"surface": "pan", "lemma": "pan", "pos": "NOUN", "morph": "", "start": 3, "end": 6},
        ],
        "display_tokens": ["El", "pan"],
        "lemmas": ["el", "pan"],
    }
    slot = _slot("El pan", "The bread", analysis=analysis, sid="aaaaaaaaaaaa0001")
    assert _ending_target(slot, ["El", "pan"], LANG) is None
    # A sentence with NO analysis at all gets no drill either: a segmentation is a claim
    # about a lemma and a POS, and there is no way to make one from a bare surface.
    assert _ending_target(_slot("El pan", "The bread"), ["El", "pan"], LANG) is None
    # An AUTHORED candidate is no longer in that category. It carries G5's analysis
    # (B16), so its endings segment like any other sentence's — `corre` off `correr`.
    authored = _slot(
        "Ella corre",
        "She runs",
        analysis={
            "analyser": _ADAPTER,
            "tokens": [
                {
                    "surface": "Ella", "lemma": "ella", "pos": "PRON",
                    "morph": "", "start": 0, "end": 4,
                },
                {
                    "surface": "corre", "lemma": "correr", "pos": "VERB",
                    "morph": "", "start": 5, "end": 10,
                },
            ],
            "display_tokens": ["Ella", "corre"],
            "lemmas": ["ella", "correr"],
        },
        candidate_id="b" * 16,
    )
    assert _ending_target(authored, ["Ella", "corre"], LANG) == (1, "corr", "e")


def test_the_alignment_pairs_ride_on_the_records_that_need_them() -> None:
    """Every record shipped `alignment: []` while the stage said the pairs were written.

    The frozen contract has an `alignment` array and no field for tiles, tile order or
    hints, so this is the one learner-visible thing the aligner buys that survives the
    projection — and the player re-derives the dotted underlines from it.
    """
    records = _built_records()
    needing = [record for record in records if shape_of_record(record).needs_alignment]
    assert needing
    assert all(record["alignment"] for record in needing), [
        shape_of_record(record).id for record in needing if not record["alignment"]
    ]
    for record in needing:
        for pair in record["alignment"]:
            assert len(pair) == 2 and all(index >= 0 for index in pair)
    # And nothing else carries a stray array nobody reads.
    for record in records:
        if not shape_of_record(record).needs_alignment:
            assert record["alignment"] == []


def test_the_run_reports_what_the_alignment_actually_bought() -> None:
    """`build_hints` has a call site and its output is a number on the runlog.

    The hint LIST cannot ride the record (no field for it; the request is in
    docs/owned/p2-g7.json), so what is asserted is the honest remainder: the alignment
    that produces the hints ships, and the count of hints those pairs will render is
    recorded. A pack whose aligner produced no hintable token says `word_bank_hints: 0`
    instead of shipping a feature that renders nothing.
    """
    _built_records()
    notes = read_entries(LANG, stage="g7")[-1]["notes"]
    assert notes["alignment_pairs_written"] > 0
    assert notes["word_bank_hints"] > 0
    assert notes["hinted_glosses"]
    assert notes["ending_drills_written"] <= notes["ending_drills_planned"]


def test_build_hints_refuses_a_positional_guess_and_honours_the_new_lemma_gate() -> None:
    """Two refusals in the one function, asserted rather than described.

    A source token the alignment does not cover gets NO hint, and — under
    `HINT_ONLY_FOR_NEW_LEMMAS` — a token whose lemma the learner already knows gets none
    either.
    """
    source = ["The", "dog", "runs"]
    target = ["El", "perro", "corre"]
    alignment = [(1, 1), (2, 2)]
    lemma_of_source = ["", "perro", "correr"]
    hints = build_hints(
        source, target, alignment, new_lemmas=["perro"], lemma_of_source_index=lemma_of_source
    )
    assert [(hint.source_index, hint.surface, hint.gloss) for hint in hints] == [
        (1, "dog", "perro")
    ]
    # A multi-token gloss (`con leche`) joins in target order.
    hints = build_hints(
        ["with", "milk"],
        ["con", "leche"],
        [(0, 0), (0, 1)],
        new_lemmas=["con"],
        lemma_of_source_index=["con", "leche"],
    )
    assert hints[0].gloss == "con leche"


# ---------------------------------------------------------------------------
# The fallback for an authored candidate
# ---------------------------------------------------------------------------


def test_INV_PACK_40_an_authored_candidates_tiles_carry_no_punctuation() -> None:
    """[INV-PACK-40] the fallback split is the same KIND of list as G1's display tokens.

    An authored candidate has no `analysed_sentence`, so G7 falls back to a whitespace
    split. It used to be a bare split, which makes `Hola,` and `noche.` word-bank tiles;
    the distractor core is then asked for two same-POS same-band lexemes for a string
    that is in no lexicon and raises `NotEnoughDistractors`, failing the stage on a
    sentence that is perfectly good. Measured against the real corpus on 2026-09-12:

        g7 failed: NotEnoughDistractors: concept:subject_pronouns: needed 2 distractors
        for 'Hola,' (POS , band unbanded) and the rule core found 0.

    `_lemmas_for`'s fallback had always stripped the same characters, so one sentence
    produced clean lemmas and dirty tiles — which is what made it findable.
    """
    assert _display_split("Hola, buenas noches.") == ["Hola", "buenas", "noches"]
    assert _display_split("¿Qué tal, señor?") == ["Qué", "tal", "señor"]
    assert _display_split("Sí, por favor.") == ["Sí", "por", "favor"]
    # The fallback branch: a slot with no analysis at all. It is now reachable only for
    # a corpus sentence G1 never analysed — an AUTHORED slot with no analysis is refused
    # by name (B16) rather than split here — and it still must not make tiles out of
    # punctuation.
    tokens = _target_tokens(_slot("Perdón, mi teléfono no responde.", "Sorry, my phone is dead."))
    assert tokens == ["Perdón", "mi", "teléfono", "no", "responde"]
    assert not any(token.strip(".,¿?¡!") != token for token in tokens)
