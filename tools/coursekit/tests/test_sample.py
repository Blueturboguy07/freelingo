"""`coursekit sample` — the stratified draw, its determinism, and the honesty string.

Three properties, each with the shortcut that would break it:

* **stratified**, not uniform — a draw that ignored exercise type would say nothing about
  the word bank, and a draw that ignored provenance would say nothing about the
  gap-filled rows, which are the ones a defect rate exists to measure;
* **deterministic under the recorded seed** — a sheet that cannot be redrawn belongs to
  no measurable population, so a reviewer's 300 rows and a maintainer's 300 rows six
  weeks later have to be the same 300;
* **never a rate without its provenance** — this run has no paid native reviewer, and
  `PROVISIONAL (unreviewed by a paid native speaker)` has to ride with every number it
  produced.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from coursekit.artifacts import write_records
from coursekit.config import MAX_DEFECT_RATE, REVIEWER_SAMPLE_ITEMS
from coursekit.config.sample import (
    PROVISIONAL_DEFECT_RATE_NOTE,
    REVIEW_VERDICTS,
    REVIEWER_KIND_AGENT,
    REVIEWER_KIND_PAID_NATIVE,
    SAMPLE_SEED,
    SAMPLE_STRATA,
)
from coursekit.sample import (
    ScoreError,
    allocate,
    derive_review,
    draw_sample,
    gate_passed,
    read_scores,
    review_summary,
    sample_path,
    unscored_items,
    write_sample,
)
from coursekit.validators.pack import SuiteInputMissing

REPO_REVIEW_LANG = "es"

#: `tools/coursekit/tests/test_sample.py` -> three parents is the repository root.
REPO_ROOT = Path(__file__).resolve().parents[3]


# ---------------------------------------------------------------------------
# Allocation
# ---------------------------------------------------------------------------


def test_the_allocation_sums_to_the_sheet_size() -> None:
    sizes = {"a": 40, "b": 10, "c": 5, "d": 1}
    allocation = allocate(sizes, 30)
    assert sum(allocation.values()) == 30


def test_no_stratum_is_asked_for_more_rows_than_it_has() -> None:
    sizes = {"a": 2, "b": 100}
    allocation = allocate(sizes, 50)
    assert allocation["a"] <= 2
    assert sum(allocation.values()) == 50


def test_every_non_empty_stratum_gets_at_least_one_row_while_the_budget_allows() -> None:
    """The falsifier for a purely proportional split.

    Proportional allocation gives a stratum of 1 out of 5,000 a quota of 0.06, which
    rounds to nothing — and the rarest exercise type is exactly the one most likely to be
    broken. So the first pass is one each.
    """
    sizes = {f"s{index}": (500 if index == 0 else 1) for index in range(20)}
    allocation = allocate(sizes, 25)
    assert all(value >= 1 for value in allocation.values())
    assert sum(allocation.values()) == 25


def test_a_budget_smaller_than_the_strata_still_reaches_the_last_unit() -> None:
    """The falsifier for a lexicographic one-each pass, measured on this repo.

    5 units x 8 exercise types x 2 provenances is ~80 strata. A 40-row sheet allocated
    one-each in key order filled up inside units 1-4 and never drew a single row from
    unit 5 — and unit 5 is where accumulated vocabulary, and therefore drift, lands.
    """
    sizes = {
        f"{unit}|type{kind}|{provenance}": 3
        for unit in range(1, 6)
        for kind in range(8)
        for provenance in ("corpus", "llm")
    }
    allocation = allocate(sizes, 40)
    units = {key.split("|")[0] for key, value in allocation.items() if value}
    assert units == {"1", "2", "3", "4", "5"}


def test_unit_order_is_numeric_not_lexicographic() -> None:
    """`10` sorts before `2` as a string, and unit 10 would eat unit 2's budget."""
    sizes = {f"{unit}|t|corpus": 5 for unit in (1, 2, 10)}
    allocation = allocate(sizes, 3)
    assert all(value == 1 for value in allocation.values())


