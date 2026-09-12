"""The distractor rule core, and the re-ranker that must stay unreachable.

Everything here builds its pool from the `es-mini` fixture rather than from invented
lemmas, because the two properties V5 is about — same POS, same frequency band — are
properties of a real ledger's shape, and a hand-made pool can be given whatever shape
makes the test pass.

The property test runs `PROPERTY_RUNS` (10,000) draws, matching the plan's floor for
the TypeScript suite. It is a floor, never lowered to buy wall-clock.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any

import pytest

from coursekit.config.g7 import (
    DISTRACTOR_BAND_WIDENING,
    DISTRACTOR_SEED,
    DISTRACTOR_STRATEGIES,
    PROPERTY_RUNS,
    RERANK_ENABLED,
)
from coursekit.exercises.distractors import (
    AlternativesIndex,
    DistractorPool,
    L1DecoyPool,
    NotEnoughDistractors,
    RerankerUnavailable,
    normalise,
    rerank,
    rule_core_distractors,
)

FIXTURES = Path(__file__).parent / "fixtures" / "es-mini"
DISTRACTORS_SOURCE = (
    Path(__file__).resolve().parents[1] / "src" / "coursekit" / "exercises" / "distractors.py"
)


def banded_rows() -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in (FIXTURES / "banded.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def analysed_rows() -> list[dict[str, Any]]:
    """One synthetic `analysed_sentence`-shaped row carrying every attested surface.

    `lemma-map.tsv` is the pinned `es_core_news_md` output for the fixture, so the
    surface set per lemma here is the one the real G1 would produce — which is what
    makes the `wrong_form` strategy a claim about the ledger rather than about a list
    somebody typed.
    """
    tokens = []
    for line in (FIXTURES / "lemma-map.tsv").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        surface, lemma, pos = line.split("\t")
        tokens.append(
            {
                "surface": surface,
                "lemma": lemma,
                "pos": pos,
                "morph": surface,
                "start": 0,
                "end": len(surface),
            }
        )
    return [{"tokens": tokens}]


@pytest.fixture(scope="module")
def pool() -> DistractorPool:
    return DistractorPool.build(banded_rows(), analysed_rows())


@pytest.fixture(scope="module")
def ledger() -> dict[str, dict[str, str]]:
    rows = banded_rows()
    return {
        "pos": {row["lemma"]: row["pos"] for row in rows},
        "band": {row["lemma"]: row["band"] for row in rows},
    }


def drawable(pool: DistractorPool, ledger: dict[str, dict[str, str]], count: int) -> list[str]:
    """Lemmas whose (POS, band) bucket can actually supply `count` distractors.

    Filtering the sample is not weakening the property: the core's contract is "these
    constraints or an exception", and a lemma from a one-member bucket exercises the
    exception path, which `test_the_core_refuses_rather_than_padding` covers on its own.
    """
    return sorted(
        lemma
        for lemma in ledger["pos"]
        if len(pool.by_pos_band.get((ledger["pos"][lemma], ledger["band"][lemma]), [])) > count
    )


# ---------------------------------------------------------------------------
# V5's three clauses
# ---------------------------------------------------------------------------


def test_V5_the_rule_core_never_returns_an_accepted_answer(
    pool: DistractorPool, ledger: dict[str, dict[str, str]]
) -> None:
    import random

    lemmas = drawable(pool, ledger, 3)
    rng = random.Random(DISTRACTOR_SEED)
    alternatives = AlternativesIndex()
    for lemma in lemmas:
        alternatives.add(f"lexeme:{lemma}", [lemma])

    for _run in range(PROPERTY_RUNS):
        lemma = rng.choice(lemmas)
        count = rng.randint(1, 3)
        accepted = [lemma, lemma.upper()]
        drawn = rule_core_distractors(
            pool=pool,
            alternatives=alternatives,
            key=f"lexeme:{lemma}",
            answer_surface=lemma,
            answer_lemma=lemma,
            pos=ledger["pos"][lemma],
            band=ledger["band"][lemma],
            accepted_answers=accepted,
            count=count,
        )
        assert len(drawn) == count
        folded = {normalise(item) for item in drawn}
        assert folded.isdisjoint({normalise(answer) for answer in accepted})
        assert len(folded) == count, "a distractor was offered twice in one option list"


def test_V5_the_rule_core_never_leaves_the_pos(
    pool: DistractorPool, ledger: dict[str, dict[str, str]]
) -> None:
    import random

    lemmas = drawable(pool, ledger, 3)
    rng = random.Random(DISTRACTOR_SEED + 1)
    alternatives = AlternativesIndex()

    for _run in range(PROPERTY_RUNS):
        lemma = rng.choice(lemmas)
        pos = ledger["pos"][lemma]
        drawn = rule_core_distractors(
            pool=pool,
            alternatives=alternatives,
            key=f"lexeme:{lemma}",
            answer_surface=lemma,
            answer_lemma=lemma,
            pos=pos,
            band=ledger["band"][lemma],
            accepted_answers=[lemma],
            count=rng.randint(1, 3),
        )
        bucket = set(pool.by_pos_band.get((pos, ledger["band"][lemma]), []))
        inflections = set(pool.forms.get(lemma, {}).values())
        for item in drawn:
            # Two ways to share the answer's POS, and no third: a ledger row in the
            # SAME (POS, band) bucket, or an attested inflection of the answer's own
            # lemma. `pos_of_lemma` is deliberately not consulted — a lemma with two
            # POS rows (`frío` is ADJ and NOUN, `estar` is AUX and VERB) would make
            # that lookup disagree with the bucket the candidate was drawn from.
            assert item in bucket or item in inflections, (lemma, item, pos)


def test_V5_the_rule_core_never_returns_a_valid_alternative(
    pool: DistractorPool, ledger: dict[str, dict[str, str]]
) -> None:
    """The third clause, over the whole unit rather than one row.

    A gloss authored on a sibling exercise over the same item is in the alternatives
    index, and must never come back as a distractor for that item.
    """
    import random

    lemmas = drawable(pool, ledger, 4)
    rng = random.Random(DISTRACTOR_SEED + 2)

    for _run in range(PROPERTY_RUNS):
        lemma = rng.choice(lemmas)
        siblings = [
            other
            for other in pool.by_pos_band[(ledger["pos"][lemma], ledger["band"][lemma])]
            if other != lemma
        ][:2]
        alternatives = AlternativesIndex()
        alternatives.add(f"lexeme:{lemma}", [lemma, *siblings])
        drawn = rule_core_distractors(
            pool=pool,
            alternatives=alternatives,
            key=f"lexeme:{lemma}",
            answer_surface=lemma,
            answer_lemma=lemma,
            pos=ledger["pos"][lemma],
            band=ledger["band"][lemma],
            accepted_answers=[lemma],
            count=1,
        )
        assert not {normalise(item) for item in drawn} & {normalise(s) for s in siblings}


def test_the_core_refuses_rather_than_padding(
    pool: DistractorPool, ledger: dict[str, dict[str, str]]
) -> None:
    """`NotEnoughDistractors`, never a distractor from another POS or band.

    Padding is exactly the V5 violation the core exists to prevent, so running out has
    to be an error the build surfaces rather than a quietly shorter option list.
    """
    starved = next(
        lemma
        for lemma in ledger["pos"]
        if len(pool.by_pos_band[(ledger["pos"][lemma], ledger["band"][lemma])]) <= 3
        and len(pool.forms.get(lemma, {})) <= 1
    )
    with pytest.raises(NotEnoughDistractors) as excinfo:
        rule_core_distractors(
            pool=pool,
            alternatives=AlternativesIndex(),
            key=f"lexeme:{starved}",
            answer_surface=starved,
            answer_lemma=starved,
            pos=ledger["pos"][starved],
            band=ledger["band"][starved],
            accepted_answers=[starved],
            count=50,
        )
    assert "V5 violation" in str(excinfo.value)


def test_zero_distractors_is_not_an_error(pool: DistractorPool) -> None:
    """A typed shape asks for none, and must not be routed through the pool at all."""
    assert (
        rule_core_distractors(
            pool=pool,
            alternatives=AlternativesIndex(),
            key="x",
            answer_surface="casa",
            answer_lemma="casa",
            pos="NOUN",
            band="A1",
            accepted_answers=["casa"],
            count=0,
        )
        == ()
    )


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_the_core_is_deterministic_across_pools(
    ledger: dict[str, dict[str, str]],
) -> None:
    """Two pools built from the same ledger produce the same distractors.

    A pack must rebuild byte-identically or the content-addressed audio and the FSRS
    item ids move under the learner. Rebuilding the pool is the case that catches a
    dependence on `set` iteration order, which is stable within a process and not
    across two.
    """
    first = DistractorPool.build(banded_rows(), analysed_rows())
    second = DistractorPool.build(banded_rows(), analysed_rows())
    for lemma in drawable(first, ledger, 3)[:200]:
        kwargs = dict(
            alternatives=AlternativesIndex(),
            key=f"lexeme:{lemma}",
            answer_surface=lemma,
            answer_lemma=lemma,
            pos=ledger["pos"][lemma],
            band=ledger["band"][lemma],
            accepted_answers=[lemma],
            count=2,
        )
        assert rule_core_distractors(pool=first, **kwargs) == rule_core_distractors(
            pool=second, **kwargs
        )


def test_the_strategy_order_is_the_declared_one() -> None:
    """Wrong forms first: the distractor that teaches the grammar point leads."""
    assert DISTRACTOR_STRATEGIES == ("wrong_form", "same_pos_same_band")


def test_the_band_never_widens() -> None:
    """`scope2/00` §2.4: distractor quality is NDCG@10 ~34/100 to beat. A distractor
    from a band the learner has never met is eliminable without knowing anything."""
    assert DISTRACTOR_BAND_WIDENING == ()


def test_a_wrong_form_is_preferred_over_a_neighbour_lemma(pool: DistractorPool) -> None:
    """When the answer's lemma has an attested second surface, that surface leads."""
    lemma, forms = next(
        (lemma, forms) for lemma, forms in sorted(pool.forms.items()) if len(forms) >= 3
    )
    surfaces = sorted(forms.values())
    drawn = rule_core_distractors(
        pool=pool,
        alternatives=AlternativesIndex(),
        key=f"lexeme:{lemma}",
        answer_surface=surfaces[0],
        answer_lemma=lemma,
        pos=pool.pos_of_lemma.get(lemma, ""),
        band=pool.band_of_lemma.get(lemma, "unbanded"),
        accepted_answers=[surfaces[0]],
        count=1,
    )
    assert drawn[0] in surfaces[1:]


