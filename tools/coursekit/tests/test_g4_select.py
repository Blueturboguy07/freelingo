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

from coursekit.artifacts import (
    ARTIFACT_SCHEMA_VERSION,
    read_records,
    validate_record,
    write_records,
)
from coursekit.config.g3 import LESSONS_PER_LEVEL
from coursekit.config.g4 import (
    CANDIDATE_TOKENS_MAX,
    CANDIDATE_TOKENS_MIN,
    CROSS_UNIT_REPEAT_CEILING,
    LEDGER_EXCLUDED_POS,
    MAX_GAP_FRACTION,
    MAX_NEW_LEMMAS_PER_EXERCISE,
    MAX_NEW_LEMMAS_PER_LESSON,
    MAX_USES_PER_SENTENCE_PER_COURSE,
    PREDICTED_YIELD_MAX,
    PREDICTED_YIELD_MIN,
    SLOTS_PER_LESSON,
)
from coursekit.runlog import RunLog
from coursekit.stages import STAGES, StageContext, StageResult
from coursekit.stages.g3_solve import load_curriculum, solve
from coursekit.stages.g4_select import (
    Candidate,
    SelectReport,
    build_candidates,
    main,
    measure_candidate_yield,
    read_tatoeba,
    select,
    short_candidates,
    stage_verdict,
)

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
    """Turn G4's slots into `exercise` records, the way G7 will.

    G7 belongs to another lane, so this is the minimum honest projection: one translate
    exercise per slot, tagged with the lemmas it puts in front of the learner and with its
    unit's grammar concept. It is deliberately a FAITHFUL tagger — a projection that
    mis-tagged would make V4 red for a reason that has nothing to do with the ledger.
    Every record is validated against the frozen contract before it is used.

    A GAP IS PROJECTED TOO, and it has to be. G4 reserves a gap slot to teach one named
    lemma and records that lemma as shown, because G5 fills the slot with a sentence that
    introduces it. Dropping gaps from this projection models a course in which that
    promise is broken — the reserved word is never introduced by anything — and V2 then
    reports the NEXT exercise using it as carrying two new lemmas. Measured on es-mini
    the moment G4 started reserving: seven blocking V2 findings, all of that shape, none
    of them a ledger defect. So a gap projects as an exercise whose only lemma tag is the
    one the slot reserves. It is the narrowest claim the reservation actually makes; it
    invents no sentence and no vocabulary G5 has not been told to use.
    """
    by_id = {candidate.sentence_id: candidate for candidate in candidates}
    exercises: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        if item["gap"]:
            if not item["new_lemmas"]:
                continue
            gap_record = {
                "schema_version": ARTIFACT_SCHEMA_VERSION,
                "lang": item["lang"],
                "exercise_id": f"{index:016x}",
                "unit_index": item["unit_index"],
                "lesson_index": item["lesson_index"],
                "type": "translate",
                "prompt": "Translate this sentence.",
                "accepted_answers": ["G5 authors this slot"],
                "distractors": [],
                "alignment": [],
                "item_tags": {
                    "lemmas": sorted(item["new_lemmas"]),
                    "grammar_concepts": [item["grammar_concept"]],
                },
                "audio_ref": None,
                "register": "n/a",
                "source_sentence_id": None,
            }
            validate_record("exercise", gap_record)
            exercises.append(gap_record)
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


# ---------------------------------------------------------------------------
# The stage, run as a stage
# ---------------------------------------------------------------------------
#
# Everything above calls `select()`. Nothing above ever reached `select_items()`, which
# means the two ceilings in `stage_verdict` — the ONLY things standing between a thin
# corpus and a course handed to G5 — had never been executed by any test, in either
# direction. The refuter found that by re-running the pipeline: es-mini gaps 87% of its
# slots and `run()` refuses it, while the test suite reported the same ledger as clean.


def run_g4_over_es_mini() -> tuple[StageResult, list[dict[str, Any]]]:
    """Run the REAL g3 and g4 stages over the fixture, and return g4's verdict.

    `conftest.isolated_build_root` has already pointed `COURSEKIT_BUILD_ROOT` at a
    tmp_path, so this writes nowhere near the repository's `build/`. G0, G1 and G2 belong
    to other lanes, so their outputs are written straight from the fixture under their own
    runlog entries — which is also what makes `require_successful` a real check here
    rather than a line nothing exercises.
    """
    runlog = RunLog("es")
    upstream = {
        "g0": ("ingested_sentence", ingested_rows()),
        "g1": ("analysed_sentence", list(analyse_es_mini())),
        "g2": ("banded_lemma", banded_rows()),
    }
    for stage_id, (kind, rows) in upstream.items():
        with runlog.stage(stage_id, tool="test", tool_version="0") as entry:
            entry.written = write_records(kind, rows, lang="es")
            entry.record_output(kind)

    for stage_id in ("g3", "g4"):
        stage = REGISTERED_AT_IMPORT[stage_id]
        with runlog.stage(stage_id, tool="test", tool_version="0") as entry:
            result = stage.run(StageContext(lang="es", runlog=runlog, entry=entry))
            if not result.ok:
                entry.status = "failed"

    return result, list(read_records("selected_item", lang="es"))