def test_allocation_cannot_exceed_the_population() -> None:
    assert sum(allocate({"a": 3, "b": 2}, 300).values()) == 5


def test_allocation_is_a_function_of_the_population_alone() -> None:
    """No randomness: the seed is the only source of variation in the whole draw."""
    sizes = {"a": 17, "b": 3, "c": 41}
    assert allocate(sizes, 22) == allocate(dict(reversed(list(sizes.items()))), 22)


# ---------------------------------------------------------------------------
# The draw
# ---------------------------------------------------------------------------


def test_the_draw_is_stratified_over_all_three_dimensions(make_es_build) -> None:
    make_es_build(units=5, per_unit=12, llm_every=3)
    sheet = draw_sample("es", n=40)
    assert sheet.strata == SAMPLE_STRATA
    assert {item.unit_index for item in sheet.items} == {1, 2, 3, 4, 5}
    assert len({item.exercise_type for item in sheet.items}) > 1
    assert {item.provenance for item in sheet.items} == {"corpus", "llm"}


def test_the_same_seed_draws_the_same_sheet(make_es_build) -> None:
    make_es_build(units=5, per_unit=12)
    first = draw_sample("es", n=30, seed=SAMPLE_SEED)
    second = draw_sample("es", n=30, seed=SAMPLE_SEED)
    assert [item.exercise_id for item in first.items] == [item.exercise_id for item in second.items]


def test_a_different_seed_draws_a_different_sheet(make_es_build) -> None:
    """Otherwise "deterministic under a seed" is indistinguishable from "ignores it"."""
    make_es_build(units=5, per_unit=12)
    first = draw_sample("es", n=30, seed=SAMPLE_SEED)
    second = draw_sample("es", n=30, seed=SAMPLE_SEED + 1)
    assert [item.exercise_id for item in first.items] != [
        item.exercise_id for item in second.items
    ]


def test_the_sheet_records_everything_needed_to_redraw_it(make_es_build) -> None:
    make_es_build(units=4, per_unit=10)
    sheet = draw_sample("es", n=20)
    summary = sheet.summary()
    assert summary["seed"] == SAMPLE_SEED
    assert summary["requested"] == 20
    assert summary["drawn"] == 20
    assert summary["strata"] == list(SAMPLE_STRATA)
    assert sum(summary["allocation"].values()) == 20


def test_the_default_sheet_is_the_three_hundred_the_plan_asks_for(make_es_build) -> None:
    make_es_build(units=10, per_unit=40)
    sheet = draw_sample("es")
    assert REVIEWER_SAMPLE_ITEMS == 300
    assert sheet.drawn == 300
    assert len({item.exercise_id for item in sheet.items}) == 300


def test_drawing_from_nothing_raises_instead_of_producing_a_perfect_pack() -> None:
    """An empty sheet scores 0 wrong out of 0, which reads as a flawless course."""
    with pytest.raises(SuiteInputMissing, match="exercise"):
        draw_sample("es", n=10)


def test_drawing_from_an_empty_exercise_file_raises(make_es_build) -> None:
    make_es_build(units=1, per_unit=4)
    write_records("exercise", [], lang="es")
    with pytest.raises(SuiteInputMissing, match="nothing to sample"):
        draw_sample("es", n=10)


