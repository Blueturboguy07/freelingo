"""The suite runner and the report it writes.

The three lies this file exists to make impossible, in the order they cost money:

1. a suite that is green because a validator was never written;
2. a suite that is green because a validator could not run;
3. a report that says "17/17 green" for a run where neither of those was true.

Every test below is the falsifier for one of them. The pattern is `test_cli.py`'s
`test_exit_two_is_not_vacuous`: prove the refusal fires, then prove the success path is
still reachable, because a runner that refused unconditionally would pass half of these.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from typer.testing import CliRunner

from coursekit.cli import app
from coursekit.config import (
    EXIT_FAILED,
    EXIT_MISSING_INPUT,
    EXIT_NOT_REGISTERED,
    EXIT_OK,
    VALIDATOR_IDS,
)
from coursekit.config.sample import PROVISIONAL_DEFECT_RATE_NOTE, REVIEWER_KIND_PAID_NATIVE
from coursekit.config.validate import BLOCKING_OUTCOMES, HARD_GATE_VALIDATOR_IDS
from coursekit.runlog import read_entries
from coursekit.validators import Finding, ValidatorContext, register_validator
from coursekit.validators.report import ReportError, read_report, report_path, summarise
from coursekit.validators.runner import run_suite

runner = CliRunner()


def clean(ctx: ValidatorContext) -> list[Finding]:
    return []


def register_all(*, skip: tuple[str, ...] = (), group: dict[str, str] | None = None) -> None:
    for validator_id in VALIDATOR_IDS:
        if validator_id in skip:
            continue
        register_validator(validator_id, requires_group=(group or {}).get(validator_id))(clean)


# ---------------------------------------------------------------------------
# 1. Unregistered is a failure, with the id named
# ---------------------------------------------------------------------------


def test_an_unregistered_validator_is_a_blocking_outcome_not_an_absence(
    empty_registry: None,
) -> None:
    register_all(skip=("V9",))
    result = run_suite("es")
    assert result.unregistered == ("V9",)
    assert result.exit_code == EXIT_NOT_REGISTERED
    row = next(v for v in result.report["validators"] if v["id"] == "V9")
    assert row["outcome"] == "unregistered"
    assert "V9" in row["messages"][0]
    assert result.report["status"] == "failed"


def test_the_report_counts_an_unregistered_validator_as_not_green(
    empty_registry: None,
) -> None:
    """THE falsifier for the whole module.

    A report that simply omitted the unwritten validator would say "16/16 green" and
    print it on the S002 card. The denominator is the ledger, never the registry.
    """
    register_all(skip=("V9", "F3"))
    result = run_suite("es")
    counts = result.report["counts"]
    assert counts["declared"] == len(VALIDATOR_IDS)
    assert counts["green"] == len(VALIDATOR_IDS) - 2
    assert counts["unregistered"] == 2
    assert summarise(result.report)["not_run"] == 2


def test_the_cli_exits_two_and_names_every_missing_validator(empty_registry: None) -> None:
    register_all(skip=("V9", "F3"))
    result = runner.invoke(app, ["validate", "es"])
    assert result.exit_code == EXIT_NOT_REGISTERED, result.output
    assert "V9" in result.output
    assert "F3" in result.output


# ---------------------------------------------------------------------------
# 2. Skipped is a failure too
# ---------------------------------------------------------------------------


def test_a_validator_whose_dependency_group_is_absent_is_skipped_and_blocking(
    empty_registry: None,
) -> None:
    """A registered validator that did not run reports zero findings. So does a green one."""
    register_all(group={"V8": "align"})
    result = run_suite("es")
    if not result.skipped:
        pytest.skip("the align group is installed in this environment")
    assert result.skipped == ("V8",)
    assert result.exit_code == EXIT_MISSING_INPUT
    row = next(v for v in result.report["validators"] if v["id"] == "V8")
    assert row["outcome"] == "skipped"
    assert "uv sync --group align" in row["messages"][0]
    assert result.report["status"] == "failed"


def test_skipped_and_unregistered_are_both_declared_blocking() -> None:
    """Stated as data, so a later edit that demotes one to a warning fails here."""
    assert set(BLOCKING_OUTCOMES) >= {"skipped", "unregistered"}


def test_a_skipped_validator_leaves_a_runlog_entry_saying_so(empty_registry: None) -> None:
    """"Did not run" and "ran clean" must be distinguishable in the provenance log."""
    register_all(group={"V8": "align"})
    run_suite("es")
    entries = [entry for entry in read_entries("es") if entry["stage"] == "V8"]
    if entries and entries[-1]["status"] == "ok":
        pytest.skip("the align group is installed in this environment")
    assert entries[-1]["status"] == "skipped"
    assert entries[-1]["notes"]["skipped_reason"] == "missing_group"


# ---------------------------------------------------------------------------
# 3. The success path is still reachable
# ---------------------------------------------------------------------------


def test_a_fully_registered_clean_suite_is_green_and_exits_zero(empty_registry: None) -> None:
    register_all()
    result = run_suite("es")
    assert result.exit_code == EXIT_OK
    assert result.report["status"] == "green"
    assert result.report["counts"]["green"] == len(VALIDATOR_IDS)
    assert result.report["hard_gate"]["passed"] is True
    assert runner.invoke(app, ["validate", "es"]).exit_code == EXIT_OK


def test_green_is_not_vacuous(empty_registry: None) -> None:
    """2 with one missing, 0 with all of them, 2 again when one is removed.

    Without the middle step a runner that returned "failed" unconditionally would pass
    every refusal test in this file.
    """
    from coursekit.validators import VALIDATORS

    register_all(skip=("V5",))
    assert run_suite("es").exit_code == EXIT_NOT_REGISTERED
    register_validator("V5")(clean)
    assert run_suite("es").exit_code == EXIT_OK
    VALIDATORS._entries.pop("V5")  # noqa: SLF001 — removing one is the point
    assert run_suite("es").exit_code == EXIT_NOT_REGISTERED


# ---------------------------------------------------------------------------
# Findings, ordering and crashes
# ---------------------------------------------------------------------------


def test_every_validator_runs_even_after_a_blocking_finding(empty_registry: None) -> None:
    seen: list[str] = []

    def make(validator_id: str, blocking: bool):
        def run(ctx: ValidatorContext) -> list[Finding]:
            seen.append(validator_id)
            if not blocking:
                return []
            return [Finding(validator_id=validator_id, severity="blocking", message="no")]

        return run

    for index, validator_id in enumerate(VALIDATOR_IDS):
        register_validator(validator_id)(make(validator_id, index in (0, 5)))

    result = run_suite("es")
    assert seen == list(VALIDATOR_IDS)
    assert result.exit_code == EXIT_FAILED
    assert result.report["counts"]["failed"] == 2


def test_a_validator_that_raises_is_a_failure_not_a_pass(empty_registry: None) -> None:
    """An exception produces no findings, and no findings is what green looks like."""

    def explode(ctx: ValidatorContext) -> list[Finding]:
        raise RuntimeError("the ledger moved under me")

    register_all(skip=("V7",))
    register_validator("V7")(explode)
    result = run_suite("es")
    assert result.exit_code == EXIT_FAILED
    row = next(v for v in result.report["validators"] if v["id"] == "V7")
    assert row["outcome"] == "failed"
    assert "the ledger moved under me" in row["messages"][0]


def test_a_warning_does_not_block_but_is_counted(empty_registry: None) -> None:
    def warn(ctx: ValidatorContext) -> list[Finding]:
        return [Finding(validator_id="V11", severity="warning", message="coverage is low")]

    register_all(skip=("V11",))
    register_validator("V11")(warn)
    result = run_suite("es")
    assert result.exit_code == EXIT_OK
    assert result.report["counts"]["warning_findings"] == 1
    assert next(v for v in result.report["validators"] if v["id"] == "V11")["outcome"] == "warned"


def test_a_validators_own_notes_reach_the_report(empty_registry: None) -> None:
    """V8 records `spellcheck_engine: none` for Japanese; a reader must be able to see it."""

    def degrade(ctx: ValidatorContext) -> list[Finding]:
        ctx.entry.note(spellcheck_engine="none")
        return []

    register_all(skip=("V8",))
    register_validator("V8")(degrade)
    result = run_suite("es")
    row = next(v for v in result.report["validators"] if v["id"] == "V8")
    assert row["notes"]["spellcheck_engine"] == "none"


# ---------------------------------------------------------------------------
# The report as a file
# ---------------------------------------------------------------------------


def test_the_report_is_written_validated_and_re_readable(empty_registry: None) -> None:
    register_all()
    result = run_suite("es")
    assert result.report_file == report_path("es")
    assert read_report(report_path("es")) == result.report


def test_a_hand_edited_report_is_refused_on_read(empty_registry: None) -> None:
    """Reading is where a hand-edited file shows up; writing is the only path we control."""
    register_all()
    run_suite("es")
    path = report_path("es")
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["status"] = "excellent"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ReportError):
        read_report(path)


def test_only_v1_to_v4_are_the_hard_gate(empty_registry: None) -> None:
    """The plan's P2 row: "V1-V4 100%". The other thirteen must be green too, but the
    gate the pack CI asserts separately is these four."""
    assert HARD_GATE_VALIDATOR_IDS == ("V1", "V2", "V3", "V4")
    register_all(skip=("V2",))
    result = run_suite("es")
    assert result.report["hard_gate"]["passed"] is False


def test_a_single_validator_run_says_so_in_declared(empty_registry: None) -> None:
    """`--only V10` must never be mistakable for a suite run."""
    register_all()
    result = run_suite("es", ("V10",))
    assert result.report["declared"] == ["V10"]
    assert result.report["counts"]["declared"] == 1


# ---------------------------------------------------------------------------
# Trust marking
# ---------------------------------------------------------------------------


def test_the_summary_never_reports_a_rate_without_its_provenance(
    empty_registry: None,
) -> None:
    register_all()
    result = run_suite(
        "es",
        review={
            "reviewer_kind": "opus-agent-reviewer",
            "sample_size": 300,
            "scored": 300,
            "joined": 300,
            "unjoined": 0,
            "wrong_item_rate": 0.01,
            "awkward_rate": 0.02,
            "note": PROVISIONAL_DEFECT_RATE_NOTE,
        },
    )
    summary = summarise(result.report)
    assert summary["wrong_item_rate"] == 0.01
    assert summary["wrong_item_rate_note"] == PROVISIONAL_DEFECT_RATE_NOTE
    # The denominator rides with the rate: 3/300 of a sheet is not the same claim as
    # 300/300 of it, and S002 renders one line.
    assert (summary["reviewer_scored"], summary["reviewer_joined"]) == (300, 300)


def test_an_unreviewed_pack_summarises_with_no_rate_and_the_note(
    empty_registry: None,
) -> None:
    register_all()
    summary = summarise(run_suite("es").report)
    assert summary["wrong_item_rate"] is None
    assert summary["wrong_item_rate_note"] == PROVISIONAL_DEFECT_RATE_NOTE
    assert summary["reviewer_joined"] is None


def test_a_review_block_without_its_join_count_cannot_be_written_at_all(
    empty_registry: None,
) -> None:
    """The schema half of founder ruling B3's denominator.

    `joined` is REQUIRED in the report schema, not optional, because the failure it
    prevents is silent: a block carrying `scored: 300, wrong_item_rate: 0.01` and no join
    count publishes a rate whose denominator the reader cannot see. Four rows of a stale
    scores file joining this build's sheet produce the same two fields as three hundred.
    `write_report` validates on the way out, so a caller that forgot the count gets a
    `ReportError` rather than a report.
    """
    register_all()
    with pytest.raises(ReportError, match="joined"):
        run_suite(
            "es",
            review={
                "reviewer_kind": REVIEWER_KIND_PAID_NATIVE,
                "sample_size": 300,
                "scored": 300,
                "wrong_item_rate": 0.013,
                "note": "",
            },
        )


def test_only_a_paid_native_review_clears_the_provisional_note(empty_registry: None) -> None:
    register_all()
    result = run_suite(
        "es",
        review={
            "reviewer_kind": REVIEWER_KIND_PAID_NATIVE,
            "sample_size": 300,
            "scored": 300,
            "joined": 300,
            "unjoined": 0,
            "wrong_item_rate": 0.013,
            "awkward_rate": 0.02,
            "note": "",
        },
    )
    assert summarise(result.report)["wrong_item_rate_note"] == ""


# ---------------------------------------------------------------------------
# The workflow that runs this suite
# ---------------------------------------------------------------------------
#
# `pack-ci.yml` is where the suite is actually a gate. The runner above refuses to report
# a pass it did not earn; these tests refuse the one level up — a workflow that never
# reaches the runner, or reaches it and does not read its answer. Every failure below was
# real once (`docs/P2-BLOCKERS.md` B8, B13, and `docs/ci.md` §"the job that was green
# because it never ran"), and none of them is visible in a green `pnpm test` or a green
# `uv run pytest` unless something reads the YAML.

WORKFLOW = (
    Path(__file__).resolve().parents[3] / ".github" / "workflows" / "pack-ci.yml"
).read_text(encoding="utf-8")


def _job(name: str) -> str:
    """One job's YAML, from its `name:` line to the next top-level job key."""
    start = WORKFLOW.index(f"\n  {name}:\n")
    rest = WORKFLOW[start + 1 :]
    match = re.search(r"\n  [a-z][a-z0-9-]*:\n", rest)
    return rest[: match.start()] if match else rest