# ---------------------------------------------------------------------------
# The re-ranker
# ---------------------------------------------------------------------------


def test_the_reranker_is_disabled() -> None:
    assert RERANK_ENABLED is False


def test_the_reranker_raises_rather_than_faking_a_model() -> None:
    """No hosted model is reachable here. A heuristic under this name would put a claim
    in the pack manifest that is not true."""
    with pytest.raises(RerankerUnavailable) as excinfo:
        rerank("casa", ["gato", "perro"])
    assert "no hosted model" in str(excinfo.value)


def test_the_reranker_has_no_call_site() -> None:
    """"Unreachable" made executable: walk the module and find no call to `rerank`.

    Without this, "the hook is unimplemented" is a comment. `RERANK_ENABLED` guards
    nothing on its own — a call site behind a false flag is still a call site somebody
    flips on without re-reading why it was off.
    """
    tree = ast.parse(DISTRACTORS_SOURCE.read_text(encoding="utf-8"))
    call_sites = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "rerank"
    ]
    assert call_sites == [], f"rerank() is called at line(s) {[n.lineno for n in call_sites]}"


def test_the_call_site_walk_would_catch_one(tmp_path: Path) -> None:
    """The falsifier for the test above, which otherwise passes on a parse error."""
    planted = tmp_path / "planted.py"
    planted.write_text("def f():\n    return rerank('a', ['b'])\n", encoding="utf-8")
    tree = ast.parse(planted.read_text(encoding="utf-8"))
    found = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "rerank"
    ]
    assert len(found) == 1


