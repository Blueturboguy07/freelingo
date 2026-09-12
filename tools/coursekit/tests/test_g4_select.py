"""G4 — select, and the G1 analysis the other two P2 test modules borrow from here.

`analyse_es_mini()` lives in this module rather than in `conftest.py` because `conftest.py`
is not this lane's file. `tests/` is on `sys.path` under pytest's default prepend import
mode, so `from test_g4_select import analyse_es_mini` works from the sibling modules; if
that ever stops being true the fix is one `conftest.py` fixture, owned by whoever owns
that file.

The analysis is the real pinned lemmatiser, not a hand-written stub. `es_core_news_md`
3.8.0 is pinned by wheel URL and synced by CI, and running the fixture through it is the
only way these tests are about the ledger the pipeline would actually produce. Where it is
absent the tests skip rather than substituting a toy analyser: a ledger validated against
a different lemmatiser is a ledger validated against nothing, which is the whole reason
the wheel is pinned by URL in the first place.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from functools import lru_cache
from pathlib import Path
from typing import Any

import pytest

from coursekit.artifacts import ARTIFACT_SCHEMA_VERSION, validate_record
from coursekit.config.g3 import LESSONS_PER_LEVEL
from coursekit.config.g4 import (
    CANDIDATE_TOKENS_MAX,
    LEDGER_EXCLUDED_POS,
    MAX_NEW_LEMMAS_PER_EXERCISE,
    MAX_NEW_LEMMAS_PER_LESSON,
    MAX_USES_PER_SENTENCE_PER_COURSE,
    SLOTS_PER_LESSON,
)
from coursekit.stages import STAGES
from coursekit.stages.g3_solve import load_curriculum, solve
from coursekit.stages.g4_select import Candidate, build_candidates, select

FIXTURES = Path(__file__).parent / "fixtures" / "es-mini"
REPO_ROOT = Path(__file__).resolve().parents[3]
ES_CURRICULUM = REPO_ROOT / "content" / "es" / "curriculum.yaml"


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def ingested_rows() -> list[dict[str, Any]]:
    return read_jsonl(FIXTURES / "sentences.jsonl")


def banded_rows() -> list[dict[str, Any]]:
    return read_jsonl(FIXTURES / "banded.jsonl")


@lru_cache(maxsize=1)
def analyse_es_mini() -> tuple[dict[str, Any], ...]:
    """G1 over the fixture with the pinned model. Cached: the model load dominates."""
    spacy = pytest.importorskip("spacy", reason="the `nlp` group is not installed")
    try:
        nlp = spacy.load("es_core_news_md")
    except OSError:  # pragma: no cover - only on a machine without the pinned wheel
        pytest.skip("es_core_news_md 3.8.0 is not installed; `uv sync --group nlp`")

    rows = ingested_rows()
    analysed: list[dict[str, Any]] = []
    for row, doc in zip(rows, nlp.pipe([r["text"] for r in rows]), strict=True):
        tokens = [
            {
                "surface": token.text,
                "lemma": token.lemma_.lower(),
                "pos": token.pos_,
                "morph": str(token.morph),
                "start": token.idx,
                "end": token.idx + len(token.text),
            }
            for token in doc
        ]
        record = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "sentence_id": row["sentence_id"],
            "lang": "es",
            "adapter": {
                "name": "spacy",
                "version": spacy.__version__,
                "model": "es_core_news_md-3.8.0",
                "split_mode": None,
            },
            "tokens": tokens,
            "lemmas": sorted({token["lemma"] for token in tokens}),
            "display_tokens": [token["surface"] for token in tokens],
        }
        validate_record("analysed_sentence", record)
        analysed.append(record)
    return tuple(analysed)


def es_mini_candidates() -> tuple[list[Candidate], dict[str, int]]:
    return build_candidates(ingested_rows(), list(analyse_es_mini()))


def project_exercises(
    items: Sequence[Mapping[str, Any]],
    candidates: Iterable[Candidate],
) -> list[dict[str, Any]]:
    """Turn G4's filled slots into `exercise` records, the way G7 will.

    G7 belongs to another lane, so this is the minimum honest projection: one translate
    exercise per filled slot, tagged with the lemmas the sentence actually contains and
    with its unit's grammar concept. It is deliberately a FAITHFUL tagger — a projection
    that mis-tagged would make V4 red for a reason that has nothing to do with the ledger.
    Every record is validated against the frozen contract before it is used.
    """
    by_id = {candidate.sentence_id: candidate for candidate in candidates}
    exercises: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        if item["gap"]:
            continue
        candidate = by_id[str(item["sentence_id"])]
        record = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "lang": item["lang"],
            "exercise_id": f"{index:016x}",
            "unit_index": item["unit_index"],
            "lesson_index": item["lesson_index"],
            "type": "translate",
            "prompt": "Translate this sentence.",
            "accepted_answers": ["projection does not grade"],
            "distractors": [],
            "alignment": [],
            "item_tags": {
                "lemmas": sorted(candidate.lemmas),
                "grammar_concepts": [item["grammar_concept"]],
            },
            "audio_ref": None,
            "register": "n/a",
            "source_sentence_id": item["sentence_id"],
        }
        validate_record("exercise", record)
        exercises.append(record)
    return exercises


# ---------------------------------------------------------------------------
# Candidate building
# ---------------------------------------------------------------------------


def _analysed(sentence_id: str, tokens: list[tuple[str, str, str]]) -> dict[str, Any]:
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "sentence_id": sentence_id,
        "lang": "es",
        "adapter": {"name": "t", "version": "1", "model": None, "split_mode": None},
        "tokens": [
            {
                "surface": surface,
                "lemma": lemma,
                "pos": pos,
                "morph": "",
                "start": index,
                "end": index + 1,
            }
            for index, (surface, lemma, pos) in enumerate(tokens)
        ],
        "lemmas": sorted({lemma for _, lemma, _ in tokens}),
        "display_tokens": [surface for surface, _, _ in tokens],
    }


def _ingested(sentence_id: str, *, verdict: str = "shippable", tokens: int = 4) -> dict[str, Any]:
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "sentence_id": sentence_id,
        "lang": "es",
        "l1": "en",
        "text": "x",
        "translation": "x",
        "source_id": "test",
        "corpus": "test",
        "corpus_version": "1",
        "licence": "CC0-1.0",
        "licence_verdict": verdict,
        "attribution_required": False,
        "attribution_owner": None,
        "token_count": tokens,
        "dedup_hash": "0" * 32,
    }


def test_only_shippable_rows_become_candidates() -> None:
    """Oracle-only text informs statistics and never fills a lesson slot."""
    ingested = [
        _ingested("1" * 16, verdict="shippable"),
        _ingested("2" * 16, verdict="oracle_only"),
        _ingested("3" * 16, verdict="forbidden"),
    ]
    analysed = [
        _analysed("1" * 16, [("a", "a", "NOUN")]),
        _analysed("2" * 16, [("b", "b", "NOUN")]),
        _analysed("3" * 16, [("c", "c", "NOUN")]),
    ]
    candidates, census = build_candidates(ingested, analysed)
    assert [candidate.sentence_id for candidate in candidates] == ["1" * 16]
    assert census["not_shippable"] == 2


def test_the_length_window_is_applied_before_anything_else() -> None:
    ingested = [
        _ingested("1" * 16, tokens=2),
        _ingested("2" * 16, tokens=CANDIDATE_TOKENS_MAX + 1),
        _ingested("3" * 16, tokens=5),
    ]
    analysed = [_analysed(sid * 16, [("a", "a", "NOUN")]) for sid in "123"]
    candidates, census = build_candidates(ingested, analysed)
    assert [candidate.sentence_id for candidate in candidates] == ["3" * 16]
    assert census["wrong_length"] == 2


def test_punctuation_is_not_a_ledger_item() -> None:
    """The bug that made the whole stage a no-op while reporting success.

    With a full stop in the lemma set, every sentence waits forever on a lemma no
    curriculum will ever introduce: 0 of 200 candidates admissible and 738 of 738 slots
    gapped, with no error anywhere. Measured on this fixture before `LEDGER_EXCLUDED_POS`
    existed.
    """
    analysed = [
        _analysed("1" * 16, [("Hola", "hola", "INTJ"), (".", ".", "PUNCT")]),
        _analysed("2" * 16, [(".", ".", "PUNCT"), ("?", "?", "PUNCT")]),
    ]
    ingested = [_ingested("1" * 16), _ingested("2" * 16)]
    candidates, census = build_candidates(ingested, analysed)
    assert [candidate.lemmas for candidate in candidates] == [frozenset({"hola"})]
    assert census["no_ledger_lemmas"] == 1
    assert "PUNCT" in LEDGER_EXCLUDED_POS


# ---------------------------------------------------------------------------
# Selection over the fixture
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def es_mini_run() -> tuple[Any, Any, list[Candidate]]:
    """G3 then G4 over the real Spanish curriculum and the es-mini fixture."""
    curriculum = load_curriculum("es", path=ES_CURRICULUM)
    banded = banded_rows()
    g3 = solve(curriculum, banded)
    candidates, census = es_mini_candidates()
    g4 = select(g3.units, candidates, curriculum.concepts, census)
    return g3, g4, candidates


def test_every_slot_is_written_filled_or_gapped() -> None:
    """A gap is a row, never a silence. A lesson that quietly got shorter is invisible."""
    _, g4, _ = es_mini_run()
    assert len(g4.items) == g4.report.slots
    assert g4.report.filled + g4.report.gaps == g4.report.slots
    gaps = [item for item in g4.items if item["gap"]]
    assert gaps, "the fixture corpus cannot fill a 30-unit course; the gaps must be visible"
    for item in gaps:
        assert item["sentence_id"] is None
        assert item["provenance"] == "llm"
    for item in g4.items:
        validate_record("selected_item", item)


def test_selection_obeys_the_new_item_budget() -> None:
    """At most one of the unit's own new items per exercise, at most K per lesson."""
    _, g4, _ = es_mini_run()
    per_lesson: dict[tuple[int, int], set[str]] = {}
    for item in g4.items:
        assert len(item["new_lemmas"]) <= MAX_NEW_LEMMAS_PER_EXERCISE
        key = (item["unit_index"], item["lesson_index"])
        per_lesson.setdefault(key, set()).update(item["new_lemmas"])
    for key, new in per_lesson.items():
        assert len(new) <= MAX_NEW_LEMMAS_PER_LESSON, key