def test_INV_PACK_06_the_workflow_reads_the_hard_gate_it_asked_for() -> None:
    """[INV-PACK-06] V1-V4 at 100% is asserted by the job, not left in a file.

    `coursekit validate es` exits 0 when no validator FAILED. That is not the plan's P2
    row, which says "V1-V4 100%" — and the two can differ: V1 can warn, or the suite can
    be green with a hard-gate validator that only ran because `--only` narrowed the run.
    So `validate-es` re-reads `validator-report.json` and checks `hard_gate.passed`,
    `not_run`, the status and green-vs-declared. A job that ran the suite and never read
    the report would be a gate whose answer nobody looked at.
    """
    job = _job("validate-es")
    assert "uv run coursekit validate es" in job
    assert 'report["hard_gate"]["passed"]' in job
    assert "HARD_GATE_VALIDATOR_IDS" in job
    assert 'summary["not_run"]' in job
    assert 'report["status"] != "green"' in job
    assert HARD_GATE_VALIDATOR_IDS == ("V1", "V2", "V3", "V4")


def test_INV_PACK_14_validate_es_only_ever_reads_a_build_that_brought_an_engine() -> None:
    """[INV-PACK-14] the sidecar (B8) and the `align` group (B13) stay in `build-es`.

    Both omissions were invisible for the whole phase because the build failed one stage
    earlier, and both make `validate-es` unreachable rather than red: without the
    LanguageTool sidecar V8 reads "zero errors from nothing" and blocks; without `align`
    G7 exits 3 by name and the pack never exists. `validate-es` `needs: build-es`, so a
    regression in either is a skipped job, and a skipped job is a green job.

    The base-URL rule is asserted in `test_g6_validate_language.py` against the
    invocation; here it is the server's existence and the groups.
    """
    build = _job("build-es")
    assert "--group align" in build, "B13: G7 exits 3 without the align group"
    assert "org.languagetool.server.HTTPServer" in build
    assert "--set languagetool_url=" in build
    # The probe is what makes `spellcheck_engine` on es a claim rather than a hope.
    assert "MORFOLOGIK_RULE_ES" in build
    assert "needs: [pipeline-ready, build-es]" in _job("validate-es")