# ---------------------------------------------------------------------------
# The L1 pool — decoy tiles for a bank rendered in English
# ---------------------------------------------------------------------------


TRANSLATIONS = [
    "The bread is warm.",
    "The soup is very tasty.",
    "My house has three rooms.",
    "The dog runs in the park.",
    "The book is on the table.",
]


def test_the_l1_pool_holds_english_tokens_and_no_course_language_lemma() -> None:
    """`word_bank_reverse` renders an English grid, so its tiles have to be English.

    The rule core is a course-language machine — its POS tags, its bands and its
    attested inflections are facts about Spanish — and asking it for an English tile
    returned `["aprendo", "está", "conocerte"]` under the prompt `Write this in
    English`. V5 could not catch it: its POS clause can only be evaluated against the
    course-language ledger, and those three have no row in it.
    """
    pool = L1DecoyPool.build(TRANSLATIONS, exclude_lemmas=["the", "is", "el", "pan"])
    assert "bread" in pool.tokens
    assert "the" not in pool.tokens and "is" not in pool.tokens
    # Sorted, deduplicated, and a sentence-initial capital is lower-cased: a tile is not
    # a sentence start.
    assert list(pool.tokens) == sorted(pool.tokens)
    assert len(set(pool.tokens)) == len(pool.tokens)
    assert "The" not in pool.tokens
    # Trailing punctuation never rides onto a tile.
    assert all(not token.endswith((".", ",", "?", "!")) for token in pool.tokens)