def test_no_lemma_is_selected_before_its_unit() -> None:
    """V1 by construction: this is the property the whole stage exists to preserve."""
    g3, g4, candidates = es_mini_run()
    introduction = {
        lemma: unit["unit_index"] for unit in g3.units for lemma in unit["target_lemmas"]
    }
    by_id = {candidate.sentence_id: candidate for candidate in candidates}
    for item in g4.items:
        if item["gap"]:
            continue
        for lemma in by_id[item["sentence_id"]].lemmas:
            assert introduction.get(lemma, 0) <= item["unit_index"], (lemma, item)


def test_no_sentence_is_used_twice_in_the_course() -> None:
    _, g4, _ = es_mini_run()
    used = [item["sentence_id"] for item in g4.items if not item["gap"]]
    assert len(used) == len(set(used))
    assert MAX_USES_PER_SENTENCE_PER_COURSE == 1
    assert g4.report.cross_unit_repeats == 0


def test_the_lesson_count_comes_from_g3_not_from_the_corpus() -> None:
    g3, g4, _ = es_mini_run()
    expected = sum(unit["level_count"] * LESSONS_PER_LEVEL for unit in g3.units)
    assert g4.report.slots == expected * SLOTS_PER_LESSON


def test_selection_is_deterministic() -> None:
    """A reshuffled ledger re-keys every content-hashed FSRS row on pack update."""
    curriculum = load_curriculum("es", path=ES_CURRICULUM)
    banded = banded_rows()
    candidates, census = es_mini_candidates()
    first = select(solve(curriculum, banded).units, candidates, curriculum.concepts, census)
    second = select(solve(curriculum, banded).units, candidates, curriculum.concepts, census)
    assert first.items == second.items


