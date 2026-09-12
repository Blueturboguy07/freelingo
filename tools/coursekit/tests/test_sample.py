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
    RECORDED_REVIEWER_KINDS,
    REVIEW_DIMENSIONS,
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
    sheet_exercise_ids,
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
    assert [item.exercise_id for item in first.items] != [item.exercise_id for item in second.items]


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
        [{"exercise_id": f"e{index}", "verdict": "ok", "reviewer": "opus"} for index in range(98)]
        + [
            {"exercise_id": "e98", "verdict": "wrong", "reviewer": "opus"},
            {"exercise_id": "e99", "verdict": "awkward", "reviewer": "opus"},
        ],
    )
    scores = read_scores("es", repo_root=tmp_path)
    summary = review_summary(
        scores=scores, sample_size=100, sheet_item_ids=[f"e{index}" for index in range(100)]
    )
    assert summary["scored"] == 100
    assert summary["joined"] == 100
    assert summary["unjoined"] == 0
    assert summary["wrong_item_rate"] == pytest.approx(0.01)
    assert summary["awkward_rate"] == pytest.approx(0.01)


def test_awkward_is_not_folded_into_the_wrong_item_rate(tmp_path) -> None:
    """ "A native speaker would not say it this way" and "this is not Spanish" are
    different claims, and the published number is about the second one."""
    make_scores(
        tmp_path,
        [{"exercise_id": f"e{i}", "verdict": "awkward", "reviewer": "opus"} for i in range(10)],
    )
    summary = review_summary(
        scores=read_scores("es", repo_root=tmp_path),
        sample_size=10,
        sheet_item_ids=[f"e{index}" for index in range(10)],
    )
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
    summary = review_summary(scores=[], sample_size=300, sheet_item_ids=["e0"])
    assert summary["wrong_item_rate"] is None
    assert gate_passed(summary) is False


def test_the_gate_is_the_two_percent_the_plan_names() -> None:
    assert MAX_DEFECT_RATE == 0.02
    assert gate_passed(_summary(6, 294)) is True
    assert gate_passed(_summary(7, 293)) is False


def _verdicts(wrong: int, ok: int) -> list[dict]:
    rows = [{"exercise_id": f"w{i}", "verdict": "wrong", "reviewer": "opus"} for i in range(wrong)]
    rows += [{"exercise_id": f"o{i}", "verdict": "ok", "reviewer": "opus"} for i in range(ok)]
    return rows


def _summary(wrong: int, ok: int, **kwargs) -> dict:
    """A review block whose sheet is exactly the rows that were scored."""
    scores = _verdicts(wrong, ok)
    return review_summary(
        scores=scores,
        sample_size=wrong + ok,
        sheet_item_ids=[row["exercise_id"] for row in scores],
        **kwargs,
    )


# ---------------------------------------------------------------------------
# Founder ruling B3 — the code half
# ---------------------------------------------------------------------------


def test_an_agent_scored_rate_under_the_gate_now_passes_it() -> None:
    """**Founder ruling B3, 2026-09-12.** P3 proceeds on an agent-scored sample.

    Before the ruling the only question was the number. The ruling makes the answer
    depend on the reviewer class as well, and says that class may be
    `REVIEWER_KIND_AGENT` for the automated run — with the paid native review moved to
    `docs/RELEASE.md` as a release prerequisite. So this is the pass the ruling grants,
    with the kind recorded on the block that passed.
    """
    summary = _summary(2, 298)
    assert summary["reviewer_kind"] == REVIEWER_KIND_AGENT
    assert summary["wrong_item_rate"] == pytest.approx(2 / 300)
    assert gate_passed(summary) is True


def test_the_gate_still_refuses_a_rate_of_none() -> None:
    """The half of B3 that did NOT move. An unmeasured pack is not a passing pack."""
    assert gate_passed(review_summary(scores=[], sample_size=300, sheet_item_ids=[])) is False
    unmeasured = {
        "reviewer_kind": REVIEWER_KIND_AGENT,
        "joined": 5,
        "wrong_item_rate": None,
    }
    assert gate_passed(unmeasured) is False