def test_the_sheet_and_its_summary_are_written_where_ci_uploads_them(make_es_build) -> None:
    make_es_build(units=4, per_unit=10)
    sheet = draw_sample("es", n=20)
    sheet_file, summary_file = write_sample(sheet)
    assert sheet_file == sample_path("es", 20)
    rows = [json.loads(line) for line in sheet_file.read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 20
    assert {"exercise_id", "stratum", "provenance", "prompt"} <= set(rows[0])
    assert json.loads(summary_file.read_text(encoding="utf-8"))["seed"] == SAMPLE_SEED


def test_a_sheet_row_carries_the_source_sentence_a_reviewer_has_to_read(
    make_es_build,
) -> None:
    make_es_build(units=3, per_unit=8)
    sheet = draw_sample("es", n=12)
    assert all(item.source_text for item in sheet.items)
    assert all(item.accepted_answers for item in sheet.items)


# ---------------------------------------------------------------------------
# Scores and the published rate
# ---------------------------------------------------------------------------


def make_scores(tmp_path, rows) -> None:
    review = tmp_path / "content" / "es" / "review"
    review.mkdir(parents=True, exist_ok=True)
    (review / "scores.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def test_scores_are_read_and_the_rate_is_the_wrong_fraction(tmp_path) -> None:
    make_scores(
        tmp_path,
        [
            {"exercise_id": f"e{index}", "verdict": "ok", "reviewer": "opus"}
            for index in range(98)
        ]
        + [
            {"exercise_id": "e98", "verdict": "wrong", "reviewer": "opus"},
            {"exercise_id": "e99", "verdict": "awkward", "reviewer": "opus"},
        ],
    )
    scores = read_scores("es", repo_root=tmp_path)
    summary = review_summary(scores=scores, sample_size=100)
    assert summary["scored"] == 100
    assert summary["wrong_item_rate"] == pytest.approx(0.01)
    assert summary["awkward_rate"] == pytest.approx(0.01)


def test_awkward_is_not_folded_into_the_wrong_item_rate(tmp_path) -> None:
    """"A native speaker would not say it this way" and "this is not Spanish" are
    different claims, and the published number is about the second one."""
    make_scores(
        tmp_path,
        [{"exercise_id": f"e{i}", "verdict": "awkward", "reviewer": "opus"} for i in range(10)],
    )
    summary = review_summary(scores=read_scores("es", repo_root=tmp_path), sample_size=10)
    assert summary["wrong_item_rate"] == 0.0
    assert summary["awkward_rate"] == 1.0


def test_an_unknown_verdict_is_an_error_not_a_silently_dropped_row(tmp_path) -> None:
    """A verdict this module cannot read would otherwise vanish from the denominator."""
    make_scores(tmp_path, [{"exercise_id": "e0", "verdict": "meh", "reviewer": "opus"}])
    with pytest.raises(ScoreError, match="meh"):
        read_scores("es", repo_root=tmp_path)


def test_a_score_row_must_name_its_reviewer(tmp_path) -> None:
    make_scores(tmp_path, [{"exercise_id": "e0", "verdict": "ok"}])
    with pytest.raises(ScoreError, match="reviewer"):
        read_scores("es", repo_root=tmp_path)


def test_an_absent_scores_file_is_an_empty_review_not_a_crash(tmp_path) -> None:
    assert read_scores("es", repo_root=tmp_path) == []


def test_an_unscored_sample_has_no_rate_and_does_not_pass_the_gate() -> None:
    """`None` is not 0%. The plan's non-negotiable 5 gates on a measurement."""
    summary = review_summary(scores=[], sample_size=300)
    assert summary["wrong_item_rate"] is None
    assert gate_passed(summary) is False


def test_the_gate_is_the_two_percent_the_plan_names() -> None:
    assert MAX_DEFECT_RATE == 0.02
    assert gate_passed(review_summary(scores=_verdicts(6, 294), sample_size=300)) is True
    assert gate_passed(review_summary(scores=_verdicts(7, 293), sample_size=300)) is False


def _verdicts(wrong: int, ok: int) -> list[dict]:
    rows = [{"exercise_id": f"w{i}", "verdict": "wrong", "reviewer": "opus"} for i in range(wrong)]
    rows += [{"exercise_id": f"o{i}", "verdict": "ok", "reviewer": "opus"} for i in range(ok)]
    return rows


def test_an_agent_review_always_carries_the_provisional_note() -> None:
    summary = review_summary(scores=_verdicts(1, 99), sample_size=100)
    assert summary["reviewer_kind"] == REVIEWER_KIND_AGENT
    assert summary["note"] == PROVISIONAL_DEFECT_RATE_NOTE


def test_only_a_paid_native_review_clears_the_note() -> None:
    summary = review_summary(
        scores=_verdicts(1, 99), sample_size=100, reviewer_kind=REVIEWER_KIND_PAID_NATIVE
    )
    assert summary["note"] == ""


def test_the_honesty_string_is_exactly_what_the_docs_promise() -> None:
    """The literal, and then the two places that exist today that must carry it verbatim.

    The constant exists so the string is identical everywhere it is shown. Pinning the
    literal against itself proves nothing about that; a doc edit that softened the
    wording would still be green. So the two committed files are opened and searched.

    The other two carriers — the S001 pack card and the pack manifest's `review` block,
    which S137 renders — are P3 and G9 respectively and do not exist yet;
    `docs/pack-provenance.md` says so in the same terms rather than claiming four.
    """
    assert PROVISIONAL_DEFECT_RATE_NOTE == "PROVISIONAL (unreviewed by a paid native speaker)"
    carriers = {
        "docs/pack-provenance.md": REPO_ROOT / "docs" / "pack-provenance.md",
        "tools/coursekit/README.md": REPO_ROOT / "tools" / "coursekit" / "README.md",
    }
    for name, path in carriers.items():
        assert path.exists(), f"{name} is one of the places the note is promised to appear"
        assert PROVISIONAL_DEFECT_RATE_NOTE in path.read_text(encoding="utf-8"), (
            f"{name} does not carry the note verbatim. It is one constant precisely so "
            f"that it cannot be paraphrased in one place and not another."
        )


def test_the_docs_do_not_claim_the_note_already_appears_where_it_cannot() -> None:
    """The S001 card and the G9 manifest are future carriers, and must read as future.

    A provenance document that says a string "appears in exactly four places" when two
    of the four are unbuilt is the same class of claim as a validator suite that exits 0
    over an empty registry: true-sounding, unfalsifiable, wrong.
    """
    text = (REPO_ROOT / "docs" / "pack-provenance.md").read_text(encoding="utf-8")
    assert "appears in exactly four places" not in text
    assert "two places that exist today" in text
    assert "S001" in text and "does not exist yet" in text


def test_unscored_sheet_rows_are_reportable(make_es_build, tmp_path) -> None:
    make_es_build(units=3, per_unit=8)
    sheet = draw_sample("es", n=12)
    scored = [
        {"exercise_id": sheet.items[0].exercise_id, "verdict": "ok", "reviewer": "opus"}
    ]
    assert len(unscored_items(sheet, scored)) == 11


def test_the_verdict_vocabulary_is_closed() -> None:
    assert REVIEW_VERDICTS == ("ok", "awkward", "wrong")


# ---------------------------------------------------------------------------
# The committed review directory
# ---------------------------------------------------------------------------


def test_the_committed_es_scores_parse_against_the_rubric() -> None:
    """`content/es/review/scores.jsonl` is read by CI; a malformed row fails here first."""
    scores = read_scores(REPO_REVIEW_LANG)
    for row in scores:
        assert row["verdict"] in REVIEW_VERDICTS
        assert row["reviewer"]


def test_derive_review_is_none_when_nothing_has_been_drawn_or_scored(tmp_path) -> None:
    """Nothing to say is said as nothing, not as a rate of zero."""
    assert derive_review("es", repo_root=tmp_path) is None


def test_a_drawn_but_unscored_sample_still_appears_in_the_report(
    make_es_build, tmp_path
) -> None:
    """"We have not measured this" and "we measured it and it was fine" must differ.

    A drawn sheet with no scores is the state a pack is in between `coursekit sample`
    and the reviewer finishing, and the report has to show `sample_size: 40, scored: 0,
    wrong_item_rate: null` rather than dropping the block and looking unmeasured.
    """
    make_es_build(units=4, per_unit=10)
    write_sample(draw_sample("es", n=20))
    review = derive_review("es", repo_root=tmp_path)
    assert review is not None
    assert review["sample_size"] == 20
    assert review["scored"] == 0
    assert review["wrong_item_rate"] is None
    assert review["note"] == PROVISIONAL_DEFECT_RATE_NOTE