def test_the_stage_refuses_the_es_mini_pack_and_names_the_ceiling() -> None:
    """G4's own gate REJECTS the pack this lane's fixture produces, and that is correct.

    Measured 2026-09-12 at this commit: 756 slots, 98 filled, 658 gaps, gap_fraction
    0.8704, against `MAX_GAP_FRACTION` 0.60. The fixture is 200 sentences and the
    curriculum is 30 units; no arrangement of 200 sentences fills 756 slots.

    The point of asserting it is that the previous version of this suite never did.
    `INV-PACK-06`'s pack half called `select()` directly, so the ledger it certified as
    clean was one the pipeline refuses to hand to G5 — the validators were right and the
    claim around them was too broad. The honest statement of what es-mini proves is in
    `test_validators_ledger.py`'s module docstring.
    """
    verdict, items = run_g4_over_es_mini()
    assert verdict.ok is False
    assert "over the 60% ceiling" in verdict.message
    assert verdict.detail["slots"] == len(items)
    assert verdict.detail["gap_fraction"] > MAX_GAP_FRACTION
    #: and the rejected run still WROTE every row, gaps included: a stage that fails its
    #: gate must leave the evidence behind, not delete it.
    assert [item for item in items if item["gap"]]


def test_the_stage_verdict_is_the_one_the_stage_returns() -> None:
    """`select_items` returns exactly `stage_verdict(report)`, so the tests below are
    tests OF the gate rather than of a parallel copy of it."""
    verdict, _ = run_g4_over_es_mini()
    _, g4, _ = es_mini_run()
    assert verdict == stage_verdict(g4.report)


def _report(*, slots: int, gaps: int, repeats: int = 0, yield_: float = 0.10) -> SelectReport:
    """A finished report with the two ratios set exactly, and nothing else pretended."""
    report = SelectReport(census={"candidates": 1000})
    report.slots = slots
    report.gaps = gaps
    report.filled = slots - gaps
    report.cross_unit_repeats = repeats
    report.ledger_yield = yield_
    report.within_prediction = PREDICTED_YIELD_MIN <= yield_ <= PREDICTED_YIELD_MAX
    return report


@pytest.mark.parametrize(
    ("gaps", "ok"),
    [(61, False), (60, True)],
    ids=["just over the gap ceiling", "exactly at the gap ceiling"],
)
def test_the_gap_ceiling_decides_the_stage_in_both_directions(gaps: int, ok: bool) -> None:
    """60 gaps in 100 slots passes; 61 does not. The comparison is `>`, not `>=`.

    `MAX_GAP_FRACTION` is the gate that stops a thin corpus from being laundered into a
    $100 authoring bill at G5, and until this test it had never returned False anywhere
    except in production.
    """
    assert MAX_GAP_FRACTION == 0.60
    verdict = stage_verdict(_report(slots=100, gaps=gaps))
    assert verdict.ok is ok
    if not ok:
        assert "G5 is an authoring stage with a budget" in verdict.message


@pytest.mark.parametrize(
    ("repeats", "ok"),
    [(6, False), (5, True)],
    ids=["just over the repeat ceiling", "exactly at the repeat ceiling"],
)
def test_the_cross_unit_repeat_ceiling_decides_the_stage_in_both_directions(
    repeats: int, ok: bool
) -> None:
    """V9's second half as a STAGE gate: 5 repeats in 100 filled slots passes, 6 does not.

    Some repetition is recycling working as designed; a lot of it is a corpus that ran
    out and a selector that hid it.
    """
    assert CROSS_UNIT_REPEAT_CEILING == 0.05
    verdict = stage_verdict(_report(slots=100, gaps=0, repeats=repeats))
    assert verdict.ok is ok
    if not ok:
        assert "reuse a sentence from an earlier unit" in verdict.message


def test_the_gap_ceiling_is_checked_before_the_repeat_ceiling() -> None:
    """Both breached: the reader is told about the gaps, which is the bigger fact."""
    verdict = stage_verdict(_report(slots=100, gaps=99, repeats=1))
    assert verdict.ok is False
    assert "are gaps" in verdict.message