def test_the_gate_refuses_a_rate_whose_reviewer_class_is_not_recorded() -> None:
    """B3 is a ruling about WHO measured, so an unrecorded measurer is not a pass.

    The falsifier is a truthy check: `if summary["reviewer_kind"]:` accepts
    `"whoever"`, which is how a rate measured by nobody in particular ends up on the
    S001 card wearing the same weight as one a paid native speaker produced.
    """
    assert RECORDED_REVIEWER_KINDS == (REVIEWER_KIND_PAID_NATIVE, REVIEWER_KIND_AGENT)
    for kind in ("", "whoever", "intern", "unknown"):
        summary = _summary(2, 298)
        summary["reviewer_kind"] = kind
        assert gate_passed(summary) is False, kind
    for kind in RECORDED_REVIEWER_KINDS:
        summary = _summary(2, 298)
        summary["reviewer_kind"] = kind
        assert gate_passed(summary) is True, kind


def test_an_agent_review_always_carries_the_provisional_note() -> None:
    summary = _summary(1, 99)
    assert summary["reviewer_kind"] == REVIEWER_KIND_AGENT
    assert summary["note"] == PROVISIONAL_DEFECT_RATE_NOTE


def test_a_passing_agent_rate_still_carries_the_provisional_note() -> None:
    """B3 grants the pass and keeps the label. The two are not the same decision.

    "The gate accepts this rate" and "a learner may read this rate as reviewed" are
    different claims; the ruling makes the first true and leaves the second false until
    somebody is paid. A pass that cleared the note would be the pack claiming a review
    that has not happened.
    """
    summary = _summary(2, 298)
    assert gate_passed(summary) is True
    assert summary["note"] == PROVISIONAL_DEFECT_RATE_NOTE


def test_only_a_paid_native_review_clears_the_note() -> None:
    summary = _summary(1, 99, reviewer_kind=REVIEWER_KIND_PAID_NATIVE)
    assert summary["note"] == ""


# ---------------------------------------------------------------------------
# The join count the honest rate needs
# ---------------------------------------------------------------------------


def test_the_rate_is_computed_over_the_rows_that_join_this_builds_sheet() -> None:
    """The denominator is the intersection, not the length of the scores file.

    `content/es/review/scores.jsonl` is committed and the sheet is not. The draw is
    reproducible under `SAMPLE_SEED` only for a fixed population, and G0 reads a live
    Tatoeba export that rebuilds every Saturday 06:30 UTC — so a scores file can name
    exercise ids this build does not have. Ten rows scored, four of them on the sheet,
    one of those four wrong: the honest rate is 1/4, not 1/10, and a reader has to be
    able to see which.
    """
    scores = [
        {"exercise_id": "on-sheet-1", "verdict": "wrong", "reviewer": "opus"},
        {"exercise_id": "on-sheet-2", "verdict": "ok", "reviewer": "opus"},
        {"exercise_id": "on-sheet-3", "verdict": "ok", "reviewer": "opus"},
        {"exercise_id": "on-sheet-4", "verdict": "ok", "reviewer": "opus"},
    ] + [
        {"exercise_id": f"last-week-{index}", "verdict": "wrong", "reviewer": "opus"}
        for index in range(6)
    ]
    summary = review_summary(
        scores=scores,
        sample_size=4,
        sheet_item_ids=[f"on-sheet-{index}" for index in range(1, 5)],
    )
    assert summary["scored"] == 10
    assert summary["joined"] == 4
    assert summary["unjoined"] == 6
    assert summary["wrong_item_rate"] == pytest.approx(0.25)
    # And the falsifier: over `scored` the same input reads 0.6, which would fail the
    # gate for rows that belong to no population, or pass it if the stale rows were the
    # good ones. Either way the number is an average of two different builds.
    assert summary["wrong_item_rate"] != pytest.approx(6 / 10)