def test_INV_PACK_18_the_pack_artefacts_cannot_be_an_empty_archive() -> None:
    """[INV-PACK-18] the signed manifest travels with the pack, or the job is red.

    `if-no-files-found: error` on both uploads: an empty `es-pack-<sha>` would read as a
    successful build with a downloadable pack in it. And the signing step is allowed to
    NOTICE that `PACK_SIGNING_KEY` is absent (it is not exposed to fork pull requests)
    rather than failing — but it says what that means, because the state it produces is
    the `unverified` one INV-PACK-18 is about, not `corrupt` and not "fine".
    """
    assert WORKFLOW.count("if-no-files-found: error") >= 2
    collect = _job("validate-es")
    assert "g9/manifest.json" in collect
    assert "g9/pack.sqlite" in collect
    build = _job("build-es")
    assert "uv run coursekit sign es" in build
    assert "unverified" in build


def test_INV_PACK_13_the_frequency_list_is_fetched_through_the_allow_list() -> None:
    """[INV-PACK-13] nothing the workflow downloads gets in without a verdict.

    Two third-party downloads exist in `build-es` — the hermitdave frequency list and the
    LanguageTool jar — and both are on the ingest allow-list with a licence and a verdict
    (`coursekit doctor es`). The invariant's own words are that NC and ND sources are
    excluded **at ingest**, so the thing to assert here is that the workflow does not
    reach around `resolve()`: it drops the list into `build/es/sources` for G2 to resolve,
    rather than passing a URL into a stage.
    """
    build = _job("build-es")
    assert "build/es/sources" in build
    assert "hermitdave" in build and "CC BY-SA-4.0" in build
    assert "LGPL-2.1-or-later" in build