@pytest.mark.parametrize(
    ("yield_", "flagged"),
    [(0.10, False), (0.1606, True), (0.01, True)],
    ids=["inside the predicted band", "above it", "below it"],
)
def test_a_yield_outside_the_predicted_band_is_stated_in_the_verdict(
    yield_: float, flagged: bool
) -> None:
    """`PREDICTED_YIELD_MIN/MAX` exist to make a prediction failure VISIBLE.

    Before this, `within_prediction` was computed, written to the runlog and read by
    nobody — so the 16.06% measured against real Tatoeba, which is above the framework's
    15% ceiling, was a prediction failure that nothing in the tool would ever mention.
    """
    verdict = stage_verdict(_report(slots=100, gaps=0, yield_=yield_))
    assert verdict.ok is True
    assert ("OUTSIDE the predicted" in verdict.message) is flagged


# ---------------------------------------------------------------------------
# deep/10 Open Question 1 — the committed measurement
# ---------------------------------------------------------------------------


def _stub_analyser(analyses: Mapping[str, Sequence[tuple[str, str]]]) -> Any:
    """Turn a `{text: [(lemma, pos), ...]}` table into an `Analyser`."""

    def analyse(texts: Sequence[str]) -> Any:
        for text in texts:
            yield [
                {"lemma": lemma, "pos": pos, "morph": ""} for lemma, pos in analyses[text]
            ]

    return analyse


def test_the_yield_measurement_counts_what_open_question_1_asked_for() -> None:
    """Admitted = every content lemma is in the ledger. Exhibiting = and it shows a concept.

    Five sentences: one too short and one too long (dropped before anything else), one
    whose lemmas are all in the curriculum and which exhibits a concept, one admitted but
    exhibiting nothing, and one carrying a lemma the curriculum never teaches.
    """
    curriculum = load_curriculum("es", path=ES_CURRICULUM)
    ledger = {lx for _, unit in curriculum.units() for lx in unit.target_lexemes}
    taught = sorted(ledger)[0]
    texts = {
        "too short": [("x", "NOUN")],
        "a b c d e f g h i j k l m": [("x", "NOUN")],
        "admitted and exhibiting": [(taught, "NOUN"), ("ser", "AUX"), (".", "PUNCT")],
        "admitted only here": [(taught, "NOUN")],
        "carries an untaught word": [(taught, "NOUN"), ("zzzuntaught", "NOUN")],
    }
    measurement = measure_candidate_yield(
        list(texts),
        curriculum,
        _stub_analyser(texts),
        sample=0,
        corpus="unit-test",
    )
    assert measurement.total == 5
    assert measurement.sample == measurement.short == 3
    assert measurement.admitted == 2  # the untaught-word sentence is not one of them
    assert 1 <= measurement.exhibiting <= measurement.admitted
    assert measurement.ledger_lexemes == len(ledger)
    assert measurement.admitted_fraction == pytest.approx(2 / 3)
    assert measurement.within_prediction is False


def test_the_yield_measurement_uses_the_length_window_from_config() -> None:
    """The denominator of the headline number is `CANDIDATE_TOKENS_MIN..MAX`, not a
    number retyped into a script that can drift from the stage."""
    texts = ["w " * n for n in range(1, 20)]
    kept = short_candidates(text.strip() for text in texts)
    assert {len(text.split()) for text in kept} == set(
        range(CANDIDATE_TOKENS_MIN, CANDIDATE_TOKENS_MAX + 1)
    )