def test_a_review_block_with_no_sheet_on_disk_has_no_rate_at_all() -> None:
    """No sheet is not an empty sheet, and neither is a measurement.

    `None` for `joined` says the intersection could not be taken; `0` says it was taken
    and is empty. Both refuse the gate, and only one of them means a missing file.
    """
    unknown = review_summary(scores=_verdicts(1, 9), sample_size=10, sheet_item_ids=None)
    assert unknown["joined"] is None
    assert unknown["unjoined"] is None
    assert unknown["wrong_item_rate"] is None
    assert gate_passed(unknown) is False

    empty = review_summary(scores=_verdicts(1, 9), sample_size=10, sheet_item_ids=[])
    assert (empty["joined"], empty["unjoined"]) == (0, 10)
    assert empty["wrong_item_rate"] is None
    assert gate_passed(empty) is False


def test_the_gate_refuses_a_rate_no_row_of_which_is_on_this_sheet() -> None:
    """Every scored row is from another build: a 0% that describes nothing."""
    scores = [{"exercise_id": f"old-{i}", "verdict": "ok", "reviewer": "opus"} for i in range(300)]
    summary = review_summary(scores=scores, sample_size=300, sheet_item_ids=["new-1", "new-2"])
    assert summary["scored"] == 300
    assert summary["joined"] == 0
    assert summary["wrong_item_rate"] is None
    assert gate_passed(summary) is False


def test_the_sheet_reader_distinguishes_an_absent_sheet_from_an_empty_one(
    make_es_build,
) -> None:
    assert sheet_exercise_ids("es", 20) is None
    make_es_build(units=4, per_unit=10)
    sheet = draw_sample("es", n=20)
    write_sample(sheet)
    ids = sheet_exercise_ids("es", 20)
    assert ids is not None
    assert list(ids) == [item.exercise_id for item in sheet.items]


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
    scored = [{"exercise_id": sheet.items[0].exercise_id, "verdict": "ok", "reviewer": "opus"}]
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


def test_the_committed_es_review_is_the_complete_round_four_agent_pass() -> None:
    """The P2 gate may not quote a rate from a stale or partially scored sheet."""
    scores = read_scores(REPO_REVIEW_LANG)

    assert len(scores) == REVIEWER_SAMPLE_ITEMS
    assert len({row["exercise_id"] for row in scores}) == REVIEWER_SAMPLE_ITEMS
    assert {row["reviewer"] for row in scores} == {REVIEWER_KIND_AGENT}
    assert all(set(row["dimensions"]) == set(REVIEW_DIMENSIONS) for row in scores)

    method = (REPO_ROOT / "content" / "es" / "review" / "scores-method.md").read_text(
        encoding="utf-8"
    )
    assert PROVISIONAL_DEFECT_RATE_NOTE in method


def test_the_round_four_review_reports_its_red_gate_without_rounding_it_clean() -> None:
    scores = read_scores(REPO_REVIEW_LANG)
    sheet_ids = [row["exercise_id"] for row in scores]
    summary = review_summary(
        scores=scores,
        sample_size=REVIEWER_SAMPLE_ITEMS,
        sheet_item_ids=sheet_ids,
    )

    assert (summary["scored"], summary["joined"], summary["unjoined"]) == (300, 300, 0)
    assert summary["reviewer_kind"] == REVIEWER_KIND_AGENT
    assert summary["wrong_item_rate"] == pytest.approx(51 / 300)
    assert summary["awkward_rate"] == pytest.approx(22 / 300)
    assert summary["note"] == PROVISIONAL_DEFECT_RATE_NOTE
    assert gate_passed(summary) is False


def test_derive_review_is_none_when_nothing_has_been_drawn_or_scored(tmp_path) -> None:
    """Nothing to say is said as nothing, not as a rate of zero."""
    assert derive_review("es", repo_root=tmp_path) is None