def test_the_ledger_yield_is_measured_and_reported() -> None:
    """`deep/10` Open Question 1: the number stops being untested here.

    The assertion is about the MEASUREMENT, not about a value. The fixture is 200 original
    sentences written on the same themes as this curriculum, so its admission rate is an
    upper bound on a real corpus and a poor estimate of one; what this test pins is that
    the stage computes the number over the right denominator and writes it where a reader
    can find it.
    """
    _, g4, candidates = es_mini_run()
    notes = g4.report.as_notes()["ledger_yield"]
    assert notes["short_shippable_candidates"] == len(candidates)
    assert 0.0 < notes["ledger_yield"] <= 1.0
    assert notes["admitted_by_the_ledger"] <= len(candidates)
    assert notes["actually_selected"] == g4.report.selected_distinct
    assert notes["predicted_range"] == [0.05, 0.15]


def test_a_thin_corpus_gaps_most_of_the_course_and_says_so() -> None:
    """200 sentences cannot carry 30 units, and the stage must not pretend otherwise."""
    _, g4, _ = es_mini_run()
    assert g4.report.gap_fraction > 0.5
    assert sum(g4.report.per_unit_gaps.values()) == g4.report.gaps


#: Captured at IMPORT time; see the same note in `test_g3_solve.py`.
REGISTERED_AT_IMPORT = {stage_id: stage for stage_id, stage in STAGES}


def test_g4_is_registered() -> None:
    """The wiring. `coursekit build es` dispatches to this stage with no CLI change."""
    stage = REGISTERED_AT_IMPORT.get("g4")
    assert stage is not None
    assert stage.writes == ("selected_item",)
    assert "unit_assignment" in stage.reads