def test_the_yield_command_reads_a_tatoeba_export_and_prints_json(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`python -m coursekit.stages.g4_select --corpus <tsv>` — the re-runnable command.

    The 16.06% figure in `docs/owned/p2-g3-g4.json` was first measured by a script in a
    scratchpad that no longer exists, which makes a load-bearing number unre-runnable by
    the integrator or the founder. This is that script, committed inside the stage whose
    admission predicate it borrows, and this test runs its whole path: the export reader,
    the length window, the ledger test and the JSON it prints. Only the lemmatiser is
    stubbed, because a 40,000-sentence spaCy run is not a unit test.
    """
    export = tmp_path / "spa_sentences.tsv"
    curriculum = load_curriculum("es", path=ES_CURRICULUM)
    taught = sorted({lx for _, u in curriculum.units() for lx in u.target_lexemes})[0]
    rows = {"uno dos tres": [(taught, "NOUN")], "x": [("x", "NOUN")]}
    export.write_text(
        "".join(f"{i}\tspa\t{text}\n" for i, text in enumerate(rows, start=1))
        + "9\tspa\n",  # a malformed row: skipped, never guessed at
        encoding="utf-8",
    )
    assert read_tatoeba(export) == list(rows)

    assert main(
        ["--corpus", str(export), "--lang", "es", "--sample", "0"],
        analyse=_stub_analyser(rows),
    ) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["sentences"] == 2
    assert printed[f"short_{CANDIDATE_TOKENS_MIN}_to_{CANDIDATE_TOKENS_MAX}_tokens"] == 1
    assert printed["admitted_by_the_ledger"] == 1
    assert printed["ledger_yield"] == 1.0
    assert printed["predicted_range"] == [PREDICTED_YIELD_MIN, PREDICTED_YIELD_MAX]
    assert printed["within_prediction"] is False


# ---------------------------------------------------------------------------
# INV-PACK-06 — a gap carries the ledger it is authored against
# ---------------------------------------------------------------------------


def test_INV_PACK_06_a_gap_carries_a_non_empty_ledger() -> None:
    """[INV-PACK-06] THE FALSIFIER, and it shipped: a gap used to carry no ledger at all.

    G4 emitted every gap with `new_lemmas: []` and `known_lemmas: []`. G5's permitted
    vocabulary is `known | new`, so every reserved slot permitted the EMPTY SET, and no
    sentence in any language is inside the empty set. The 918-slot gap list of run
    34684986287 was therefore unfillable by construction — V4's coverage clause could
    never reach 100% because the slots reserved to fix coverage could never be filled.

    A gap whose ledger is empty is not a gap, it is a slot nobody can author.
    """
    _, g4, _ = es_mini_run()
    gaps = [item for item in g4.items if item["gap"]]
    assert gaps, "the fixture must produce gaps or this proves nothing"
    empty = [item for item in gaps if not (item["known_lemmas"] or item["new_lemmas"])]
    assert empty == [], f"{len(empty)} gap(s) carry an empty ledger; nothing can fill them"


def test_INV_PACK_06_a_gaps_ledger_never_contains_a_lemma_from_a_later_unit() -> None:
    """[INV-PACK-06] V1's rule, applied to the window G5 authors inside.

    V1 is "no lemma appears before its introduction unit". The gap's ledger is what an
    authored sentence is allowed to use, so a ledger holding a lemma introduced later
    would let G5 write a V1 failure that passes every axis on the way in.
    """
    g3, g4, _ = es_mini_run()
    introduction = {
        lemma: unit["unit_index"] for unit in g3.units for lemma in unit["target_lemmas"]
    }
    for item in g4.items:
        if not item["gap"]:
            continue
        for lemma in (*item["known_lemmas"], *item["new_lemmas"]):
            assert introduction.get(lemma, 0) <= item["unit_index"], (lemma, item)


def test_INV_PACK_06_a_gap_reserves_at_most_one_new_item_and_never_one_it_knows() -> None:
    """[INV-PACK-06] V2's per-exercise budget holds for reserved slots too.

    A gap that reserved two new lemmas would ask the author for a sentence V2 rejects,
    and `known` and `new` overlapping would make the budget uncountable.
    """
    _, g4, _ = es_mini_run()
    for item in g4.items:
        if not item["gap"]:
            continue
        assert len(item["new_lemmas"]) <= MAX_NEW_LEMMAS_PER_EXERCISE
        assert not (set(item["new_lemmas"]) & set(item["known_lemmas"]))


def test_INV_PACK_06_two_gap_slots_in_one_lesson_reserve_different_words() -> None:
    """[INV-PACK-06] V4 coverage: nine gaps in a lesson must not all teach one word.

    A reserved slot teaches its lemma as surely as a filled one does, so the stage has to
    record it as shown. Without that, `pending` never shrinks and every gap in the lesson
    names the same next word — nine slots, one new item, and the unit's other target
    lexemes never reserved at all, which is a V4 coverage failure with no gap against it.
    """
    _, g4, _ = es_mini_run()
    by_lesson: dict[tuple[int, int], list[str]] = {}
    for item in g4.items:
        if not item["gap"] or not item["new_lemmas"]:
            continue
        by_lesson.setdefault((item["unit_index"], item["lesson_index"]), []).extend(
            item["new_lemmas"]
        )
        assert MAX_NEW_LEMMAS_PER_LESSON >= 1
    multi = {key: value for key, value in by_lesson.items() if len(value) > 1}
    assert multi, "no lesson in the fixture has two reserving gaps; this proves nothing"
    for key, reserved in multi.items():
        assert len(reserved) == len(set(reserved)), (key, reserved)