def test_the_l1_pool_never_offers_a_token_of_the_displayed_prompt() -> None:
    """The second half of the same defect: one shipped decoy (`está`) was a word of the
    Spanish sentence rendered directly above the bank, so the exercise was answerable by
    copying."""
    pool = L1DecoyPool.build(TRANSLATIONS)
    drawn = pool.decoys(
        key="sentence:x",
        accepted=["The", "soup", "is", "very", "tasty."],
        prompt_tokens=["The", "book", "is", "on", "the", "table."],
        alternatives=AlternativesIndex(),
        count=3,
    )
    assert len(drawn) == 3
    forbidden = {"the", "soup", "is", "very", "tasty", "book", "on", "table"}
    assert not {token.casefold() for token in drawn} & forbidden


def test_the_l1_pool_refuses_rather_than_repeating_itself() -> None:
    """Same rule as the rule core: running out is a content failure, not a licence to
    pad from the course language."""
    pool = L1DecoyPool.build(["The bread is warm."])
    with pytest.raises(NotEnoughDistractors, match="English word bank"):
        pool.decoys(
            key="sentence:x",
            accepted=["bread"],
            prompt_tokens=["warm"],
            alternatives=AlternativesIndex(),
            count=3,
        )


def test_the_l1_pool_honours_the_alternatives_index() -> None:
    """V5's third clause applies to an English tile too: a string that is an accepted
    answer of a sibling exercise over the same item may not be a distractor for it."""
    pool = L1DecoyPool.build(TRANSLATIONS)
    alternatives = AlternativesIndex()
    alternatives.add("lexeme:perro", ["dog", "park", "runs"])
    drawn = pool.decoys(
        key="lexeme:perro",
        accepted=["dog"],
        prompt_tokens=[],
        alternatives=alternatives,
        count=4,
    )
    assert not {token.casefold() for token in drawn} & {"dog", "park", "runs"}


def test_the_l1_pool_is_deterministic() -> None:
    """A pack must rebuild byte-identically; the player's saved tile indices ride on it."""
    pool = L1DecoyPool.build(TRANSLATIONS)
    call = dict(
        key="sentence:x", accepted=["bread"], prompt_tokens=[],
        alternatives=AlternativesIndex(), count=3,
    )
    assert pool.decoys(**call) == pool.decoys(**call)


def test_the_alternatives_index_renders_the_authored_casing() -> None:
    """`everywhere` holds casefolded comparison keys. `complete_the_chat` drew its one
    wrong reply line from there and shipped `el pan está caliente.` as rendered copy."""
    index = AlternativesIndex()
    index.add("sentence:1", ["El pan está caliente."])
    folded = normalise("El pan está caliente.")
    assert folded in index.everywhere
    assert folded == "el pan está caliente."
    assert index.original(folded) == "El pan está caliente."
    with pytest.raises(KeyError):
        index.original("a string nobody added")