def test_a_drawn_but_unscored_sample_still_appears_in_the_report(make_es_build, tmp_path) -> None:
    """ "We have not measured this" and "we measured it and it was fine" must differ.

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
    assert review["joined"] == 0
    assert review["wrong_item_rate"] is None
    assert review["note"] == PROVISIONAL_DEFECT_RATE_NOTE


def test_derive_review_joins_the_committed_scores_against_the_drawn_sheet(
    make_es_build, tmp_path
) -> None:
    """End to end, on real artefacts: `derive_review` takes the intersection itself.

    This is the path `coursekit validate` uses (`commands/_run.py`), so the join has to
    happen there and not only in `review_summary`'s signature. Half the scored rows name
    ids from the sheet and half are invented, and the rate follows the half that joins.
    """
    make_es_build(units=4, per_unit=10)
    sheet = draw_sample("es", n=20)
    write_sample(sheet)
    on_sheet = [item.exercise_id for item in sheet.items][:10]
    make_scores(
        tmp_path,
        [{"exercise_id": on_sheet[0], "verdict": "wrong", "reviewer": "opus"}]
        + [
            {"exercise_id": identifier, "verdict": "ok", "reviewer": "opus"}
            for identifier in on_sheet[1:]
        ]
        + [
            {"exercise_id": f"not-in-this-build-{index}", "verdict": "wrong", "reviewer": "opus"}
            for index in range(10)
        ],
    )
    review = derive_review("es", repo_root=tmp_path)
    assert review is not None
    assert (review["scored"], review["joined"], review["unjoined"]) == (20, 10, 10)
    assert review["wrong_item_rate"] == pytest.approx(0.1)
    assert gate_passed(review) is False  # 10% is over the 2% gate, and says so


# ---------------------------------------------------------------------------
# The spelling the briefs used, and the exit code it collides with (B4)
# ---------------------------------------------------------------------------


def test_the_phantom_n_flag_is_rejected_and_collides_with_exit_2() -> None:
    """`coursekit sample es --n 300` is not a spelling this CLI has, and never was.

    The P2 task briefs and `docs/P2-REPORT.md` §B4 both wrote it. Per-stage options ride
    on `--set` for all seven verbs — `cli.py`'s docstring argues why — and a bare
    `coursekit sample es` already draws `REVIEWER_SAMPLE_ITEMS` at `SAMPLE_SEED`, which
    is what the plan's P2 row asks for. Nothing is missing.

    This test pins the rejection rather than the absence, because the failure that would
    actually hurt is the flag being ACCEPTED AND IGNORED: a command line reading
    `--n 300` that quietly draws some other number of items puts a sheet size in the
    shell history that is not the sheet size in `sample-summary.json`.

    It also pins the collision that came out of measuring it. `config/base.py` defines
    exit 2 as EXIT_NOT_REGISTERED — "the verb exists, the stage behind it is not
    registered" — and Click exits 2 for ANY usage error, before a command body runs. So
    a mistyped flag and an unwritten stage are the same number to a caller. `coursekit`
    cannot change that: Click owns the code it exits with. Written down here, in
    `tools/coursekit/README.md` and in `docs/P2-BLOCKERS.md` §B4 rather than silently
    lived with, and if `--n` is ever added to `cli.py` this test fails and sends whoever
    added it to those two paragraphs.
    """
    from typer.testing import CliRunner

    from coursekit.cli import app
    from coursekit.config import EXIT_NOT_REGISTERED

    result = CliRunner().invoke(app, ["sample", "es", "--n", "300"])

    # Rejected, not silently ignored.
    assert result.exit_code != 0, "`--n` was accepted; the README and B4 are now wrong"
    assert "No such option" in result.output

    # And the code it is rejected with is this CLI's "stage not registered".
    assert result.exit_code == EXIT_NOT_REGISTERED, (
        "Click's usage-error exit changed; docs/P2-BLOCKERS.md §B4 describes the old one"
    )


def test_the_sanctioned_spellings_are_the_ones_the_readme_documents() -> None:
    """The two spellings in `tools/coursekit/README.md`, asserted against the code.

    A README that says `--set n=300` while the stage reads a differently named option is
    a README that has drifted, and B4 was a drift of exactly that shape one level up.
    """
    readme = (REPO_ROOT / "tools" / "coursekit" / "README.md").read_text(encoding="utf-8")

    assert "uv run coursekit sample es " in readme
    assert "--set n=300" in readme

    # And it corrects the phantom spelling rather than leaving a reader to find out.
    assert "coursekit sample es --n 300" in readme
    assert "not a spelling this CLI has" in readme

    # The bare draw is REVIEWER_SAMPLE_ITEMS at SAMPLE_SEED, which is what the README
    # and the plan's P2 row both claim.
    assert REVIEWER_SAMPLE_ITEMS == 300
    assert SAMPLE_SEED == 20260912