def test_the_pack_the_gate_built_is_loaded_by_packages_core() -> None:
    """The P2 gate clause "the pack loads in packages/core's pack loader tests".

    Until this step existed the clause was discharged against `__fixtures__/es-mini` — a
    real G9 output, and a tiny one built by a different invocation on a different day. The
    pack `build-es` actually produced was uploaded and never opened. So `validate-es`
    points `packages/core`'s loader at `build/es/g9/pack.sqlite` through
    `FREELINGO_REAL_PACK`, and the test behind that variable FAILS rather than skips when
    the variable is set and the pack is not there — which is the whole difference between
    a step that proves something and a step that is green on a missing file.
    """
    job = _job("validate-es")
    assert "FREELINGO_REAL_PACK" in job
    assert "real-pack" in job
    assert "pnpm install --frozen-lockfile" in job
    assert "actions/setup-node" in job
    assert "pnpm/action-setup" in job


def test_the_workflow_no_longer_names_a_deleted_workflow() -> None:
    """`pack-bake.yml` was deleted at the P2 fix round (B2) and two comments outlived it.

    A comment naming a file that is not in the tree sends the next reader to look for the
    bake job that "must be somewhere". The bake is inside `build-es`; `docs/ci.md` argues
    the deletion. Asserted rather than merely fixed, because this is the second round in
    which these two lines were listed as loose ends.
    """
    assert "pack-bake" not in WORKFLOW
